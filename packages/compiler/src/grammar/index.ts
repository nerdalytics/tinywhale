import * as ohm from 'ohm-js'

/**
 * Represents a position in the source text.
 */
export interface Position {
	line: number
	level: number
}

/**
 * Represents an INDENT or DEDENT token with its position.
 */
export interface IndentToken {
	type: 'indent' | 'dedent'
	position: Position
}

/**
 * Base interface for all AST statement nodes.
 */
export interface StatementNode {
	type: string
	lineNumber: number
}

/**
 * Represents a panic statement in the AST.
 */
export interface PanicStatementNode extends StatementNode {
	type: 'panic'
}

/**
 * Union type for all statement types.
 */
export type Statement = PanicStatementNode

/**
 * Represents a parsed line from the preprocessed input.
 */
export interface ParsedLine {
	indentTokens: IndentToken[]
	lineNumber: number
	statement?: Statement
}

/**
 * Result of parsing a program.
 */
export interface ParseResult {
	lines: ParsedLine[]
	succeeded: boolean
	message?: string | undefined
}

/**
 * TinyWhale Grammar Source
 *
 * Token format from preprocessor:
 *   ⟨line,level⟩⇥ content   (INDENT - increase indent level)
 *   ⟨line,level⟩⇤           (DEDENT - decrease indent level)
 *
 * Comment syntax (treated as whitespace):
 *   # starts a comment, ends at next # or EOL
 *   Examples: `# full line`, `code # inline # code`
 */
const grammarSource = String.raw`
TinyWhale {
  Program (a program) = Line*
  Line (a line) = IndentedLine | DedentLine

  IndentedLine = indentToken Statement?
  DedentLine = dedentToken+ Statement?

  // Statements
  Statement = PanicStatement
  PanicStatement = panic

  // Keywords
  keyword = panic
  panic = "panic" ~identifierPart
  identifierPart = alnum | "_"

  // Lexical token rules
  indentToken = position "⇥"
  dedentToken = position "⇤"
  position (a position marker) = "⟨" digit+ "," digit+ "⟩"

  // Comments treated as whitespace (newlines already in built-in space)
  space += comment
  comment = "#" (~("#" | "\n" | "\r" | dedentToken) any)* ("#" | &"\n" | &"\r" | &dedentToken | end)
}
`

/**
 * The compiled TinyWhale grammar.
 */
export const TinyWhaleGrammar = ohm.grammar(grammarSource)

/**
 * Helper to get line number from a node's source position.
 */
function getLineNumber(node: ohm.Node): number {
	const interval = node.source
	const fullSource = interval.sourceString
	const textBefore = fullSource.substring(0, interval.startIdx)
	return (textBefore.match(/\n/g) || []).length + 1
}

/**
 * Create semantics for the TinyWhale grammar.
 */
export function createSemantics() {
	const semantics = TinyWhaleGrammar.createSemantics()

	// Extract Position from position node
	semantics.addOperation<Position>('toPosition', {
		position(_open, lineDigits, _comma, levelDigits, _close) {
			return {
				level: Number(levelDigits.sourceString),
				line: Number(lineDigits.sourceString),
			}
		},
	})

	// Extract IndentToken from indent/dedent nodes
	semantics.addOperation<IndentToken>('toIndentToken', {
		dedentToken(position, _marker) {
			return {
				position: position['toPosition'](),
				type: 'dedent',
			}
		},
		indentToken(position, _marker) {
			return {
				position: position['toPosition'](),
				type: 'indent',
			}
		},
	})

	// Extract Statement from statement nodes
	semantics.addOperation<Statement>('toStatement', {
		PanicStatement(_panicKeyword) {
			return {
				lineNumber: getLineNumber(this),
				type: 'panic',
			} as PanicStatementNode
		},
		Statement(stmt) {
			return stmt['toStatement']()
		},
	})

	// Convert line nodes to ParsedLine
	semantics.addOperation<ParsedLine>('toLine', {
		DedentLine(dedentTokens, optionalStatement) {
			const tokens: IndentToken[] = dedentTokens.children.map((t) => t['toIndentToken']())
			const firstToken = tokens[0]
			const stmtNode = optionalStatement.children[0]
			const statement = stmtNode !== undefined ? stmtNode['toStatement']() : undefined
			return {
				indentTokens: tokens,
				lineNumber: firstToken !== undefined ? firstToken.position.line : getLineNumber(this),
				statement,
			}
		},
		IndentedLine(indentToken, optionalStatement) {
			const token = indentToken['toIndentToken']()
			const stmtNode = optionalStatement.children[0]
			const statement = stmtNode !== undefined ? stmtNode['toStatement']() : undefined
			return {
				indentTokens: [token],
				lineNumber: token.position.line,
				statement,
			}
		},
	})

	// Collect all lines from a Program
	semantics.addOperation<ParsedLine[]>('toLines', {
		Program(lines) {
			return lines.children.map((line) => line['toLine']())
		},
	})

	return semantics
}

/**
 * Default semantics instance.
 */
export const semantics = createSemantics()

/**
 * Parse preprocessed input and return structured result.
 *
 * @param input - Preprocessed input string (with INDENT/DEDENT tokens)
 * @returns Parse result with lines and success status
 */
export function parse(input: string): ParseResult {
	const matchResult = TinyWhaleGrammar.match(input)

	if (matchResult.failed()) {
		return {
			lines: [],
			message: matchResult.message,
			succeeded: false,
		}
	}

	const lines = semantics(matchResult)['toLines']()

	return {
		lines,
		succeeded: true,
	}
}

/**
 * Match input against the grammar without extracting semantics.
 *
 * @param input - Preprocessed input string
 * @returns Ohm match result
 */
export function match(input: string): ohm.MatchResult {
	return TinyWhaleGrammar.match(input)
}

/**
 * Trace a parse for debugging purposes.
 *
 * @param input - Preprocessed input string
 * @returns Trace string
 */
export function trace(input: string): string {
	return TinyWhaleGrammar.trace(input).toString()
}

// Re-export for backwards compatibility
export type { Position as SourcePosition }
export type IndentInfo = IndentToken
