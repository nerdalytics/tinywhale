/**
 * Checker state management types and functions.
 *
 * This module contains the core state interfaces and functions used by the checker.
 * It provides the foundation for tracking:
 * - Block contexts (type declarations, record literals, nested record inits)
 * - Match expression contexts
 * - Unreachable code ranges
 * - Expression results
 */

import type { StringId } from '../core/context.ts'
import type { NodeId } from '../core/nodes.ts'
import type { NodeKind } from '../core/nodes.ts'
import type { InstStore, ScopeStore, SymbolStore, TypeStore } from './stores.ts'
import type { InstId, Scope, TypeId } from './types.ts'

/**
 * Result of evaluating an expression.
 */
export interface ExprResult {
	typeId: TypeId
	instId: InstId | null
}

/**
 * Tracks a range of unreachable code for diagnostic purposes.
 */
export interface UnreachableRange {
	firstNodeId: NodeId
	startLine: number
	endLine: number
}

/**
 * Context for collecting match arms.
 */
export interface MatchContext {
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
export interface TypeDeclContext extends BlockContextBase {
	kind: 'TypeDecl'
	fields: Array<{ name: string; typeId: TypeId; nodeId: NodeId }>
}

/**
 * Context for record literal blocks (top-level record instantiation).
 */
export interface RecordLiteralContext extends BlockContextBase {
	kind: 'RecordLiteral'
	bindingNameId: StringId
	bindingNodeId: NodeId
	fieldInits: Array<{ name: string; nodeId: NodeId; exprResult: ExprResult }>
}

/**
 * Context for nested record initialization blocks.
 */
export interface NestedRecordInitContext extends BlockContextBase {
	kind: 'NestedRecordInit'
	fieldName: string
	parentPath: string
	fieldInits: Array<{ name: string; nodeId: NodeId; exprResult: ExprResult }>
}

/**
 * Discriminated union for block-based constructs.
 * All share the pattern: header starts block, indented lines are children, dedent finalizes.
 */
export type BlockContext = TypeDeclContext | RecordLiteralContext | NestedRecordInitContext

/**
 * Core checker state passed through all checking functions.
 */
export interface CheckerState {
	readonly insts: InstStore
	readonly scopes: ScopeStore
	readonly symbols: SymbolStore
	readonly types: TypeStore
	currentScope: Scope
	unreachableRange: UnreachableRange | null
	matchContext: MatchContext | null
	blockContextStack: BlockContext[]
}

/**
 * Push a block context onto the stack.
 */
export function pushBlockContext(state: CheckerState, ctx: BlockContext): void {
	state.blockContextStack.push(ctx)
}

/**
 * Pop and return the top block context from the stack.
 */
export function popBlockContext(state: CheckerState): BlockContext | null {
	return state.blockContextStack.pop() ?? null
}

/**
 * Get the current (top) block context without removing it.
 */
export function currentBlockContext(state: CheckerState): BlockContext | null {
	return state.blockContextStack.at(-1) ?? null
}

/**
 * Get the parent (second from top) block context without removing it.
 */
export function parentBlockContext(state: CheckerState): BlockContext | null {
	return state.blockContextStack.at(-2) ?? null
}

/**
 * Check if we're in a TypeDecl block context.
 */
export function isInTypeDeclContext(state: CheckerState): boolean {
	const ctx = currentBlockContext(state)
	return ctx?.kind === 'TypeDecl'
}

/**
 * Check if we're in a RecordLiteral block context.
 */
export function isInRecordLiteralContext(state: CheckerState): boolean {
	const ctx = currentBlockContext(state)
	return ctx !== null && ctx.kind === 'RecordLiteral'
}

/**
 * Check if we're in a RecordLiteral or NestedRecordInit block context.
 */
export function isInRecordInitContext(state: CheckerState): boolean {
	const ctx = currentBlockContext(state)
	return ctx !== null && (ctx.kind === 'RecordLiteral' || ctx.kind === 'NestedRecordInit')
}

/**
 * Check if we're in a NestedRecordInit block context.
 */
export function isInNestedRecordInitContext(state: CheckerState): boolean {
	const ctx = currentBlockContext(state)
	return ctx !== null && ctx.kind === 'NestedRecordInit'
}
