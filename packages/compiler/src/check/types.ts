/**
 * Type definitions for the Check phase (SemIR).
 * Carbon-style data-oriented design with 16-byte instructions.
 */

import type { FloatId, StringId } from '../core/context.ts'
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

export type SymbolId = number & { readonly __brand: 'SymbolId' }

export function symbolId(n: number): SymbolId {
	return n as SymbolId
}

/**
 * Instruction kinds.
 * These represent semantic operations in the IR.
 *
 * Number ranges:
 * - Terminators: 0-9
 * - Constants: 10-19
 * - Variables: 20-29
 * - Operators: 30-39
 * - Control flow: 40-49
 */
export const InstKind = {
	/** Binary operation: arg0 = left InstId, arg1 = right InstId. Operator from parseNodeId. */
	BinaryOp: 32,
	/** Variable binding: arg0 = SymbolId, arg1 = initializer InstId */
	Bind: 20,
	/** Bitwise NOT: arg0 = operand InstId */
	BitwiseNot: 31,
	/** Field access: arg0 = base InstId, arg1 = field index */
	FieldAccess: 22,
	/** Float constant: arg0 = FloatId (index into FloatStore) */
	FloatConst: 11,
	/** Integer constant: arg0 = low 32 bits, arg1 = high 32 bits (for i64) */
	IntConst: 10,
	/** Logical AND (short-circuit): arg0 = left InstId, arg1 = right InstId */
	LogicalAnd: 33,
	/** Logical OR (short-circuit): arg0 = left InstId, arg1 = right InstId */
	LogicalOr: 34,
	/** Match expression: arg0 = scrutinee InstId, arg1 = arm count */
	Match: 40,
	/** Match arm: arg0 = pattern InstId, arg1 = body InstId */
	MatchArm: 41,
	/** Unary negation: arg0 = operand InstId */
	Negate: 30,
	/** Pattern binding: arg0 = SymbolId, arg1 = scrutinee InstId */
	PatternBind: 42,
	/** panic - unconditional trap, terminates control flow */
	Unreachable: 0,
	/** Variable reference: arg0 = SymbolId */
	VarRef: 21,
} as const

export type InstKind = (typeof InstKind)[keyof typeof InstKind]

/**
 * Type kinds for the type system.
 *
 * TinyWhale uses nominal types:
 * - Primitives (i32, i64, f32, f64) are first-class types
 * - All `type X = T` declarations create distinct (incompatible) types
 * - No aliases exist - every type declaration is nominal
 */
export const TypeKind = {
	// User-defined types (5+) - NOMINAL
	/** Distinct type - every `type` declaration creates one of these */
	Distinct: 5,
	/** 32-bit IEEE 754 float */
	F32: 3,
	/** 64-bit IEEE 754 float */
	F64: 4,
	// WASM core value types (1-4)
	/** 32-bit signed integer */
	I32: 1,
	/** 64-bit signed integer */
	I64: 2,
	/** No value (for instructions that don't produce a result) */
	None: 0,
	/** Record type with named fields */
	Record: 6,
} as const

export type TypeKind = (typeof TypeKind)[keyof typeof TypeKind]

/**
 * Built-in type IDs - fixed indices for primitive types.
 * These are pre-populated in TypeStore at construction.
 */
export const BuiltinTypeId = {
	/** 32-bit IEEE 754 float */
	F32: typeId(3),
	/** 64-bit IEEE 754 float */
	F64: typeId(4),
	/** 32-bit signed integer */
	I32: typeId(1),
	/** 64-bit signed integer */
	I64: typeId(2),
	/** Invalid sentinel - indicates type-checking error (not a valid TypeId) */
	Invalid: typeId(-1),
	/** No value (for instructions that don't produce a result, like panic) */
	None: typeId(0),
} as const

/**
 * Information about a record field.
 */
export interface FieldInfo {
	readonly name: string
	readonly typeId: TypeId
	readonly index: number
}

/**
 * Information about a type stored in TypeStore.
 */
export interface TypeInfo {
	/** The kind of type */
	readonly kind: TypeKind
	/** Human-readable name for diagnostics */
	readonly name: string
	/** For Distinct: the underlying type; for primitives: self */
	readonly underlying: TypeId
	/** Parse node that declared this type (null for builtins) */
	readonly parseNodeId: NodeId | null
	/** For Record types: field definitions */
	readonly fields?: readonly FieldInfo[]
}

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
 * A symbol entry in the symbol table.
 * Represents a variable binding with its type and location.
 */
export interface SymbolEntry {
	/** Interned name of the symbol */
	readonly nameId: StringId
	/** Type of this symbol */
	readonly typeId: TypeId
	/** WASM local index (fresh for each binding, supports shadowing) */
	readonly localIndex: number
	/** Parse node of the declaration (for diagnostics) */
	readonly parseNodeId: NodeId
}

/**
 * Result of the check phase.
 */
export interface CheckResult {
	/** Whether checking succeeded (no errors) */
	readonly succeeded: boolean
}

// Inst accessor functions - type-safe access to instruction arguments

export function getIntConstLow(inst: Inst): number {
	return inst.arg0
}

export function getIntConstHigh(inst: Inst): number {
	return inst.arg1
}

export function getFloatConstId(inst: Inst): FloatId {
	return inst.arg0 as FloatId
}

export function getVarRefSymbolId(inst: Inst): SymbolId {
	return inst.arg0 as SymbolId
}

export function getBindSymbolId(inst: Inst): SymbolId {
	return inst.arg0 as SymbolId
}

export function getBindInitId(inst: Inst): InstId {
	return inst.arg1 as InstId
}

export function getNegateOperandId(inst: Inst): InstId {
	return inst.arg0 as InstId
}

export function getMatchScrutineeId(inst: Inst): InstId {
	return inst.arg0 as InstId
}

export function getMatchArmCount(inst: Inst): number {
	return inst.arg1
}

export function getMatchArmPatternNodeId(inst: Inst): NodeId {
	return inst.arg0 as NodeId
}

export function getMatchArmBodyId(inst: Inst): InstId {
	return inst.arg1 as InstId
}

export function getPatternBindSymbolId(inst: Inst): SymbolId {
	return inst.arg0 as SymbolId
}

export function getPatternBindScrutineeId(inst: Inst): InstId {
	return inst.arg1 as InstId
}

export function getBinaryOpLeftId(inst: Inst): InstId {
	return inst.arg0 as InstId
}

export function getBinaryOpRightId(inst: Inst): InstId {
	return inst.arg1 as InstId
}

export function getBitwiseNotOperandId(inst: Inst): InstId {
	return inst.arg0 as InstId
}

export function getLogicalAndLeftId(inst: Inst): InstId {
	return inst.arg0 as InstId
}

export function getLogicalAndRightId(inst: Inst): InstId {
	return inst.arg1 as InstId
}

export function getLogicalOrLeftId(inst: Inst): InstId {
	return inst.arg0 as InstId
}

export function getLogicalOrRightId(inst: Inst): InstId {
	return inst.arg1 as InstId
}
