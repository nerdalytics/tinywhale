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
import { nextTokenId, TokenKind, type Token } from '../core/tokens.ts'
import { InstStore, ScopeStore, SymbolStore, TypeStore } from './stores.ts'
import {
	BuiltinTypeId,
	type CheckResult,
	type FieldInfo,
	type InstId,
	InstKind,
	type Scope,
	type SymbolId,
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

/**
 * Context for collecting type declaration fields.
 */
interface TypeDeclContext {
	/** Type name */
	typeName: string
	/** Parse node ID of the TypeDecl (for diagnostics) */
	typeDeclNodeId: NodeId
	/** Collected fields */
	fields: Array<{ name: string; typeId: TypeId; nodeId: NodeId }>
	/** Track field names for duplicate detection */
	fieldNames: Set<string>
}

/**
 * Context for collecting record literal field initializers.
 */
interface RecordLiteralContext {
	/** Record type ID */
	recordTypeId: TypeId
	/** Record type name (for diagnostics) */
	typeName: string
	/** Parse node ID of the VariableBinding (for diagnostics) */
	bindingNodeId: NodeId
	/** Variable name string ID */
	bindingNameId: StringId
	/** Collected field initializers */
	fieldInits: Array<{ name: string; nodeId: NodeId; exprResult: ExprResult }>
	/** Track field names for duplicate detection */
	fieldNames: Set<string>
}

interface CheckerState {
	readonly insts: InstStore
	readonly scopes: ScopeStore
	readonly symbols: SymbolStore
	readonly types: TypeStore
	currentScope: Scope
	unreachableRange: UnreachableRange | null
	matchContext: MatchContext | null
	typeDeclContext: TypeDeclContext | null
	recordLiteralContext: RecordLiteralContext | null
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
 * Resolve type from a TypeAnnotation node.
 * Handles both primitive types (i32, i64, f32, f64) and user-defined record types.
 * Returns null if the type is unknown.
 */
function resolveTypeFromAnnotation(
	typeAnnotationId: NodeId,
	state: CheckerState,
	context: CompilationContext
): { name: string; typeId: TypeId } | null {
	const typeAnnotationNode = context.nodes.get(typeAnnotationId)
	const typeToken = context.tokens.get(typeAnnotationNode.tokenId)

	// Try primitive type first
	const primitiveType = getTypeNameFromToken(typeToken.kind)
	if (primitiveType) {
		return primitiveType
	}

	// Try user-defined type (identifier)
	if (typeToken.kind === TokenKind.Identifier) {
		const typeName = context.strings.get(typeToken.payload as StringId)
		const typeId = state.types.lookup(typeName)
		if (typeId !== undefined) {
			return { name: typeName, typeId }
		}
		// Type not found - return null (caller will emit error)
	}

	return null
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

/**
 * Try to resolve a flattened record field symbol.
 * For p.x where p is a record, returns the symbol for p_x if it exists.
 */
function tryResolveFlattenedSymbol(
	baseId: NodeId,
	fieldName: string,
	state: CheckerState,
	context: CompilationContext
): { symId: SymbolId; baseName: string } | null {
	const baseNode = context.nodes.get(baseId)
	if (baseNode.kind !== NodeKind.Identifier) return null

	const baseToken = context.tokens.get(baseNode.tokenId)
	const baseName = context.strings.get(baseToken.payload as StringId)
	const flattenedName = `${baseName}_${fieldName}`
	const flattenedNameId = context.strings.intern(flattenedName)
	const symId = state.symbols.lookupByName(flattenedNameId)

	return symId !== undefined ? { baseName, symId } : null
}

/**
 * Emit a VarRef instruction for a flattened symbol.
 */
function emitFlattenedVarRef(exprId: NodeId, symId: SymbolId, state: CheckerState): ExprResult {
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

/**
 * Check for unknown identifier in flattened field access.
 */
function checkFlattenedBaseExists(
	baseId: NodeId,
	state: CheckerState,
	context: CompilationContext
): boolean {
	const baseNode = context.nodes.get(baseId)
	if (baseNode.kind !== NodeKind.Identifier) return true

	const baseToken = context.tokens.get(baseNode.tokenId)
	const baseName = context.strings.get(baseToken.payload as StringId)
	const baseNameId = baseToken.payload as StringId
	const baseSymId = state.symbols.lookupByName(baseNameId)

	if (baseSymId === undefined) {
		context.emitAtNode('TWCHECK013' as DiagnosticCode, baseId, { name: baseName })
		return false
	}
	return true
}

/**
 * Emit standard field access instruction.
 */
function emitFieldAccessInst(
	exprId: NodeId,
	fieldName: string,
	baseResult: { typeId: TypeId; instId: InstId },
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	if (!state.types.isRecordType(baseResult.typeId)) {
		const typeName = state.types.typeName(baseResult.typeId)
		context.emitAtNode('TWCHECK031' as DiagnosticCode, exprId, { name: fieldName, typeName })
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	const fieldInfo = state.types.getField(baseResult.typeId, fieldName)
	if (!fieldInfo) {
		const typeName = state.types.typeName(baseResult.typeId)
		context.emitAtNode('TWCHECK030' as DiagnosticCode, exprId, { name: fieldName, typeName })
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	const instId = state.insts.add({
		arg0: baseResult.instId as number,
		arg1: fieldInfo.index,
		kind: InstKind.FieldAccess,
		parseNodeId: exprId,
		typeId: fieldInfo.typeId,
	})
	return { instId, typeId: fieldInfo.typeId }
}

/**
 * Check a field access expression with type inference.
 * In postorder: [base..., FieldAccess]
 * The base expression is at exprId - 1 (accounting for subtreeSize - 1).
 * The tokenId points to the field name identifier.
 *
 * For flattened record bindings (p: Point → $p_x, $p_y), this resolves
 * p.x directly to the flattened symbol $p_x.
 */
function checkFieldAccessInferred(
	exprId: NodeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const node = context.nodes.get(exprId)
	const baseId = prevNodeId(exprId)
	const fieldToken = context.tokens.get(node.tokenId)
	const fieldName = context.strings.get(fieldToken.payload as StringId)

	// Try flattened symbol resolution first (p.x → p_x)
	const flattened = tryResolveFlattenedSymbol(baseId, fieldName, state, context)
	if (flattened) return emitFlattenedVarRef(exprId, flattened.symId, state)

	// Check for unknown base identifier
	if (!checkFlattenedBaseExists(baseId, state, context)) {
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	// Standard field access handling
	const baseResult = checkExpressionInferred(baseId, state, context)
	if (!isValidExprResult(baseResult)) return baseResult

	return emitFieldAccessInst(exprId, fieldName, baseResult, state, context)
}

/**
 * Check a field access expression with expected type.
 * Validates that the field type matches the expected type.
 */
function checkFieldAccess(
	exprId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const result = checkFieldAccessInferred(exprId, state, context)
	if (!isValidExprResult(result)) return result

	// Check that the field type matches the expected type
	if (!state.types.areEqual(result.typeId, expectedType)) {
		const expected = state.types.typeName(expectedType)
		const found = state.types.typeName(result.typeId)
		context.emitAtNode('TWCHECK012' as DiagnosticCode, exprId, { expected, found })
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	return result
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
		case NodeKind.FieldAccess:
			return checkFieldAccessInferred(exprId, state, context)
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
		case NodeKind.FieldAccess:
			return checkFieldAccess(exprId, expectedType, state, context)
		default:
			// Should be unreachable - all expression kinds should be handled
			console.assert(false, 'checkExpression: unhandled expression kind %d', node.kind)
			return { instId: null, typeId: BuiltinTypeId.Invalid }
	}
}

/**
 * Result of extracting binding nodes from a VariableBinding.
 */
interface BindingNodes {
	identId: NodeId
	typeAnnotationId: NodeId
	exprId: NodeId | null
	hasExpression: boolean
}

/**
 * Extract the node positions for identifier, type annotation, and optional expression
 * from a VariableBinding node in postorder storage.
 */
function extractBindingNodes(bindingId: NodeId, context: CompilationContext): BindingNodes | null {
	const prevId = prevNodeId(bindingId)
	const prevNode = context.nodes.get(prevId)

	if (prevNode.kind === NodeKind.TypeAnnotation) {
		// No expression - record literal mode
		const typeAnnotationId = prevId
		const identId = offsetNodeId(typeAnnotationId, -prevNode.subtreeSize)
		return { exprId: null, hasExpression: false, identId, typeAnnotationId }
	}

	if (isExpressionNode(prevNode.kind)) {
		// Has expression - normal variable binding
		const typeAnnotationId = offsetNodeId(prevId, -prevNode.subtreeSize)
		const typeAnnotationNode = context.nodes.get(typeAnnotationId)
		const identId = offsetNodeId(typeAnnotationId, -typeAnnotationNode.subtreeSize)
		return { exprId: prevId, hasExpression: true, identId, typeAnnotationId }
	}

	// Unexpected node kind
	console.assert(
		false,
		'VariableBinding: expected TypeAnnotation or expression, found %d',
		prevNode.kind
	)
	return null
}

/**
 * Emit unknown type error with the type name from the annotation.
 */
function emitUnknownTypeError(typeAnnotationId: NodeId, context: CompilationContext): void {
	const typeAnnotationNode = context.nodes.get(typeAnnotationId)
	const typeToken = context.tokens.get(typeAnnotationNode.tokenId)
	const typeName =
		typeToken.kind === TokenKind.Identifier
			? context.strings.get(typeToken.payload as StringId)
			: 'unknown'
	context.emitAtNode('TWCHECK010' as DiagnosticCode, typeAnnotationId, {
		found: typeName,
	})
}

/**
 * Handle record literal binding (no expression, record type).
 */
function processRecordLiteralBinding(
	bindingId: NodeId,
	typeAnnotationId: NodeId,
	declaredType: TypeId,
	typeInfo: { name: string; typeId: TypeId },
	nameId: StringId,
	state: CheckerState,
	context: CompilationContext
): void {
	if (state.types.isRecordType(declaredType)) {
		startRecordLiteral(bindingId, declaredType, typeInfo.name, nameId, state, context)
	} else {
		// Non-record type without expression - error
		context.emitAtNode('TWCHECK010' as DiagnosticCode, typeAnnotationId, {
			found: typeInfo.name,
		})
	}
}

/**
 * Process a VariableBinding statement.
 * Syntax: identifier TypeAnnotation = Expression?
 * In postorder with expression: [Identifier, TypeAnnotation, Expression..., VariableBinding]
 * In postorder without expression: [Identifier, TypeAnnotation, VariableBinding]
 *
 * When Expression is absent (record literal mode), the indented lines contain FieldInit nodes.
 */
function processVariableBinding(
	bindingId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	const nodes = extractBindingNodes(bindingId, context)
	if (!nodes) return

	const { exprId, hasExpression, identId, typeAnnotationId } = nodes

	const identNode = context.nodes.get(identId)
	console.assert(
		identNode.kind === NodeKind.Identifier,
		'VariableBinding: expected Identifier, found %d',
		identNode.kind
	)

	const identToken = context.tokens.get(identNode.tokenId)
	const nameId = identToken.payload as StringId

	const typeInfo = resolveTypeFromAnnotation(typeAnnotationId, state, context)
	if (!typeInfo) {
		emitUnknownTypeError(typeAnnotationId, context)
		return
	}

	const declaredType = typeInfo.typeId

	if (!hasExpression) {
		processRecordLiteralBinding(
			bindingId,
			typeAnnotationId,
			declaredType,
			typeInfo,
			nameId,
			state,
			context
		)
		return
	}

	// Normal variable binding with expression
	const exprResult = checkExpression(exprId as NodeId, declaredType, state, context)
	if (!isValidExprResult(exprResult)) return

	const symId = state.symbols.add({
		nameId,
		parseNodeId: bindingId,
		typeId: declaredType,
	})

	state.insts.add({
		arg0: symId as number,
		arg1: exprResult.instId as number,
		kind: InstKind.Bind,
		parseNodeId: bindingId,
		typeId: declaredType,
	})
}

/**
 * Get TypeDecl node from a line (if present).
 */
function getTypeDeclFromLine(
	lineId: NodeId,
	context: CompilationContext
): { id: NodeId; kind: NodeKind } | null {
	for (const [childId, child] of context.nodes.iterateChildren(lineId)) {
		if (child.kind === NodeKind.TypeDecl) {
			return { id: childId, kind: child.kind }
		}
	}
	return null
}

/**
 * Get FieldDecl node from a line (if present).
 */
function getFieldDeclFromLine(
	lineId: NodeId,
	context: CompilationContext
): { id: NodeId; kind: NodeKind } | null {
	for (const [childId, child] of context.nodes.iterateChildren(lineId)) {
		if (child.kind === NodeKind.FieldDecl) {
			return { id: childId, kind: child.kind }
		}
	}
	return null
}

/**
 * Start processing a type declaration.
 * Extracts the type name and initializes the context for collecting fields.
 */
function startTypeDecl(typeDeclId: NodeId, state: CheckerState, context: CompilationContext): void {
	const typeDeclNode = context.nodes.get(typeDeclId)
	// TypeDecl node's tokenId points to the 'type' keyword
	// The type name is in the next token (the identifier)
	const identTokenId = nextTokenId(typeDeclNode.tokenId)
	const identToken = context.tokens.get(identTokenId)
	const typeName = context.strings.get(identToken.payload as StringId)

	state.typeDeclContext = {
		fieldNames: new Set(),
		fields: [],
		typeDeclNodeId: typeDeclId,
		typeName,
	}
}

/**
 * Resolves a user-defined field type by name lookup.
 */
function resolveUserDefinedFieldType(
	fieldTypeName: string,
	fieldDeclId: NodeId,
	state: CheckerState,
	context: CompilationContext
): TypeId | null {
	// Check for self-reference
	if (fieldTypeName === state.typeDeclContext?.typeName) {
		context.emitAtNode('TWCHECK032' as DiagnosticCode, fieldDeclId, {
			field: fieldTypeName,
			type: fieldTypeName,
		})
		return null
	}

	const lookedUpTypeId = state.types.lookup(fieldTypeName)
	if (lookedUpTypeId === undefined) {
		context.emitAtNode('TWCHECK010' as DiagnosticCode, fieldDeclId, {
			name: fieldTypeName,
		})
		return null
	}
	return lookedUpTypeId
}

/**
 * Resolves field type from token (either user-defined or primitive).
 * Returns typeId or null if type is invalid.
 */
function resolveFieldType(
	typeToken: Token,
	fieldDeclId: NodeId,
	state: CheckerState,
	context: CompilationContext
): TypeId | null {
	if (typeToken.kind === TokenKind.Identifier) {
		const fieldTypeName = context.strings.get(typeToken.payload as StringId)
		return resolveUserDefinedFieldType(fieldTypeName, fieldDeclId, state, context)
	}

	// Primitive type
	const typeInfo = getTypeNameFromToken(typeToken.kind)
	if (!typeInfo) {
		context.emitAtNode('TWCHECK010' as DiagnosticCode, fieldDeclId, {
			name: 'unknown',
		})
		return null
	}
	return typeInfo.typeId
}

/**
 * Process a FieldDecl node within a type declaration.
 * Extracts field name and type, checking for duplicates.
 */
function processFieldDecl(
	fieldDeclId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	if (!state.typeDeclContext) {
		// FieldDecl outside type declaration - should not happen if parser is correct
		return
	}

	const fieldDeclNode = context.nodes.get(fieldDeclId)
	const fieldToken = context.tokens.get(fieldDeclNode.tokenId)
	const fieldName = context.strings.get(fieldToken.payload as StringId)

	// Get the type token (field token + 2: skip colon)
	// Token layout: Identifier, Colon, TypeKeyword/Identifier
	const typeTokenId = (fieldDeclNode.tokenId as number) + 2
	const typeToken = context.tokens.get(typeTokenId as typeof fieldDeclNode.tokenId)

	const fieldTypeId = resolveFieldType(typeToken, fieldDeclId, state, context)
	if (!fieldTypeId) {
		return
	}

	// Check for duplicate field names
	if (state.typeDeclContext.fieldNames.has(fieldName)) {
		context.emitAtNode('TWCHECK026' as DiagnosticCode, fieldDeclId, {
			name: fieldName,
			typeName: state.typeDeclContext.typeName,
		})
		return
	}

	state.typeDeclContext.fieldNames.add(fieldName)
	state.typeDeclContext.fields.push({
		name: fieldName,
		nodeId: fieldDeclId,
		typeId: fieldTypeId,
	})
}

/**
 * Finalize a type declaration by registering it with the TypeStore.
 */
function finalizeTypeDecl(state: CheckerState, _context: CompilationContext): void {
	if (!state.typeDeclContext) return

	const { fields, typeDeclNodeId, typeName } = state.typeDeclContext

	// Convert to FieldInfo format
	const fieldInfos = fields.map((f, index) => ({
		index,
		name: f.name,
		typeId: f.typeId,
	}))

	state.types.registerRecordType(typeName, fieldInfos, typeDeclNodeId)
	state.typeDeclContext = null
}

/**
 * Get FieldInit node from a line (if present).
 */
function getFieldInitFromLine(
	lineId: NodeId,
	context: CompilationContext
): { id: NodeId; kind: NodeKind } | null {
	for (const [childId, child] of context.nodes.iterateChildren(lineId)) {
		if (child.kind === NodeKind.FieldInit) {
			return { id: childId, kind: child.kind }
		}
	}
	return null
}

/**
 * Start processing a record literal.
 * Called when we detect a VariableBinding with a record type and no direct expression.
 */
function startRecordLiteral(
	bindingId: NodeId,
	recordTypeId: TypeId,
	typeName: string,
	bindingNameId: StringId,
	state: CheckerState,
	_context: CompilationContext
): void {
	state.recordLiteralContext = {
		bindingNameId,
		bindingNodeId: bindingId,
		fieldInits: [],
		fieldNames: new Set(),
		recordTypeId,
		typeName,
	}
}

/**
 * Process a FieldInit node within a record literal.
 * Extracts field name and expression, checking for duplicates and unknown fields.
 */
function processFieldInit(
	fieldInitId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	if (!state.recordLiteralContext) {
		// FieldInit outside record literal - should not happen if parser is correct
		return
	}

	const fieldInitNode = context.nodes.get(fieldInitId)
	const fieldToken = context.tokens.get(fieldInitNode.tokenId)
	const fieldName = context.strings.get(fieldToken.payload as StringId)

	// Check for duplicate field in initializer
	if (state.recordLiteralContext.fieldNames.has(fieldName)) {
		context.emitAtNode('TWCHECK029' as DiagnosticCode, fieldInitId, {
			name: fieldName,
		})
		return
	}

	// Check if field exists in the record type
	const fieldInfo = state.types.getField(state.recordLiteralContext.recordTypeId, fieldName)
	if (!fieldInfo) {
		context.emitAtNode('TWCHECK028' as DiagnosticCode, fieldInitId, {
			name: fieldName,
			typeName: state.recordLiteralContext.typeName,
		})
		return
	}

	// Get the expression (in postorder, expression is before FieldInit node)
	const exprId = prevNodeId(fieldInitId)
	const exprResult = checkExpression(exprId, fieldInfo.typeId, state, context)

	state.recordLiteralContext.fieldNames.add(fieldName)
	state.recordLiteralContext.fieldInits.push({
		exprResult,
		name: fieldName,
		nodeId: fieldInitId,
	})
}

/**
 * Check for missing fields in record literal and emit errors.
 */
function checkMissingRecordFields(
	recordTypeId: TypeId,
	fieldNames: Set<string>,
	bindingNodeId: NodeId,
	typeName: string,
	state: CheckerState,
	context: CompilationContext
): void {
	const requiredFields = state.types.getFields(recordTypeId)
	for (const field of requiredFields) {
		if (!fieldNames.has(field.name)) {
			context.emitAtNode('TWCHECK027' as DiagnosticCode, bindingNodeId, {
				name: field.name,
				typeName,
			})
		}
	}
}

/**
 * Emit Bind instructions for flattened record field symbols.
 */
function emitRecordFieldBindings(
	fieldSymbolIds: SymbolId[],
	fields: readonly FieldInfo[],
	fieldInits: RecordLiteralContext['fieldInits'],
	bindingNodeId: NodeId,
	state: CheckerState
): void {
	for (let i = 0; i < fieldSymbolIds.length; i++) {
		const symId = fieldSymbolIds[i]
		const field = fields[i]
		const fieldInit = fieldInits.find((fi) => fi.name === field?.name)

		if (symId !== undefined && fieldInit?.exprResult.instId !== undefined && field) {
			state.insts.add({
				arg0: symId as number,
				arg1: fieldInit.exprResult.instId as number,
				kind: InstKind.Bind,
				parseNodeId: bindingNodeId,
				typeId: field.typeId,
			})
		}
	}
}

/**
 * Finalize a record literal by validating all required fields are present
 * and emitting the binding instruction.
 *
 * Creates flattened symbols for each field: p: Point → $p_x, $p_y locals.
 */
function finalizeRecordLiteral(state: CheckerState, context: CompilationContext): void {
	if (!state.recordLiteralContext) return

	const { bindingNameId, bindingNodeId, fieldInits, fieldNames, recordTypeId, typeName } =
		state.recordLiteralContext

	checkMissingRecordFields(recordTypeId, fieldNames, bindingNodeId, typeName, state, context)

	if (!context.hasErrors()) {
		const baseName = context.strings.get(bindingNameId)
		const fields = state.types.getFields(recordTypeId)
		const fieldSymbolIds = state.symbols.declareRecordBinding(
			baseName,
			fields,
			bindingNodeId,
			(name) => context.strings.intern(name)
		)
		emitRecordFieldBindings(fieldSymbolIds, fields, fieldInits, bindingNodeId, state)
	}

	state.recordLiteralContext = null
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

function processIndentedLineAsFieldDecl(
	lineId: NodeId,
	state: CheckerState,
	context: CompilationContext
): boolean {
	if (!state.typeDeclContext) return false

	const fieldDecl = getFieldDeclFromLine(lineId, context)
	if (!fieldDecl) return false

	processFieldDecl(fieldDecl.id, state, context)
	return true
}

function processIndentedLineAsFieldInit(
	lineId: NodeId,
	state: CheckerState,
	context: CompilationContext
): boolean {
	if (!state.recordLiteralContext) return false

	const fieldInit = getFieldInitFromLine(lineId, context)
	if (!fieldInit) return false

	processFieldInit(fieldInit.id, state, context)
	return true
}

function handleIndentedLine(
	lineId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	if (processIndentedLineAsMatchArm(lineId, state, context)) return
	if (processIndentedLineAsFieldDecl(lineId, state, context)) return
	if (processIndentedLineAsFieldInit(lineId, state, context)) return
	context.emitAtNode('TWCHECK001' as DiagnosticCode, lineId)
}

function processDedentLineStatement(
	lineId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	// Check for TypeDecl first (needs special context setup)
	const typeDecl = getTypeDeclFromLine(lineId, context)
	if (typeDecl) {
		startTypeDecl(typeDecl.id, state, context)
		return
	}

	// Handle other statements
	const stmt = getStatementFromLine(lineId, context)
	if (stmt) emitStatement(stmt.id, stmt.kind, state, context)
}

function handleDedentLine(lineId: NodeId, state: CheckerState, context: CompilationContext): void {
	// Finalize pending type declaration and process statement
	if (state.typeDeclContext) {
		finalizeTypeDecl(state, context)
		processDedentLineStatement(lineId, state, context)
		return
	}

	// Finalize pending match context and process statement
	if (state.matchContext) {
		finalizeMatch(state, context)
		processDedentLineStatement(lineId, state, context)
		return
	}

	// Finalize pending record literal and process statement
	if (state.recordLiteralContext) {
		finalizeRecordLiteral(state, context)
		processDedentLineStatement(lineId, state, context)
		return
	}

	// No context - error
	context.emitAtNode('TWCHECK001' as DiagnosticCode, lineId)
}

function handleRootLine(lineId: NodeId, state: CheckerState, context: CompilationContext): void {
	// Finalize any pending type declaration
	if (state.typeDeclContext) finalizeTypeDecl(state, context)

	// Finalize any pending match context
	if (state.matchContext) finalizeMatch(state, context)

	// Finalize any pending record literal
	if (state.recordLiteralContext) finalizeRecordLiteral(state, context)

	// Check if this line contains a type declaration
	const typeDecl = getTypeDeclFromLine(lineId, context)
	if (typeDecl) {
		startTypeDecl(typeDecl.id, state, context)
		return
	}

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

function assignCheckResultsToContext(
	context: CompilationContext,
	insts: InstStore,
	symbols: SymbolStore,
	types: TypeStore
): void {
	context.insts = insts
	context.symbols = symbols
	context.types = types
}

function finalizePendingContexts(state: CheckerState, context: CompilationContext): void {
	if (state.typeDeclContext) finalizeTypeDecl(state, context)
	if (state.matchContext) finalizeMatch(state, context)
	if (state.recordLiteralContext) finalizeRecordLiteral(state, context)
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
		recordLiteralContext: null,
		scopes,
		symbols,
		typeDeclContext: null,
		types,
		unreachableRange: null,
	}

	// Find Program node (last node in postorder storage)
	const nodeCount = context.nodes.count()
	if (nodeCount === 0) {
		assignCheckResultsToContext(context, insts, symbols, types)
		return { succeeded: true }
	}

	const programId = nodeId(nodeCount - 1)
	const program = context.nodes.get(programId)

	if (program.kind !== NodeKind.Program) {
		// No valid Program node - might be a parse error
		assignCheckResultsToContext(context, insts, symbols, types)
		return { succeeded: !context.hasErrors() }
	}

	// Process line children in source order
	const lines = getLineChildrenInSourceOrder(programId, context)
	for (const [lineId, line] of lines) {
		processLine(lineId, line, state, context)
	}

	finalizePendingContexts(state, context)
	flushUnreachableWarning(state, context)
	assignCheckResultsToContext(context, insts, symbols, types)

	return { succeeded: !context.hasErrors() }
}
