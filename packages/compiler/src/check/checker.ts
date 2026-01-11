/**
 * Check phase: semantic analysis between Parse and Codegen.
 *
 * Performs:
 * - Scope validation (reject invalid indentation)
 * - Reachability analysis (unreachable code warnings)
 * - Name resolution (symbol table lookup)
 * - Type checking (type annotation validation)
 * - SemIR emission (instructions for codegen)
 */

import type { CompilationContext, StringId } from '../core/context.ts'
import type { DiagnosticCode } from '../core/diagnostics.ts'
import {
	type NodeId,
	NodeKind,
	nodeId,
	offsetNodeId,
	type ParseNode,
	prevNodeId,
} from '../core/nodes.ts'
import { TokenKind } from '../core/tokens.ts'
import { InstStore, ScopeStore, SymbolStore, TypeStore } from './stores.ts'
import {
	BuiltinTypeId,
	type CheckResult,
	type InstId,
	InstKind,
	type Scope,
	type TypeId,
} from './types.ts'

interface UnreachableRange {
	firstNodeId: NodeId
	startLine: number
	endLine: number
}

/**
 * Context for collecting match arms.
 */
interface MatchContext {
	/** Scrutinee expression result */
	scrutinee: ExprResult
	/** Scrutinee node ID (for diagnostics) */
	scrutineeNodeId: NodeId
	/** Expected result type of the match */
	expectedType: TypeId
	/** Collected arms (pattern + body) */
	arms: Array<{ patternNodeId: NodeId; bodyInstId: InstId }>
	/** The node ID of the match binding/expr for diagnostics */
	matchNodeId: NodeId
	/** Binding name for variable creation after finalization */
	bindingNameId: StringId
	/** Binding node ID for symbol creation */
	bindingNodeId: NodeId
}

interface CheckerState {
	readonly insts: InstStore
	readonly scopes: ScopeStore
	readonly symbols: SymbolStore
	readonly types: TypeStore
	currentScope: Scope
	unreachableRange: UnreachableRange | null
	matchContext: MatchContext | null
}

interface ExprResult {
	typeId: TypeId
	instId: InstId | null
}

function isValidExprResult(result: ExprResult): result is { typeId: TypeId; instId: InstId } {
	return result.typeId !== BuiltinTypeId.Invalid && result.instId !== null
}

function isTerminator(kind: NodeKind): boolean {
	return kind === NodeKind.PanicStatement
}

/**
 * Checks if a node kind represents a statement.
 * Statement kinds are in range 10-99.
 */
function isStatementNode(kind: NodeKind): boolean {
	return kind >= 10 && kind < 100
}

/**
 * Checks if a node kind represents an expression.
 * Expression kinds are in range 100-149.
 */
function isExpressionNode(kind: NodeKind): boolean {
	return kind >= 100 && kind < 150
}

/**
 * Checks if a node kind represents a pattern.
 * Pattern kinds are in range 200-249.
 */
function isPatternNode(kind: NodeKind): boolean {
	return kind >= 200 && kind < 250
}

function getStatementFromLine(
	lineId: NodeId,
	context: CompilationContext
): { id: NodeId; kind: NodeKind } | null {
	for (const [childId, child] of context.nodes.iterateChildren(lineId)) {
		if (isStatementNode(child.kind)) {
			return { id: childId, kind: child.kind }
		}
	}
	return null
}

function getTypeNameFromToken(tokenKind: TokenKind): { name: string; typeId: TypeId } | null {
	switch (tokenKind) {
		case TokenKind.I32:
			return { name: 'i32', typeId: BuiltinTypeId.I32 }
		case TokenKind.I64:
			return { name: 'i64', typeId: BuiltinTypeId.I64 }
		case TokenKind.F32:
			return { name: 'f32', typeId: BuiltinTypeId.F32 }
		case TokenKind.F64:
			return { name: 'f64', typeId: BuiltinTypeId.F64 }
		default:
			return null
	}
}

/**
 * Integer bounds for type checking literals.
 * All bounds use BigInt for consistent precision.
 */
const INT_BOUNDS = {
	i32: { max: BigInt(2147483647), min: BigInt(-2147483648) },
	i64: { max: BigInt('9223372036854775807'), min: BigInt('-9223372036854775808') },
}

function valueFitsInType(value: bigint, typeId: TypeId): boolean {
	if (typeId === BuiltinTypeId.I32) {
		return value >= INT_BOUNDS.i32.min && value <= INT_BOUNDS.i32.max
	}
	if (typeId === BuiltinTypeId.I64) {
		return value >= INT_BOUNDS.i64.min && value <= INT_BOUNDS.i64.max
	}
	return false
}

/**
 * Split a BigInt value into low and high 32-bit parts for codegen.
 * Uses two's complement representation for negative values.
 */
function splitBigIntTo32BitParts(value: bigint, typeId: TypeId): { low: number; high: number } {
	if (typeId === BuiltinTypeId.I32) {
		// For i32, the value fits in low 32 bits
		return { high: 0, low: Number(BigInt.asIntN(32, value)) }
	}
	const low = Number(BigInt.asIntN(32, value))
	const high = Number(BigInt.asIntN(32, value >> 32n))
	return { high, low }
}

function isValidF32(value: number): boolean {
	const f32Value = Math.fround(value)
	return Number.isFinite(f32Value) || !Number.isFinite(value)
}

function isFloatType(typeId: TypeId): boolean {
	return typeId === BuiltinTypeId.F32 || typeId === BuiltinTypeId.F64
}

function isIntegerType(typeId: TypeId): boolean {
	return typeId === BuiltinTypeId.I32 || typeId === BuiltinTypeId.I64
}

/** Operators that only work with integer types */
function isIntegerOnlyOperator(tokenKind: TokenKind): boolean {
	switch (tokenKind) {
		case TokenKind.Percent:
		case TokenKind.PercentPercent:
		case TokenKind.Ampersand:
		case TokenKind.Pipe:
		case TokenKind.Caret:
		case TokenKind.Tilde:
		case TokenKind.LessLess:
		case TokenKind.GreaterGreater:
		case TokenKind.GreaterGreaterGreater:
			return true
		default:
			return false
	}
}

/** Operators that are comparisons (result is i32 regardless of operand types) */
function isComparisonOperator(tokenKind: TokenKind): boolean {
	switch (tokenKind) {
		case TokenKind.LessThan:
		case TokenKind.LessEqual:
		case TokenKind.GreaterThan:
		case TokenKind.GreaterEqual:
		case TokenKind.EqualEqual:
		case TokenKind.BangEqual:
			return true
		default:
			return false
	}
}

function getOperatorName(tokenKind: TokenKind): string {
	switch (tokenKind) {
		case TokenKind.Plus:
			return '+'
		case TokenKind.Minus:
			return '-'
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
		case TokenKind.Pipe:
			return '|'
		case TokenKind.Caret:
			return '^'
		case TokenKind.Tilde:
			return '~'
		case TokenKind.LessLess:
			return '<<'
		case TokenKind.GreaterGreater:
			return '>>'
		case TokenKind.GreaterGreaterGreater:
			return '>>>'
		case TokenKind.LessThan:
			return '<'
		case TokenKind.LessEqual:
			return '<='
		case TokenKind.GreaterThan:
			return '>'
		case TokenKind.GreaterEqual:
			return '>='
		case TokenKind.EqualEqual:
			return '=='
		case TokenKind.BangEqual:
			return '!='
		case TokenKind.AmpersandAmpersand:
			return '&&'
		case TokenKind.PipePipe:
			return '||'
		default:
			return '?'
	}
}

function applyNegation(value: number, negate: boolean): number {
	return negate ? -value : value
}

function formatDisplayValue(literalText: string, negate: boolean): string {
	return negate ? `-${literalText}` : literalText
}

function emitFloatConstInst(
	nodeId: NodeId,
	typeId: TypeId,
	value: number,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const floatId = context.floats.add(value)
	const instId = state.insts.add({
		arg0: floatId as number,
		arg1: 0,
		kind: InstKind.FloatConst,
		parseNodeId: nodeId,
		typeId,
	})
	return { instId, typeId }
}

function emitF32OverflowError(
	nodeId: NodeId,
	displayValue: string,
	context: CompilationContext
): ExprResult {
	context.emitAtNode('TWCHECK017' as DiagnosticCode, nodeId, {
		type: 'f32',
		value: displayValue,
	})
	return { instId: null, typeId: BuiltinTypeId.Invalid }
}

function emitIntConstInst(
	nodeId: NodeId,
	expectedType: TypeId,
	value: bigint,
	state: CheckerState
): ExprResult {
	const { high, low } = splitBigIntTo32BitParts(value, expectedType)
	const instId = state.insts.add({
		arg0: low,
		arg1: high,
		kind: InstKind.IntConst,
		parseNodeId: nodeId,
		typeId: expectedType,
	})
	return { instId, typeId: expectedType }
}

function emitIntBoundsError(
	nodeId: NodeId,
	typeName: string,
	displayValue: string,
	context: CompilationContext
): ExprResult {
	context.emitAtNode('TWCHECK014' as DiagnosticCode, nodeId, {
		type: typeName,
		value: displayValue,
	})
	return { instId: null, typeId: BuiltinTypeId.Invalid }
}

/** Parse integer literal text, handling scientific notation (e.g., 1e10) */
function parseIntegerLiteral(text: string): bigint {
	const expMatch = text.match(/^(\d+)[eE]([+-]?\d+)$/)
	if (expMatch) {
		const base = BigInt(expMatch[1] as string)
		const exp = Number(expMatch[2])
		if (exp < 0) throw new Error('Negative exponent not allowed for integers')
		return base * 10n ** BigInt(exp)
	}
	return BigInt(text)
}

function checkIntLiteralAsInt(
	nodeId: NodeId,
	expectedType: TypeId,
	literalText: string,
	negate: boolean,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	let value = parseIntegerLiteral(literalText)
	if (negate) value = -value

	if (!valueFitsInType(value, expectedType)) {
		const typeName = state.types.typeName(expectedType)
		return emitIntBoundsError(nodeId, typeName, formatDisplayValue(literalText, negate), context)
	}
	return emitIntConstInst(nodeId, expectedType, value, state)
}

function checkIntLiteral(
	nodeId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext,
	negate = false
): ExprResult {
	const node = context.nodes.get(nodeId)
	const token = context.tokens.get(node.tokenId)
	const literalText = context.strings.get(token.payload as StringId)

	if (isFloatType(expectedType)) {
		const expected = state.types.typeName(expectedType)
		context.emitAtNode('TWCHECK016' as DiagnosticCode, nodeId, {
			expected,
			found: 'integer literal',
		})
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}
	return checkIntLiteralAsInt(nodeId, expectedType, literalText, negate, state, context)
}

function checkVarRef(
	nodeId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const node = context.nodes.get(nodeId)
	const token = context.tokens.get(node.tokenId)
	const nameId = token.payload as StringId
	const name = context.strings.get(nameId)
	const symId = state.symbols.lookupByName(nameId)
	if (symId === undefined) {
		context.emitAtNode('TWCHECK013' as DiagnosticCode, nodeId, { name })
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	const symbol = state.symbols.get(symId)

	if (!state.types.areEqual(symbol.typeId, expectedType)) {
		const expected = state.types.typeName(expectedType)
		const found = state.types.typeName(symbol.typeId)
		context.emitAtNode('TWCHECK012' as DiagnosticCode, nodeId, { expected, found })
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	const instId = state.insts.add({
		arg0: symId as number,
		arg1: 0,
		kind: InstKind.VarRef,
		parseNodeId: nodeId,
		typeId: symbol.typeId,
	})

	return { instId, typeId: symbol.typeId }
}

function emitFloatTypeMismatchError(
	nodeId: NodeId,
	expected: string,
	context: CompilationContext
): ExprResult {
	context.emitAtNode('TWCHECK016' as DiagnosticCode, nodeId, {
		expected,
		found: 'float literal',
	})
	return { instId: null, typeId: BuiltinTypeId.Invalid }
}

function checkFloatLiteral(
	nodeId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext,
	negate = false
): ExprResult {
	const node = context.nodes.get(nodeId)
	const token = context.tokens.get(node.tokenId)
	const literalText = context.strings.get(token.payload as StringId)
	const value = applyNegation(Number.parseFloat(literalText), negate)

	if (!isFloatType(expectedType)) {
		return emitFloatTypeMismatchError(nodeId, state.types.typeName(expectedType), context)
	}
	if (expectedType === BuiltinTypeId.F32 && !isValidF32(value)) {
		return emitF32OverflowError(nodeId, formatDisplayValue(literalText, negate), context)
	}
	return emitFloatConstInst(nodeId, expectedType, value, state, context)
}

/**
 * Check a unary expression (negation or bitwise NOT).
 * In postorder, the child is at exprNodeId - 1.
 * Operator is determined by the tokenId.
 */
function checkBitwiseNot(
	exprNodeId: NodeId,
	childId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const childResult = checkExpressionInferred(childId, state, context)
	if (!isValidExprResult(childResult)) return childResult

	if (!isIntegerType(childResult.typeId)) {
		context.emitAtNode('TWCHECK021' as DiagnosticCode, exprNodeId, {
			op: '~',
			type: state.types.typeName(childResult.typeId),
		})
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	if (!state.types.areEqual(childResult.typeId, expectedType)) {
		context.emitAtNode('TWCHECK012' as DiagnosticCode, exprNodeId, {
			expected: state.types.typeName(expectedType),
			found: state.types.typeName(childResult.typeId),
		})
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	const instId = state.insts.add({
		arg0: childResult.instId as number,
		arg1: 0,
		kind: InstKind.BitwiseNot,
		parseNodeId: exprNodeId,
		typeId: childResult.typeId,
	})
	return { instId, typeId: childResult.typeId }
}

function checkUnaryNegate(
	exprNodeId: NodeId,
	childId: NodeId,
	childKind: NodeKind,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	if (childKind === NodeKind.IntLiteral) {
		return checkIntLiteral(childId, expectedType, state, context, true)
	}
	if (childKind === NodeKind.FloatLiteral) {
		return checkFloatLiteral(childId, expectedType, state, context, true)
	}

	const childResult = checkExpression(childId, expectedType, state, context)
	if (!isValidExprResult(childResult)) return childResult

	const instId = state.insts.add({
		arg0: childResult.instId as number,
		arg1: 0,
		kind: InstKind.Negate,
		parseNodeId: exprNodeId,
		typeId: childResult.typeId,
	})
	return { instId, typeId: childResult.typeId }
}

function checkUnaryExpr(
	exprNodeId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const node = context.nodes.get(exprNodeId)
	const token = context.tokens.get(node.tokenId)
	const childId = prevNodeId(exprNodeId)

	if (token.kind === TokenKind.Tilde) {
		return checkBitwiseNot(exprNodeId, childId, expectedType, state, context)
	}

	const child = context.nodes.get(childId)
	return checkUnaryNegate(exprNodeId, childId, child.kind, expectedType, state, context)
}

/**
 * Check a parenthesized expression.
 * In postorder, the child is at exprNodeId - 1.
 */
function checkParenExpr(
	exprNodeId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const childId = prevNodeId(exprNodeId)
	return checkExpression(childId, expectedType, state, context)
}

/**
 * Check a binary expression.
 * In postorder: [left..., right..., BinaryExpr]
 * The right operand's root is at exprId - 1.
 * The left operand's root is at rightRootId - rightSubtreeSize.
 */
interface BinaryOperands {
	leftResult: ExprResult
	rightResult: ExprResult
	operandType: TypeId
}

function getBinaryOperands(
	exprNodeId: NodeId,
	state: CheckerState,
	context: CompilationContext
): BinaryOperands | ExprResult {
	const rightId = prevNodeId(exprNodeId)
	const rightNode = context.nodes.get(rightId)
	const leftId = offsetNodeId(rightId, -rightNode.subtreeSize)

	const leftResult = checkExpressionInferred(leftId, state, context)
	if (!isValidExprResult(leftResult)) return leftResult

	const rightResult = checkExpressionInferred(rightId, state, context)
	if (!isValidExprResult(rightResult)) return rightResult

	if (!state.types.areEqual(leftResult.typeId, rightResult.typeId)) {
		context.emitAtNode('TWCHECK022' as DiagnosticCode, exprNodeId, {
			left: state.types.typeName(leftResult.typeId),
			right: state.types.typeName(rightResult.typeId),
		})
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	return { leftResult, operandType: leftResult.typeId, rightResult }
}

function isBinaryOperands(result: BinaryOperands | ExprResult): result is BinaryOperands {
	return 'leftResult' in result
}

function validateBinaryOperator(
	exprNodeId: NodeId,
	operatorKind: TokenKind,
	operandType: TypeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): TypeId | null {
	if (isIntegerOnlyOperator(operatorKind) && !isIntegerType(operandType)) {
		context.emitAtNode('TWCHECK021' as DiagnosticCode, exprNodeId, {
			op: getOperatorName(operatorKind),
			type: state.types.typeName(operandType),
		})
		return null
	}

	const resultType = isComparisonOperator(operatorKind) ? BuiltinTypeId.I32 : operandType

	if (!state.types.areEqual(resultType, expectedType)) {
		context.emitAtNode('TWCHECK012' as DiagnosticCode, exprNodeId, {
			expected: state.types.typeName(expectedType),
			found: state.types.typeName(resultType),
		})
		return null
	}

	return resultType
}

function emitLogicalOp(
	exprNodeId: NodeId,
	operatorKind: TokenKind,
	operands: BinaryOperands,
	resultType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	if (!isIntegerType(operands.operandType)) {
		const op = operatorKind === TokenKind.AmpersandAmpersand ? '&&' : '||'
		context.emitAtNode('TWCHECK024' as DiagnosticCode, exprNodeId, {
			op,
			type: state.types.typeName(operands.operandType),
		})
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	const kind =
		operatorKind === TokenKind.AmpersandAmpersand ? InstKind.LogicalAnd : InstKind.LogicalOr
	const instId = state.insts.add({
		arg0: operands.leftResult.instId as number,
		arg1: operands.rightResult.instId as number,
		kind,
		parseNodeId: exprNodeId,
		typeId: resultType,
	})
	return { instId, typeId: resultType }
}

function checkBinaryExpr(
	exprNodeId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const node = context.nodes.get(exprNodeId)
	const operatorKind = context.tokens.get(node.tokenId).kind

	const operandsResult = getBinaryOperands(exprNodeId, state, context)
	if (!isBinaryOperands(operandsResult)) return operandsResult

	const resultType = validateBinaryOperator(
		exprNodeId,
		operatorKind,
		operandsResult.operandType,
		expectedType,
		state,
		context
	)
	if (resultType === null) return { instId: null, typeId: BuiltinTypeId.Invalid }

	if (operatorKind === TokenKind.AmpersandAmpersand || operatorKind === TokenKind.PipePipe) {
		return emitLogicalOp(exprNodeId, operatorKind, operandsResult, resultType, state, context)
	}

	const instId = state.insts.add({
		arg0: operandsResult.leftResult.instId as number,
		arg1: operandsResult.rightResult.instId as number,
		kind: InstKind.BinaryOp,
		parseNodeId: exprNodeId,
		typeId: resultType,
	})
	return { instId, typeId: resultType }
}

function collectCompareChainOperands(exprNodeId: NodeId, context: CompilationContext): NodeId[] {
	const operandNodes: NodeId[] = []
	for (const [childId, child] of context.nodes.iterateChildren(exprNodeId)) {
		if (isExpressionNode(child.kind)) operandNodes.push(childId)
	}
	operandNodes.reverse()
	return operandNodes
}

function checkCompareChainOperands(
	operandNodes: NodeId[],
	state: CheckerState,
	context: CompilationContext
): ExprResult[] | null {
	const results: ExprResult[] = []
	for (const opId of operandNodes) {
		const result = checkExpressionInferred(opId, state, context)
		if (!isValidExprResult(result)) return null
		results.push(result)
	}
	return results
}

function findTypeMismatch(
	operandResults: ExprResult[],
	operandNodes: NodeId[],
	firstType: TypeId,
	state: CheckerState
): { nodeId: NodeId; resultType: TypeId } | null {
	for (let i = 1; i < operandResults.length; i++) {
		const result = operandResults[i]
		const nodeId = operandNodes[i]
		if (result && nodeId && !state.types.areEqual(result.typeId, firstType)) {
			return { nodeId, resultType: result.typeId }
		}
	}
	return null
}

function validateCompareChainTypes(
	operandResults: ExprResult[],
	operandNodes: NodeId[],
	state: CheckerState,
	context: CompilationContext
): TypeId | null {
	const firstResult = operandResults[0]
	if (!firstResult) return null
	const firstType = firstResult.typeId

	const mismatch = findTypeMismatch(operandResults, operandNodes, firstType, state)
	if (mismatch) {
		context.emitAtNode('TWCHECK022' as DiagnosticCode, mismatch.nodeId, {
			left: state.types.typeName(firstType),
			right: state.types.typeName(mismatch.resultType),
		})
		return null
	}
	return firstType
}

interface ValidatedCompareChain {
	firstResult: ExprResult
	secondResult: ExprResult
}

function checkCompareChainPrereqs(
	operandNodes: NodeId[],
	state: CheckerState,
	context: CompilationContext
): ExprResult[] | null {
	if (operandNodes.length < 2) return null
	const operandResults = checkCompareChainOperands(operandNodes, state, context)
	if (!operandResults) return null
	const firstType = validateCompareChainTypes(operandResults, operandNodes, state, context)
	return firstType !== null ? operandResults : null
}

function checkExpectedTypeI32(
	exprNodeId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): boolean {
	if (state.types.areEqual(BuiltinTypeId.I32, expectedType)) return true
	context.emitAtNode('TWCHECK012' as DiagnosticCode, exprNodeId, {
		expected: state.types.typeName(expectedType),
		found: 'i32',
	})
	return false
}

function validateCompareChain(
	exprNodeId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ValidatedCompareChain | null {
	const operandNodes = collectCompareChainOperands(exprNodeId, context)
	const operandResults = checkCompareChainPrereqs(operandNodes, state, context)
	if (!operandResults) return null
	if (!checkExpectedTypeI32(exprNodeId, expectedType, state, context)) return null

	const firstResult = operandResults[0]
	const secondResult = operandResults[1]
	return firstResult && secondResult ? { firstResult, secondResult } : null
}

function checkCompareChain(
	exprNodeId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const validated = validateCompareChain(exprNodeId, expectedType, state, context)
	if (!validated) return { instId: null, typeId: BuiltinTypeId.Invalid }

	const instId = state.insts.add({
		arg0: validated.firstResult.instId as number,
		arg1: validated.secondResult.instId as number,
		kind: InstKind.BinaryOp,
		parseNodeId: exprNodeId,
		typeId: BuiltinTypeId.I32,
	})
	return { instId, typeId: BuiltinTypeId.I32 }
}

function checkUnaryExprInferred(
	exprId: NodeId,
	node: ParseNode,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const childId = prevNodeId(exprId)
	const childResult = checkExpressionInferred(childId, state, context)
	if (!isValidExprResult(childResult)) return childResult

	const opToken = context.tokens.get(node.tokenId)
	if (opToken.kind === TokenKind.Tilde) {
		if (!isIntegerType(childResult.typeId)) {
			context.emitAtNode('TWCHECK021' as DiagnosticCode, exprId, {
				op: '~',
				type: state.types.typeName(childResult.typeId),
			})
			return { instId: null, typeId: BuiltinTypeId.Invalid }
		}
		const instId = state.insts.add({
			arg0: childResult.instId as number,
			arg1: 0,
			kind: InstKind.BitwiseNot,
			parseNodeId: exprId,
			typeId: childResult.typeId,
		})
		return { instId, typeId: childResult.typeId }
	}
	const instId = state.insts.add({
		arg0: childResult.instId as number,
		arg1: 0,
		kind: InstKind.Negate,
		parseNodeId: exprId,
		typeId: childResult.typeId,
	})
	return { instId, typeId: childResult.typeId }
}

function checkIdentifierInferred(
	exprId: NodeId,
	node: ParseNode,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const token = context.tokens.get(node.tokenId)
	const nameId = token.payload as StringId
	const name = context.strings.get(nameId)
	const symId = state.symbols.lookupByName(nameId)
	if (symId === undefined) {
		context.emitAtNode('TWCHECK013' as DiagnosticCode, exprId, { name })
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}
	const symbol = state.symbols.get(symId)
	const instId = state.insts.add({
		arg0: symId as number,
		arg1: 0,
		kind: InstKind.VarRef,
		parseNodeId: exprId,
		typeId: symbol.typeId,
	})
	return { instId, typeId: symbol.typeId }
}

function emitLogicalOpInferred(
	exprId: NodeId,
	opKind: TokenKind,
	leftResult: ExprResult,
	rightResult: ExprResult,
	operandType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	if (!isIntegerType(operandType)) {
		context.emitAtNode('TWCHECK024' as DiagnosticCode, exprId, {
			op: getOperatorName(opKind),
			type: state.types.typeName(operandType),
		})
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}
	const kind = opKind === TokenKind.AmpersandAmpersand ? InstKind.LogicalAnd : InstKind.LogicalOr
	const instId = state.insts.add({
		arg0: leftResult.instId as number,
		arg1: rightResult.instId as number,
		kind,
		parseNodeId: exprId,
		typeId: BuiltinTypeId.I32,
	})
	return { instId, typeId: BuiltinTypeId.I32 }
}

function validateIntegerOnlyOperator(
	exprId: NodeId,
	opKind: TokenKind,
	operandType: TypeId,
	state: CheckerState,
	context: CompilationContext
): boolean {
	if (!isIntegerOnlyOperator(opKind) || isIntegerType(operandType)) return true
	context.emitAtNode('TWCHECK021' as DiagnosticCode, exprId, {
		op: getOperatorName(opKind),
		type: state.types.typeName(operandType),
	})
	return false
}

function isLogicalOperator(kind: TokenKind): boolean {
	return kind === TokenKind.AmpersandAmpersand || kind === TokenKind.PipePipe
}

function emitBinaryOpInferred(
	exprId: NodeId,
	opKind: TokenKind,
	operands: BinaryOperands,
	state: CheckerState
): ExprResult {
	const resultType = isComparisonOperator(opKind) ? BuiltinTypeId.I32 : operands.operandType
	const instId = state.insts.add({
		arg0: operands.leftResult.instId as number,
		arg1: operands.rightResult.instId as number,
		kind: InstKind.BinaryOp,
		parseNodeId: exprId,
		typeId: resultType,
	})
	return { instId, typeId: resultType }
}

function checkBinaryExprInferred(
	exprId: NodeId,
	node: ParseNode,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const operandsResult = getBinaryOperands(exprId, state, context)
	if (!isBinaryOperands(operandsResult)) return operandsResult

	const opKind = context.tokens.get(node.tokenId).kind

	if (isLogicalOperator(opKind)) {
		const { leftResult, rightResult, operandType } = operandsResult
		return emitLogicalOpInferred(
			exprId,
			opKind,
			leftResult,
			rightResult,
			operandType,
			state,
			context
		)
	}

	if (!validateIntegerOnlyOperator(exprId, opKind, operandsResult.operandType, state, context)) {
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	return emitBinaryOpInferred(exprId, opKind, operandsResult, state)
}

function checkExpressionInferred(
	exprId: NodeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const node = context.nodes.get(exprId)

	switch (node.kind) {
		case NodeKind.IntLiteral:
			return checkIntLiteral(exprId, BuiltinTypeId.I32, state, context)
		case NodeKind.FloatLiteral:
			return checkFloatLiteral(exprId, BuiltinTypeId.F64, state, context)
		case NodeKind.UnaryExpr:
			return checkUnaryExprInferred(exprId, node, state, context)
		case NodeKind.Identifier:
			return checkIdentifierInferred(exprId, node, state, context)
		case NodeKind.ParenExpr:
			return checkExpressionInferred(prevNodeId(exprId), state, context)
		case NodeKind.BinaryExpr:
			return checkBinaryExprInferred(exprId, node, state, context)
		case NodeKind.CompareChain:
			return checkCompareChain(exprId, BuiltinTypeId.I32, state, context)
		default:
			return { instId: null, typeId: BuiltinTypeId.Invalid }
	}
}

function checkExpression(
	exprId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const node = context.nodes.get(exprId)

	switch (node.kind) {
		case NodeKind.IntLiteral:
			return checkIntLiteral(exprId, expectedType, state, context)
		case NodeKind.FloatLiteral:
			return checkFloatLiteral(exprId, expectedType, state, context)
		case NodeKind.UnaryExpr:
			return checkUnaryExpr(exprId, expectedType, state, context)
		case NodeKind.Identifier:
			return checkVarRef(exprId, expectedType, state, context)
		case NodeKind.ParenExpr:
			return checkParenExpr(exprId, expectedType, state, context)
		case NodeKind.BinaryExpr:
			return checkBinaryExpr(exprId, expectedType, state, context)
		case NodeKind.CompareChain:
			return checkCompareChain(exprId, expectedType, state, context)
		default:
			// Should be unreachable - all expression kinds should be handled
			console.assert(false, 'checkExpression: unhandled expression kind %d', node.kind)
			return { instId: null, typeId: BuiltinTypeId.Invalid }
	}
}

/**
 * Process a VariableBinding statement.
 * Syntax: identifier TypeAnnotation = Expression
 * In postorder: [Identifier, TypeAnnotation, Expression..., VariableBinding]
 *
 * Note: Expression may have subtreeSize > 1 (e.g., UnaryExpr has subtreeSize=2).
 * We must use subtreeSize to correctly navigate the postorder storage.
 */
function processVariableBinding(
	bindingId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	// In postorder, expression root is immediately before VariableBinding
	// Then we work backwards using subtreeSize to find TypeAnnotation and Identifier
	const exprId = prevNodeId(bindingId)
	const exprNode = context.nodes.get(exprId)
	console.assert(
		isExpressionNode(exprNode.kind),
		'VariableBinding: expected expression at offset -1, found %d',
		exprNode.kind
	)

	// TypeAnnotation is before the expression's entire subtree
	const typeAnnotationId = offsetNodeId(exprId, -exprNode.subtreeSize)
	const typeAnnotationNode = context.nodes.get(typeAnnotationId)
	console.assert(
		typeAnnotationNode.kind === NodeKind.TypeAnnotation,
		'VariableBinding: expected TypeAnnotation, found %d',
		typeAnnotationNode.kind
	)

	// Identifier is before the TypeAnnotation's subtree (subtreeSize=1)
	const identId = offsetNodeId(typeAnnotationId, -typeAnnotationNode.subtreeSize)
	const identNode = context.nodes.get(identId)
	console.assert(
		identNode.kind === NodeKind.Identifier,
		'VariableBinding: expected Identifier, found %d',
		identNode.kind
	)

	// 1. Get identifier name
	const identToken = context.tokens.get(identNode.tokenId)
	const nameId = identToken.payload as StringId

	// 2. Resolve declared type from TypeAnnotation
	const typeToken = context.tokens.get(typeAnnotationNode.tokenId)
	const typeInfo = getTypeNameFromToken(typeToken.kind)

	if (!typeInfo) {
		context.emitAtNode('TWCHECK010' as DiagnosticCode, typeAnnotationId, {
			found: 'unknown',
		})
		return
	}

	const declaredType = typeInfo.typeId

	// 3. Check expression with expected type
	const exprResult = checkExpression(exprId, declaredType, state, context)
	if (!isValidExprResult(exprResult)) {
		return // Error already reported
	}

	// 4. Add symbol to table (allocates fresh local, supports shadowing)
	const symId = state.symbols.add({
		nameId,
		parseNodeId: bindingId,
		typeId: declaredType,
	})

	// 5. Emit Bind instruction
	state.insts.add({
		arg0: symId as number,
		arg1: exprResult.instId as number,
		kind: InstKind.Bind,
		parseNodeId: bindingId,
		typeId: declaredType,
	})
}

function getMatchArmFromLine(
	lineId: NodeId,
	context: CompilationContext
): { id: NodeId; kind: NodeKind } | null {
	for (const [childId, child] of context.nodes.iterateChildren(lineId)) {
		if (child.kind === NodeKind.MatchArm) {
			return { id: childId, kind: child.kind }
		}
	}
	return null
}

function validateLiteralPattern(
	patternId: NodeId,
	scrutineeType: TypeId,
	state: CheckerState,
	context: CompilationContext
): void {
	if (!isIntegerType(scrutineeType)) {
		context.emitAtNode('TWCHECK018' as DiagnosticCode, patternId, {
			patternType: 'integer literal',
			scrutineeType: state.types.typeName(scrutineeType),
		})
	}
}

function checkOrPatternChildren(
	patternId: NodeId,
	scrutineeType: TypeId,
	state: CheckerState,
	context: CompilationContext
): void {
	for (const [childId, child] of context.nodes.iterateChildren(patternId)) {
		if (isPatternNode(child.kind)) {
			checkPattern(childId, scrutineeType, state, context)
		}
	}
}

function checkPattern(
	patternId: NodeId,
	scrutineeType: TypeId,
	state: CheckerState,
	context: CompilationContext
): NodeId {
	const patternNode = context.nodes.get(patternId)

	switch (patternNode.kind) {
		case NodeKind.LiteralPattern:
			validateLiteralPattern(patternId, scrutineeType, state, context)
			break
		case NodeKind.OrPattern:
			checkOrPatternChildren(patternId, scrutineeType, state, context)
			break
	}

	return patternId
}

/**
 * Process a MatchArm node.
 * In postorder: [Pattern..., Expression..., MatchArm]
 */
function processMatchArm(armId: NodeId, state: CheckerState, context: CompilationContext): void {
	if (!state.matchContext) {
		context.emitAtNode('TWCHECK019' as DiagnosticCode, armId)
		return
	}

	// In postorder, children are before parent. We need to find the pattern and expression.
	// The expression is the last child (closest to MatchArm).
	// Pattern(s) come before the expression.
	const exprId = prevNodeId(armId)
	const exprNode = context.nodes.get(exprId)

	if (!isExpressionNode(exprNode.kind)) {
		// Malformed arm
		return
	}

	// Pattern is before the expression's subtree
	const patternId = offsetNodeId(exprId, -exprNode.subtreeSize)
	const patternNode = context.nodes.get(patternId)

	if (!isPatternNode(patternNode.kind)) {
		// Malformed arm
		return
	}

	// Check the pattern
	checkPattern(patternId, state.matchContext.scrutinee.typeId, state, context)

	// Check the body expression
	const bodyResult = checkExpression(exprId, state.matchContext.expectedType, state, context)

	// Add to collected arms
	if (isValidExprResult(bodyResult)) {
		state.matchContext.arms.push({
			bodyInstId: bodyResult.instId,
			patternNodeId: patternId,
		})
	}
}

function isSimpleCatchAll(kind: NodeKind): boolean {
	return kind === NodeKind.WildcardPattern || kind === NodeKind.BindingPattern
}

function orPatternContainsCatchAll(patternId: NodeId, context: CompilationContext): boolean {
	for (const [childId, child] of context.nodes.iterateChildren(patternId)) {
		if (isPatternNode(child.kind) && isCatchAllPattern(childId, context)) {
			return true
		}
	}
	return false
}

/**
 * Check if a pattern is a catch-all (wildcard or binding).
 * For OrPattern, recursively checks if any child is a catch-all.
 */
function isCatchAllPattern(patternId: NodeId, context: CompilationContext): boolean {
	const pattern = context.nodes.get(patternId)

	if (isSimpleCatchAll(pattern.kind)) return true
	if (pattern.kind === NodeKind.OrPattern) return orPatternContainsCatchAll(patternId, context)
	return false
}

function checkMatchExhaustiveness(
	arms: MatchContext['arms'],
	matchNodeId: NodeId,
	context: CompilationContext
): void {
	const lastArm = arms[arms.length - 1]
	if (!lastArm || !isCatchAllPattern(lastArm.patternNodeId, context)) {
		context.emitAtNode('TWCHECK020' as DiagnosticCode, matchNodeId)
	}
}

function emitMatchArmInsts(
	arms: MatchContext['arms'],
	matchNodeId: NodeId,
	expectedType: TypeId,
	state: CheckerState
): void {
	for (const arm of arms) {
		state.insts.add({
			arg0: arm.patternNodeId as number,
			arg1: arm.bodyInstId as number,
			kind: InstKind.MatchArm,
			parseNodeId: matchNodeId,
			typeId: expectedType,
		})
	}
}

function createMatchBinding(
	matchCtx: MatchContext,
	matchInstId: InstId,
	state: CheckerState
): void {
	const symId = state.symbols.add({
		nameId: matchCtx.bindingNameId,
		parseNodeId: matchCtx.bindingNodeId,
		typeId: matchCtx.expectedType,
	})
	state.insts.add({
		arg0: symId as number,
		arg1: matchInstId as number,
		kind: InstKind.Bind,
		parseNodeId: matchCtx.bindingNodeId,
		typeId: matchCtx.expectedType,
	})
}

function finalizeMatch(state: CheckerState, context: CompilationContext): void {
	if (!state.matchContext) return

	const { arms, expectedType, matchNodeId, scrutinee } = state.matchContext

	checkMatchExhaustiveness(arms, matchNodeId, context)

	// scrutinee.instId null check (matchContext only set after valid typeId check)
	if (scrutinee.instId === null) return

	emitMatchArmInsts(arms, matchNodeId, expectedType, state)

	const matchInstId = state.insts.add({
		arg0: scrutinee.instId as number,
		arg1: arms.length,
		kind: InstKind.Match,
		parseNodeId: matchNodeId,
		typeId: expectedType,
	})

	createMatchBinding(state.matchContext, matchInstId, state)
	state.matchContext = null
}

interface MatchBindingNodes {
	identId: NodeId
	typeAnnotationId: NodeId
	scrutineeId: NodeId
	bindingNameId: StringId
	expectedType: TypeId
}

/** Extract raw positional nodes from match binding, returns null if structure invalid */
function extractMatchBindingPositionalNodes(
	bindingId: NodeId,
	context: CompilationContext
): {
	matchExprNode: ReturnType<typeof context.nodes.get>
	scrutineeId: NodeId
	typeAnnotationId: NodeId
	identId: NodeId
} | null {
	const matchExprId = prevNodeId(bindingId)
	const matchExprNode = context.nodes.get(matchExprId)
	if (matchExprNode.kind !== NodeKind.MatchExpr) return null

	const scrutineeId = prevNodeId(matchExprId)
	if (!isExpressionNode(context.nodes.get(scrutineeId).kind)) return null

	const typeAnnotationId = offsetNodeId(matchExprId, -matchExprNode.subtreeSize)
	if (context.nodes.get(typeAnnotationId).kind !== NodeKind.TypeAnnotation) return null

	const identId = offsetNodeId(typeAnnotationId, -context.nodes.get(typeAnnotationId).subtreeSize)
	if (context.nodes.get(identId).kind !== NodeKind.Identifier) return null

	return { identId, matchExprNode, scrutineeId, typeAnnotationId }
}

function extractMatchBindingNodes(
	bindingId: NodeId,
	context: CompilationContext
): MatchBindingNodes | null {
	const positional = extractMatchBindingPositionalNodes(bindingId, context)
	if (!positional) return null

	const { identId, scrutineeId, typeAnnotationId } = positional
	const bindingNameId = context.tokens.get(context.nodes.get(identId).tokenId).payload as StringId
	const typeToken = context.tokens.get(context.nodes.get(typeAnnotationId).tokenId)
	const typeInfo = getTypeNameFromToken(typeToken.kind)

	if (!typeInfo) {
		context.emitAtNode('TWCHECK010' as DiagnosticCode, typeAnnotationId, { found: 'unknown' })
		return null
	}

	return { bindingNameId, expectedType: typeInfo.typeId, identId, scrutineeId, typeAnnotationId }
}

function startMatchBinding(
	bindingId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	const nodes = extractMatchBindingNodes(bindingId, context)
	if (!nodes) {
		processVariableBinding(bindingId, state, context)
		return
	}

	const scrutineeResult = checkExpression(nodes.scrutineeId, nodes.expectedType, state, context)
	if (scrutineeResult.typeId === BuiltinTypeId.Invalid) return

	state.matchContext = {
		arms: [],
		bindingNameId: nodes.bindingNameId,
		bindingNodeId: bindingId,
		expectedType: nodes.expectedType,
		matchNodeId: bindingId,
		scrutinee: scrutineeResult,
		scrutineeNodeId: nodes.scrutineeId,
	}
}

function emitStatement(
	stmtId: NodeId,
	stmtKind: NodeKind,
	state: CheckerState,
	context: CompilationContext
): void {
	switch (stmtKind) {
		case NodeKind.PanicStatement:
			state.insts.add({
				arg0: 0,
				arg1: 0,
				kind: InstKind.Unreachable,
				parseNodeId: stmtId,
				typeId: BuiltinTypeId.None,
			})
			break
		case NodeKind.VariableBinding:
			// Check if this is a match binding
			{
				const matchExprId = prevNodeId(stmtId)
				const matchExprNode = context.nodes.get(matchExprId)
				if (matchExprNode.kind === NodeKind.MatchExpr) {
					startMatchBinding(stmtId, state, context)
				} else {
					processVariableBinding(stmtId, state, context)
				}
			}
			break
		case NodeKind.MatchExpr:
			// Standalone match expression (discarded form) - not yet implemented
			break
	}
}

function flushUnreachableWarning(state: CheckerState, context: CompilationContext): void {
	const range = state.unreachableRange
	if (!range) return

	const { endLine, firstNodeId, startLine } = range

	if (startLine === endLine) {
		// Single line - use default suggestion
		context.emitAtNode('TWCHECK050' as DiagnosticCode, firstNodeId)
	} else {
		// Multiple lines - use custom suggestion with range
		const suggestion = `Lines ${startLine}-${endLine} are unreachable. You can safely remove this code, or move it before the exit point.`
		context.emitAtNodeWithSuggestion('TWCHECK050' as DiagnosticCode, firstNodeId, suggestion)
	}

	state.unreachableRange = null
}

function getNodeLine(nodeId: NodeId, context: CompilationContext): number {
	const node = context.nodes.get(nodeId)
	const token = context.tokens.get(node.tokenId)
	return token.line
}

function trackUnreachable(stmtId: NodeId, state: CheckerState, context: CompilationContext): void {
	const line = getNodeLine(stmtId, context)

	if (!state.unreachableRange) {
		state.unreachableRange = {
			endLine: line,
			firstNodeId: stmtId,
			startLine: line,
		}
	} else {
		state.unreachableRange.endLine = line
	}
}

function processRootLineStatement(
	lineId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	const stmt = getStatementFromLine(lineId, context)
	if (!stmt) return

	if (!state.currentScope.reachable) {
		trackUnreachable(stmt.id, state, context)
	}

	emitStatement(stmt.id, stmt.kind, state, context)

	if (isTerminator(stmt.kind)) {
		state.currentScope.reachable = false
	}
}

function processIndentedLineAsMatchArm(
	lineId: NodeId,
	state: CheckerState,
	context: CompilationContext
): boolean {
	if (!state.matchContext) return false

	const arm = getMatchArmFromLine(lineId, context)
	if (!arm) return false

	processMatchArm(arm.id, state, context)
	return true
}

function handleIndentedLine(
	lineId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	if (!processIndentedLineAsMatchArm(lineId, state, context)) {
		context.emitAtNode('TWCHECK001' as DiagnosticCode, lineId)
	}
}

function handleDedentLine(lineId: NodeId, state: CheckerState, context: CompilationContext): void {
	if (!state.matchContext) {
		context.emitAtNode('TWCHECK001' as DiagnosticCode, lineId)
		return
	}
	finalizeMatch(state, context)
	const stmt = getStatementFromLine(lineId, context)
	if (stmt) emitStatement(stmt.id, stmt.kind, state, context)
}

function handleRootLine(lineId: NodeId, state: CheckerState, context: CompilationContext): void {
	if (state.matchContext) finalizeMatch(state, context)
	processRootLineStatement(lineId, state, context)
}

/**
 * Process a line node.
 * - RootLine: finalize any pending match, then process statement
 * - IndentedLine: if match context active, process as match arm; else error
 * - DedentLine: if match context active, finalize it and process any statement; else error
 */
function processLine(
	lineId: NodeId,
	line: { kind: NodeKind },
	state: CheckerState,
	context: CompilationContext
): void {
	switch (line.kind) {
		case NodeKind.IndentedLine:
			handleIndentedLine(lineId, state, context)
			break
		case NodeKind.DedentLine:
			handleDedentLine(lineId, state, context)
			break
		default:
			handleRootLine(lineId, state, context)
	}
}

/**
 * Collect line children from Program node in source order.
 * iterateChildren yields in reverse order, so we reverse to get source order.
 */
function getLineChildrenInSourceOrder(
	programId: NodeId,
	context: CompilationContext
): Array<[NodeId, { kind: NodeKind }]> {
	const lines: Array<[NodeId, { kind: NodeKind }]> = []
	for (const [lineId, line] of context.nodes.iterateChildren(programId)) {
		lines.push([lineId, line])
	}
	return lines.reverse()
}

/**
 * Perform semantic checking on a parsed program.
 *
 * Algorithm:
 * 1. Create "main" scope
 * 2. Find Program node (last in postorder)
 * 3. Iterate line children in source order
 * 4. For each line:
 *    - IndentedLine/DedentLine → error
 *    - RootLine → process statement
 *      - If unreachable, warn
 *      - Emit instruction
 *      - If terminator, mark unreachable
 */
export function check(context: CompilationContext): CheckResult {
	const insts = new InstStore()
	const scopes = new ScopeStore()
	const symbols = new SymbolStore()
	const types = new TypeStore()
	const mainScopeId = scopes.createMainScope()
	const mainScope = scopes.get(mainScopeId)

	const state: CheckerState = {
		currentScope: mainScope,
		insts,
		matchContext: null,
		scopes,
		symbols,
		types,
		unreachableRange: null,
	}

	// Find Program node (last node in postorder storage)
	const nodeCount = context.nodes.count()
	if (nodeCount === 0) {
		context.insts = insts
		context.symbols = symbols
		context.types = types
		return { succeeded: true }
	}

	const programId = nodeId(nodeCount - 1)
	const program = context.nodes.get(programId)

	if (program.kind !== NodeKind.Program) {
		// No valid Program node - might be a parse error
		context.insts = insts
		context.symbols = symbols
		context.types = types
		return { succeeded: !context.hasErrors() }
	}

	// Process line children in source order
	const lines = getLineChildrenInSourceOrder(programId, context)
	for (const [lineId, line] of lines) {
		processLine(lineId, line, state, context)
	}

	// Finalize any pending match at end of program
	if (state.matchContext) {
		finalizeMatch(state, context)
	}

	flushUnreachableWarning(state, context)
	context.insts = insts
	context.symbols = symbols
	context.types = types

	return { succeeded: !context.hasErrors() }
}
