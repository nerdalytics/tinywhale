/**
 * Type definitions for the Check phase (SemIR).
 * Carbon-style data-oriented design with 16-byte instructions.
 */

import type { NodeId } from '../core/nodes.ts'

export type InstId = number & { readonly __brand: 'InstId' }

export function instId(n: number): InstId {
	return n as InstId
}

export type TypeId = number & { readonly __brand: 'TypeId' }

export function typeId(n: number): TypeId {
	return n as TypeId
}

export type ScopeId = number & { readonly __brand: 'ScopeId' }

export function scopeId(n: number): ScopeId {
	return n as ScopeId
}

/**
 * Instruction kinds.
 * These represent semantic operations in the IR.
 */
export const InstKind = {
	// Terminators (0-9)
	/** panic - unconditional trap, terminates control flow */
	Unreachable: 0,
	// Future: Return: 1, Branch: 2, etc.
} as const

export type InstKind = (typeof InstKind)[keyof typeof InstKind]

/**
 * Built-in type IDs.
 */
export const BuiltinTypeId = {
	/** Error sentinel - indicates type error */
	Error: typeId(1),
	/** void/unit type - no value */
	None: typeId(0),
} as const

/**
 * A semantic instruction - 16 bytes (4 x 32-bit slots).
 *
 * Layout:
 * - Slot 0: kind (InstKind)
 * - Slot 1: typeId (result type of this instruction)
 * - Slot 2: arg0 (usually InstId operand)
 * - Slot 3: arg1 (usually InstId operand)
 * - parseNodeId: backreference for diagnostics
 */
export interface Inst {
	readonly kind: InstKind
	readonly typeId: TypeId
	readonly arg0: number
	readonly arg1: number
	/** Backreference to the parse node for diagnostics */
	readonly parseNodeId: NodeId
}

/**
 * A scope in the program.
 * Currently only "main" scope exists.
 * Future: functions will create new scopes.
 */
export interface Scope {
	readonly id: ScopeId
	/** Parent scope ID, or null for top-level (main) */
	readonly parentId: ScopeId | null
	/** Whether this scope is currently reachable */
	reachable: boolean
}

/**
 * Result of the check phase.
 */
export interface CheckResult {
	/** Whether checking succeeded (no errors) */
	readonly succeeded: boolean
}
