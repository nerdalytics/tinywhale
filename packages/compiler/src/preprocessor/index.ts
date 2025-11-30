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
 * Line and column are 1-indexed.
 */
interface Position {
  line: number;
  column: number;
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
 * Creates an indentation token string.
 * Format: indent_<type>:<startLine>,<startCol>;<endLine>,<endCol>
 */
function createIndentToken(
  type: IndentType,
  start: Position,
  end: Position
): string {
  return `indent_${type}:${start.line},${start.column};${end.line},${end.column}`;
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
 * Processes a single line and returns the tokenized version.
 */
function processLine(
  line: string,
  lineNumber: number,
  indentInfo: LineIndentInfo
): string {
  if (line.length === 0 || indentInfo.type === null || indentInfo.count === 0) {
    return line;
  }

  const start: Position = { line: lineNumber, column: 1 };
  const end: Position = { line: lineNumber, column: indentInfo.count };
  const token = createIndentToken(indentInfo.type, start, end);
  const rest = line.slice(indentInfo.count);

  return `${token} ${rest}`;
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
  // For directive mode: buffer lines until we find directive or finish
  // We need to do a two-pass in directive mode since directive can appear after indented lines
  bufferedLines: { line: string; lineNumber: number; indentInfo: LineIndentInfo }[];
  directiveFound: boolean;
  isFirstChunk: boolean;
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
    // First indent sets the type (detect mode)
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
 * Preprocesses source code by tokenizing indentation.
 *
 * This is the first phase of compilation that operates on raw text streams.
 * It replaces leading whitespace (tabs or spaces) with explicit tokens that
 * include position information.
 *
 * The preprocessor operates in two modes:
 * - 'detect' (default): First indentation character sets file-wide type
 * - 'directive': Respects "use spaces" directive, defaults to tabs
 *
 * Mixed indentation (tabs and spaces in the same file) causes an error.
 *
 * Token format: indent_<type>:<startLine>,<startCol>;<endLine>,<endCol>
 * Examples:
 *   - indent_tab:1,1;1,1 (single tab on line 1)
 *   - indent_space:2,1;2,4 (4 spaces on line 2)
 *
 * @param stream - A readable stream of UTF-8 text
 * @param options - Preprocessor options
 * @returns The preprocessed text with indentation tokens
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

          // Lines before directive are discarded with it
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
        processedLines.push(processLine(line, lineNumber, indentInfo));
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
      processedLines.push(processLine(pendingChunk, lineNumber, indentInfo));
    }
  }

  if (mode === 'directive' && !state.directiveFound && state.bufferedLines.length > 0) {
    for (const buffered of state.bufferedLines) {
      validateIndent(buffered.indentInfo, buffered.lineNumber, state);
      processedLines.push(processLine(buffered.line, buffered.lineNumber, buffered.indentInfo));
    }
  }

  const result = processedLines.join('\n');

  // Preserve trailing newline
  if (pendingChunk.length === 0 && state.lineNumber > 0) {
    return result + '\n';
  }

  return result;
}
