/**
 * Expression checking for the Check phase.
 *
 * This module is the HUB for expression evaluation. It handles:
 * - Literal checking (int, float)
 * - Unary expressions (negate, bitwise not)
 * - Binary expressions (arithmetic, comparison, logical)
 * - Compare chains
 * - Variable references
 * - Field and index access
 * - List literals
 *
 * CRITICAL: This module exports checkExpression and checkExpressionInferred
 * which are used by higher-level modules (bindings, records, match).
 * It does NOT import from those modules to prevent cyclic imports.
 */

import type { CompilationContext, StringId } from '../core/context.ts'
import type { DiagnosticCode } from '../core/diagnostics.ts'
import { type NodeId, NodeKind, offsetNodeId, type ParseNode, prevNodeId } from '../core/nodes.ts'
import { type TokenId, TokenKind } from '../core/tokens.ts'
import { handleFuncCall } from './funcs.ts'
import type { CheckerState, ExprResult } from './state.ts'
import {
	checkRefinementConstraints,
	emitIntBoundsError,
	emitIntConstInst,
	parseIntegerLiteral,
} from './type-resolution.ts'
import { BuiltinTypeId, type InstId, InstKind, type SymbolId, type TypeId } from './types.ts'
import {
	fitsInBaseBounds,
	getOperatorName,
	isComparisonOperator,
	isExpressionNode,
	isFloatType,
	isIntegerOnlyOperator,
	isIntegerType,
	isLogicalOperator,
	isValidExprResult,
	isValidF32,
} from './utils.ts'

// ============================================================================
// Utility Functions
// ============================================================================

function applyNegation(value: number, negate: boolean): number {
	return negate ? -value : value
}

function formatDisplayValue(literalText: string, negate: boolean): string {
	return negate ? `-${literalText}` : literalText
}

// ============================================================================
// Float Literal Checking
// ============================================================================

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

// ============================================================================
// Integer Literal Checking
// ============================================================================

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

	// Check base type bounds (TWCHECK014)
	const baseTypeId = state.types.toWasmType(expectedType)
	if (!fitsInBaseBounds(value, baseTypeId)) {
		const typeName = state.types.typeName(expectedType)
		return emitIntBoundsError(nodeId, typeName, formatDisplayValue(literalText, negate), context)
	}

	// Check refinement constraints (TWCHECK041)
	const constraintError = checkRefinementConstraints(nodeId, value, expectedType, state, context)
	if (constraintError) return constraintError

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

// ============================================================================
// Variable Reference
// ============================================================================

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

// ============================================================================
// Unary Expressions
// ============================================================================

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

function checkParenExpr(
	exprNodeId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const childId = prevNodeId(exprNodeId)
	return checkExpression(childId, expectedType, state, context)
}

// ============================================================================
// Binary Expressions
// ============================================================================

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

// ============================================================================
// Compare Chains
// ============================================================================

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

// ============================================================================
// Identifier (Inferred)
// ============================================================================

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

// ============================================================================
// Field Access
// ============================================================================

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
 * Check a field access expression with type inference.
 * In postorder: [base..., FieldAccess]
 * The base expression is at exprId - 1 (accounting for subtreeSize - 1).
 * The tokenId points to the field name identifier.
 *
 * For flattened record bindings (p: Point -> $p_x, $p_y), this resolves
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

	const flattened = tryResolveFlattenedSymbol(baseId, fieldName, state, context)
	if (flattened) return emitFlattenedVarRef(exprId, flattened.symId, state)

	if (!checkFlattenedBaseExists(baseId, state, context)) {
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

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

	if (!state.types.areEqual(result.typeId, expectedType)) {
		const expected = state.types.typeName(expectedType)
		const found = state.types.typeName(result.typeId)
		context.emitAtNode('TWCHECK012' as DiagnosticCode, exprId, { expected, found })
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	return result
}

// ============================================================================
// Index Access
// ============================================================================

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

	const listSize = state.types.getListSize(listTypeId)
	if (listSize !== undefined && !validateListIndexBounds(indexId, index, listSize, context)) {
		return { isListBinding: true, valid: false }
	}

	return { isListBinding: true, valid: true }
}

function extractIndexValue(indexNode: { tokenId: TokenId }, context: CompilationContext): number {
	const indexToken = context.tokens.get(indexNode.tokenId)
	const indexText = context.strings.get(indexToken.payload as StringId)
	return Number.parseInt(indexText, 10)
}

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
		kind: InstKind.FieldAccess,
		parseNodeId: exprId,
		typeId: elementTypeId,
	})
	return { instId, typeId: elementTypeId }
}

function extractValidatedIndex(
	indexId: NodeId,
	indexNode: { kind: NodeKind; tokenId: TokenId },
	context: CompilationContext
): number | null {
	if (indexNode.kind !== NodeKind.IntLiteral) {
		context.emitAtNode('TWCHECK035' as DiagnosticCode, indexId)
		return null
	}
	return extractIndexValue(indexNode, context)
}

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

function checkIndexAccess(
	exprId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const result = checkIndexAccessInferred(exprId, state, context)
	if (!isValidExprResult(result)) return result

	if (!state.types.areEqual(result.typeId, expectedType)) {
		const expected = state.types.typeName(expectedType)
		const found = state.types.typeName(result.typeId)
		context.emitAtNode('TWCHECK012' as DiagnosticCode, exprId, { expected, found })
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	return result
}

// ============================================================================
// List Literals
// ============================================================================

export function collectListElementIds(
	listLiteralId: NodeId,
	context: CompilationContext
): NodeId[] {
	const elementIds: NodeId[] = []
	for (const [childId, child] of context.nodes.iterateChildren(listLiteralId)) {
		if (isExpressionNode(child.kind)) {
			elementIds.push(childId)
		}
	}
	return elementIds.reverse()
}

export function validateListLiteralSize(
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

export function checkListElements(
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

function checkListLiteral(
	exprId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const listMeta = validateListExpectedType(exprId, expectedType, state, context)
	if (!listMeta) return { instId: null, typeId: BuiltinTypeId.Invalid }

	const { elementTypeId, expectedSize } = listMeta

	const elementIds = collectListElementIds(exprId, context)
	if (!validateListLiteralSize(exprId, elementIds.length, expectedSize, context)) {
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	const { hasError, results } = checkListElements(elementIds, elementTypeId, state, context)
	if (hasError) return { instId: null, typeId: BuiltinTypeId.Invalid }

	return { instId: results[0]?.instId ?? null, typeId: expectedType }
}

// ============================================================================
// Main Expression Dispatch
// ============================================================================

/**
 * Check an expression with type inference.
 * Used when the expected type is not known ahead of time.
 */
export function checkExpressionInferred(
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
		case NodeKind.FuncCall:
			return handleFuncCall(exprId, state, context, checkExpressionInferred)
		default:
			return { instId: null, typeId: BuiltinTypeId.Invalid }
	}
}

/**
 * Check an expression with an expected type.
 * The expression must produce the expected type or a type error is emitted.
 */
export function checkExpression(
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
		case NodeKind.FuncCall:
			return handleFuncCall(exprId, state, context, checkExpressionInferred)
		default:
			console.assert(false, 'checkExpression: unhandled expression kind %d', node.kind)
			return { instId: null, typeId: BuiltinTypeId.Invalid }
	}
}
