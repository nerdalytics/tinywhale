import * as ohm from 'ohm-js';

/**
 * Represents a position span in the source text.
 */
export interface PositionSpan {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/**
 * Represents an INDENT or DEDENT token with its position.
 */
export interface IndentToken {
  type: 'indent' | 'dedent';
  position: PositionSpan;
}

/**
 * Represents a parsed line from the preprocessed input.
 */
export interface ParsedLine {
  indentTokens: IndentToken[];
  content: string;
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
 * This grammar is designed to work with preprocessed input where leading
 * whitespace has been converted to explicit INDENT (⇥) and DEDENT (⇤) tokens
 * with position information.
 *
 * Token format from preprocessor:
 *   INDENT: ⟨startLine,startCol;endLine,endCol⟩⇥
 *   DEDENT: ⟨startLine,startCol;endLine,endCol⟩⇤
 *
 * Examples:
 *   ⟨2,1;2,4⟩⇥fn bar()    (indent at line 2, whitespace cols 1-4)
 *   ⟨4,1;4,1⟩⇤fn baz()    (dedent at line 4)
 */
const grammarSource = String.raw`
TinyWhale {
  // ============================================================
  // Top-level structure
  // All rules use lowercase (lexical) to avoid implicit space skipping.
  // Each alternative must consume at least one character to avoid
  // infinite loops in repetitions.
  // ============================================================

  program = regularLine* eofPart

  // Lines terminated by newline - each consumes at least one character
  regularLine = indentTokens content newline  -- withContent
              | newline                        -- blank

  // Final part of file (no trailing newline)
  // Each non-empty alternative consumes at least one character
  eofPart = indentToken+ content              -- indentAtEof
          | contentChar+                       -- contentAtEof
          |                                    -- empty

  // Zero or more INDENT/DEDENT tokens at the start of a line
  indentTokens = indentToken*

  indentToken = indent | dedent

  // ============================================================
  // INDENT and DEDENT tokens with position
  // ============================================================

  indent = position "⇥"
  dedent = position "⇤"

  // Position format: ⟨startLine,startCol;endLine,endCol⟩
  position = "⟨" coords ";" coords "⟩"
  coords = digit+ "," digit+

  // ============================================================
  // Line content
  // ============================================================

  // Content after indent tokens until newline
  content = contentChar*

  contentChar = ~newline ~"⇥" ~"⇤" any

  // ============================================================
  // Lexical rules
  // ============================================================

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
 * Parse a coords string like "2,4" into [line, col].
 */
function parseCoords(coordsStr: string): [number, number] {
  const [line, col] = coordsStr.split(',').map(Number);
  return [line, col];
}

/**
 * Parse a position node into a PositionSpan.
 */
function parsePosition(positionNode: ohm.Node): PositionSpan {
  // position = "⟨" coords ";" coords "⟩"
  const children = positionNode.children;
  const startCoords = children[1].sourceString;
  const endCoords = children[3].sourceString;

  const [startLine, startCol] = parseCoords(startCoords);
  const [endLine, endCol] = parseCoords(endCoords);

  return { startLine, startCol, endLine, endCol };
}

/**
 * Helper to get line number from a node's source position.
 */
function getLineNumber(node: ohm.Node): number {
  const interval = node.source;
  const textBefore = interval.sourceString.substring(0, interval.startIdx);
  return (textBefore.match(/\n/g) || []).length + 1;
}

/**
 * Create semantics for the TinyWhale grammar.
 */
export function createSemantics() {
  const semantics = TinyWhaleGrammar.createSemantics();

  // Extract PositionSpan from position node
  semantics.addOperation<PositionSpan>('toPosition', {
    position(_open, startCoords, _semi, endCoords, _close) {
      const [startLine, startCol] = parseCoords(startCoords.sourceString);
      const [endLine, endCol] = parseCoords(endCoords.sourceString);
      return { startLine, startCol, endLine, endCol };
    },
  });

  // Extract IndentToken from indent/dedent nodes
  semantics.addOperation<IndentToken>('toIndentToken', {
    indent(position, _marker) {
      return {
        type: 'indent',
        position: position.toPosition(),
      };
    },

    dedent(position, _marker) {
      return {
        type: 'dedent',
        position: position.toPosition(),
      };
    },

    indentToken(token) {
      return token.toIndentToken();
    },
  });

  // Extract array of IndentTokens
  semantics.addOperation<IndentToken[]>('toIndentTokens', {
    indentTokens(tokens) {
      return tokens.children.map(t => t.toIndentToken());
    },
  });

  // Extract content string
  semantics.addOperation<string>('toContent', {
    content(chars) {
      return this.sourceString;
    },
  });

  // Convert regularLine nodes to ParsedLine
  semantics.addOperation<ParsedLine | null>('toLine', {
    regularLine_withContent(indentTokens, content, _newline) {
      const tokens = indentTokens.toIndentTokens();
      const lineNum = tokens.length > 0
        ? tokens[0].position.startLine
        : getLineNumber(this);

      return {
        indentTokens: tokens,
        content: content.toContent(),
        lineNumber: lineNum,
      };
    },

    regularLine_blank(_newline) {
      return null;
    },
  });

  // Convert eofPart to ParsedLine (or null if empty)
  semantics.addOperation<ParsedLine | null>('toEofLine', {
    eofPart_indentAtEof(indentTokensIter, content) {
      const tokens = indentTokensIter.children.map(t => t.toIndentToken());
      const lineNum = tokens.length > 0
        ? tokens[0].position.startLine
        : getLineNumber(this);

      return {
        indentTokens: tokens,
        content: content.toContent(),
        lineNumber: lineNum,
      };
    },

    eofPart_contentAtEof(contentChars) {
      return {
        indentTokens: [],
        content: this.sourceString,
        lineNumber: getLineNumber(this),
      };
    },

    eofPart_empty() {
      return null;
    },
  });

  // Collect all lines from a Program
  semantics.addOperation<ParsedLine[]>('toLines', {
    program(regularLines, eofPart) {
      const lines: ParsedLine[] = regularLines.children
        .map(line => line.toLine())
        .filter((line): line is ParsedLine => line !== null);

      const eofLine = eofPart.toEofLine();
      if (eofLine !== null) {
        lines.push(eofLine);
      }

      return lines;
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
export type { PositionSpan as SourcePosition };
export type IndentInfo = IndentToken;
