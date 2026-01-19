/**
 * Variable binding processing for the Check phase.
 *
 * This module handles:
 * - Variable binding extraction and validation
 * - Simple variable bindings with expressions
 * - List literal bindings with element unpacking
 * - Record literal binding detection (delegates to checker for context setup)
 *
 * This is Layer 3 (Constructs) - imports from expressions.ts (Layer 2).
 */

import type { CompilationContext, StringId } from '../core/context.ts'
import type { DiagnosticCode } from '../core/diagnostics.ts'
import { type NodeId, NodeKind, offsetNodeId, prevNodeId } from '../core/nodes.ts'
import { TokenKind } from '../core/tokens.ts'
import {
	checkExpression,
	checkListElements,
	collectListElementIds,
	validateListLiteralSize,
} from './expressions.ts'
import type { CheckerState, ExprResult } from './state.ts'
import { resolveTypeFromAnnotation } from './type-resolution.ts'
import { InstKind, type SymbolId, type TypeId } from './types.ts'
import { isExpressionNode, isValidExprResult } from './utils.ts'

// ============================================================================
// Types
// ============================================================================

/**
 * Result of extracting binding nodes from a VariableBinding.
 */
interface BindingNodes {
	identId: NodeId
	typeAnnotationId: NodeId
	exprId: NodeId | null
	hasExpression: boolean
}

// ============================================================================
// Internal Helper Functions
// ============================================================================

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
 * Check if binding is a list literal.
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
 * Emit bindings for list elements.
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

	const elementIds = collectListElementIds(listLiteralId, context)
	if (!validateListLiteralSize(listLiteralId, elementIds.length, expectedSize, context)) return

	const { hasError, results } = checkListElements(elementIds, elementTypeId, state, context)
	if (hasError) return

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

// ============================================================================
// Exported Functions
// ============================================================================

/**
 * Emit a simple variable binding.
 * Creates a symbol and emits a Bind instruction.
 */
export function emitSimpleBinding(
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
 * Process a VariableBinding statement.
 * Syntax: identifier TypeAnnotation = Expression?
 * In postorder with expression: [Identifier, TypeAnnotation, Expression..., VariableBinding]
 * In postorder without expression: [Identifier, TypeAnnotation, VariableBinding]
 *
 * When Expression is absent (record literal mode), returns info needed for record literal setup.
 * The caller (checker.ts) handles starting the record literal context.
 *
 * @returns Object with record literal info if no expression and type is a record type, null otherwise
 */
export function processVariableBinding(
	bindingId: NodeId,
	state: CheckerState,
	context: CompilationContext
): {
	isRecordLiteral: true
	typeAnnotationId: NodeId
	declaredType: TypeId
	typeInfo: { name: string; typeId: TypeId }
	nameId: StringId
} | null {
	const nodes = extractBindingNodes(bindingId, context)
	if (!nodes) return null

	const { exprId, hasExpression, identId, typeAnnotationId } = nodes
	const nameId = extractBindingIdentInfo(identId, context)

	const typeInfo = resolveTypeFromAnnotation(typeAnnotationId, state, context)
	if (!typeInfo) {
		emitUnknownTypeError(typeAnnotationId, context)
		return null
	}

	const declaredType = typeInfo.typeId

	if (!hasExpression) {
		// No expression - this could be a record literal
		// Return info for the caller to set up record literal context
		return {
			declaredType,
			isRecordLiteral: true,
			nameId,
			typeAnnotationId,
			typeInfo,
		}
	}

	if (isListLiteralBinding(exprId as NodeId, declaredType, state, context)) {
		processListLiteralBinding(bindingId, exprId as NodeId, declaredType, nameId, state, context)
		return null
	}

	emitSimpleBinding(bindingId, exprId as NodeId, declaredType, nameId, state, context)
	return null
}

/**
 * Extract binding nodes from a PrimitiveBinding.
 * Structure: [Identifier, TypeAnnotation, Expression, PrimitiveBinding]
 */
function extractPrimitiveBindingNodes(
	bindingId: NodeId,
	context: CompilationContext
): { identId: NodeId; typeAnnotationId: NodeId; exprId: NodeId } | null {
	const prevId = prevNodeId(bindingId)
	const prevNode = context.nodes.get(prevId)

	// Expression is immediately before the PrimitiveBinding
	if (!isExpressionNode(prevNode.kind)) {
		console.assert(false, 'PrimitiveBinding: expected expression, found %d', prevNode.kind)
		return null
	}

	const exprId = prevId
	const typeAnnotationId = offsetNodeId(prevId, -prevNode.subtreeSize)
	const typeAnnotationNode = context.nodes.get(typeAnnotationId)

	if (typeAnnotationNode.kind !== NodeKind.TypeAnnotation) {
		console.assert(
			false,
			'PrimitiveBinding: expected TypeAnnotation, found %d',
			typeAnnotationNode.kind
		)
		return null
	}

	const identId = offsetNodeId(typeAnnotationId, -typeAnnotationNode.subtreeSize)
	return { exprId, identId, typeAnnotationId }
}

/**
 * Process a PrimitiveBinding statement.
 * Syntax: identifier : PrimitiveTypeRef = Expression
 * Always has an expression (required for primitive types).
 */
export function processPrimitiveBinding(
	bindingId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	const nodes = extractPrimitiveBindingNodes(bindingId, context)
	if (!nodes) return

	const { exprId, identId, typeAnnotationId } = nodes
	const nameId = extractBindingIdentInfo(identId, context)

	const typeInfo = resolveTypeFromAnnotation(typeAnnotationId, state, context)
	if (!typeInfo) {
		emitUnknownTypeError(typeAnnotationId, context)
		return
	}

	const declaredType = typeInfo.typeId

	if (isListLiteralBinding(exprId, declaredType, state, context)) {
		processListLiteralBinding(bindingId, exprId, declaredType, nameId, state, context)
		return
	}

	emitSimpleBinding(bindingId, exprId, declaredType, nameId, state, context)
}

/**
 * Extract binding nodes from a RecordBinding.
 * Structure: [Identifier, TypeAnnotation, RecordBinding]
 */
function extractRecordBindingNodes(
	bindingId: NodeId,
	context: CompilationContext
): { identId: NodeId; typeAnnotationId: NodeId } | null {
	const typeAnnotationId = prevNodeId(bindingId)
	const typeAnnotationNode = context.nodes.get(typeAnnotationId)

	if (typeAnnotationNode.kind !== NodeKind.TypeAnnotation) {
		console.assert(
			false,
			'RecordBinding: expected TypeAnnotation, found %d',
			typeAnnotationNode.kind
		)
		return null
	}

	const identId = offsetNodeId(typeAnnotationId, -typeAnnotationNode.subtreeSize)
	return { identId, typeAnnotationId }
}

/**
 * Process a RecordBinding statement.
 * Syntax: identifier : upperIdentifier =
 * No expression - record type with block follows.
 * Returns info for record literal setup.
 */
export function processRecordBinding(
	bindingId: NodeId,
	state: CheckerState,
	context: CompilationContext
): {
	isRecordLiteral: true
	typeAnnotationId: NodeId
	declaredType: TypeId
	typeInfo: { name: string; typeId: TypeId }
	nameId: StringId
} | null {
	const nodes = extractRecordBindingNodes(bindingId, context)
	if (!nodes) return null

	const { identId, typeAnnotationId } = nodes
	const nameId = extractBindingIdentInfo(identId, context)

	const typeInfo = resolveTypeFromAnnotation(typeAnnotationId, state, context)
	if (!typeInfo) {
		emitUnknownTypeError(typeAnnotationId, context)
		return null
	}

	const declaredType = typeInfo.typeId

	// Record binding always returns record literal info
	return {
		declaredType,
		isRecordLiteral: true,
		nameId,
		typeAnnotationId,
		typeInfo,
	}
}
