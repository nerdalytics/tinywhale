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
import { type NodeId, NodeKind, nodeId, offsetNodeId, prevNodeId } from '../core/nodes.ts'
import { nextTokenId, type Token, TokenKind } from '../core/tokens.ts'
import { processVariableBinding } from './bindings.ts'
import { checkExpression } from './expressions.ts'
import {
	type BlockContext,
	type CheckerState,
	currentBlockContext,
	isInNestedRecordInitContext,
	isInRecordInitContext,
	isInRecordLiteralContext,
	isInTypeDeclContext,
	type MatchContext,
	type NestedRecordInitContext,
	popBlockContext,
	pushBlockContext,
	type RecordLiteralContext,
	type TypeDeclContext,
} from './state.ts'
import { InstStore, ScopeStore, SymbolStore, TypeStore } from './stores.ts'
import { getTypeNameFromToken } from './type-resolution.ts'
import {
	BuiltinTypeId,
	type CheckResult,
	type FieldInfo,
	type InstId,
	InstKind,
	type SymbolId,
	type TypeId,
} from './types.ts'
import {
	isExpressionNode,
	isIntegerType,
	isPatternNode,
	isStatementNode,
	isTerminator,
	isValidExprResult,
} from './utils.ts'

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

/**
 * Handle record literal binding (no expression, record type).
 * Called when processVariableBinding returns record literal info.
 */
function handleRecordLiteralBinding(
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
 * Process a variable binding, handling record literals locally.
 */
function handleVariableBinding(
	bindingId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	const result = processVariableBinding(bindingId, state, context)
	if (result) {
		// Record literal case - handle locally since startRecordLiteral is in this module
		handleRecordLiteralBinding(
			bindingId,
			result.typeAnnotationId,
			result.declaredType,
			result.typeInfo,
			result.nameId,
			state,
			context
		)
	}
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
		handleVariableBinding(bindingId, state, context)
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
					handleVariableBinding(stmtId, state, context)
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
