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
import { type NodeId, NodeKind, nodeId, prevNodeId } from '../core/nodes.ts'
import {
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
import { handleFuncBinding, handleFuncDecl } from './funcs.ts'
import { finalizeMatch, getMatchArmFromLine, processMatchArm, startMatchBinding } from './match.ts'
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
import { BuiltinTypeId, type CheckResult, InstKind, type TypeId } from './types.ts'
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
			handleFuncBinding(stmtId, state, context, checkExpression)
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
