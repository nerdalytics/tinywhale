import * as ohm from 'ohm-js';

/**
 * Represents a position in the source text.
 */
export interface Position {
  line: number;
  level: number;
}

/**
 * Represents an INDENT or DEDENT token with its position.
 */
export interface IndentToken {
  type: 'indent' | 'dedent';
  position: Position;
}

/**
 * Segment type in parsed content.
 */
export type SegmentType = 'text' | 'comment';

/**
 * A segment of content on a line.
 */
export interface Segment {
  type: SegmentType;
  content: string;
}

/**
 * Represents a parsed line from the preprocessed input.
 */
export interface ParsedLine {
  indentTokens: IndentToken[];
  segments: Segment[];
  lineNumber: number;
}

/**
 * Result of parsing a program.
 */
export interface ParseResult {
  lines: ParsedLine[];
  succeeded: boolean;
  message?: string;
}

/**
 * TinyWhale Grammar Source
 *
 * Token format from preprocessor:
 *   ⟨line,level⟩⇥ content   (INDENT - increase indent level)
 *   ⟨line,level⟩⇤           (DEDENT - decrease indent level)
 *
 * Comment syntax:
 *   # starts a comment, ends at next # or EOL
 *   Examples: `# full line`, `text # inline # back`
 */
const grammarSource = String.raw`
TinyWhale {
  program = line*

  line = indentedLine | dedentLine | contentLine | blankLine

  indentedLine = indentToken lineContent terminator
  dedentLine = dedentToken+ lineContent? terminator
  contentLine = lineContent terminator
  blankLine = newline

  lineContent = segment+
  segment = comment | text
  comment = "#" commentContent ("#" | &newline | &dedentToken | end)
  commentContent = (~("#" | newline | dedentToken) any)*
  text = (~("#" | newline | dedentToken) any)+

  indentToken = position "⇥"
  dedentToken = position "⇤"
  position = "⟨" digit+ "," digit+ "⟩"

  terminator = newline | end
  newline = "\n" | "\r\n" | "\r"
}
`;

/**
 * The compiled TinyWhale grammar.
 */
export const grammars = ohm.grammars(grammarSource);

/**
 * The base TinyWhale grammar for indentation handling.
 */
export const TinyWhaleGrammar = grammars['TinyWhale'];

/**
 * Helper to get line number from a node's source position.
 */
function getLineNumber(node: ohm.Node): number {
  const interval = node.source;
  const fullSource = interval.sourceString;
  const textBefore = fullSource.substring(0, interval.startIdx);
  return (textBefore.match(/\n/g) || []).length + 1;
}

/**
 * Create semantics for the TinyWhale grammar.
 */
export function createSemantics() {
  const semantics = TinyWhaleGrammar.createSemantics();

  // Extract Position from position node
  semantics.addOperation<Position>('toPosition', {
    position(_open, lineDigits, _comma, levelDigits, _close) {
      return {
        line: Number(lineDigits.sourceString),
        level: Number(levelDigits.sourceString),
      };
    },
  });

  // Extract IndentToken from indent/dedent nodes
  semantics.addOperation<IndentToken>('toIndentToken', {
    indentToken(position, _marker) {
      return {
        type: 'indent',
        position: position.toPosition(),
      };
    },

    dedentToken(position, _marker) {
      return {
        type: 'dedent',
        position: position.toPosition(),
      };
    },
  });

  // Extract Segment from segment nodes
  semantics.addOperation<Segment>('toSegment', {
    comment(_hash1, content, _hash2OrEnd) {
      return {
        type: 'comment',
        content: content.sourceString,
      };
    },

    text(chars) {
      return {
        type: 'text',
        content: chars.sourceString,
      };
    },

    segment(inner) {
      return inner.toSegment();
    },
  });

  // Extract array of Segments from lineContent
  semantics.addOperation<Segment[]>('toSegments', {
    lineContent(segments) {
      return segments.children.map(s => s.toSegment());
    },
  });

  // Convert line nodes to ParsedLine
  semantics.addOperation<ParsedLine | null>('toLine', {
    indentedLine(indentToken, lineContent, _terminator) {
      const token = indentToken.toIndentToken();
      return {
        indentTokens: [token],
        segments: lineContent.toSegments(),
        lineNumber: token.position.line,
      };
    },

    dedentLine(dedentTokens, lineContent, _terminator) {
      const tokens: IndentToken[] = dedentTokens.children.map(t => t.toIndentToken());
      const segments = lineContent.children.length > 0
        ? lineContent.children[0].toSegments()
        : [];
      return {
        indentTokens: tokens,
        segments,
        lineNumber: tokens.length > 0 ? tokens[0].position.line : getLineNumber(this),
      };
    },

    contentLine(lineContent, _terminator) {
      return {
        indentTokens: [],
        segments: lineContent.toSegments(),
        lineNumber: getLineNumber(this),
      };
    },

    blankLine(_newline) {
      return null;
    },

    line(inner) {
      return inner.toLine();
    },
  });

  // Collect all lines from a Program
  semantics.addOperation<ParsedLine[]>('toLines', {
    program(lines) {
      return lines.children
        .map(line => line.toLine())
        .filter((line): line is ParsedLine => line !== null);
    },
  });

  return semantics;
}

/**
 * Default semantics instance.
 */
export const semantics = createSemantics();

/**
 * Parse preprocessed input and return structured result.
 *
 * @param input - Preprocessed input string (with INDENT/DEDENT tokens)
 * @returns Parse result with lines and success status
 */
export function parse(input: string): ParseResult {
  const matchResult = TinyWhaleGrammar.match(input);

  if (matchResult.failed()) {
    return {
      lines: [],
      succeeded: false,
      message: matchResult.message,
    };
  }

  const lines = semantics(matchResult).toLines();

  return {
    lines,
    succeeded: true,
  };
}

/**
 * Match input against the grammar without extracting semantics.
 *
 * @param input - Preprocessed input string
 * @returns Ohm match result
 */
export function match(input: string): ohm.MatchResult {
  return TinyWhaleGrammar.match(input);
}

/**
 * Trace a parse for debugging purposes.
 *
 * @param input - Preprocessed input string
 * @returns Trace string
 */
export function trace(input: string): string {
  return TinyWhaleGrammar.trace(input).toString();
}

// Re-export for backwards compatibility
export type { Position as SourcePosition };
export type IndentInfo = IndentToken;
