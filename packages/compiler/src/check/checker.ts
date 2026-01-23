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
import { TokenKind } from '../core/tokens.ts'
import {
	emitSimpleBinding,
	processPrimitiveBinding,
	processRecordBinding,
	processVariableBinding,
} from './bindings.ts'
import {
	finalizeTypeDecl,
	getFieldDeclFromLine,
	getTypeDeclFromLine,
	processFieldDecl,
	startTypeDecl,
} from './declarations.ts'
import { checkExpression } from './expressions.ts'
import { handleFuncBinding, handleFuncDecl, handleLambdaBinding, resolveFuncType } from './funcs.ts'
import {
	finalizeMatch,
	getMatchArmFromLine,
	processMatchArm,
	startMatchBinding,
	startMatchFromBindingExpr,
} from './match.ts'
import {
	extractFieldDeclName,
	finalizeNestedRecordInit,
	finalizeRecordLiteral,
	getFieldInitFromLine,
	getIndentLevelFromLine,
	hasUppercaseTypeRef,
	processFieldInitInNestedContext,
	startNestedRecordInit,
	startRecordLiteral,
} from './records.ts'
import {
	type CheckerState,
	currentBlockContext,
	isInNestedRecordInitContext,
	isInRecordInitContext,
	isInRecordLiteralContext,
	isInTypeDeclContext,
} from './state.ts'
import { FuncStore, InstStore, ScopeStore, SymbolStore, TypeStore } from './stores.ts'
import { resolveTypeFromAnnotation } from './type-resolution.ts'
import { BuiltinTypeId, type CheckResult, type InstId, InstKind, type TypeId } from './types.ts'
import { isStatementNode, isTerminator } from './utils.ts'

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
 * Get FieldDecl node from a line (if present) - for nested record init detection.
 */
function getFieldDeclFromLineForInit(
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
 * Process a record binding (no expression, record type).
 * Called for RecordBinding nodes from the grammar.
 */
function handleRecordBinding(
	bindingId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	const result = processRecordBinding(bindingId, state, context)
	if (result) {
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
 * Check if a string starts with an uppercase letter.
 */
function isUppercaseName(name: string): boolean {
	return name.length > 0 && name[0] === name[0]?.toUpperCase() && name[0] !== name[0]?.toLowerCase()
}

/**
 * Find FuncType child of a TypeAnnotation node (if present).
 */
function findFuncTypeChild(typeAnnotationId: NodeId, context: CompilationContext): NodeId | null {
	for (const [childId, child] of context.nodes.iterateChildren(typeAnnotationId)) {
		if (child.kind === NodeKind.FuncType) {
			return childId
		}
	}
	return null
}

/**
 * Try to resolve a function type alias.
 * Returns true if this was a function type (resolved or not).
 */
function tryResolveFuncTypeAlias(
	typeAnnotationId: NodeId,
	aliasName: string,
	state: CheckerState,
	context: CompilationContext
): boolean {
	const funcTypeChildId = findFuncTypeChild(typeAnnotationId, context)
	if (funcTypeChildId === null) return false

	const funcTypeId = resolveFuncType(funcTypeChildId, state, context)
	if (funcTypeId !== BuiltinTypeId.Invalid) {
		state.types.addAlias(aliasName, funcTypeId)
	}
	return true
}

/**
 * Emit error for unknown type in type alias.
 */
function emitUnknownTypeAliasError(typeAnnotationId: NodeId, context: CompilationContext): void {
	const typeAnnotationNode = context.nodes.get(typeAnnotationId)
	const typeToken = context.tokens.get(typeAnnotationNode.tokenId)
	const targetName =
		typeToken.kind === TokenKind.Identifier
			? context.strings.get(typeToken.payload as StringId)
			: 'unknown'
	context.emitAtNode('TWCHECK010' as DiagnosticCode, typeAnnotationId, { found: targetName })
}

/**
 * Handle a TypeAlias statement.
 * Syntax: UppercaseId = TypeRef
 * Creates a type alias that maps the name to the target type.
 */
function handleTypeAlias(aliasId: NodeId, state: CheckerState, context: CompilationContext): void {
	const aliasNode = context.nodes.get(aliasId)
	const aliasToken = context.tokens.get(aliasNode.tokenId)
	const aliasName = context.strings.get(aliasToken.payload as StringId)
	const typeAnnotationId = prevNodeId(aliasId)

	if (tryResolveFuncTypeAlias(typeAnnotationId, aliasName, state, context)) return

	const typeInfo = resolveTypeFromAnnotation(typeAnnotationId, state, context)
	if (!typeInfo) {
		emitUnknownTypeAliasError(typeAnnotationId, context)
		return
	}

	state.types.addAlias(aliasName, typeInfo.typeId)
}

/**
 * Extract nodes from a BindingExpr in postorder storage.
 * Structure: [Identifier, (TypeAnnotation)?, Expression..., BindingExpr]
 */
function extractBindingExprNodes(
	bindingId: NodeId,
	context: CompilationContext
): { identId: NodeId; typeAnnotationId: NodeId | null; exprId: NodeId } | null {
	const exprId = prevNodeId(bindingId)
	const exprNode = context.nodes.get(exprId)

	// Go back to find the identifier, skipping past the expression
	const beforeExprId = offsetNodeId(exprId, -exprNode.subtreeSize)
	const beforeExprNode = context.nodes.get(beforeExprId)

	if (beforeExprNode.kind === NodeKind.TypeAnnotation) {
		// Has type annotation: [Identifier, TypeAnnotation, Expression..., BindingExpr]
		const typeAnnotationId = beforeExprId
		const identId = offsetNodeId(typeAnnotationId, -beforeExprNode.subtreeSize)
		return { exprId, identId, typeAnnotationId }
	}

	if (beforeExprNode.kind === NodeKind.Identifier) {
		// No type annotation: [Identifier, Expression..., BindingExpr]
		return { exprId, identId: beforeExprId, typeAnnotationId: null }
	}

	console.assert(false, 'BindingExpr: unexpected structure')
	return null
}

/**
 * Check if expression is an uppercase identifier (for record instantiation pattern).
 */
function getUppercaseIdentifier(exprId: NodeId, context: CompilationContext): string | null {
	const exprNode = context.nodes.get(exprId)
	if (exprNode.kind !== NodeKind.Identifier) return null

	const rhsToken = context.tokens.get(exprNode.tokenId)
	const rhsName = context.strings.get(rhsToken.payload as StringId)
	return isUppercaseName(rhsName) ? rhsName : null
}

/**
 * Try to handle record instantiation pattern: lowercase = Uppercase
 * Returns true if this was a record instantiation (handled or errored).
 */
function tryHandleRecordInstantiation(
	bindingId: NodeId,
	exprId: NodeId,
	identName: string,
	nameId: StringId,
	state: CheckerState,
	context: CompilationContext
): boolean {
	const rhsName = getUppercaseIdentifier(exprId, context)
	if (!rhsName || isUppercaseName(identName)) return false

	const typeId = state.types.lookup(rhsName)
	if (typeId !== undefined && state.types.isRecordType(typeId)) {
		startRecordLiteral(bindingId, typeId, rhsName, nameId, state, context)
		return true
	}

	context.emitAtNode('TWCHECK010' as DiagnosticCode, exprId, { found: rhsName })
	return true
}

/**
 * Emit binding with type inferred from expression.
 */
function emitInferredBinding(
	bindingId: NodeId,
	exprId: NodeId,
	nameId: StringId,
	state: CheckerState,
	context: CompilationContext
): void {
	const result = checkExpression(exprId, BuiltinTypeId.None, state, context)
	if (result.instId === null || result.typeId === BuiltinTypeId.Invalid) return

	const symId = state.symbols.add({
		nameId,
		parseNodeId: bindingId,
		typeId: result.typeId,
	})
	state.insts.add({
		arg0: symId as number,
		arg1: result.instId as number,
		kind: InstKind.Bind,
		parseNodeId: bindingId,
		typeId: result.typeId,
	})
}

/**
 * Extract identifier info from an identifier node.
 */
function getIdentifierInfo(
	identId: NodeId,
	context: CompilationContext
): { nameId: StringId; name: string } {
	const identNode = context.nodes.get(identId)
	const identToken = context.tokens.get(identNode.tokenId)
	const nameId = identToken.payload as StringId
	return { name: context.strings.get(nameId), nameId }
}

/**
 * Handle typed binding with explicit type annotation.
 */
function handleTypedBinding(
	bindingId: NodeId,
	exprId: NodeId,
	typeAnnotationId: NodeId,
	nameId: StringId,
	state: CheckerState,
	context: CompilationContext
): void {
	const typeInfo = resolveTypeFromAnnotation(typeAnnotationId, state, context)
	if (typeInfo) {
		emitSimpleBinding(bindingId, exprId, typeInfo.typeId, nameId, state, context)
	}
}

/**
 * Try to handle Lambda binding: name = (params) -> body
 * Returns true if this was a Lambda binding.
 */
function tryHandleLambdaBinding(
	bindingId: NodeId,
	exprId: NodeId,
	nameId: StringId,
	state: CheckerState,
	context: CompilationContext
): boolean {
	const exprNode = context.nodes.get(exprId)
	if (exprNode.kind !== NodeKind.Lambda) return false

	handleLambdaBinding(bindingId, exprId, nameId, state, context, checkExpressionWithSequence)
	return true
}

/**
 * Try to handle MatchExpr binding: name: Type = match scrutinee
 * Returns true if this was a MatchExpr binding.
 */
function tryHandleMatchExprBinding(
	bindingId: NodeId,
	exprId: NodeId,
	nameId: StringId,
	typeAnnotationId: NodeId | null,
	state: CheckerState,
	context: CompilationContext
): boolean {
	const exprNode = context.nodes.get(exprId)
	if (exprNode.kind !== NodeKind.MatchExpr) return false

	// MatchExpr requires type annotation
	if (!typeAnnotationId) {
		context.emitAtNode('TWCHECK010' as DiagnosticCode, exprId, {
			found: 'match expression requires type annotation',
		})
		return true
	}

	const typeInfo = resolveTypeFromAnnotation(typeAnnotationId, state, context)
	if (!typeInfo) return true

	startMatchFromBindingExpr(bindingId, exprId, nameId, typeInfo.typeId, state, context)
	return true
}

/**
 * Handle regular binding (not record, lambda, or match).
 */
function handleRegularBinding(
	bindingId: NodeId,
	exprId: NodeId,
	nameId: StringId,
	typeAnnotationId: NodeId | null,
	state: CheckerState,
	context: CompilationContext
): void {
	if (typeAnnotationId) {
		handleTypedBinding(bindingId, exprId, typeAnnotationId, nameId, state, context)
	} else {
		emitInferredBinding(bindingId, exprId, nameId, state, context)
	}
}

/**
 * Handle a BindingExpr statement.
 * Detects record instantiation pattern: lowercase = Uppercase
 * Detects Lambda binding pattern: name = (params) -> body
 * Detects MatchExpr binding pattern: name: Type = match scrutinee
 */
function handleBindingExpr(
	bindingId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	const nodes = extractBindingExprNodes(bindingId, context)
	if (!nodes) return

	const { exprId, identId, typeAnnotationId } = nodes
	const { name: identName, nameId } = getIdentifierInfo(identId, context)

	if (tryHandleRecordInstantiation(bindingId, exprId, identName, nameId, state, context)) return
	if (tryHandleLambdaBinding(bindingId, exprId, nameId, state, context)) return
	if (tryHandleMatchExprBinding(bindingId, exprId, nameId, typeAnnotationId, state, context)) return

	handleRegularBinding(bindingId, exprId, nameId, typeAnnotationId, state, context)
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
		case NodeKind.FuncDecl:
			handleFuncDecl(stmtId, state, context)
			break
		case NodeKind.FuncBinding:
			handleFuncBinding(stmtId, state, context, checkExpressionWithSequence)
			break
		case NodeKind.PrimitiveBinding:
			processPrimitiveBinding(stmtId, state, context)
			break
		case NodeKind.RecordBinding:
			handleRecordBinding(stmtId, state, context)
			break
		case NodeKind.VariableBinding:
			{
				const matchExprId = prevNodeId(stmtId)
				const matchExprNode = context.nodes.get(matchExprId)
				if (matchExprNode.kind === NodeKind.MatchExpr) {
					startMatchBinding(stmtId, state, context, handleVariableBinding)
				} else {
					handleVariableBinding(stmtId, state, context)
				}
			}
			break
		case NodeKind.MatchExpr:
			break
		case NodeKind.BindingExpr:
			handleBindingExpr(stmtId, state, context)
			break
		case NodeKind.TypeAlias:
			handleTypeAlias(stmtId, state, context)
			break
	}
}

// ============================================================================
// Expression Sequence Handling (for lambda bodies)
// ============================================================================

/**
 * Collect children from an expression sequence in source order.
 */
function collectSequenceChildren(
	seqId: NodeId,
	context: CompilationContext
): Array<{ id: NodeId; kind: NodeKind }> {
	const children: Array<{ id: NodeId; kind: NodeKind }> = []
	for (const [childId, child] of context.nodes.iterateChildren(seqId)) {
		children.push({ id: childId, kind: child.kind })
	}
	return children.reverse()
}

/**
 * Process all non-last children in an expression sequence as statements.
 */
function processSequenceStatements(
	children: Array<{ id: NodeId; kind: NodeKind }>,
	state: CheckerState,
	context: CompilationContext
): void {
	for (let i = 0; i < children.length - 1; i++) {
		const child = children[i]
		if (child !== undefined && isStatementNode(child.kind)) {
			emitStatementInLambdaBody(child.id, child.kind, state, context)
		}
	}
}

/**
 * Check an expression sequence (multi-line lambda body).
 * Processes all children in order, returning the type of the last expression.
 */
function checkExpressionSequence(
	seqId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): { instId: InstId | null; typeId: TypeId } {
	const children = collectSequenceChildren(seqId, context)
	if (children.length === 0) {
		return { instId: null, typeId: BuiltinTypeId.None }
	}

	processSequenceStatements(children, state, context)

	const lastChild = children[children.length - 1]
	if (lastChild === undefined) {
		return { instId: null, typeId: BuiltinTypeId.None }
	}

	return checkExpressionWithSequence(lastChild.id, expectedType, state, context)
}

/**
 * Emit a statement within a lambda body expression sequence.
 * Handles bindings and function declarations that can appear in multi-line lambdas.
 */
function emitStatementInLambdaBody(
	stmtId: NodeId,
	stmtKind: NodeKind,
	state: CheckerState,
	context: CompilationContext
): void {
	switch (stmtKind) {
		case NodeKind.FuncDecl:
			handleFuncDecl(stmtId, state, context)
			break
		case NodeKind.FuncBinding:
			handleFuncBinding(stmtId, state, context, checkExpressionWithSequence)
			break
		case NodeKind.PrimitiveBinding:
			processPrimitiveBinding(stmtId, state, context)
			break
	}
}

/**
 * Check an expression, handling ExpressionSequence specially for lambda bodies.
 * This wrapper is passed to handleFuncBinding to support multi-line function bodies.
 */
function checkExpressionWithSequence(
	exprId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): { instId: InstId | null; typeId: TypeId } {
	const node = context.nodes.get(exprId)
	if (node.kind === NodeKind.ExpressionSequence) {
		return checkExpressionSequence(exprId, expectedType, state, context)
	}
	return checkExpression(exprId, expectedType, state, context)
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

	const fieldDecl = getFieldDeclFromLine(lineId, context)
	if (fieldDecl) {
		processFieldDecl(fieldDecl.id, state, context)
		return true
	}

	return false
}

/**
 * Try to start a nested record init from a FieldDecl with uppercase TypeRef.
 * In record literal context, FieldDecl with uppercase TypeRef indicates nested record construction.
 */
function maybeStartNestedRecordInit(
	lineId: NodeId,
	currentIndentLevel: number,
	state: CheckerState,
	context: CompilationContext
): boolean {
	const fieldDecl = getFieldDeclFromLineForInit(lineId, context)
	if (!fieldDecl) return false
	if (!isInRecordInitContext(state)) return false
	if (!hasUppercaseTypeRef(fieldDecl.id, context)) {
		return false
	}

	const fieldName = extractFieldDeclName(fieldDecl.id, context)
	return startNestedRecordInit(fieldDecl.id, fieldName, state, context, currentIndentLevel)
}

function processIndentedLineAsFieldInit(
	lineId: NodeId,
	state: CheckerState,
	context: CompilationContext
): boolean {
	if (!isInRecordInitContext(state)) return false

	const fieldInit = getFieldInitFromLine(lineId, context)
	if (!fieldInit) return false

	processFieldInitInNestedContext(fieldInit.id, state, context)
	return true
}

/**
 * Check if we should finalize a nested record context based on indent level.
 * Returns true if the context should be finalized.
 */
function shouldFinalizeNestedForIndent(state: CheckerState, lineIndentLevel: number): boolean {
	const ctx = currentBlockContext(state)
	if (!ctx || ctx.kind === 'FuncDef') return false
	return ctx.childIndentLevel !== undefined && lineIndentLevel < ctx.childIndentLevel
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

function tryStartNestedRecordInit(
	lineId: NodeId,
	lineIndentLevel: number | null,
	state: CheckerState,
	context: CompilationContext
): boolean {
	return (
		lineIndentLevel !== null && maybeStartNestedRecordInit(lineId, lineIndentLevel, state, context)
	)
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
	if (tryStartNestedRecordInit(lineId, lineIndentLevel, state, context)) return
	if (processIndentedLineAsFieldInit(lineId, state, context)) return
	context.emitAtNode('TWCHECK001' as DiagnosticCode, lineId)
}

function processDedentLineStatement(
	lineId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	const typeDecl = getTypeDeclFromLine(lineId, context)
	if (typeDecl) {
		startTypeDecl(typeDecl.id, state, context)
		return
	}

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

	if (isInRecordLiteralContext(state)) {
		finalizeRecordLiteral(state, context)
		processDedentLineStatement(lineId, state, context)
		return
	}

	// No special context - this happens when returning from lambda body indentation.
	// Lambda bodies with expression sequences have their indented lines grouped into
	// the ExpressionSequence node, so the checker only sees the DedentLine after.
	// Process the statement normally.
	processDedentLineStatement(lineId, state, context)
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
	types: TypeStore,
	funcs: FuncStore
): void {
	context.insts = insts
	context.symbols = symbols
	context.types = types
	context.funcs = funcs
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
	const funcs = new FuncStore()
	const mainScopeId = scopes.createMainScope()
	const mainScope = scopes.get(mainScopeId)

	// Initialize funcs in context early so handlers can access it
	context.funcs = funcs

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

	const nodeCount = context.nodes.count()
	if (nodeCount === 0) {
		assignCheckResultsToContext(context, insts, symbols, types, funcs)
		return { succeeded: true }
	}

	const programId = nodeId(nodeCount - 1)
	const program = context.nodes.get(programId)

	if (program.kind !== NodeKind.Program) {
		assignCheckResultsToContext(context, insts, symbols, types, funcs)
		return { succeeded: !context.hasErrors() }
	}

	const lines = getLineChildrenInSourceOrder(programId, context)
	for (const [lineId, line] of lines) {
		processLine(lineId, line, state, context)
	}

	finalizePendingContexts(state, context)
	flushUnreachableWarning(state, context)
	assignCheckResultsToContext(context, insts, symbols, types, funcs)

	return { succeeded: !context.hasErrors() }
}
