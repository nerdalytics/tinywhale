/**
 * Record literal and nested record processing for the Check phase.
 *
 * This module handles:
 * - Record literal initialization (top-level)
 * - Nested record initialization (fields with user-defined types)
 * - Field init detection and processing
 * - Flattened record symbol emission
 *
 * Records are flattened to primitive locals: p: Point -> $p_x, $p_y
 * Nested records extend this: o: Outer -> $o_inner_val for o.inner.val
 */

import type { CompilationContext, StringId } from '../core/context.ts'
import type { DiagnosticCode } from '../core/diagnostics.ts'
import type { NodeId } from '../core/nodes.ts'
import { NodeKind, prevNodeId } from '../core/nodes.ts'
import { TokenKind } from '../core/tokens.ts'
import { checkExpression } from './expressions.ts'
import {
	type BlockContext,
	type CheckerState,
	currentBlockContext,
	type NestedRecordInitContext,
	popBlockContext,
	pushBlockContext,
	type RecordLiteralContext,
} from './state.ts'
import { type FieldInfo, InstKind, type SymbolId, type TypeId } from './types.ts'

// ============================================================================
// Field Init Detection
// ============================================================================

/**
 * Get FieldInit node from a line (if present).
 */
export function getFieldInitFromLine(
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
export function getIndentLevelFromLine(lineId: NodeId, context: CompilationContext): number | null {
	const node = context.nodes.get(lineId)
	const token = context.tokens.get(node.tokenId)
	if (token.kind === TokenKind.Indent) {
		return token.payload
	}
	return null
}

/**
 * Check if a FieldDecl node has an uppercase TypeRef (user-defined type).
 * In record literal context, this indicates nested record construction.
 */
export function hasUppercaseTypeRef(fieldDeclId: NodeId, context: CompilationContext): boolean {
	const fieldDeclNode = context.nodes.get(fieldDeclId)
	const typeTokenId = (fieldDeclNode.tokenId as number) + 2
	const typeToken = context.tokens.get(typeTokenId as typeof fieldDeclNode.tokenId)
	// Uppercase means user-defined type
	if (typeToken.kind === TokenKind.Identifier) {
		const typeName = context.strings.get(typeToken.payload as StringId)
		const firstChar = typeName[0]
		return typeName.length > 0 && firstChar !== undefined && firstChar === firstChar.toUpperCase()
	}
	return false
}

/**
 * Get the type name from a FieldDecl node.
 */
export function getFieldDeclTypeName(
	fieldDeclId: NodeId,
	context: CompilationContext
): string | null {
	const fieldDeclNode = context.nodes.get(fieldDeclId)
	const typeTokenId = (fieldDeclNode.tokenId as number) + 2
	const typeToken = context.tokens.get(typeTokenId as typeof fieldDeclNode.tokenId)
	if (typeToken.kind === TokenKind.Identifier) {
		return context.strings.get(typeToken.payload as StringId)
	}
	return null
}

// ============================================================================
// Field Init Processing
// ============================================================================

/**
 * Extract field name from a FieldInit node.
 */
export function extractFieldInitName(fieldInitId: NodeId, context: CompilationContext): string {
	const fieldInitNode = context.nodes.get(fieldInitId)
	const fieldToken = context.tokens.get(fieldInitNode.tokenId)
	return context.strings.get(fieldToken.payload as StringId)
}

/**
 * Extract field name from a FieldDecl node.
 */
export function extractFieldDeclName(fieldDeclId: NodeId, context: CompilationContext): string {
	const fieldDeclNode = context.nodes.get(fieldDeclId)
	const fieldToken = context.tokens.get(fieldDeclNode.tokenId)
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
 * Process a FieldInit node within a record literal or nested record init context.
 * Handles type checking and registers the field with the current context.
 */
export function processFieldInitInNestedContext(
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

// ============================================================================
// Record Literal Start/Finalize
// ============================================================================

/**
 * Start processing a record literal.
 * Called when we detect a VariableBinding with a record type and no direct expression.
 */
export function startRecordLiteral(
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
 * Creates flattened symbols for each field: p: Point -> $p_x, $p_y locals.
 */
export function finalizeRecordLiteral(state: CheckerState, context: CompilationContext): void {
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

// ============================================================================
// Nested Record Init
// ============================================================================

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
 * Start processing a nested record initialization from a FieldDecl.
 * Called when we detect a FieldDecl with uppercase TypeRef in a record literal context.
 */
export function startNestedRecordInit(
	fieldDeclId: NodeId,
	fieldName: string,
	state: CheckerState,
	context: CompilationContext,
	currentIndentLevel?: number
): boolean {
	const typeName = getFieldDeclTypeName(fieldDeclId, context)
	if (!typeName) return false

	const typeId = state.types.lookup(typeName)
	if (typeId === undefined) {
		context.emitAtNode('TWCHECK010' as DiagnosticCode, fieldDeclId, { name: typeName })
		return false
	}

	if (!validateNestedRecordTypeMatch(fieldDeclId, fieldName, typeId, typeName, state, context))
		return false

	const parentCtx = currentBlockContext(state)
	const parentPath = buildNestedRecordParentPath(fieldName, parentCtx, context)

	const ctx: BlockContext = {
		children: [],
		expectedChildKind: NodeKind.FieldInit,
		fieldInits: [],
		fieldName,
		fieldNames: new Set(),
		kind: 'NestedRecordInit',
		nodeId: fieldDeclId,
		parentPath,
		typeId,
		typeName,
	}

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
 * Uses parentPath as the base name for flattened locals (e.g., "o_inner" -> "$o_inner_val").
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
export function finalizeNestedRecordInit(state: CheckerState, context: CompilationContext): void {
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
