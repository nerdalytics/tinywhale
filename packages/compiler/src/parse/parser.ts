/**
 * Parser that bridges TokenStore to Ohm.js and emits to NodeStore.
 * Keeps Ohm.js for grammar definition while adopting data-oriented output.
 */

import type { Node } from 'ohm-js'
import type { CompilationContext } from '../core/context.ts'
import { type NodeId, NodeKind } from '../core/nodes.ts'
import { type TokenId, TokenKind, tokenId } from '../core/tokens.ts'
import type { TinyWhaleSemantics } from './tinywhale.ohm-bundle.js'
import TinyWhaleGrammar from './tinywhale.ohm-bundle.js'

/**
 * Result of parsing.
 */
export interface ParseResult {
	succeeded: boolean
	rootNode?: NodeId
}

/**
 * Convert a single token to its Ohm string representation.
 */
function tokenToOhmString(token: import('../core/tokens.ts').Token): string | null {
	switch (token.kind) {
		case TokenKind.Indent:
			return `⇥${token.payload}`
		case TokenKind.Dedent:
			return `⇤${token.payload}`
		case TokenKind.Panic:
			return 'panic'
		default:
			return null
	}
}

/**
 * Generates newline characters to reach a target line.
 */
function generateNewlines(currentLine: number, targetLine: number): string {
	return '\n'.repeat(Math.max(0, targetLine - currentLine))
}

/**
 * Converts TokenStore to the string format Ohm.js expects.
 * This bridges between our data-oriented tokens and Ohm's string-based parsing.
 */
function tokensToOhmInput(context: CompilationContext): string {
	const parts: string[] = []
	let currentLine = 1

	for (const [, token] of context.tokens) {
		parts.push(generateNewlines(currentLine, token.line))
		currentLine = token.line

		const str = tokenToOhmString(token)
		if (str !== null) parts.push(str)
	}

	return parts.join('')
}

/**
 * Maps source positions to token IDs.
 * Used to associate parsed nodes with their source tokens.
 */
interface TokenMapping {
	/** Maps (line, column) to TokenId */
	positionToToken: Map<string, TokenId>
	/** Maps line number to first token on that line */
	lineToFirstToken: Map<number, TokenId>
}

/**
 * Builds a mapping from source positions to token IDs.
 */
function buildTokenMapping(context: CompilationContext): TokenMapping {
	const positionToToken = new Map<string, TokenId>()
	const lineToFirstToken = new Map<number, TokenId>()

	for (const [id, token] of context.tokens) {
		const key = `${token.line}:${token.column}`
		positionToToken.set(key, id)

		if (!lineToFirstToken.has(token.line)) {
			lineToFirstToken.set(token.line, id)
		}
	}

	return { lineToFirstToken, positionToToken }
}

/**
 * Creates semantics that emit to NodeStore.
 */
function createNodeEmittingSemantics(
	context: CompilationContext,
	tokenMapping: TokenMapping
): TinyWhaleSemantics {
	const semantics = TinyWhaleGrammar.createSemantics()

	/**
	 * Helper to get line number from a node's source position.
	 */
	function getLineNumber(node: Node): number {
		const interval = node.source
		const fullSource = interval.sourceString
		const textBefore = fullSource.substring(0, interval.startIdx)
		return (textBefore.match(/\n/g) || []).length + 1
	}

	/**
	 * Helper to find token ID for a line.
	 */
	function getTokenIdForLine(lineNumber: number): TokenId {
		return tokenMapping.lineToFirstToken.get(lineNumber) ?? tokenId(0)
	}

	// Extract indent level from indent/dedent tokens
	semantics.addOperation<number>('toLevel', {
		dedentToken(_marker: Node, levelDigits: Node) {
			return Number(levelDigits.sourceString)
		},
		indentToken(_marker: Node, levelDigits: Node) {
			return Number(levelDigits.sourceString)
		},
	})

	// Emit statement nodes to NodeStore, return NodeId
	semantics.addOperation<NodeId>('emitStatement', {
		PanicStatement(_panicKeyword: Node): NodeId {
			const lineNumber = getLineNumber(this)
			const tid = getTokenIdForLine(lineNumber)

			return context.nodes.add({
				kind: NodeKind.PanicStatement,
				subtreeSize: 1,
				tokenId: tid,
			})
		},
		Statement(stmt: Node): NodeId {
			return stmt['emitStatement']()
		},
	})

	// Emit line nodes to NodeStore, return NodeId
	// Lines contain their statements as children (in postorder, statement comes first)
	semantics.addOperation<NodeId | null>('emitLine', {
		DedentLine(_dedentTokens: Node, optionalStatement: Node) {
			const lineNumber = getLineNumber(this)

			// Emit statement first (if any) - postorder
			const stmtNode = optionalStatement.children[0]
			let subtreeSize = 1
			if (stmtNode !== undefined) {
				stmtNode['emitStatement']()
				subtreeSize = 2 // self + statement
			}

			const tid = getTokenIdForLine(lineNumber)
			return context.nodes.add({
				kind: NodeKind.DedentLine,
				subtreeSize,
				tokenId: tid,
			})
		},
		IndentedLine(_indentToken: Node, optionalStatement: Node) {
			const lineNumber = getLineNumber(this)

			// Emit statement first (if any) - postorder
			const stmtNode = optionalStatement.children[0]
			let subtreeSize = 1
			if (stmtNode !== undefined) {
				stmtNode['emitStatement']()
				subtreeSize = 2
			}

			const tid = getTokenIdForLine(lineNumber)
			return context.nodes.add({
				kind: NodeKind.IndentedLine,
				subtreeSize,
				tokenId: tid,
			})
		},
		RootLine(statement: Node) {
			// Emit statement first - postorder
			statement['emitStatement']()

			const lineNumber = getLineNumber(this)
			const tid = getTokenIdForLine(lineNumber)

			return context.nodes.add({
				kind: NodeKind.RootLine,
				subtreeSize: 2, // self + statement
				tokenId: tid,
			})
		},
	})

	// Emit program node, return NodeId
	semantics.addOperation<NodeId>('emitProgram', {
		Program(lines: Node) {
			const startCount = context.nodes.count()

			// Emit all lines (children first in postorder)
			for (const line of lines.children) {
				line['emitLine']()
			}

			const childCount = context.nodes.count() - startCount
			const subtreeSize = childCount + 1 // children + self

			// Use first token or create a synthetic one
			const tid = context.tokens.count() > 0 ? tokenId(0) : tokenId(0)

			return context.nodes.add({
				kind: NodeKind.Program,
				subtreeSize,
				tokenId: tid,
			})
		},
	})

	return semantics
}

/**
 * Parses tokens from context.tokens and populates context.nodes.
 *
 * @param context - Compilation context with populated tokens
 * @returns Parse result with success status and root node ID
 */
export function parse(context: CompilationContext): ParseResult {
	// Convert tokens to Ohm input format
	const ohmInput = tokensToOhmInput(context)

	// Match against grammar
	const matchResult = TinyWhaleGrammar.match(ohmInput)

	if (matchResult.failed()) {
		context.addError(1, 1, matchResult.message ?? 'Parse error')
		return {
			succeeded: false,
		}
	}

	// Build token mapping for associating nodes with tokens
	const tokenMapping = buildTokenMapping(context)

	// Create semantics and emit nodes
	const semantics = createNodeEmittingSemantics(context, tokenMapping)
	const rootNode = semantics(matchResult)['emitProgram']() as NodeId

	return {
		rootNode,
		succeeded: true,
	}
}

/**
 * Match input against the grammar without emitting nodes.
 * Useful for syntax checking.
 */
export function matchOnly(context: CompilationContext): boolean {
	const ohmInput = tokensToOhmInput(context)
	const matchResult = TinyWhaleGrammar.match(ohmInput)
	return matchResult.succeeded()
}
