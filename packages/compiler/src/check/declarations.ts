/**
 * Type declaration processing functions for the Check phase.
 *
 * This module handles:
 * - Type declaration detection from line nodes
 * - Field declaration processing within type declarations
 * - Type finalization and registration
 */

import type { CompilationContext, StringId } from '../core/context.ts'
import type { DiagnosticCode } from '../core/diagnostics.ts'
import type { NodeId } from '../core/nodes.ts'
import { NodeKind } from '../core/nodes.ts'
import type { Token } from '../core/tokens.ts'
import { nextTokenId, TokenKind } from '../core/tokens.ts'
import type { CheckerState, TypeDeclContext } from './state.ts'
import { currentBlockContext, popBlockContext, pushBlockContext } from './state.ts'
import { getTypeNameFromToken, resolveListType, resolveRefinementType } from './type-resolution.ts'
import type { TypeId } from './types.ts'

// ============================================================================
// Type Declaration Detection
// ============================================================================

/**
 * Get TypeDecl node from a line (if present).
 */
export function getTypeDeclFromLine(
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

// ============================================================================
// Type Declaration Processing
// ============================================================================

/**
 * Start processing a type declaration.
 * Extracts the type name and initializes the context for collecting fields.
 */
export function startTypeDecl(
	typeDeclId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
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

// ============================================================================
// Field Type Resolution (Internal)
// ============================================================================

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
 * Maps node kinds to complex type identifiers for field type resolution.
 */
const complexTypeKinds = new Map<NodeKind, 'refinement' | 'list'>([
	[NodeKind.RefinementType, 'refinement'],
	[NodeKind.ListType, 'list'],
])

/**
 * Find a complex type child (RefinementType or ListType) in a FieldDecl.
 */
function findComplexTypeChild(
	fieldDeclId: NodeId,
	context: CompilationContext
): { kind: 'refinement' | 'list'; nodeId: NodeId } | null {
	for (const [childId, child] of context.nodes.iterateChildren(fieldDeclId)) {
		const kind = complexTypeKinds.get(child.kind)
		if (kind) {
			return { kind, nodeId: childId }
		}
	}
	return null
}

/**
 * Resolve field type by traversing node children.
 * Handles refinement types, list types, user-defined types, and primitives.
 */
function resolveFieldTypeFromNode(
	fieldDeclId: NodeId,
	state: CheckerState,
	context: CompilationContext
): TypeId | null {
	const complexType = findComplexTypeChild(fieldDeclId, context)
	if (complexType) {
		const result =
			complexType.kind === 'refinement'
				? resolveRefinementType(complexType.nodeId, state, context)
				: resolveListType(complexType.nodeId, state, context)
		return result?.typeId ?? null
	}

	// Fall back to token-based resolution for simple types (primitives, user-defined)
	const fieldDeclNode = context.nodes.get(fieldDeclId)
	const typeTokenId = (fieldDeclNode.tokenId as number) + 2
	const typeToken = context.tokens.get(typeTokenId as typeof fieldDeclNode.tokenId)

	return resolveFieldType(typeToken, fieldDeclId, state, context)
}

// ============================================================================
// Field Context Management (Internal)
// ============================================================================

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

// ============================================================================
// Field Declaration Processing
// ============================================================================

/**
 * Process a FieldDecl node within a type declaration.
 * Extracts field name and type, checking for duplicates.
 */
export function processFieldDecl(
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

	const fieldTypeId = resolveFieldTypeFromNode(fieldDeclId, state, context)
	if (!fieldTypeId) return

	addFieldToTypeDeclContext(ctx, fieldName, fieldTypeId, fieldDeclId, context)
}

// ============================================================================
// Type Declaration Finalization
// ============================================================================

/**
 * Finalize a type declaration by registering it with the TypeStore.
 */
export function finalizeTypeDecl(state: CheckerState, _context: CompilationContext): void {
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

// ============================================================================
// Re-exports for checker.ts internal use
// ============================================================================

// These are used by checker.ts for FieldInit handling in TypeDecl context
export { getFieldDeclFromLine, resolveUserDefinedFieldType, addFieldToTypeDeclContext }
