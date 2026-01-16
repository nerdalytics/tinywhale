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
import { nextTokenId, type Token, TokenKind } from '../core/tokens.ts'
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
 * Common properties shared by all block context kinds.
 */
interface BlockContextBase {
	typeName: string
	typeId: TypeId | null
	nodeId: NodeId
	children: NodeId[]
	expectedChildKind: NodeKind
	childIndentLevel?: number
	fieldNames: Set<string>
}

/**
 * Context for type declaration blocks.
 */
interface TypeDeclContext extends BlockContextBase {
	kind: 'TypeDecl'
	fields: Array<{ name: string; typeId: TypeId; nodeId: NodeId }>
}

/**
 * Context for record literal blocks (top-level record instantiation).
 */
interface RecordLiteralContext extends BlockContextBase {
	kind: 'RecordLiteral'
	bindingNameId: StringId
	bindingNodeId: NodeId
	fieldInits: Array<{ name: string; nodeId: NodeId; exprResult: ExprResult }>
}

/**
 * Context for nested record initialization blocks.
 */
interface NestedRecordInitContext extends BlockContextBase {
	kind: 'NestedRecordInit'
	fieldName: string
	parentPath: string
	fieldInits: Array<{ name: string; nodeId: NodeId; exprResult: ExprResult }>
}

/**
 * Discriminated union for block-based constructs.
 * All share the pattern: header starts block, indented lines are children, dedent finalizes.
 */
type BlockContext = TypeDeclContext | RecordLiteralContext | NestedRecordInitContext

function pushBlockContext(state: CheckerState, ctx: BlockContext): void {
	state.blockContextStack.push(ctx)
}

function popBlockContext(state: CheckerState): BlockContext | null {
	return state.blockContextStack.pop() ?? null
}

function currentBlockContext(state: CheckerState): BlockContext | null {
	return state.blockContextStack.at(-1) ?? null
}

function parentBlockContext(state: CheckerState): BlockContext | null {
	return state.blockContextStack.at(-2) ?? null
}

void parentBlockContext

interface CheckerState {
	readonly insts: InstStore
	readonly scopes: ScopeStore
	readonly symbols: SymbolStore
	readonly types: TypeStore
	currentScope: Scope
	unreachableRange: UnreachableRange | null
	matchContext: MatchContext | null
	blockContextStack: BlockContext[]
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
 * Extract the size value from a SizeHint node.
 * SizeHint token contains the integer literal value.
 */
function extractSizeFromSizeHint(sizeHintId: NodeId, context: CompilationContext): number | null {
	const sizeHintNode = context.nodes.get(sizeHintId)
	const sizeToken = context.tokens.get(sizeHintNode.tokenId)
	const sizeText = context.strings.get(sizeToken.payload as StringId)
	const size = Number.parseInt(sizeText, 10)
	return Number.isNaN(size) ? null : size
}

/**
 * Resolve the element type from a ListType node.
 * ListType children (in postorder): [SizeHint] or [nestedListType, SizeHint]
 * The tokenId points to the element type keyword/identifier.
 */
function resolveListElementType(
	listTypeId: NodeId,
	state: CheckerState,
	context: CompilationContext
): TypeId | null {
	const listTypeNode = context.nodes.get(listTypeId)
	const elementToken = context.tokens.get(listTypeNode.tokenId)

	// Try primitive types first
	const primitiveType = getTypeNameFromToken(elementToken.kind)
	if (primitiveType) {
		return primitiveType.typeId
	}

	// Try user-defined types
	if (elementToken.kind === TokenKind.Identifier) {
		const typeName = context.strings.get(elementToken.payload as StringId)
		return state.types.lookup(typeName) ?? null
	}

	return null
}

/**
 * Find a child node by kind.
 */
function findChildByKind(
	parentId: NodeId,
	kind: NodeKind,
	context: CompilationContext
): NodeId | null {
	for (const [childId, child] of context.nodes.iterateChildren(parentId)) {
		if (child.kind === kind) return childId
	}
	return null
}

/**
 * Find SizeHint child from a ListType node.
 */
function findSizeHintChild(listTypeId: NodeId, context: CompilationContext): NodeId | null {
	return findChildByKind(listTypeId, NodeKind.SizeHint, context)
}

/**
 * Find nested ListType child from a ListType node.
 */
function findNestedListTypeChild(listTypeId: NodeId, context: CompilationContext): NodeId | null {
	return findChildByKind(listTypeId, NodeKind.ListType, context)
}

/**
 * Validate and extract list size from SizeHint.
 */
function validateListSize(sizeHintId: NodeId, context: CompilationContext): number | null {
	const size = extractSizeFromSizeHint(sizeHintId, context)
	if (size === null) return null

	if (size <= 0) {
		context.emitAtNode('TWCHECK036' as DiagnosticCode, sizeHintId)
		return null
	}

	return size
}

/**
 * Emit unknown element type error for list.
 */
function emitListElementTypeError(listTypeId: NodeId, context: CompilationContext): void {
	const listTypeNode = context.nodes.get(listTypeId)
	const elementToken = context.tokens.get(listTypeNode.tokenId)
	const typeName =
		elementToken.kind === TokenKind.Identifier
			? context.strings.get(elementToken.payload as StringId)
			: 'unknown'
	context.emitAtNode('TWCHECK010' as DiagnosticCode, listTypeId, { found: typeName })
}

/**
 * Resolve element type for a list (handles nested vs simple case).
 */
function resolveListElementTypeForList(
	listTypeId: NodeId,
	nestedListTypeId: NodeId | null,
	state: CheckerState,
	context: CompilationContext
): TypeId | null {
	if (nestedListTypeId !== null) {
		return resolveListType(nestedListTypeId, state, context)?.typeId ?? null
	}
	return resolveListElementType(listTypeId, state, context)
}

/**
 * Resolve type from a ListType node.
 * Handles nested list types and primitive/user-defined element types.
 * Returns null if the type is invalid.
 */
function resolveListType(
	listTypeId: NodeId,
	state: CheckerState,
	context: CompilationContext
): { name: string; typeId: TypeId } | null {
	const sizeHintId = findSizeHintChild(listTypeId, context)
	if (sizeHintId === null) return null

	const size = validateListSize(sizeHintId, context)
	if (size === null) return null

	const nestedListTypeId = findNestedListTypeChild(listTypeId, context)
	const elementTypeId = resolveListElementTypeForList(listTypeId, nestedListTypeId, state, context)

	if (elementTypeId === null) {
		emitListElementTypeError(listTypeId, context)
		return null
	}

	const typeId = state.types.registerListType(elementTypeId, size)
	return { name: state.types.typeName(typeId), typeId }
}

/**
 * Find ListType child from a TypeAnnotation node (if any).
 */
function findListTypeChild(typeAnnotationId: NodeId, context: CompilationContext): NodeId | null {
	for (const [childId, child] of context.nodes.iterateChildren(typeAnnotationId)) {
		if (child.kind === NodeKind.ListType) {
			return childId
		}
	}
	return null
}

/**
 * Resolve user-defined type from identifier token.
 */
function resolveUserDefinedType(
	typeName: string,
	state: CheckerState
): { name: string; typeId: TypeId } | null {
	const typeId = state.types.lookup(typeName)
	return typeId !== undefined ? { name: typeName, typeId } : null
}

/**
 * Resolve type from a TypeAnnotation node.
 * Handles primitive types (i32, i64, f32, f64), user-defined record types, and list types.
 * Returns null if the type is unknown.
 */
function resolveTypeFromAnnotation(
	typeAnnotationId: NodeId,
	state: CheckerState,
	context: CompilationContext
): { name: string; typeId: TypeId } | null {
	// Check for ListType child (for list type annotations)
	const listTypeChildId = findListTypeChild(typeAnnotationId, context)
	if (listTypeChildId !== null) {
		return resolveListType(listTypeChildId, state, context)
	}

	const typeAnnotationNode = context.nodes.get(typeAnnotationId)
	const typeToken = context.tokens.get(typeAnnotationNode.tokenId)

	const primitiveType = getTypeNameFromToken(typeToken.kind)
	if (primitiveType) return primitiveType

	if (typeToken.kind === TokenKind.Identifier) {
		const typeName = context.strings.get(typeToken.payload as StringId)
		return resolveUserDefinedType(typeName, state)
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
 * Build the flattened base path from a FieldAccess chain.
 * For o.inner.val, this builds "o_inner" from the base FieldAccess node.
 */
function buildFlattenedBasePath(nodeId: NodeId, context: CompilationContext): string | null {
	const node = context.nodes.get(nodeId)

	if (node.kind === NodeKind.Identifier) {
		const token = context.tokens.get(node.tokenId)
		return context.strings.get(token.payload as StringId)
	}

	if (node.kind === NodeKind.FieldAccess) {
		const fieldToken = context.tokens.get(node.tokenId)
		const fieldName = context.strings.get(fieldToken.payload as StringId)
		const baseId = prevNodeId(nodeId)
		const basePath = buildFlattenedBasePath(baseId, context)
		if (basePath === null) return null
		return `${basePath}_${fieldName}`
	}

	return null
}

/**
 * Try to resolve a flattened record field symbol.
 * For p.x where p is a record, returns the symbol for p_x if it exists.
 * For nested access like o.inner.val, builds path o_inner_val.
 */
function tryResolveFlattenedSymbol(
	baseId: NodeId,
	fieldName: string,
	state: CheckerState,
	context: CompilationContext
): { symId: SymbolId; baseName: string } | null {
	const basePath = buildFlattenedBasePath(baseId, context)
	if (basePath === null) return null

	const flattenedName = `${basePath}_${fieldName}`
	const flattenedNameId = context.strings.intern(flattenedName)
	const symId = state.symbols.lookupByName(flattenedNameId)

	return symId !== undefined ? { baseName: basePath, symId } : null
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
 * Get the root identifier node from a field access chain.
 * For o.inner.val, returns the node ID for 'o'.
 */
function getRootIdentifierNode(nodeId: NodeId, context: CompilationContext): NodeId | null {
	const node = context.nodes.get(nodeId)
	if (node.kind === NodeKind.Identifier) return nodeId
	if (node.kind === NodeKind.FieldAccess) {
		return getRootIdentifierNode(prevNodeId(nodeId), context)
	}
	return null
}

/**
 * Check for unknown identifier in flattened field access.
 * For nested access like o.inner.val, checks that the root identifier 'o' exists.
 */
function checkFlattenedBaseExists(
	baseId: NodeId,
	state: CheckerState,
	context: CompilationContext
): boolean {
	const rootId = getRootIdentifierNode(baseId, context)
	if (rootId === null) return true

	const rootNode = context.nodes.get(rootId)
	const rootToken = context.tokens.get(rootNode.tokenId)
	const rootName = context.strings.get(rootToken.payload as StringId)
	const rootNameId = rootToken.payload as StringId
	const rootSymId = state.symbols.lookupByName(rootNameId)

	if (rootSymId === undefined) {
		context.emitAtNode('TWCHECK013' as DiagnosticCode, rootId, { name: rootName })
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
 * Try to resolve a flattened list element symbol.
 * For arr[0] where arr is a list, returns the symbol for arr_0 if it exists.
 */
function tryResolveFlattenedListSymbol(
	baseId: NodeId,
	index: number,
	state: CheckerState,
	context: CompilationContext
): SymbolId | null {
	const basePath = buildFlattenedBasePath(baseId, context)
	if (basePath === null) return null

	const flattenedName = `${basePath}_${index}`
	const flattenedNameId = context.strings.intern(flattenedName)
	return state.symbols.lookupByName(flattenedNameId) ?? null
}

/**
 * Check if base is a list binding and validate index bounds.
 * Returns true if it's a list binding (valid or out of bounds).
 * Returns false if it's not a list binding.
 * When out of bounds, emits TWCHECK034.
 */
function checkListBindingBounds(
	baseId: NodeId,
	indexId: NodeId,
	index: number,
	state: CheckerState,
	context: CompilationContext
): { isListBinding: boolean; valid: boolean } {
	const basePath = buildFlattenedBasePath(baseId, context)
	if (basePath === null) return { isListBinding: false, valid: false }

	const baseNameId = context.strings.intern(basePath)
	const listTypeId = state.symbols.getListBinding(baseNameId)

	if (listTypeId === undefined) return { isListBinding: false, valid: false }

	// It's a list binding - check bounds
	const listSize = state.types.getListSize(listTypeId)
	if (listSize !== undefined && !validateListIndexBounds(indexId, index, listSize, context)) {
		return { isListBinding: true, valid: false }
	}

	return { isListBinding: true, valid: true }
}

/**
 * Extract integer index value from an IntLiteral node.
 */
function extractIndexValue(indexNode: ParseNode, context: CompilationContext): number {
	const indexToken = context.tokens.get(indexNode.tokenId)
	const indexText = context.strings.get(indexToken.payload as StringId)
	return Number.parseInt(indexText, 10)
}

/**
 * Validate list index is within bounds.
 */
function validateListIndexBounds(
	indexId: NodeId,
	index: number,
	listSize: number,
	context: CompilationContext
): boolean {
	if (index < 0 || index >= listSize) {
		context.emitAtNode('TWCHECK034' as DiagnosticCode, indexId, {
			index: index.toString(),
			maxIndex: (listSize - 1).toString(),
			size: listSize.toString(),
		})
		return false
	}
	return true
}

/**
 * Emit index access instruction for standard (non-flattened) list access.
 */
function emitIndexAccessInst(
	exprId: NodeId,
	baseResult: ExprResult,
	index: number,
	elementTypeId: TypeId,
	state: CheckerState
): ExprResult {
	const instId = state.insts.add({
		arg0: baseResult.instId as number,
		arg1: index,
		kind: InstKind.FieldAccess, // Reuse FieldAccess for element access
		parseNodeId: exprId,
		typeId: elementTypeId,
	})
	return { instId, typeId: elementTypeId }
}

/**
 * Validate index is IntLiteral and extract its value.
 */
function extractValidatedIndex(
	indexId: NodeId,
	indexNode: ParseNode,
	context: CompilationContext
): number | null {
	if (indexNode.kind !== NodeKind.IntLiteral) {
		context.emitAtNode('TWCHECK035' as DiagnosticCode, indexId)
		return null
	}
	return extractIndexValue(indexNode, context)
}

/**
 * Validate base is a list type and return element access result.
 */
function checkListBaseAndIndex(
	exprId: NodeId,
	indexId: NodeId,
	baseResult: ExprResult,
	index: number,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	if (!state.types.isListType(baseResult.typeId)) {
		const typeName = state.types.typeName(baseResult.typeId)
		context.emitAtNode('TWCHECK031' as DiagnosticCode, exprId, { name: `[${index}]`, typeName })
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	const listSize = state.types.getListSize(baseResult.typeId)
	if (listSize !== undefined && !validateListIndexBounds(indexId, index, listSize, context)) {
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	const elementTypeId = state.types.getListElementType(baseResult.typeId)
	if (elementTypeId === undefined) return { instId: null, typeId: BuiltinTypeId.Invalid }

	return emitIndexAccessInst(exprId, baseResult, index, elementTypeId, state)
}

/**
 * Try early resolution of index access via flattened symbols or bounds checking.
 * Returns ExprResult if resolved, null if should continue to standard handling.
 */
function tryEarlyIndexResolution(
	exprId: NodeId,
	baseId: NodeId,
	indexId: NodeId,
	index: number,
	state: CheckerState,
	context: CompilationContext
): ExprResult | null {
	const symId = tryResolveFlattenedListSymbol(baseId, index, state, context)
	if (symId !== null) return emitFlattenedVarRef(exprId, symId, state)

	const listBoundsResult = checkListBindingBounds(baseId, indexId, index, state, context)
	if (listBoundsResult.isListBinding) {
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	if (!checkFlattenedBaseExists(baseId, state, context)) {
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	return null
}

/**
 * Check an index access expression with type inference.
 * In postorder: [base..., indexExpr, IndexAccess]
 * For lists, validates index bounds and returns element type.
 */
function checkIndexAccessInferred(
	exprId: NodeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const indexId = prevNodeId(exprId)
	const indexNode = context.nodes.get(indexId)
	const baseId = offsetNodeId(indexId, -indexNode.subtreeSize)

	const index = extractValidatedIndex(indexId, indexNode, context)
	if (index === null) return { instId: null, typeId: BuiltinTypeId.Invalid }

	const earlyResult = tryEarlyIndexResolution(exprId, baseId, indexId, index, state, context)
	if (earlyResult !== null) return earlyResult

	const baseResult = checkExpressionInferred(baseId, state, context)
	if (!isValidExprResult(baseResult)) return baseResult

	return checkListBaseAndIndex(exprId, indexId, baseResult, index, state, context)
}

/**
 * Check an index access expression with expected type.
 * Validates that the element type matches the expected type.
 */
function checkIndexAccess(
	exprId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const result = checkIndexAccessInferred(exprId, state, context)
	if (!isValidExprResult(result)) return result

	// Check that the element type matches the expected type
	if (!state.types.areEqual(result.typeId, expectedType)) {
		const expected = state.types.typeName(expectedType)
		const found = state.types.typeName(result.typeId)
		context.emitAtNode('TWCHECK012' as DiagnosticCode, exprId, { expected, found })
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	return result
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

/**
 * Collect element expression IDs from a ListLiteral node.
 * Returns them in source order (reversed from postorder iteration).
 */
function collectListElementIds(listLiteralId: NodeId, context: CompilationContext): NodeId[] {
	const elementIds: NodeId[] = []
	for (const [childId, child] of context.nodes.iterateChildren(listLiteralId)) {
		if (isExpressionNode(child.kind)) {
			elementIds.push(childId)
		}
	}
	return elementIds.reverse()
}

/**
 * Validate list literal element count matches expected size.
 */
function validateListLiteralSize(
	exprId: NodeId,
	actualCount: number,
	expectedSize: number,
	context: CompilationContext
): boolean {
	if (actualCount !== expectedSize) {
		context.emitAtNode('TWCHECK037' as DiagnosticCode, exprId, {
			expected: expectedSize.toString(),
			found: actualCount.toString(),
		})
		return false
	}
	return true
}

/**
 * Type-check list literal elements and collect results.
 */
function checkListElements(
	elementIds: NodeId[],
	elementTypeId: TypeId,
	state: CheckerState,
	context: CompilationContext
): { results: ExprResult[]; hasError: boolean } {
	const results: ExprResult[] = []
	let hasError = false

	for (const elemId of elementIds) {
		const result = checkExpression(elemId, elementTypeId, state, context)
		if (!isValidExprResult(result)) hasError = true
		results.push(result)
	}

	return { hasError, results }
}

/**
 * Validate expected type is a list type and extract metadata.
 */
function validateListExpectedType(
	exprId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): { expectedSize: number; elementTypeId: TypeId } | null {
	if (!state.types.isListType(expectedType)) {
		const expected = state.types.typeName(expectedType)
		context.emitAtNode('TWCHECK012' as DiagnosticCode, exprId, { expected, found: 'list literal' })
		return null
	}

	const expectedSize = state.types.getListSize(expectedType)
	const elementTypeId = state.types.getListElementType(expectedType)
	if (expectedSize === undefined || elementTypeId === undefined) return null

	return { elementTypeId, expectedSize }
}

/**
 * Check a list literal expression with expected type.
 * Validates element count matches expected size and type-checks each element.
 */
function checkListLiteral(
	exprId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const listMeta = validateListExpectedType(exprId, expectedType, state, context)
	if (!listMeta) return { instId: null, typeId: BuiltinTypeId.Invalid }

	const { elementTypeId, expectedSize } = listMeta

	// Collect element IDs and validate count
	const elementIds = collectListElementIds(exprId, context)
	if (!validateListLiteralSize(exprId, elementIds.length, expectedSize, context)) {
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	// Type-check each element
	const { hasError, results } = checkListElements(elementIds, elementTypeId, state, context)
	if (hasError) return { instId: null, typeId: BuiltinTypeId.Invalid }

	// For list literals, we don't emit a single instruction - the bindings handle storage
	return { instId: results[0]?.instId ?? null, typeId: expectedType }
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
		case NodeKind.IndexAccess:
			return checkIndexAccessInferred(exprId, state, context)
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
		case NodeKind.IndexAccess:
			return checkIndexAccess(exprId, expectedType, state, context)
		case NodeKind.ListLiteral:
			return checkListLiteral(exprId, expectedType, state, context)
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
		const typeAnnotationId = prevId
		const identId = offsetNodeId(typeAnnotationId, -prevNode.subtreeSize)
		return { exprId: null, hasExpression: false, identId, typeAnnotationId }
	}

	if (isExpressionNode(prevNode.kind)) {
		const typeAnnotationId = offsetNodeId(prevId, -prevNode.subtreeSize)
		const typeAnnotationNode = context.nodes.get(typeAnnotationId)
		const identId = offsetNodeId(typeAnnotationId, -typeAnnotationNode.subtreeSize)
		return { exprId: prevId, hasExpression: true, identId, typeAnnotationId }
	}

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
		context.emitAtNode('TWCHECK010' as DiagnosticCode, typeAnnotationId, {
			found: typeInfo.name,
		})
	}
}

/**
 * Extract binding identifier info from nodes.
 */
function extractBindingIdentInfo(identId: NodeId, context: CompilationContext): StringId {
	const identNode = context.nodes.get(identId)
	console.assert(
		identNode.kind === NodeKind.Identifier,
		'VariableBinding: expected Identifier, found %d',
		identNode.kind
	)
	const identToken = context.tokens.get(identNode.tokenId)
	return identToken.payload as StringId
}

/**
 * Emit a simple variable binding (non-record, non-list).
 */
function emitSimpleBinding(
	bindingId: NodeId,
	exprId: NodeId,
	declaredType: TypeId,
	nameId: StringId,
	state: CheckerState,
	context: CompilationContext
): void {
	const exprResult = checkExpression(exprId, declaredType, state, context)
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
 * Check if expression is a list literal and type is a list.
 */
function isListLiteralBinding(
	exprId: NodeId,
	declaredType: TypeId,
	state: CheckerState,
	context: CompilationContext
): boolean {
	const exprNode = context.nodes.get(exprId)
	return exprNode.kind === NodeKind.ListLiteral && state.types.isListType(declaredType)
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
	const nameId = extractBindingIdentInfo(identId, context)

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

	if (isListLiteralBinding(exprId as NodeId, declaredType, state, context)) {
		processListLiteralBinding(bindingId, exprId as NodeId, declaredType, nameId, state, context)
		return
	}

	emitSimpleBinding(bindingId, exprId as NodeId, declaredType, nameId, state, context)
}

/**
 * Emit Bind instructions for flattened list element symbols.
 */
function emitListElementBindings(
	symbolIds: SymbolId[],
	elementResults: ExprResult[],
	bindingId: NodeId,
	elementTypeId: TypeId,
	state: CheckerState
): void {
	for (let i = 0; i < symbolIds.length; i++) {
		const symId = symbolIds[i]
		const elemResult = elementResults[i]
		if (symId !== undefined && elemResult && isValidExprResult(elemResult)) {
			state.insts.add({
				arg0: symId as number,
				arg1: elemResult.instId as number,
				kind: InstKind.Bind,
				parseNodeId: bindingId,
				typeId: elementTypeId,
			})
		}
	}
}

/**
 * Process a list literal binding.
 * Creates flattened symbols for each element (arr_0, arr_1, etc.)
 * and emits Bind instructions for each.
 */
function processListLiteralBinding(
	bindingId: NodeId,
	listLiteralId: NodeId,
	listTypeId: TypeId,
	nameId: StringId,
	state: CheckerState,
	context: CompilationContext
): void {
	const expectedSize = state.types.getListSize(listTypeId)
	const elementTypeId = state.types.getListElementType(listTypeId)
	if (expectedSize === undefined || elementTypeId === undefined) return

	// Collect element IDs and validate size
	const elementIds = collectListElementIds(listLiteralId, context)
	if (!validateListLiteralSize(listLiteralId, elementIds.length, expectedSize, context)) return

	// Type-check each element
	const { hasError, results } = checkListElements(elementIds, elementTypeId, state, context)
	if (hasError) return

	// Create flattened symbols and emit bindings
	const baseName = context.strings.get(nameId)
	const symbolIds = state.symbols.declareListBinding(
		baseName,
		listTypeId,
		bindingId,
		(name) => context.strings.intern(name),
		state.types
	)

	emitListElementBindings(symbolIds, results, bindingId, elementTypeId, state)
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

	pushBlockContext(state, {
		children: [],
		expectedChildKind: NodeKind.FieldDecl,
		fieldNames: new Set(),
		fields: [],
		kind: 'TypeDecl',
		nodeId: typeDeclId,
		typeId: null, // Will be assigned after registration
		typeName,
	})
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
	const ctx = currentBlockContext(state)
	if (ctx?.kind === 'TypeDecl' && fieldTypeName === ctx.typeName) {
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
	const ctx = currentBlockContext(state)
	if (!ctx || ctx.kind !== 'TypeDecl') {
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
	if (!fieldTypeId) return

	addFieldToTypeDeclContext(ctx, fieldName, fieldTypeId, fieldDeclId, context)
}

/**
 * Finalize a type declaration by registering it with the TypeStore.
 */
function finalizeTypeDecl(state: CheckerState, _context: CompilationContext): void {
	const ctx = currentBlockContext(state)
	if (!ctx || ctx.kind !== 'TypeDecl') return

	popBlockContext(state)

	const { fields, nodeId, typeName } = ctx
	if (!fields) return

	// Convert to FieldInfo format
	const fieldInfos = fields.map((f, index) => ({
		index,
		name: f.name,
		typeId: f.typeId,
	}))

	state.types.registerRecordType(typeName, fieldInfos, nodeId)
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
 * Get the indent level from a line node.
 * For IndentedLine, the tokenId points to the indent token which has the level in its payload.
 * Returns null if the line's token is not an indent token.
 */
function getIndentLevelFromLine(lineId: NodeId, context: CompilationContext): number | null {
	const node = context.nodes.get(lineId)
	const token = context.tokens.get(node.tokenId)
	if (token.kind === TokenKind.Indent) {
		return token.payload
	}
	return null
}

/**
 * Check if a FieldInit node has a NestedRecordInit child.
 * This indicates a field with user-defined type (in type declaration context)
 * or nested record construction (in record literal context).
 */
function hasNestedRecordInit(fieldInitId: NodeId, context: CompilationContext): boolean {
	for (const [, child] of context.nodes.iterateChildren(fieldInitId)) {
		if (child.kind === NodeKind.NestedRecordInit) {
			return true
		}
	}
	return false
}

/**
 * Get the type name from a NestedRecordInit child of a FieldInit node.
 */
function getNestedRecordTypeName(fieldInitId: NodeId, context: CompilationContext): string | null {
	for (const [, child] of context.nodes.iterateChildren(fieldInitId)) {
		if (child.kind === NodeKind.NestedRecordInit) {
			const typeToken = context.tokens.get(child.tokenId)
			return context.strings.get(typeToken.payload as StringId)
		}
	}
	return null
}

/**
 * Get the NestedRecordInit node ID from a FieldInit node (if present).
 */
function getNestedRecordInitFromFieldInit(
	fieldInitId: NodeId,
	context: CompilationContext
): NodeId | null {
	for (const [childId, child] of context.nodes.iterateChildren(fieldInitId)) {
		if (child.kind === NodeKind.NestedRecordInit) {
			return childId
		}
	}
	return null
}

/**
 * Add a field to the current TypeDecl block context.
 * Returns false if the field name is a duplicate.
 */
function addFieldToTypeDeclContext(
	ctx: TypeDeclContext,
	fieldName: string,
	fieldTypeId: TypeId,
	fieldNodeId: NodeId,
	context: CompilationContext
): boolean {
	if (ctx.fieldNames.has(fieldName)) {
		context.emitAtNode('TWCHECK026' as DiagnosticCode, fieldNodeId, {
			name: fieldName,
			typeName: ctx.typeName,
		})
		return false
	}
	ctx.fieldNames.add(fieldName)
	ctx.fields.push({ name: fieldName, nodeId: fieldNodeId, typeId: fieldTypeId })
	return true
}

/**
 * Process a FieldInit with NestedRecordInit as a type declaration field.
 * This handles the case where a user-defined type field is parsed as FieldInit.
 */
function processFieldInitAsTypeField(
	fieldInitId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	const ctx = currentBlockContext(state)
	if (!ctx || ctx.kind !== 'TypeDecl') return

	const fieldInitNode = context.nodes.get(fieldInitId)
	const fieldToken = context.tokens.get(fieldInitNode.tokenId)
	const fieldName = context.strings.get(fieldToken.payload as StringId)

	const typeName = getNestedRecordTypeName(fieldInitId, context)
	if (!typeName) return

	const fieldTypeId = resolveUserDefinedFieldType(typeName, fieldInitId, state, context)
	if (!fieldTypeId) return

	addFieldToTypeDeclContext(ctx, fieldName, fieldTypeId, fieldInitId, context)
}

/**
 * Start processing a record literal.
 * Called when we detect a VariableBinding with a record type and no direct expression.
 */
function startRecordLiteral(
	bindingNodeId: NodeId,
	recordTypeId: TypeId,
	typeName: string,
	bindingNameId: StringId,
	state: CheckerState,
	_context: CompilationContext
): void {
	pushBlockContext(state, {
		bindingNameId,
		bindingNodeId,
		children: [],
		expectedChildKind: NodeKind.FieldInit,
		fieldInits: [],
		fieldNames: new Set(),
		kind: 'RecordLiteral',
		nodeId: bindingNodeId,
		typeId: recordTypeId,
		typeName,
	})
}

/**
 * Extract field name from a FieldInit node.
 */
function extractFieldInitName(fieldInitId: NodeId, context: CompilationContext): string {
	const fieldInitNode = context.nodes.get(fieldInitId)
	const fieldToken = context.tokens.get(fieldInitNode.tokenId)
	return context.strings.get(fieldToken.payload as StringId)
}

/**
 * Validate that a field is not a duplicate and exists in the record type.
 * Returns field info if valid, null otherwise (errors already emitted).
 */
function validateRecordField(
	fieldInitId: NodeId,
	fieldName: string,
	ctx: BlockContext,
	state: CheckerState,
	context: CompilationContext
): FieldInfo | null {
	if (ctx.fieldNames.has(fieldName)) {
		context.emitAtNode('TWCHECK029' as DiagnosticCode, fieldInitId, { name: fieldName })
		return null
	}

	const recordTypeId = ctx.typeId
	if (recordTypeId === null) return null

	const fieldInfo = state.types.getField(recordTypeId, fieldName)
	if (!fieldInfo) {
		context.emitAtNode('TWCHECK028' as DiagnosticCode, fieldInitId, {
			name: fieldName,
			typeName: ctx.typeName,
		})
		return null
	}

	return fieldInfo
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
		const fieldInit = fieldInits.find((fi: { name: string }) => fi.name === field?.name)

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
 * Emit symbols and bindings for a finalized record literal.
 */
function emitFinalizedRecordLiteral(
	bindingNameId: StringId,
	bindingNodeId: NodeId,
	recordTypeId: TypeId,
	fieldInits: RecordLiteralContext['fieldInits'],
	state: CheckerState,
	context: CompilationContext
): void {
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

/**
 * Type guard for validating RecordLiteral block context has a resolved type.
 */
function isValidRecordLiteralCtx(
	ctx: BlockContext
): ctx is RecordLiteralContext & { typeId: TypeId } {
	return ctx.kind === 'RecordLiteral' && ctx.typeId !== null
}

/**
 * Finalize a record literal by validating all required fields are present
 * and emitting the binding instruction.
 *
 * Creates flattened symbols for each field: p: Point → $p_x, $p_y locals.
 */
function finalizeRecordLiteral(state: CheckerState, context: CompilationContext): void {
	const ctx = currentBlockContext(state)
	if (!ctx || ctx.kind !== 'RecordLiteral') return

	popBlockContext(state)

	if (!isValidRecordLiteralCtx(ctx)) return

	const {
		bindingNameId,
		bindingNodeId,
		fieldInits,
		fieldNames,
		typeId: recordTypeId,
		typeName,
	} = ctx

	checkMissingRecordFields(recordTypeId, fieldNames, bindingNodeId, typeName, state, context)

	if (!context.hasErrors()) {
		emitFinalizedRecordLiteral(
			bindingNameId,
			bindingNodeId,
			recordTypeId,
			fieldInits,
			state,
			context
		)
	}
}

/**
 * Check if we're in a NestedRecordInit block context.
 */
function isInNestedRecordInitContext(state: CheckerState): boolean {
	const ctx = currentBlockContext(state)
	return ctx !== null && ctx.kind === 'NestedRecordInit'
}

/**
 * Validate that the nested record init type matches the expected field type.
 * Returns true if valid, false if there's a mismatch (error already emitted).
 */
function validateNestedRecordTypeMatch(
	nodeId: NodeId,
	fieldName: string,
	typeId: TypeId,
	typeName: string,
	state: CheckerState,
	context: CompilationContext
): boolean {
	const parentCtx = currentBlockContext(state)
	if (!parentCtx?.typeId) return true

	const fieldInfo = state.types.getField(parentCtx.typeId, fieldName)
	if (fieldInfo && fieldInfo.typeId !== typeId) {
		context.emitAtNode('TWCHECK033' as DiagnosticCode, nodeId, {
			expected: state.types.typeName(fieldInfo.typeId),
			got: typeName,
		})
		return false
	}
	return true
}

/**
 * Build the parent path for a nested record field for flattening.
 */
function buildNestedRecordParentPath(
	fieldName: string,
	parentCtx: BlockContext | null,
	context: CompilationContext
): string {
	if (parentCtx?.kind === 'RecordLiteral' && parentCtx.bindingNameId) {
		const baseName = context.strings.get(parentCtx.bindingNameId)
		return `${baseName}_${fieldName}`
	}
	if (parentCtx?.kind === 'NestedRecordInit' && parentCtx.parentPath) {
		return `${parentCtx.parentPath}_${fieldName}`
	}
	return fieldName
}

/**
 * Start processing a nested record initialization.
 * Called when we detect a FieldInit with a NestedRecordInit child in a record literal context.
 * currentIndentLevel is the indent level of the line that contains this nested record init.
 * Children of this nested record should be at currentIndentLevel + 1.
 */
function startNestedRecordInit(
	nestedInitNodeId: NodeId,
	fieldName: string,
	state: CheckerState,
	context: CompilationContext,
	currentIndentLevel?: number
): boolean {
	const nestedInitNode = context.nodes.get(nestedInitNodeId)
	const typeToken = context.tokens.get(nestedInitNode.tokenId)
	const typeName = context.strings.get(typeToken.payload as StringId)

	const typeId = state.types.lookup(typeName)
	if (typeId === undefined) {
		context.emitAtNode('TWCHECK010' as DiagnosticCode, nestedInitNodeId, { name: typeName })
		return false
	}

	if (!validateNestedRecordTypeMatch(nestedInitNodeId, fieldName, typeId, typeName, state, context))
		return false

	const parentCtx = currentBlockContext(state)
	const parentPath = buildNestedRecordParentPath(fieldName, parentCtx, context)

	// Build the context object, conditionally including childIndentLevel
	const ctx: BlockContext = {
		children: [],
		expectedChildKind: NodeKind.FieldInit,
		fieldInits: [],
		fieldName,
		fieldNames: new Set(),
		kind: 'NestedRecordInit',
		nodeId: nestedInitNodeId,
		parentPath,
		typeId,
		typeName,
	}

	// Children of this nested record should be at the next indent level
	if (currentIndentLevel !== undefined) {
		ctx.childIndentLevel = currentIndentLevel + 1
	}

	pushBlockContext(state, ctx)
	return true
}

/**
 * Check if a nested record init context can be validated (has resolved type).
 */
function canValidateNestedRecordFields(
	ctx: BlockContext
): ctx is (RecordLiteralContext | NestedRecordInitContext) & { typeId: TypeId } {
	return (ctx.kind === 'RecordLiteral' || ctx.kind === 'NestedRecordInit') && ctx.typeId !== null
}

/**
 * Type guard for validating NestedRecordInit block context has a resolved type for emission.
 */
function isValidNestedRecordInitCtx(
	ctx: BlockContext
): ctx is NestedRecordInitContext & { typeId: TypeId } {
	return ctx.kind === 'NestedRecordInit' && ctx.typeId !== null
}

/**
 * Emit symbols and bindings for a finalized nested record init.
 * Uses parentPath as the base name for flattened locals (e.g., "o_inner" → "$o_inner_val").
 */
function emitFinalizedNestedRecordInit(
	ctx: NestedRecordInitContext & { typeId: TypeId },
	state: CheckerState,
	context: CompilationContext
): void {
	const fields = state.types.getFields(ctx.typeId)
	const fieldSymbolIds = state.symbols.declareRecordBinding(
		ctx.parentPath,
		fields,
		ctx.nodeId,
		(name) => context.strings.intern(name)
	)
	emitRecordFieldBindings(fieldSymbolIds, fields, ctx.fieldInits, ctx.nodeId, state)
}

/**
 * Validate that all required fields are provided in a nested record init.
 */
function validateNestedRecordMissingFields(
	ctx: BlockContext,
	state: CheckerState,
	context: CompilationContext
): void {
	if (!canValidateNestedRecordFields(ctx)) return
	const requiredFields = state.types.getFields(ctx.typeId)
	for (const field of requiredFields) {
		if (!ctx.fieldNames.has(field.name)) {
			context.emitAtNode('TWCHECK027' as DiagnosticCode, ctx.nodeId, {
				name: field.name,
				typeName: ctx.typeName,
			})
		}
	}
}

/**
 * Register the completed nested record init with its parent context.
 */
function registerNestedRecordWithParent(ctx: NestedRecordInitContext, state: CheckerState): void {
	const parentCtx = currentBlockContext(state)
	if (parentCtx?.kind === 'RecordLiteral' || parentCtx?.kind === 'NestedRecordInit') {
		parentCtx.fieldNames.add(ctx.fieldName)
	}
}

/**
 * Finalize a nested record initialization.
 * Validates all required fields are present, emits symbols and bindings,
 * and registers with parent context.
 */
function finalizeNestedRecordInit(state: CheckerState, context: CompilationContext): void {
	const ctx = currentBlockContext(state)
	if (!ctx || ctx.kind !== 'NestedRecordInit') return

	popBlockContext(state)
	validateNestedRecordMissingFields(ctx, state, context)

	// Emit symbols and bindings for the nested record fields
	if (!context.hasErrors() && isValidNestedRecordInitCtx(ctx)) {
		emitFinalizedNestedRecordInit(ctx, state, context)
	}

	registerNestedRecordWithParent(ctx, state)
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
		return
	}

	// Pattern is before the expression's subtree
	const patternId = offsetNodeId(exprId, -exprNode.subtreeSize)
	const patternNode = context.nodes.get(patternId)

	if (!isPatternNode(patternNode.kind)) {
		return
	}

	checkPattern(patternId, state.matchContext.scrutinee.typeId, state, context)

	const bodyResult = checkExpression(exprId, state.matchContext.expectedType, state, context)

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
		context.emitAtNode('TWCHECK050' as DiagnosticCode, firstNodeId)
	} else {
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

/**
 * Check if we're in a TypeDecl block context.
 */
function isInTypeDeclContext(state: CheckerState): boolean {
	const ctx = currentBlockContext(state)
	return ctx?.kind === 'TypeDecl'
}

/**
 * Check if we're in a RecordLiteral block context.
 */
function isInRecordLiteralContext(state: CheckerState): boolean {
	const ctx = currentBlockContext(state)
	return ctx !== null && ctx.kind === 'RecordLiteral'
}

function processIndentedLineAsFieldDecl(
	lineId: NodeId,
	state: CheckerState,
	context: CompilationContext
): boolean {
	if (!isInTypeDeclContext(state)) return false

	// Try standard FieldDecl first (for primitive types)
	const fieldDecl = getFieldDeclFromLine(lineId, context)
	if (fieldDecl) {
		processFieldDecl(fieldDecl.id, state, context)
		return true
	}

	// Also handle FieldInit with NestedRecordInit as type field (for user-defined types)
	// This occurs because the grammar parses `inner: Inner` as FieldInit when FieldInit is tried first
	const fieldInit = getFieldInitFromLine(lineId, context)
	if (fieldInit && hasNestedRecordInit(fieldInit.id, context)) {
		processFieldInitAsTypeField(fieldInit.id, state, context)
		return true
	}

	return false
}

/**
 * Check if we're in a RecordLiteral or NestedRecordInit block context.
 */
function isInRecordInitContext(state: CheckerState): boolean {
	const ctx = currentBlockContext(state)
	return ctx !== null && (ctx.kind === 'RecordLiteral' || ctx.kind === 'NestedRecordInit')
}

/**
 * Try to start a nested record init from a field init node.
 * Returns true if this field init starts a nested record construction.
 * currentIndentLevel is the indent level of the current line, used to set the expected child level.
 */
function tryStartNestedRecordFromFieldInit(
	fieldInitId: NodeId,
	state: CheckerState,
	context: CompilationContext,
	currentIndentLevel?: number
): boolean {
	if (!hasNestedRecordInit(fieldInitId, context)) return false
	const fieldName = extractFieldInitName(fieldInitId, context)
	const nestedInitNode = getNestedRecordInitFromFieldInit(fieldInitId, context)
	if (nestedInitNode && fieldName) {
		return startNestedRecordInit(nestedInitNode, fieldName, state, context, currentIndentLevel)
	}
	return false
}

function processIndentedLineAsFieldInit(
	lineId: NodeId,
	state: CheckerState,
	context: CompilationContext
): boolean {
	if (!isInRecordInitContext(state)) return false

	const fieldInit = getFieldInitFromLine(lineId, context)
	if (!fieldInit) return false

	// Get the indent level of this line to pass to nested record init
	const currentIndentLevel = getIndentLevelFromLine(lineId, context) ?? undefined

	if (tryStartNestedRecordFromFieldInit(fieldInit.id, state, context, currentIndentLevel))
		return true

	processFieldInitInNestedContext(fieldInit.id, state, context)
	return true
}

/**
 * Process a FieldInit node within a record literal or nested record init context.
 * Handles type checking and registers the field with the current context.
 */
function processFieldInitInNestedContext(
	fieldInitId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	const ctx = currentBlockContext(state)
	if (!ctx || (ctx.kind !== 'RecordLiteral' && ctx.kind !== 'NestedRecordInit')) return

	const fieldName = extractFieldInitName(fieldInitId, context)
	const fieldInfo = validateRecordField(fieldInitId, fieldName, ctx, state, context)
	if (!fieldInfo) return

	const exprId = prevNodeId(fieldInitId)
	const exprResult = checkExpression(exprId, fieldInfo.typeId, state, context)

	ctx.fieldNames.add(fieldName)
	ctx.fieldInits.push({ exprResult, name: fieldName, nodeId: fieldInitId })
}

/**
 * Check if we should finalize a nested record context based on indent level.
 * Returns true if the context should be finalized.
 */
function shouldFinalizeNestedForIndent(state: CheckerState, lineIndentLevel: number): boolean {
	const ctx = currentBlockContext(state)
	return ctx?.childIndentLevel !== undefined && lineIndentLevel < ctx.childIndentLevel
}

/**
 * Finalize nested record contexts when returning to a lower indent level.
 * This handles dedenting from nested blocks while still on an IndentedLine.
 */
function finalizeNestedContextsForIndent(
	state: CheckerState,
	context: CompilationContext,
	lineIndentLevel: number | null
): void {
	if (lineIndentLevel === null) return
	while (
		isInNestedRecordInitContext(state) &&
		shouldFinalizeNestedForIndent(state, lineIndentLevel)
	) {
		finalizeNestedRecordInit(state, context)
	}
}

function handleIndentedLine(
	lineId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	const lineIndentLevel = getIndentLevelFromLine(lineId, context)
	finalizeNestedContextsForIndent(state, context, lineIndentLevel)

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
	// Finalize pending TypeDecl from blockContextStack
	if (isInTypeDeclContext(state)) {
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

	// Finalize pending nested record init - pops back to parent context
	if (isInNestedRecordInitContext(state)) {
		finalizeNestedRecordInit(state, context)
		// After finalizing, we may still be in a record context - handle the dedent line
		// by recursively handling this line (now in the parent context)
		handleDedentLine(lineId, state, context)
		return
	}

	// Finalize pending record literal and process statement
	if (isInRecordLiteralContext(state)) {
		finalizeRecordLiteral(state, context)
		processDedentLineStatement(lineId, state, context)
		return
	}

	// No context - error
	context.emitAtNode('TWCHECK001' as DiagnosticCode, lineId)
}

/**
 * Finalize all pending block contexts before processing a root line.
 */
function finalizeAllPendingBlockContexts(state: CheckerState, context: CompilationContext): void {
	if (isInTypeDeclContext(state)) finalizeTypeDecl(state, context)
	if (state.matchContext) finalizeMatch(state, context)
	while (isInNestedRecordInitContext(state)) finalizeNestedRecordInit(state, context)
	if (isInRecordLiteralContext(state)) finalizeRecordLiteral(state, context)
}

function handleRootLine(lineId: NodeId, state: CheckerState, context: CompilationContext): void {
	finalizeAllPendingBlockContexts(state, context)

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
	// Finalize any pending TypeDecl from blockContextStack
	if (isInTypeDeclContext(state)) finalizeTypeDecl(state, context)

	if (state.matchContext) finalizeMatch(state, context)

	// Finalize any pending nested record inits (unwind the stack)
	while (isInNestedRecordInitContext(state)) {
		finalizeNestedRecordInit(state, context)
	}

	if (isInRecordLiteralContext(state)) finalizeRecordLiteral(state, context)
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
		blockContextStack: [],
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
