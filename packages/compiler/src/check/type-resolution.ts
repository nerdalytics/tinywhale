/**
 * Type resolution functions for the Check phase.
 *
 * This module handles:
 * - Primitive type name resolution from tokens
 * - List type resolution with size validation
 * - User-defined type resolution
 * - Bounded primitive resolution (type bounds like `i32<min=0, max=100>`)
 * - Refinement constraint checking
 * - Integer constant emission helpers
 */

import type { CompilationContext, StringId } from '../core/context.ts'
import type { DiagnosticCode } from '../core/diagnostics.ts'
import type { NodeId } from '../core/nodes.ts'
import { NodeKind } from '../core/nodes.ts'
import { TokenKind } from '../core/tokens.ts'
import type { CheckerState, ExprResult } from './state.ts'
import { BuiltinTypeId, InstKind, type TypeConstraints, type TypeId } from './types.ts'
import { fitsInConstraints, isIntegerType, splitBigIntTo32BitParts } from './utils.ts'

// ============================================================================
// Type Name Resolution
// ============================================================================

/**
 * Get primitive type from token kind.
 */
export function getTypeNameFromToken(
	tokenKind: TokenKind
): { name: string; typeId: TypeId } | null {
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

// ============================================================================
// List Type Resolution (Internal Helpers)
// ============================================================================

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

function extractSizeFromSizeBound(sizeBoundId: NodeId, context: CompilationContext): number | null {
	const sizeBoundNode = context.nodes.get(sizeBoundId)
	const sizeToken = context.tokens.get(sizeBoundNode.tokenId)
	const sizeText = context.strings.get(sizeToken.payload as StringId)
	const size = Number.parseInt(sizeText, 10)
	return Number.isNaN(size) ? null : size
}

/**
 * Extract size from a TypeBounds node.
 * For list types, there should be exactly one bound (the size).
 */
function extractSizeFromTypeBounds(
	typeBoundsId: NodeId,
	context: CompilationContext
): number | null {
	const boundId = findChildByKind(typeBoundsId, NodeKind.Bound, context)
	if (boundId === null) return null

	const boundNode = context.nodes.get(boundId)
	const valueToken = context.tokens.get(boundNode.tokenId)
	const valueText = context.strings.get(valueToken.payload as StringId)
	const size = Number.parseInt(valueText, 10)
	return Number.isNaN(size) ? null : size
}

function resolveListElementType(
	listTypeId: NodeId,
	state: CheckerState,
	context: CompilationContext
): TypeId | null {
	const listTypeNode = context.nodes.get(listTypeId)
	const elementToken = context.tokens.get(listTypeNode.tokenId)

	const primitiveType = getTypeNameFromToken(elementToken.kind)
	if (primitiveType) {
		return primitiveType.typeId
	}

	if (elementToken.kind === TokenKind.Identifier) {
		const typeName = context.strings.get(elementToken.payload as StringId)
		return state.types.lookup(typeName) ?? null
	}

	return null
}

function findSizeBoundChild(listTypeId: NodeId, context: CompilationContext): NodeId | null {
	const typeBoundsId = findChildByKind(listTypeId, NodeKind.TypeBounds, context)
	if (typeBoundsId !== null) return typeBoundsId

	// Fall back to SizeBound for backward compatibility
	return findChildByKind(listTypeId, NodeKind.SizeBound, context)
}

function findNestedListTypeChild(listTypeId: NodeId, context: CompilationContext): NodeId | null {
	return findChildByKind(listTypeId, NodeKind.ListType, context)
}

function validateListSize(sizeBoundId: NodeId, context: CompilationContext): number | null {
	const node = context.nodes.get(sizeBoundId)

	let size: number | null
	if (node.kind === NodeKind.TypeBounds) {
		size = extractSizeFromTypeBounds(sizeBoundId, context)
	} else {
		size = extractSizeFromSizeBound(sizeBoundId, context)
	}

	if (size === null) return null

	if (size <= 0) {
		context.emitAtNode('TWCHECK036' as DiagnosticCode, sizeBoundId)
		return null
	}

	return size
}

function emitListElementTypeError(listTypeId: NodeId, context: CompilationContext): void {
	const listTypeNode = context.nodes.get(listTypeId)
	const elementToken = context.tokens.get(listTypeNode.tokenId)
	const typeName =
		elementToken.kind === TokenKind.Identifier
			? context.strings.get(elementToken.payload as StringId)
			: 'unknown'
	context.emitAtNode('TWCHECK010' as DiagnosticCode, listTypeId, { found: typeName })
}

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

// ============================================================================
// List Type Resolution (Exported)
// ============================================================================

/**
 * Resolve a list type from a ListType node.
 */
export function resolveListType(
	listTypeId: NodeId,
	state: CheckerState,
	context: CompilationContext
): { name: string; typeId: TypeId } | null {
	const sizeBoundId = findSizeBoundChild(listTypeId, context)
	if (sizeBoundId === null) return null

	const size = validateListSize(sizeBoundId, context)
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

function findListTypeChild(typeAnnotationId: NodeId, context: CompilationContext): NodeId | null {
	for (const [childId, child] of context.nodes.iterateChildren(typeAnnotationId)) {
		if (child.kind === NodeKind.ListType) {
			return childId
		}
	}
	return null
}

// ============================================================================
// User-Defined Type Resolution
// ============================================================================

/**
 * Resolve a user-defined type by name.
 */
export function resolveUserDefinedType(
	typeName: string,
	state: CheckerState
): { name: string; typeId: TypeId } | null {
	const typeId = state.types.lookup(typeName)
	return typeId !== undefined ? { name: typeName, typeId } : null
}

// ============================================================================
// Bounded Primitive Resolution (Internal Helpers)
// ============================================================================

function findRefinementTypeChild(
	typeAnnotationId: NodeId,
	context: CompilationContext
): NodeId | null {
	return findChildByKind(typeAnnotationId, NodeKind.RefinementType, context)
}

function hasMinOrMaxConstraint(constraints: { min?: bigint; max?: bigint } | null): boolean {
	return constraints?.min !== undefined || constraints?.max !== undefined
}

function extractBoundValue(boundId: NodeId, context: CompilationContext): bigint {
	const boundNode = context.nodes.get(boundId)
	const valueToken = context.tokens.get(boundNode.tokenId)
	const valueText = context.strings.get(valueToken.payload as StringId)
	const line = context.getSourceLine(valueToken.line) ?? ''
	const beforeValue = line.substring(0, valueToken.column - 1).trimEnd()
	const isNegative = beforeValue.endsWith('-')
	return isNegative ? -BigInt(valueText) : BigInt(valueText)
}

function parseKeywordFromPrefix(prefix: string): string | null {
	const trimmed = prefix.trim()
	if (trimmed.endsWith('min')) return 'min'
	if (trimmed.endsWith('max')) return 'max'
	if (trimmed.endsWith('size')) return 'size'
	return null
}

function extractBoundKeyword(boundId: NodeId, context: CompilationContext): string | null {
	const boundNode = context.nodes.get(boundId)
	const valueToken = context.tokens.get(boundNode.tokenId)
	const line = context.getSourceLine(valueToken.line)
	if (!line) return null

	const beforeValue = line.substring(0, valueToken.column - 1)
	const eqPos = beforeValue.lastIndexOf('=')
	if (eqPos === -1) return null

	return parseKeywordFromPrefix(beforeValue.substring(0, eqPos))
}

function processBoundNode(
	boundId: NodeId,
	context: CompilationContext,
	constraints: { min?: bigint; max?: bigint }
): void {
	const value = extractBoundValue(boundId, context)
	const keyword = extractBoundKeyword(boundId, context)
	if (keyword === 'min') constraints.min = value
	else if (keyword === 'max') constraints.max = value
}

// ============================================================================
// Bounded Primitive Resolution (Exported)
// ============================================================================

/**
 * Extract min/max constraints from a TypeBounds node.
 */
export function extractConstraintsFromTypeBounds(
	typeBoundsId: NodeId,
	context: CompilationContext
): { min?: bigint; max?: bigint } | null {
	const constraints: { min?: bigint; max?: bigint } = {}
	for (const [boundId, boundNode] of context.nodes.iterateChildren(typeBoundsId)) {
		if (boundNode.kind === NodeKind.Bound) {
			processBoundNode(boundId, context, constraints)
		}
	}
	return constraints
}

/**
 * Apply refinement constraints to a base type.
 * Returns refined type if constraints are valid, null if invalid.
 */
function applyRefinementConstraints(
	baseType: { name: string; typeId: TypeId },
	constraints: TypeConstraints,
	refinementTypeId: NodeId,
	state: CheckerState,
	context: CompilationContext
): { name: string; typeId: TypeId } | null {
	if (!isIntegerType(baseType.typeId)) {
		context.emitAtNode('TWCHECK040' as DiagnosticCode, refinementTypeId, {
			type: baseType.name,
		})
		return null
	}
	const refinedTypeId = state.types.registerRefinedType(baseType.typeId, constraints)
	return { name: state.types.typeName(refinedTypeId), typeId: refinedTypeId }
}

/**
 * Resolve a refinement type (e.g., `i32<min=0, max=100>`).
 */
export function resolveRefinementType(
	refinementTypeId: NodeId,
	state: CheckerState,
	context: CompilationContext
): { name: string; typeId: TypeId } | null {
	const refinementTypeNode = context.nodes.get(refinementTypeId)
	const baseToken = context.tokens.get(refinementTypeNode.tokenId)
	const baseType = getTypeNameFromToken(baseToken.kind)
	if (!baseType) return null

	const typeBoundsId = findChildByKind(refinementTypeId, NodeKind.TypeBounds, context)
	if (typeBoundsId === null) return baseType

	const constraints = extractConstraintsFromTypeBounds(typeBoundsId, context)
	if (!constraints || !hasMinOrMaxConstraint(constraints)) return baseType

	return applyRefinementConstraints(baseType, constraints, refinementTypeId, state, context)
}

// ============================================================================
// Main Type Resolution
// ============================================================================

/**
 * Resolve a type from a TypeAnnotation node.
 * Handles list types, refinement types, primitive types, and user-defined types.
 */
export function resolveTypeFromAnnotation(
	typeAnnotationId: NodeId,
	state: CheckerState,
	context: CompilationContext
): { name: string; typeId: TypeId } | null {
	const listTypeChildId = findListTypeChild(typeAnnotationId, context)
	if (listTypeChildId !== null) {
		return resolveListType(listTypeChildId, state, context)
	}

	const refinementTypeId = findRefinementTypeChild(typeAnnotationId, context)
	if (refinementTypeId !== null) {
		return resolveRefinementType(refinementTypeId, state, context)
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

// ============================================================================
// Refinement Constraint Checking
// ============================================================================

/**
 * Check refinement constraints on a value and emit error if violated.
 * Returns the error result if constraints are violated, null otherwise.
 */
export function checkRefinementConstraints(
	nodeId: NodeId,
	value: bigint,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult | null {
	if (!state.types.isRefinedType(expectedType)) return null
	const constraints = state.types.getConstraints(expectedType)
	if (!constraints || fitsInConstraints(value, constraints)) return null
	return emitConstraintViolationError(nodeId, value, constraints, context)
}

// ============================================================================
// Emission Helpers
// ============================================================================

/**
 * Emit an integer constant instruction.
 */
export function emitIntConstInst(
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

/**
 * Emit a constraint violation error.
 */
export function emitConstraintViolationError(
	nodeId: NodeId,
	value: bigint,
	constraints: { min?: bigint; max?: bigint },
	context: CompilationContext
): ExprResult {
	let constraint: string
	if (constraints.min !== undefined && value < constraints.min) {
		constraint = `min=${constraints.min}`
	} else {
		constraint = `max=${constraints.max}`
	}
	context.emitAtNode('TWCHECK041' as DiagnosticCode, nodeId, {
		constraint,
		value: value.toString(),
	})
	return { instId: null, typeId: BuiltinTypeId.Invalid }
}

/**
 * Emit an integer bounds error.
 */
export function emitIntBoundsError(
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

/**
 * Parse an integer literal, handling scientific notation.
 */
export function parseIntegerLiteral(text: string): bigint {
	const expMatch = text.match(/^(\d+)[eE]([+-]?\d+)$/)
	if (expMatch) {
		const base = BigInt(expMatch[1] as string)
		const exp = Number(expMatch[2])
		if (exp < 0) throw new Error('Negative exponent not allowed for integers')
		return base * 10n ** BigInt(exp)
	}
	return BigInt(text)
}
