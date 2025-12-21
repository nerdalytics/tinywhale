/**
 * Check phase: semantic analysis between Parse and Codegen.
 *
 * Currently performs:
 * - Scope validation (reject invalid indentation)
 * - Reachability analysis (unreachable code warnings)
 *
 * Future:
 * - Name resolution
 * - Type checking
 * - Full SemIR emission
 */

import type { CompilationContext } from '../core/context.ts'
import type { DiagnosticCode } from '../core/diagnostics.ts'
import { type NodeId, NodeKind, nodeId } from '../core/nodes.ts'
import { InstStore, ScopeStore } from './stores.ts'
import { BuiltinTypeId, type CheckResult, InstKind, type Scope } from './types.ts'

/**
 * Internal state during checking.
 */
interface CheckerState {
	/** Instruction store being populated */
	readonly insts: InstStore
	/** Scope store */
	readonly scopes: ScopeStore
	/** Current scope */
	currentScope: Scope
}

/**
 * Determines if a node kind is a control flow terminator.
 */
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
 * Get the statement child from a line node.
 * Returns null if the line has no statement.
 */
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
 * Emit an instruction for a statement.
 */
function emitStatement(stmtId: NodeId, stmtKind: NodeKind, state: CheckerState): void {
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
		// Future: other statement kinds
	}
}

/**
 * Checks if a line kind requires a scope (indented or dedented).
 */
function isIndentedOrDedentedLine(kind: NodeKind): boolean {
	return kind === NodeKind.IndentedLine || kind === NodeKind.DedentLine
}

/**
 * Process the statement within a RootLine.
 */
function processRootLineStatement(
	lineId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	const stmt = getStatementFromLine(lineId, context)
	if (!stmt) return

	if (!state.currentScope.reachable) {
		context.emitAtNode('TWCHECK050' as DiagnosticCode, stmt.id)
	}

	emitStatement(stmt.id, stmt.kind, state)

	if (isTerminator(stmt.kind)) {
		state.currentScope.reachable = false
	}
}

/**
 * Process a line node.
 * - RootLine: valid, process statement
 * - IndentedLine/DedentLine: error - invalid indentation
 */
function processLine(
	lineId: NodeId,
	line: { kind: NodeKind },
	state: CheckerState,
	context: CompilationContext
): void {
	if (isIndentedOrDedentedLine(line.kind)) {
		context.emitAtNode('TWCHECK001' as DiagnosticCode, lineId)
		return
	}

	processRootLineStatement(lineId, state, context)
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

	// Create main scope
	const mainScopeId = scopes.createMainScope()
	const mainScope = scopes.get(mainScopeId)

	const state: CheckerState = {
		currentScope: mainScope,
		insts,
		scopes,
	}

	// Find Program node (last node in postorder storage)
	const nodeCount = context.nodes.count()
	if (nodeCount === 0) {
		context.insts = insts
		return { succeeded: true }
	}

	const programId = nodeId(nodeCount - 1)
	const program = context.nodes.get(programId)

	if (program.kind !== NodeKind.Program) {
		// No valid Program node - might be a parse error
		context.insts = insts
		return { succeeded: !context.hasErrors() }
	}

	// Process line children in source order
	const lines = getLineChildrenInSourceOrder(programId, context)
	for (const [lineId, line] of lines) {
		processLine(lineId, line, state, context)
	}

	// Attach instruction store to context
	context.insts = insts

	return { succeeded: !context.hasErrors() }
}
