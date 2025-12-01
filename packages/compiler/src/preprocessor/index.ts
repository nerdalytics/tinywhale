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
 * Represents a position in the source text.
 * Line is 1-indexed. Level is the indent level (0 = root).
 */
interface Position {
  line: number;
  level: number;
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
 * Creates a position string in the format ⟨line,level⟩
 */
function formatPosition(pos: Position): string {
  return `⟨${pos.line},${pos.level}⟩`;
}

/**
 * Creates an INDENT token with position.
 */
function createIndentToken(pos: Position): string {
  return `${formatPosition(pos)}${INDENT_CHAR}`;
}

/**
 * Creates a DEDENT token with position.
 */
function createDedentToken(pos: Position): string {
  return `${formatPosition(pos)}${DEDENT_CHAR}`;
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
  // Current indent level (0 = root)
  currentLevel: number;
  // For spaces: the number of spaces per indent level (detected from first indent)
  indentUnit: number | null;
  // Line where indent unit was established
  indentUnitLine: number | null;
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
 * Calculates indent level from whitespace count.
 * For tabs: level = count
 * For spaces: level = count / indentUnit
 * Throws if spaces don't divide evenly by unit.
 */
function calculateIndentLevel(
  indentInfo: LineIndentInfo,
  lineNumber: number,
  state: ProcessingState
): number {
  if (indentInfo.count === 0) {
    return 0;
  }

  if (indentInfo.type === 'tab') {
    // Tabs: 1 tab = 1 level
    return indentInfo.count;
  }

  // Spaces: need to use/detect indent unit
  if (state.indentUnit === null) {
    // First indented line with spaces - establish unit
    state.indentUnit = indentInfo.count;
    state.indentUnitLine = lineNumber;
    return 1;
  }

  // Validate spaces divide evenly by unit
  if (indentInfo.count % state.indentUnit !== 0) {
    throw new IndentationError(
      `${lineNumber}:1 Inconsistent indentation: ${indentInfo.count} spaces is not a multiple of ${state.indentUnit} (established on line ${state.indentUnitLine}).`,
      lineNumber,
      1,
      'space',
      'space'
    );
  }

  return indentInfo.count / state.indentUnit;
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
  const newLevel = calculateIndentLevel(indentInfo, lineNumber, state);
  const content = line.slice(indentInfo.count);
  const tokens: string[] = [];

  if (newLevel > state.currentLevel) {
    // Indent increased - must only go up by 1 level
    if (newLevel > state.currentLevel + 1) {
      throw new IndentationError(
        `${lineNumber}:1 Unexpected indent: jumped from level ${state.currentLevel} to level ${newLevel}. Can only increase by one level at a time.`,
        lineNumber,
        1,
        indentInfo.type || 'tab',
        indentInfo.type || 'tab'
      );
    }
    // Emit INDENT token
    const pos: Position = {
      line: lineNumber,
      level: newLevel,
    };
    tokens.push(createIndentToken(pos));
    state.currentLevel = newLevel;
  } else if (newLevel < state.currentLevel) {
    // Indent decreased - emit DEDENT token(s)
    while (state.currentLevel > newLevel) {
      state.currentLevel--;
      const pos: Position = {
        line: lineNumber,
        level: 0, // DEDENT tokens use level 0
      };
      tokens.push(createDedentToken(pos));
    }
  }
  // If newLevel === state.currentLevel, no INDENT/DEDENT needed

  tokens.push(content);
  return tokens.join('');
}

/**
 * Generates remaining DEDENT tokens at end of file.
 */
function generateEofDedents(state: ProcessingState, lastLineNumber: number): string {
  const dedents: string[] = [];
  while (state.currentLevel > 0) {
    state.currentLevel--;
    const pos: Position = {
      line: lastLineNumber,
      level: 0,
    };
    dedents.push(createDedentToken(pos));
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
 * Indentation rules:
 * - Mixed indentation (tabs and spaces in the same file) causes an error
 * - Can only increase indent by one level at a time (like Python)
 * - For tabs: 1 tab = 1 level
 * - For spaces: indent unit detected from first indent (e.g., 2 or 4 spaces)
 *   and must be consistent throughout the file
 *
 * Token format:
 *   INDENT: ⟨line,level⟩⇥
 *   DEDENT: ⟨line,level⟩⇤
 *
 * Examples:
 *   - ⟨2,1⟩⇥fn bar()    (indent at line 2, entering level 1)
 *   - ⟨4,0⟩⇤fn baz()    (dedent at line 4)
 *
 * @param stream - A readable stream of UTF-8 text
 * @param options - Preprocessor options
 * @returns The preprocessed text with INDENT/DEDENT tokens
 * @throws IndentationError if indentation rules are violated
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
    currentLevel: 0,
    indentUnit: null,
    indentUnitLine: null,
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
