import { Readable } from 'node:stream';

/**
 * Token types for indentation.
 */
type IndentType = 'tab' | 'space';

/**
 * Indentation mode for the preprocessor.
 * - 'detect': First indentation character encountered sets the file-wide type (default)
 * - 'directive': Respects "use spaces" directive, otherwise defaults to tabs
 */
export type IndentMode = 'detect' | 'directive';

/**
 * Options for the preprocessor.
 */
export interface PreprocessOptions {
  mode?: IndentMode;
}

/**
 * Error thrown when mixed indentation is detected.
 */
export class IndentationError extends Error {
  readonly line: number;
  readonly column: number;
  readonly expected: IndentType;
  readonly found: IndentType;

  constructor(
    message: string,
    line: number,
    column: number,
    expected: IndentType,
    found: IndentType
  ) {
    super(message);
    this.name = 'IndentationError';
    this.line = line;
    this.column = column;
    this.expected = expected;
    this.found = found;
  }
}

/**
 * Represents a position span in the source text.
 * Line and column are 1-indexed.
 */
interface PositionSpan {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/**
 * Result of analyzing a line's indentation.
 */
interface LineIndentInfo {
  type: IndentType | null;
  count: number;
}

/**
 * UTF-8 Byte Order Mark (BOM) character.
 * Unnecessary for UTF-8 but sometimes added by editors. We strip it.
 */
const UTF8_BOM = '\uFEFF';

/**
 * Unicode characters for INDENT and DEDENT tokens.
 */
const INDENT_CHAR = '⇥'; // U+21E5 RIGHTWARDS ARROW TO BAR
const DEDENT_CHAR = '⇤'; // U+21E4 LEFTWARDS ARROW TO BAR

/**
 * Creates a position string in the format ⟨startLine,startCol;endLine,endCol⟩
 */
function formatPosition(span: PositionSpan): string {
  return `⟨${span.startLine},${span.startCol};${span.endLine},${span.endCol}⟩`;
}

/**
 * Creates an INDENT token with position.
 */
function createIndentToken(span: PositionSpan): string {
  return `${formatPosition(span)}${INDENT_CHAR}`;
}

/**
 * Creates a DEDENT token with position.
 */
function createDedentToken(span: PositionSpan): string {
  return `${formatPosition(span)}${DEDENT_CHAR}`;
}

/**
 * Analyzes a line's leading whitespace.
 * Throws IndentationError if mixed indentation is found on the same line.
 */
function analyzeLineIndent(line: string, lineNumber: number): LineIndentInfo {
  if (line.length === 0) {
    return { type: null, count: 0 };
  }

  let indentEnd = 0;
  let indentType: IndentType | null = null;

  while (indentEnd < line.length) {
    const char = line[indentEnd];
    if (char === '\t') {
      if (indentType === null) {
        indentType = 'tab';
      } else if (indentType !== 'tab') {
        throw new IndentationError(
          `${lineNumber}:${indentEnd + 1} Mixed indentation: found tab after spaces. Use spaces only for indentation on this line.`,
          lineNumber,
          indentEnd + 1,
          indentType,
          'tab'
        );
      }
      indentEnd++;
    } else if (char === ' ') {
      if (indentType === null) {
        indentType = 'space';
      } else if (indentType !== 'space') {
        throw new IndentationError(
          `${lineNumber}:${indentEnd + 1} Mixed indentation: found space after tabs. Use tabs only for indentation on this line.`,
          lineNumber,
          indentEnd + 1,
          indentType,
          'space'
        );
      }
      indentEnd++;
    } else {
      break;
    }
  }

  return { type: indentType, count: indentEnd };
}

/**
 * Parses a "use spaces" directive from a line.
 * Returns 'space' if directive found, null otherwise.
 */
function parseDirective(line: string): IndentType | null {
  const trimmed = line.trim();
  if (trimmed === '"use spaces"' || trimmed === "'use spaces'") {
    return 'space';
  }
  return null;
}

/**
 * Entry in the indent stack tracking indentation levels.
 */
interface IndentStackEntry {
  level: number;
  lineNumber: number;
}

/**
 * State tracked during streaming processing.
 */
interface ProcessingState {
  mode: IndentMode;
  lineNumber: number;
  expectedIndentType: IndentType | null;
  indentEstablishedAt: { line: number; source: 'directive' | 'detected' } | null;
  directiveLine: number | null;
  bufferedLines: { line: string; lineNumber: number; indentInfo: LineIndentInfo }[];
  directiveFound: boolean;
  isFirstChunk: boolean;
  // Indent stack for tracking nested levels
  indentStack: IndentStackEntry[];
}

/**
 * Validates indentation consistency and throws if mismatched.
 */
function validateIndent(
  indentInfo: LineIndentInfo,
  lineNumber: number,
  state: ProcessingState
): void {
  if (indentInfo.type === null) {
    return;
  }

  if (state.expectedIndentType === null) {
    state.expectedIndentType = indentInfo.type;
    state.indentEstablishedAt = { line: lineNumber, source: 'detected' };
  } else if (indentInfo.type !== state.expectedIndentType) {
    const plural = state.expectedIndentType === 'tab' ? 'tabs' : 'spaces';
    const foundPlural = indentInfo.type === 'tab' ? 'tabs' : 'spaces';
    let context: string;
    if (state.indentEstablishedAt?.source === 'directive') {
      context = state.indentEstablishedAt.line === 0
        ? `File uses ${plural} by default (no "use spaces" directive at the top of file found).`
        : `File uses ${plural} ("use spaces" directive on line ${state.indentEstablishedAt.line}).`;
    } else {
      context = `File uses ${plural} (first indented line: ${state.indentEstablishedAt?.line}).`;
    }
    throw new IndentationError(
      `${lineNumber}:1 Unexpected ${foundPlural}. ${context} Convert this line to use ${plural}.`,
      lineNumber,
      1,
      state.expectedIndentType,
      indentInfo.type
    );
  }
}

/**
 * Processes a single line and returns the tokenized version with INDENT/DEDENT tokens.
 */
function processLine(
  line: string,
  lineNumber: number,
  indentInfo: LineIndentInfo,
  state: ProcessingState
): string {
  const currentLevel = indentInfo.count;
  const topLevel = state.indentStack.length > 0
    ? state.indentStack[state.indentStack.length - 1].level
    : 0;

  const content = line.slice(indentInfo.count);
  const tokens: string[] = [];

  if (currentLevel > topLevel) {
    // Indent increased - emit INDENT token
    const span: PositionSpan = {
      startLine: lineNumber,
      startCol: 1,
      endLine: lineNumber,
      endCol: indentInfo.count,
    };
    tokens.push(createIndentToken(span));
    state.indentStack.push({ level: currentLevel, lineNumber });
  } else if (currentLevel < topLevel) {
    // Indent decreased - emit DEDENT token(s)
    while (
      state.indentStack.length > 0 &&
      state.indentStack[state.indentStack.length - 1].level > currentLevel
    ) {
      state.indentStack.pop();
      const span: PositionSpan = {
        startLine: lineNumber,
        startCol: 1,
        endLine: lineNumber,
        endCol: 1,
      };
      tokens.push(createDedentToken(span));
    }
  }
  // If currentLevel === topLevel, no INDENT/DEDENT needed

  tokens.push(content);
  return tokens.join('');
}

/**
 * Generates remaining DEDENT tokens at end of file.
 */
function generateEofDedents(state: ProcessingState, lastLineNumber: number): string {
  const dedents: string[] = [];
  while (state.indentStack.length > 0) {
    state.indentStack.pop();
    const span: PositionSpan = {
      startLine: lastLineNumber,
      startCol: 1,
      endLine: lastLineNumber,
      endCol: 1,
    };
    dedents.push(createDedentToken(span));
  }
  return dedents.join('');
}

/**
 * Preprocesses source code by tokenizing indentation.
 *
 * This is the first phase of compilation that operates on raw text streams.
 * It replaces leading whitespace (tabs or spaces) with explicit INDENT (⇥)
 * and DEDENT (⇤) tokens that include position information.
 *
 * The preprocessor operates in two modes:
 * - 'detect' (default): First indentation character sets file-wide type
 * - 'directive': Respects "use spaces" directive, defaults to tabs
 *
 * Mixed indentation (tabs and spaces in the same file) causes an error.
 *
 * Token format:
 *   INDENT: ⟨startLine,startCol;endLine,endCol⟩⇥
 *   DEDENT: ⟨startLine,startCol;endLine,endCol⟩⇤
 *
 * Examples:
 *   - ⟨2,1;2,4⟩⇥fn bar()    (indent at line 2, whitespace cols 1-4)
 *   - ⟨4,1;4,1⟩⇤fn baz()    (dedent at line 4)
 *
 * @param stream - A readable stream of UTF-8 text
 * @param options - Preprocessor options
 * @returns The preprocessed text with INDENT/DEDENT tokens
 * @throws IndentationError if mixed indentation is detected
 */
export async function preprocess(
  stream: Readable,
  options: PreprocessOptions = {}
): Promise<string> {
  const { mode = 'detect' } = options;

  const state: ProcessingState = {
    mode,
    lineNumber: 0,
    expectedIndentType: mode === 'directive' ? 'tab' : null,
    indentEstablishedAt: mode === 'directive' ? { line: 0, source: 'directive' } : null,
    directiveLine: null,
    bufferedLines: [],
    directiveFound: false,
    isFirstChunk: true,
    indentStack: [],
  };

  const processedLines: string[] = [];
  let pendingChunk = '';

  for await (const chunk of stream) {
    let str = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');

    if (state.isFirstChunk) {
      if (str.startsWith(UTF8_BOM)) {
        str = str.slice(1);
      }
      state.isFirstChunk = false;
    }

    pendingChunk += str;
    const lines = pendingChunk.split('\n');
    pendingChunk = lines.pop() ?? '';

    for (const line of lines) {
      state.lineNumber++;
      const lineNumber = state.lineNumber;

      if (mode === 'directive' && !state.directiveFound) {
        const directive = parseDirective(line);
        if (directive !== null) {
          state.directiveFound = true;
          state.directiveLine = lineNumber;
          state.expectedIndentType = directive;
          state.indentEstablishedAt = { line: lineNumber, source: 'directive' };

          for (const buffered of state.bufferedLines) {
            validateIndent(buffered.indentInfo, buffered.lineNumber, state);
          }
          state.bufferedLines = [];
          continue;
        }
      }

      const indentInfo = analyzeLineIndent(line, lineNumber);

      if (mode === 'directive' && !state.directiveFound) {
        state.bufferedLines.push({ line, lineNumber, indentInfo });
      } else {
        validateIndent(indentInfo, lineNumber, state);
        processedLines.push(processLine(line, lineNumber, indentInfo, state));
      }
    }
  }

  if (pendingChunk.length > 0) {
    state.lineNumber++;
    const lineNumber = state.lineNumber;

    if (mode === 'directive' && !state.directiveFound) {
      const directive = parseDirective(pendingChunk);
      if (directive !== null) {
        state.directiveFound = true;
        state.directiveLine = lineNumber;
        state.expectedIndentType = directive;
        state.indentEstablishedAt = { line: lineNumber, source: 'directive' };

        for (const buffered of state.bufferedLines) {
          validateIndent(buffered.indentInfo, buffered.lineNumber, state);
        }
        state.bufferedLines = [];
      } else {
        const indentInfo = analyzeLineIndent(pendingChunk, lineNumber);
        state.bufferedLines.push({ line: pendingChunk, lineNumber, indentInfo });
      }
    } else {
      const indentInfo = analyzeLineIndent(pendingChunk, lineNumber);
      validateIndent(indentInfo, lineNumber, state);
      processedLines.push(processLine(pendingChunk, lineNumber, indentInfo, state));
    }
  }

  if (mode === 'directive' && !state.directiveFound && state.bufferedLines.length > 0) {
    for (const buffered of state.bufferedLines) {
      validateIndent(buffered.indentInfo, buffered.lineNumber, state);
      processedLines.push(processLine(buffered.line, buffered.lineNumber, buffered.indentInfo, state));
    }
  }

  let result = processedLines.join('\n');

  // Add EOF dedents
  const eofDedents = generateEofDedents(state, state.lineNumber);
  if (eofDedents) {
    result += '\n' + eofDedents;
  }

  // Preserve trailing newline
  if (pendingChunk.length === 0 && state.lineNumber > 0) {
    return result + '\n';
  }

  return result;
}
