import type { Node } from 'ohm-js'
import type { CompilationContext, StringId } from '../core/context.ts'
import type { DiagnosticCode } from '../core/diagnostics.ts'
import { type NodeId, NodeKind } from '../core/nodes.ts'
import { type Token, type TokenId, TokenKind, tokenId } from '../core/tokens.ts'
import type { TinyWhaleSemantics } from './tinywhale.ohm-bundle.js'
import TinyWhaleGrammar from './tinywhale.ohm-bundle.js'

export interface ParseResult {
	succeeded: boolean
	rootNode?: NodeId
}

function tokenToOhmString(token: Token, context: CompilationContext): string | null {
	switch (token.kind) {
		case TokenKind.Indent:
			return `⇥${token.payload}`
		case TokenKind.Dedent:
			return `⇤${token.payload}`
		case TokenKind.Panic:
			return 'panic'
		case TokenKind.Match:
			return 'match'
		case TokenKind.Type:
			return 'type'
		case TokenKind.I32:
			return 'i32'
		case TokenKind.I64:
			return 'i64'
		case TokenKind.F32:
			return 'f32'
		case TokenKind.F64:
			return 'f64'
		case TokenKind.Identifier:
			return context.strings.get(token.payload as StringId)
		case TokenKind.IntLiteral:
			return context.strings.get(token.payload as StringId)
		case TokenKind.FloatLiteral:
			return context.strings.get(token.payload as StringId)
		case TokenKind.Colon:
			return ':'
		case TokenKind.Equals:
			return '='
		case TokenKind.Minus:
			return '-'
		case TokenKind.Arrow:
			return '->'
		case TokenKind.Underscore:
			return '_'
		case TokenKind.Pipe:
			return '|'
		case TokenKind.Plus:
			return '+'
		case TokenKind.Star:
			return '*'
		case TokenKind.Slash:
			return '/'
		case TokenKind.Percent:
			return '%'
		case TokenKind.PercentPercent:
			return '%%'
		case TokenKind.Ampersand:
			return '&'
		case TokenKind.Caret:
			return '^'
		case TokenKind.Tilde:
			return '~'
		case TokenKind.LessThan:
			return '<'
		case TokenKind.GreaterThan:
			return '>'
		case TokenKind.LessEqual:
			return '<='
		case TokenKind.GreaterEqual:
			return '>='
		case TokenKind.EqualEqual:
			return '=='
		case TokenKind.BangEqual:
			return '!='
		case TokenKind.LessLess:
			return '<<'
		case TokenKind.GreaterGreater:
			return '>>'
		case TokenKind.GreaterGreaterGreater:
			return '>>>'
		case TokenKind.AmpersandAmpersand:
			return '&&'
		case TokenKind.PipePipe:
			return '||'
		case TokenKind.LParen:
			return '('
		case TokenKind.RParen:
			return ')'
		case TokenKind.Dot:
			return '.'
		case TokenKind.Bang:
			return '!'
		case TokenKind.LBracket:
			return '['
		case TokenKind.RBracket:
			return ']'
		case TokenKind.Comma:
			return ','
		default:
			return null
	}
}

function generateNewlines(currentLine: number, targetLine: number): string {
	return '\n'.repeat(Math.max(0, targetLine - currentLine))
}

function needsSyntheticNewline(
	token: Token,
	currentLine: number,
	prevTokenKind: number | null
): boolean {
	if (token.kind !== TokenKind.Dedent) return false
	if (token.line !== currentLine) return false
	if (prevTokenKind === null) return false
	// Don't insert newline if previous token was Indent or Dedent
	// (these go together: IndentedLine = indentToken anyDedent* IndentedContent?)
	return prevTokenKind !== TokenKind.Indent && prevTokenKind !== TokenKind.Dedent
}

interface TokenProcessingState {
	parts: string[]
	currentLine: number
	prevTokenKind: number | null
}

function processToken(
	token: Token,
	state: TokenProcessingState,
	context: CompilationContext
): void {
	if (needsSyntheticNewline(token, state.currentLine, state.prevTokenKind)) {
		state.parts.push('\n')
		state.currentLine++
	}
	state.parts.push(generateNewlines(state.currentLine, token.line))
	state.currentLine = token.line
	const str = tokenToOhmString(token, context)
	if (str !== null) {
		state.parts.push(str, ' ')
		state.prevTokenKind = token.kind
	}
}

export function tokensToOhmInput(context: CompilationContext): string {
	const state: TokenProcessingState = { currentLine: 1, parts: [], prevTokenKind: null }
	for (const [, token] of context.tokens) {
		processToken(token, state, context)
	}
	return state.parts.join('')
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
	token: Token,
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
		anyDedent(dedent: Node) {
			return dedent['toLevel']()
		},
		dedentNonZero(_marker: Node, firstDigit: Node, restDigits: Node) {
			return Number(firstDigit.sourceString + restDigits.sourceString)
		},
		dedentZero(_marker: Node) {
			return 0
		},
		indentToken(_marker: Node, levelDigits: Node) {
			return Number(levelDigits.sourceString)
		},
	})

	function emitBinaryNode(leftId: NodeId, opNode: Node, restNode: Node): NodeId {
		const rightId = restNode['emitExpression']() as NodeId
		const opTid = getTokenIdForOhmNode(opNode)
		const leftSize = context.nodes.get(leftId).subtreeSize
		const rightSize = context.nodes.get(rightId).subtreeSize
		return context.nodes.add({
			kind: NodeKind.BinaryExpr,
			subtreeSize: 1 + leftSize + rightSize,
			tokenId: opTid,
		})
	}

	function emitBinaryChain(first: Node, ops: Node, rest: Node): NodeId {
		let leftId = first['emitExpression']() as NodeId
		for (let i = 0; i < ops.numChildren; i++) {
			leftId = emitBinaryNode(leftId, ops.child(i), rest.child(i))
		}
		return leftId
	}

	function emitCompareChain(first: Node, ops: Node, rest: Node): NodeId {
		const startCount = context.nodes.count()
		first['emitExpression']()
		for (let i = 0; i < rest.numChildren; i++) {
			rest.child(i)['emitExpression']()
		}
		const childCount = context.nodes.count() - startCount
		const opTid = getTokenIdForOhmNode(ops.child(0))
		return context.nodes.add({
			kind: NodeKind.CompareChain,
			subtreeSize: 1 + childCount,
			tokenId: opTid,
		})
	}

	function isListTypeRef(typeNode: Node): boolean {
		if (typeNode.ctorName !== 'TypeRef') return false
		return typeNode.child(0).ctorName === 'ListType'
	}

	function isRefinementTypeRef(typeNode: Node): boolean {
		if (typeNode.ctorName !== 'TypeRef') return false
		return typeNode.child(0).ctorName === 'RefinementType'
	}

	function isFuncTypeRef(typeNode: Node): boolean {
		if (typeNode.ctorName !== 'TypeRef') return false
		return typeNode.child(0).ctorName === 'FuncType'
	}

	function maybeEmitComplexType(typeNode: Node): void {
		if (isListTypeRef(typeNode)) {
			typeNode.child(0)['emitTypeAnnotation']()
		} else if (isRefinementTypeRef(typeNode)) {
			typeNode.child(0)['emitTypeAnnotation']()
		} else if (isFuncTypeRef(typeNode)) {
			typeNode.child(0)['emitTypeAnnotation']()
		}
	}

	/**
	 * Emit a TypeAnnotation node for any TypeRef (simple or complex).
	 * For complex types (ListType, RefinementType, FuncType), emits the complex type as child.
	 * For simple types (typeKeyword, upperIdentifier), emits just the TypeAnnotation with the token.
	 */
	function emitTypeRefAsTypeAnnotation(typeNode: Node): NodeId {
		const startCount = context.nodes.count()
		maybeEmitComplexType(typeNode)
		const childCount = context.nodes.count() - startCount

		// Get token from the type node - for TypeRef, get from its child
		const typeChild = typeNode.ctorName === 'TypeRef' ? typeNode.child(0) : typeNode
		const tid = getTokenIdForOhmNode(typeChild)
		return context.nodes.add({
			kind: NodeKind.TypeAnnotation,
			subtreeSize: 1 + childCount,
			tokenId: tid,
		})
	}

	semantics.addOperation<NodeId>('emitExpression', {
		AddExpr(first: Node, ops: Node, rest: Node): NodeId {
			return emitBinaryChain(first, ops, rest)
		},
		BitwiseAndExpr(first: Node, ops: Node, rest: Node): NodeId {
			return emitBinaryChain(first, ops, rest)
		},
		BitwiseOrExpr(first: Node, ops: Node, rest: Node): NodeId {
			return emitBinaryChain(first, ops, rest)
		},
		BitwiseXorExpr(first: Node, ops: Node, rest: Node): NodeId {
			return emitBinaryChain(first, ops, rest)
		},
		CompareExpr(first: Node, ops: Node, rest: Node): NodeId {
			if (ops.numChildren === 0) return first['emitExpression']()
			if (ops.numChildren === 1) return emitBinaryChain(first, ops, rest)
			return emitCompareChain(first, ops, rest)
		},
		Expression(expr: Node): NodeId {
			return expr['emitExpression']()
		},
		FieldAccess(base: Node, _dots: Node, fields: Node): NodeId {
			let currentId = base['emitExpression']() as NodeId

			for (let i = 0; i < fields.numChildren; i++) {
				const fieldNode = fields.child(i)
				const tid = getTokenIdForOhmNode(fieldNode)
				const baseSize = context.nodes.get(currentId).subtreeSize
				currentId = context.nodes.add({
					kind: NodeKind.FieldAccess,
					subtreeSize: 1 + baseSize,
					tokenId: tid,
				})
			}
			return currentId
		},
		floatLiteral(
			_intPart: Node,
			_dot: Node,
			_fracPart: Node,
			_expE: Node,
			_expSign: Node,
			_expDigits: Node
		): NodeId {
			const tid = getTokenIdForOhmNode(this)
			return context.nodes.add({
				kind: NodeKind.FloatLiteral,
				subtreeSize: 1,
				tokenId: tid,
			})
		},
		FuncCall(base: Node, _lparen: Node, optArgList: Node, _rparen: Node): NodeId {
			const startCount = context.nodes.count()
			base['emitExpression']()
			// Emit argument list if present
			const argListNode = optArgList.children[0]
			if (argListNode !== undefined) {
				// ArgumentList = Expression (comma Expression)*
				const firstArg = argListNode.child(0)
				firstArg['emitExpression']()
				const restArgs = argListNode.child(2)
				for (let i = 0; i < restArgs.numChildren; i++) {
					restArgs.child(i)['emitExpression']()
				}
			}
			const childCount = context.nodes.count() - startCount

			const tid = getTokenIdForOhmNode(this)
			return context.nodes.add({
				kind: NodeKind.FuncCall,
				subtreeSize: 1 + childCount,
				tokenId: tid,
			})
		},
		IndexAccess(base: Node, _lbrackets: Node, indices: Node, _rbrackets: Node): NodeId {
			let currentId = base['emitExpression']() as NodeId

			for (let i = 0; i < indices.numChildren; i++) {
				const indexNode = indices.child(i)
				indexNode['emitExpression']()
				const tid = getTokenIdForOhmNode(indexNode)
				const baseSize = context.nodes.get(currentId).subtreeSize
				currentId = context.nodes.add({
					kind: NodeKind.IndexAccess,
					subtreeSize: 1 + baseSize + 1,
					tokenId: tid,
				})
			}
			return currentId
		},
		identifier(_firstChar: Node, _restChars: Node): NodeId {
			const tid = getTokenIdForOhmNode(this)
			return context.nodes.add({
				kind: NodeKind.Identifier,
				subtreeSize: 1,
				tokenId: tid,
			})
		},
		intLiteral(_digits: Node, _expE: Node, _expSign: Node, _expDigits: Node): NodeId {
			const tid = getTokenIdForOhmNode(this)
			return context.nodes.add({
				kind: NodeKind.IntLiteral,
				subtreeSize: 1,
				tokenId: tid,
			})
		},
		ListLiteral(_lbracket: Node, elements: Node, _rbracket: Node): NodeId {
			const startCount = context.nodes.count()
			const firstExpr = elements.child(0)
			firstExpr['emitExpression']()
			const restExprs = elements.child(2)
			for (let i = 0; i < restExprs.numChildren; i++) {
				restExprs.child(i)['emitExpression']()
			}
			const childCount = context.nodes.count() - startCount

			const tid = getTokenIdForOhmNode(this)
			return context.nodes.add({
				kind: NodeKind.ListLiteral,
				subtreeSize: 1 + childCount,
				tokenId: tid,
			})
		},
		LogicalAndExpr(first: Node, ops: Node, rest: Node): NodeId {
			return emitBinaryChain(first, ops, rest)
		},
		LogicalOrExpr(first: Node, ops: Node, rest: Node): NodeId {
			return emitBinaryChain(first, ops, rest)
		},
		MulExpr(first: Node, ops: Node, rest: Node): NodeId {
			return emitBinaryChain(first, ops, rest)
		},
		PostfixableBase(expr: Node): NodeId {
			return expr['emitExpression']()
		},
		PostfixExpr(expr: Node): NodeId {
			return expr['emitExpression']()
		},
		PostfixIndexBase(expr: Node): NodeId {
			return expr['emitExpression']()
		},
		PrimaryExpr_paren(_lparen: Node, expr: Node, _rparen: Node): NodeId {
			const childId = expr['emitExpression']() as NodeId
			const tid = getTokenIdForOhmNode(this)
			const childSize = context.nodes.get(childId).subtreeSize
			return context.nodes.add({
				kind: NodeKind.ParenExpr,
				subtreeSize: 1 + childSize,
				tokenId: tid,
			})
		},
		UnaryExpr_primary(expr: Node): NodeId {
			return expr['emitExpression']()
		},
		UnaryExpr_unary(op: Node, expr: Node): NodeId {
			const childId = expr['emitExpression']() as NodeId
			const tid = getTokenIdForOhmNode(op)
			const childSize = context.nodes.get(childId).subtreeSize
			return context.nodes.add({
				kind: NodeKind.UnaryExpr,
				subtreeSize: 1 + childSize,
				tokenId: tid,
			})
		},
	})

	semantics.addOperation<NodeId>('emitTypeAnnotation', {
		Bound(_keyword: Node, _equals: Node, _optMinus: Node, value: Node): NodeId {
			// Store the value token - this allows extracting the numeric value
			// The keyword type (min/max/size) can be determined from context
			// (for list size bounds, we just need the value)
			const valueTid = getTokenIdForOhmNode(value)
			return context.nodes.add({
				kind: NodeKind.Bound,
				subtreeSize: 1,
				tokenId: valueTid,
			})
		},
		FuncType(_lparen: Node, optTypeList: Node, _rparen: Node, _arrow: Node, returnType: Node): NodeId {
			const startCount = context.nodes.count()

			// Emit parameter types wrapped in TypeList if present
			const typeListNode = optTypeList.children[0]
			if (typeListNode !== undefined) {
				const typeListStartCount = context.nodes.count()
				// TypeList = TypeRef (comma TypeRef)*
				const firstType = typeListNode.child(0)
				emitTypeRefAsTypeAnnotation(firstType)
				const restTypes = typeListNode.child(2)
				for (let i = 0; i < restTypes.numChildren; i++) {
					emitTypeRefAsTypeAnnotation(restTypes.child(i))
				}
				const typeListChildCount = context.nodes.count() - typeListStartCount
				const typeListTid = getTokenIdForOhmNode(typeListNode)
				context.nodes.add({
					kind: NodeKind.TypeList,
					subtreeSize: 1 + typeListChildCount,
					tokenId: typeListTid,
				})
			}

			// Emit return type as TypeAnnotation
			emitTypeRefAsTypeAnnotation(returnType)

			const childCount = context.nodes.count() - startCount
			const tid = getTokenIdForOhmNode(this)
			return context.nodes.add({
				kind: NodeKind.FuncType,
				subtreeSize: 1 + childCount,
				tokenId: tid,
			})
		},
		ListType(elementType: Node, suffixes: Node): NodeId {
			const startCount = context.nodes.count()
			// Handle bounded primitives as base element type
			if (elementType.ctorName === 'RefinementType') {
				elementType['emitTypeAnnotation']()
			}
			// Emit each list type suffix (each is []<size=N>)
			for (let i = 0; i < suffixes.numChildren; i++) {
				suffixes.child(i)['emitTypeAnnotation']()
			}
			const childCount = context.nodes.count() - startCount

			const tid = getTokenIdForOhmNode(this)
			return context.nodes.add({
				kind: NodeKind.ListType,
				subtreeSize: 1 + childCount,
				tokenId: tid,
			})
		},
		ListTypeSuffix(_lbracket: Node, _rbracket: Node, typeBounds: Node): NodeId {
			return typeBounds['emitTypeAnnotation']()
		},
		RefinementType(_typeKeyword: Node, typeBounds: Node): NodeId {
			const startCount = context.nodes.count()
			typeBounds['emitTypeAnnotation']()
			const childCount = context.nodes.count() - startCount

			const tid = getTokenIdForOhmNode(this)
			return context.nodes.add({
				kind: NodeKind.RefinementType,
				subtreeSize: 1 + childCount,
				tokenId: tid,
			})
		},
		TypeAnnotation(_colon: Node, typeRef: Node): NodeId {
			const startCount = context.nodes.count()
			maybeEmitComplexType(typeRef)
			const childCount = context.nodes.count() - startCount

			const tid = getTokenIdForOhmNode(typeRef)
			return context.nodes.add({
				kind: NodeKind.TypeAnnotation,
				subtreeSize: 1 + childCount,
				tokenId: tid,
			})
		},
		TypeBounds(_lessThan: Node, boundList: Node, _greaterThan: Node): NodeId {
			const startCount = context.nodes.count()
			boundList.child(0)['emitTypeAnnotation']()
			const restBounds = boundList.child(2)
			for (let i = 0; i < restBounds.numChildren; i++) {
				restBounds.child(i)['emitTypeAnnotation']()
			}
			const childCount = context.nodes.count() - startCount

			const tid = getTokenIdForOhmNode(this)
			return context.nodes.add({
				kind: NodeKind.TypeBounds,
				subtreeSize: 1 + childCount,
				tokenId: tid,
			})
		},
	})

	semantics.addOperation<NodeId>('emitPattern', {
		BindingPattern(ident: Node): NodeId {
			const tid = getTokenIdForOhmNode(ident)
			return context.nodes.add({
				kind: NodeKind.BindingPattern,
				subtreeSize: 1,
				tokenId: tid,
			})
		},
		LiteralPattern(_optMinus: Node, _lit: Node): NodeId {
			const tid = getTokenIdForOhmNode(this)
			return context.nodes.add({
				kind: NodeKind.LiteralPattern,
				subtreeSize: 1,
				tokenId: tid,
			})
		},
		OrPattern(first: Node, _pipes: Node, rest: Node): NodeId {
			const startCount = context.nodes.count()
			first['emitPattern']()
			for (const child of rest.children) {
				child['emitPattern']()
			}
			const childCount = context.nodes.count() - startCount

			if (childCount === 1) {
				return startCount as NodeId
			}

			const tid = getTokenIdForOhmNode(this)
			return context.nodes.add({
				kind: NodeKind.OrPattern,
				subtreeSize: 1 + childCount,
				tokenId: tid,
			})
		},
		Pattern(orPattern: Node): NodeId {
			return orPattern['emitPattern']()
		},
		PrimaryPattern(pattern: Node): NodeId {
			return pattern['emitPattern']()
		},
		WildcardPattern(_underscore: Node): NodeId {
			const tid = getTokenIdForOhmNode(this)
			return context.nodes.add({
				kind: NodeKind.WildcardPattern,
				subtreeSize: 1,
				tokenId: tid,
			})
		},
	})

	semantics.addOperation<NodeId>('emitLambda', {
		Lambda(_lparen: Node, optParamList: Node, _rparen: Node, _optColon: Node, optReturnType: Node, _arrow: Node, body: Node): NodeId {
			const startCount = context.nodes.count()

			// Emit parameter list if present
			const paramListNode = optParamList.children[0]
			if (paramListNode !== undefined) {
				// ParameterList = Parameter (comma Parameter)*
				const firstParam = paramListNode.child(0)
				firstParam['emitLambda']()
				const restParams = paramListNode.child(2)
				for (let i = 0; i < restParams.numChildren; i++) {
					restParams.child(i)['emitLambda']()
				}
			}

			// Emit return type annotation if present
			// optReturnType is TypeRef? (the colon is separate)
			const returnTypeNode = optReturnType.children[0]
			if (returnTypeNode !== undefined) {
				const typeStartCount = context.nodes.count()
				maybeEmitComplexType(returnTypeNode)
				const typeChildCount = context.nodes.count() - typeStartCount
				const tid = getTokenIdForOhmNode(returnTypeNode)
				context.nodes.add({
					kind: NodeKind.TypeAnnotation,
					subtreeSize: 1 + typeChildCount,
					tokenId: tid,
				})
			}

			// Emit body expression - LambdaBody = Expression
			const bodyExpr = body.child(0)
			bodyExpr['emitExpression']()

			const childCount = context.nodes.count() - startCount
			const tid = getTokenIdForOhmNode(this)

			return context.nodes.add({
				kind: NodeKind.Lambda,
				subtreeSize: 1 + childCount,
				tokenId: tid,
			})
		},
		Parameter(ident: Node, _colon: Node, typeRef: Node): NodeId {
			const startCount = context.nodes.count()
			ident['emitExpression']()
			const typeStartCount = context.nodes.count()
			maybeEmitComplexType(typeRef)
			const typeChildCount = context.nodes.count() - typeStartCount

			const tid = getTokenIdForOhmNode(typeRef)
			context.nodes.add({
				kind: NodeKind.TypeAnnotation,
				subtreeSize: 1 + typeChildCount,
				tokenId: tid,
			})

			const childCount = context.nodes.count() - startCount
			const paramTid = getTokenIdForOhmNode(ident)

			return context.nodes.add({
				kind: NodeKind.Parameter,
				subtreeSize: 1 + childCount,
				tokenId: paramTid,
			})
		},
	})

	semantics.addOperation<NodeId>('emitMatchArm', {
		MatchArm(pattern: Node, _arrow: Node, expr: Node): NodeId {
			const startCount = context.nodes.count()
			pattern['emitPattern']()
			expr['emitExpression']()
			const childCount = context.nodes.count() - startCount

			const tid = getTokenIdForOhmNode(this)
			return context.nodes.add({
				kind: NodeKind.MatchArm,
				subtreeSize: 1 + childCount,
				tokenId: tid,
			})
		},
	})

	semantics.addOperation<NodeId>('emitIndentedContent', {
		FieldDecl(fieldName: Node, _colon: Node, typeRef: Node): NodeId {
			const startCount = context.nodes.count()

			// Emit complex type children (RefinementType or ListType) if present
			const innerType = typeRef.child(0)
			if (innerType.ctorName === 'ListType' || innerType.ctorName === 'RefinementType') {
				innerType['emitTypeAnnotation']()
			}

			const childCount = context.nodes.count() - startCount
			const tid = getTokenIdForOhmNode(fieldName)
			return context.nodes.add({
				kind: NodeKind.FieldDecl,
				subtreeSize: 1 + childCount,
				tokenId: tid,
			})
		},
		FieldInit(fieldName: Node, _equals: Node, expression: Node): NodeId {
			const startCount = context.nodes.count()
			expression['emitExpression']()
			const childCount = context.nodes.count() - startCount

			const tid = getTokenIdForOhmNode(fieldName)
			return context.nodes.add({
				kind: NodeKind.FieldInit,
				subtreeSize: 1 + childCount,
				tokenId: tid,
			})
		},
		IndentedContent(content: Node): NodeId {
			const routeMap: Record<string, string> = {
				FieldDecl: 'emitIndentedContent',
				FieldInit: 'emitIndentedContent',
				MatchArm: 'emitMatchArm',
			}
			const operation = routeMap[content.ctorName] ?? 'emitStatement'
			return content[operation]()
		},
		MatchArm(pattern: Node, _arrow: Node, expr: Node): NodeId {
			const startCount = context.nodes.count()
			pattern['emitPattern']()
			expr['emitExpression']()
			const childCount = context.nodes.count() - startCount

			const tid = getTokenIdForOhmNode(this)
			return context.nodes.add({
				kind: NodeKind.MatchArm,
				subtreeSize: 1 + childCount,
				tokenId: tid,
			})
		},
	})

	semantics.addOperation<NodeId>('emitStatement', {
		FuncBinding(ident: Node, _equals: Node, lambda: Node): NodeId {
			const startCount = context.nodes.count()
			ident['emitExpression']()
			lambda['emitLambda']()
			const childCount = context.nodes.count() - startCount

			const lineNumber = getLineNumber(this)
			const tid = getTokenIdForLine(lineNumber)

			return context.nodes.add({
				kind: NodeKind.FuncBinding,
				subtreeSize: 1 + childCount,
				tokenId: tid,
			})
		},
		FuncDecl(ident: Node, _colon: Node, funcType: Node): NodeId {
			const startCount = context.nodes.count()
			ident['emitExpression']()
			funcType['emitTypeAnnotation']()
			const childCount = context.nodes.count() - startCount

			const lineNumber = getLineNumber(this)
			const tid = getTokenIdForLine(lineNumber)

			return context.nodes.add({
				kind: NodeKind.FuncDecl,
				subtreeSize: 1 + childCount,
				tokenId: tid,
			})
		},
		MatchBinding(ident: Node, typeAnnotation: Node, _equals: Node, matchExpr: Node): NodeId {
			const startCount = context.nodes.count()
			ident['emitExpression']()
			typeAnnotation['emitTypeAnnotation']()
			matchExpr['emitStatement']()
			const childCount = context.nodes.count() - startCount

			const lineNumber = getLineNumber(this)
			const tid = getTokenIdForLine(lineNumber)

			return context.nodes.add({
				kind: NodeKind.VariableBinding,
				subtreeSize: 1 + childCount,
				tokenId: tid,
			})
		},
		MatchExpr(_matchKeyword: Node, scrutinee: Node): NodeId {
			const startCount = context.nodes.count()
			scrutinee['emitExpression']()
			const childCount = context.nodes.count() - startCount

			const tid = getTokenIdForOhmNode(this)
			return context.nodes.add({
				kind: NodeKind.MatchExpr,
				subtreeSize: 1 + childCount,
				tokenId: tid,
			})
		},
		PanicStatement(_panicKeyword: Node): NodeId {
			const lineNumber = getLineNumber(this)
			const tid = getTokenIdForLine(lineNumber)

			return context.nodes.add({
				kind: NodeKind.PanicStatement,
				subtreeSize: 1,
				tokenId: tid,
			})
		},
		PrimitiveBinding(ident: Node, _colon: Node, typeRef: Node, _equals: Node, expr: Node): NodeId {
			const startCount = context.nodes.count()
			ident['emitExpression']()

			// Emit type annotation node with possible complex type children
			// typeRef is PrimitiveTypeRef, need to check its child for the actual type
			const innerType = typeRef.child(0)
			if (innerType.ctorName === 'ListType' || innerType.ctorName === 'RefinementType') {
				innerType['emitTypeAnnotation']()
			}

			const tid = getTokenIdForOhmNode(typeRef)
			context.nodes.add({
				kind: NodeKind.TypeAnnotation,
				subtreeSize: 1 + (context.nodes.count() - startCount - 1),
				tokenId: tid,
			})

			expr['emitExpression']()

			const childCount = context.nodes.count() - startCount

			const lineNumber = getLineNumber(this)
			const lineTid = getTokenIdForLine(lineNumber)

			return context.nodes.add({
				kind: NodeKind.PrimitiveBinding,
				subtreeSize: 1 + childCount,
				tokenId: lineTid,
			})
		},
		RecordBinding(ident: Node, _colon: Node, typeName: Node): NodeId {
			const startCount = context.nodes.count()
			ident['emitExpression']()

			// Emit type annotation node (simple upperIdentifier, no complex type)
			const tid = getTokenIdForOhmNode(typeName)
			context.nodes.add({
				kind: NodeKind.TypeAnnotation,
				subtreeSize: 1,
				tokenId: tid,
			})

			const childCount = context.nodes.count() - startCount

			const lineNumber = getLineNumber(this)
			const lineTid = getTokenIdForLine(lineNumber)

			return context.nodes.add({
				kind: NodeKind.RecordBinding,
				subtreeSize: 1 + childCount,
				tokenId: lineTid,
			})
		},
		Statement(stmt: Node): NodeId {
			return stmt['emitStatement']()
		},
		TypeDecl(_typeKeyword: Node, _typeName: Node): NodeId {
			const tid = getTokenIdForOhmNode(this)
			return context.nodes.add({
				kind: NodeKind.TypeDecl,
				subtreeSize: 1,
				tokenId: tid,
			})
		},
	})

	semantics.addOperation<NodeId | null>('emitLine', {
		DedentLine(_anyDedents: Node, optionalStatement: Node) {
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
		IndentedLine(_indentToken: Node, _anyDedents: Node, optionalContent: Node) {
			const lineNumber = getLineNumber(this)
			const startCount = context.nodes.count()

			const contentNode = optionalContent.children[0]
			if (contentNode !== undefined) {
				contentNode['emitIndentedContent']()
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

	function emitProgramLines(optFirstLine: Node, lines: Node): void {
		const firstLine = optFirstLine.children[0]
		if (firstLine !== undefined) {
			firstLine['emitLine']()
		}
		for (const line of lines.children) {
			line['emitLine']()
		}
	}

	semantics.addOperation<NodeId>('emitProgram', {
		// Program = Line? (newline Line)* newline?
		// Ohm distributes * over grouped elements: Line?, newline*, Line*, newline?
		Program(optFirstLine: Node, _newlines: Node, lines: Node, _optTrailingNewline: Node) {
			const startCount = context.nodes.count()
			emitProgramLines(optFirstLine, lines)
			const childCount = context.nodes.count() - startCount

			return context.nodes.add({
				kind: NodeKind.Program,
				subtreeSize: childCount + 1,
				tokenId: tokenId(0),
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
