import type { Node } from 'ohm-js'
import type { CompilationContext } from '../core/context.ts'
import type { DiagnosticCode } from '../core/diagnostics.ts'
import { type NodeId, NodeKind } from '../core/nodes.ts'
import { type TokenId, TokenKind, tokenId } from '../core/tokens.ts'
import type { TinyWhaleSemantics } from './tinywhale.ohm-bundle.js'
import TinyWhaleGrammar from './tinywhale.ohm-bundle.js'

export interface ParseResult {
	succeeded: boolean
	rootNode?: NodeId
}

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

function generateNewlines(currentLine: number, targetLine: number): string {
	return '\n'.repeat(Math.max(0, targetLine - currentLine))
}

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

interface TokenMapping {
	positionToToken: Map<string, TokenId>
	lineToFirstToken: Map<number, TokenId>
}

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

function createNodeEmittingSemantics(
	context: CompilationContext,
	tokenMapping: TokenMapping
): TinyWhaleSemantics {
	const semantics = TinyWhaleGrammar.createSemantics()

	function getLineNumber(node: Node): number {
		const interval = node.source
		const fullSource = interval.sourceString
		const textBefore = fullSource.substring(0, interval.startIdx)
		return (textBefore.match(/\n/g) || []).length + 1
	}

	function getTokenIdForLine(lineNumber: number): TokenId {
		return tokenMapping.lineToFirstToken.get(lineNumber) ?? tokenId(0)
	}

	semantics.addOperation<number>('toLevel', {
		dedentToken(_marker: Node, levelDigits: Node) {
			return Number(levelDigits.sourceString)
		},
		indentToken(_marker: Node, levelDigits: Node) {
			return Number(levelDigits.sourceString)
		},
	})

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

	semantics.addOperation<NodeId | null>('emitLine', {
		DedentLine(_dedentTokens: Node, optionalStatement: Node) {
			const lineNumber = getLineNumber(this)

			const stmtNode = optionalStatement.children[0]
			let subtreeSize = 1
			if (stmtNode !== undefined) {
				stmtNode['emitStatement']()
				subtreeSize = 2
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
			statement['emitStatement']()

			const lineNumber = getLineNumber(this)
			const tid = getTokenIdForLine(lineNumber)

			return context.nodes.add({
				kind: NodeKind.RootLine,
				subtreeSize: 2,
				tokenId: tid,
			})
		},
	})

	semantics.addOperation<NodeId>('emitProgram', {
		Program(lines: Node) {
			const startCount = context.nodes.count()

			for (const line of lines.children) {
				line['emitLine']()
			}

			const childCount = context.nodes.count() - startCount
			const subtreeSize = childCount + 1

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

/** Parses tokens from context.tokens and populates context.nodes. */
export function parse(context: CompilationContext): ParseResult {
	const ohmInput = tokensToOhmInput(context)
	const matchResult = TinyWhaleGrammar.match(ohmInput)

	if (matchResult.failed()) {
		context.emit('TWPARSE001' as DiagnosticCode, 1, 1, {
			detail: matchResult.message ?? 'unexpected input',
		})
		return {
			succeeded: false,
		}
	}

	const tokenMapping = buildTokenMapping(context)
	const semantics = createNodeEmittingSemantics(context, tokenMapping)
	const rootNode = semantics(matchResult)['emitProgram']() as NodeId

	return {
		rootNode,
		succeeded: true,
	}
}

export function matchOnly(context: CompilationContext): boolean {
	const ohmInput = tokensToOhmInput(context)
	const matchResult = TinyWhaleGrammar.match(ohmInput)
	return matchResult.succeeded()
}
