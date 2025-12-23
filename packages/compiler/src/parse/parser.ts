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

function tokenToOhmString(
	token: import('../core/tokens.ts').Token,
	context: CompilationContext
): string | null {
	switch (token.kind) {
		case TokenKind.Indent:
			return `⇥${token.payload}`
		case TokenKind.Dedent:
			return `⇤${token.payload}`
		case TokenKind.Panic:
			return 'panic'
		case TokenKind.I32:
			return 'i32'
		case TokenKind.I64:
			return 'i64'
		case TokenKind.F32:
			return 'f32'
		case TokenKind.F64:
			return 'f64'
		case TokenKind.Identifier:
			return context.strings.get(token.payload as import('../core/context.ts').StringId)
		case TokenKind.IntLiteral:
			return String(token.payload)
		case TokenKind.Colon:
			return ':'
		case TokenKind.Equals:
			return '='
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

		const str = tokenToOhmString(token, context)
		if (str !== null) parts.push(str, ' ')
	}

	return parts.join('')
}

interface TokenMapping {
	positionToToken: Map<string, TokenId>
	lineToFirstToken: Map<number, TokenId>
	/** Map from Ohm string position to token ID */
	ohmPositionToToken: Map<number, TokenId>
}

interface TokenMappingState {
	ohmPosition: number
	currentLine: number
}

function updateOhmPosition(
	token: import('../core/tokens.ts').Token,
	state: TokenMappingState,
	ohmPositionToToken: Map<number, TokenId>,
	id: TokenId,
	context: CompilationContext
): void {
	const newlineCount = token.line - state.currentLine
	state.ohmPosition += newlineCount
	state.currentLine = token.line

	const str = tokenToOhmString(token, context)
	if (str !== null) {
		ohmPositionToToken.set(state.ohmPosition, id)
		state.ohmPosition += str.length + 1
	}
}

function buildTokenMapping(context: CompilationContext): TokenMapping {
	const positionToToken = new Map<string, TokenId>()
	const lineToFirstToken = new Map<number, TokenId>()
	const ohmPositionToToken = new Map<number, TokenId>()
	const state: TokenMappingState = { currentLine: 1, ohmPosition: 0 }

	for (const [id, token] of context.tokens) {
		positionToToken.set(`${token.line}:${token.column}`, id)
		if (!lineToFirstToken.has(token.line)) {
			lineToFirstToken.set(token.line, id)
		}
		updateOhmPosition(token, state, ohmPositionToToken, id, context)
	}

	return { lineToFirstToken, ohmPositionToToken, positionToToken }
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

	function findClosestPosition(targetIdx: number): TokenId {
		const entries = Array.from(tokenMapping.ohmPositionToToken.entries())
		const valid = entries.filter(([pos]) => pos <= targetIdx)
		if (valid.length === 0) return tokenId(0)
		const closest = valid.reduce((a, b) => (a[0] > b[0] ? a : b))
		return closest[1]
	}

	function getTokenIdForOhmNode(node: Node): TokenId {
		return findClosestPosition(node.source.startIdx)
	}

	semantics.addOperation<number>('toLevel', {
		dedentToken(_marker: Node, levelDigits: Node) {
			return Number(levelDigits.sourceString)
		},
		indentToken(_marker: Node, levelDigits: Node) {
			return Number(levelDigits.sourceString)
		},
	})

	// Emit expression nodes (leaves in postorder)
	semantics.addOperation<NodeId>('emitExpression', {
		Expression(expr: Node): NodeId {
			return expr['emitExpression']()
		},
		identifier(_firstChar: Node, _restChars: Node): NodeId {
			const tid = getTokenIdForOhmNode(this)
			return context.nodes.add({
				kind: NodeKind.Identifier,
				subtreeSize: 1,
				tokenId: tid,
			})
		},
		intLiteral(_digits: Node): NodeId {
			const tid = getTokenIdForOhmNode(this)
			return context.nodes.add({
				kind: NodeKind.IntLiteral,
				subtreeSize: 1,
				tokenId: tid,
			})
		},
	})

	// Emit type annotation nodes
	semantics.addOperation<NodeId>('emitTypeAnnotation', {
		TypeAnnotation(_colon: Node, typeName: Node): NodeId {
			// Use the typeName's Ohm position to find the correct type keyword token
			const tid = getTokenIdForOhmNode(typeName)
			return context.nodes.add({
				kind: NodeKind.TypeAnnotation,
				subtreeSize: 1,
				tokenId: tid,
			})
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
		VariableBinding(ident: Node, typeAnnotation: Node, _equals: Node, expr: Node): NodeId {
			// Emit children first (postorder: children before parent)
			ident['emitExpression']()
			typeAnnotation['emitTypeAnnotation']()
			expr['emitExpression']()

			const lineNumber = getLineNumber(this)
			const tid = getTokenIdForLine(lineNumber)

			// subtreeSize = 1 (self) + 3 children
			return context.nodes.add({
				kind: NodeKind.VariableBinding,
				subtreeSize: 4,
				tokenId: tid,
			})
		},
	})

	semantics.addOperation<NodeId | null>('emitLine', {
		DedentLine(_dedentTokens: Node, optionalStatement: Node) {
			const lineNumber = getLineNumber(this)
			const startCount = context.nodes.count()

			const stmtNode = optionalStatement.children[0]
			if (stmtNode !== undefined) {
				stmtNode['emitStatement']()
			}

			const childCount = context.nodes.count() - startCount
			const subtreeSize = 1 + childCount

			const tid = getTokenIdForLine(lineNumber)
			return context.nodes.add({
				kind: NodeKind.DedentLine,
				subtreeSize,
				tokenId: tid,
			})
		},
		IndentedLine(_indentToken: Node, optionalStatement: Node) {
			const lineNumber = getLineNumber(this)
			const startCount = context.nodes.count()

			const stmtNode = optionalStatement.children[0]
			if (stmtNode !== undefined) {
				stmtNode['emitStatement']()
			}

			const childCount = context.nodes.count() - startCount
			const subtreeSize = 1 + childCount

			const tid = getTokenIdForLine(lineNumber)
			return context.nodes.add({
				kind: NodeKind.IndentedLine,
				subtreeSize,
				tokenId: tid,
			})
		},
		RootLine(statement: Node) {
			const startCount = context.nodes.count()
			statement['emitStatement']()
			const childCount = context.nodes.count() - startCount

			const lineNumber = getLineNumber(this)
			const tid = getTokenIdForLine(lineNumber)

			return context.nodes.add({
				kind: NodeKind.RootLine,
				subtreeSize: 1 + childCount,
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
