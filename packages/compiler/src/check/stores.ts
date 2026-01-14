/**
 * Dense array stores for SemIR data structures.
 * Carbon-style data-oriented design.
 */

import type { StringId } from '../core/context.ts'
import type { NodeId } from '../core/nodes.ts'
import {
	BuiltinTypeId,
	type FieldInfo,
	type Inst,
	type InstId,
	instId,
	type Scope,
	type ScopeId,
	type SymbolEntry,
	type SymbolId,
	scopeId,
	symbolId,
	type TypeId,
	type TypeInfo,
	TypeKind,
	typeId,
} from './types.ts'

/**
 * Dense array storage for semantic instructions.
 * Append-only during the check phase.
 */
export class InstStore {
	private readonly insts: Inst[] = []

	add(inst: Inst): InstId {
		const id = this.insts.length as InstId
		this.insts.push(inst)
		return id
	}

	get(id: InstId): Inst {
		const inst = this.insts[id]
		if (inst === undefined) {
			throw new Error(`Invalid InstId: ${id}`)
		}
		return inst
	}

	count(): number {
		return this.insts.length
	}

	isValid(id: InstId): boolean {
		return id >= 0 && id < this.insts.length
	}

	*[Symbol.iterator](): Generator<[InstId, Inst]> {
		for (let i = 0; i < this.insts.length; i++) {
			const inst = this.insts[i]
			if (inst !== undefined) yield [instId(i), inst]
		}
	}
}

/**
 * Storage for scopes.
 * Currently minimal - only tracks main scope.
 * Future: will track function scopes, nested scopes, etc.
 */
export class ScopeStore {
	private readonly scopes: Scope[] = []

	add(scope: Scope): ScopeId {
		const id = this.scopes.length as ScopeId
		this.scopes.push(scope)
		return id
	}

	get(id: ScopeId): Scope {
		const scope = this.scopes[id]
		if (scope === undefined) {
			throw new Error(`Invalid ScopeId: ${id}`)
		}
		return scope
	}

	count(): number {
		return this.scopes.length
	}

	createMainScope(): ScopeId {
		return this.add({
			id: scopeId(0),
			parentId: null,
			reachable: true,
		})
	}

	*[Symbol.iterator](): Generator<[ScopeId, Scope]> {
		for (let i = 0; i < this.scopes.length; i++) {
			const scope = this.scopes[i]
			if (scope !== undefined) yield [scopeId(i), scope]
		}
	}
}

/**
 * Dense array storage for symbols (variable bindings).
 * Supports shadowing: same name can be bound multiple times,
 * each with a fresh local index.
 */
export class SymbolStore {
	private readonly symbols: SymbolEntry[] = []
	/** Current binding per name (overwrites on shadowing) */
	private readonly nameToSymbol: Map<StringId, SymbolId> = new Map()
	/** Next WASM local index to allocate */
	private nextLocalIndex = 0

	/**
	 * Add a new symbol binding.
	 * Allocates a fresh local index and overwrites any previous binding of the same name.
	 */
	add(entry: Omit<SymbolEntry, 'localIndex'>): SymbolId {
		const localIndex = this.nextLocalIndex++
		const id = symbolId(this.symbols.length)
		const fullEntry: SymbolEntry = { ...entry, localIndex }
		this.symbols.push(fullEntry)
		// Overwrite previous binding (shadowing)
		this.nameToSymbol.set(entry.nameId, id)
		return id
	}

	/**
	 * Look up the current binding for a name.
	 * Returns undefined if the name has not been bound.
	 */
	lookupByName(nameId: StringId): SymbolId | undefined {
		return this.nameToSymbol.get(nameId)
	}

	/**
	 * Get symbol entry by ID.
	 */
	get(id: SymbolId): SymbolEntry {
		const entry = this.symbols[id]
		if (entry === undefined) {
			throw new Error(`Invalid SymbolId: ${id}`)
		}
		return entry
	}

	/**
	 * Get total number of symbols (= number of WASM locals needed).
	 */
	count(): number {
		return this.symbols.length
	}

	/**
	 * Get the number of WASM locals needed.
	 */
	localCount(): number {
		return this.nextLocalIndex
	}

	/**
	 * Create flattened symbols for a record binding.
	 * For p: Point with fields x, y creates $p_x, $p_y locals.
	 *
	 * @param baseName - The variable name (e.g., "p")
	 * @param fields - Field definitions from the record type
	 * @param parseNodeId - Parse node of the binding for diagnostics
	 * @param intern - Function to intern strings (e.g., context.strings.intern)
	 * @returns Array of SymbolIds for the flattened locals
	 */
	declareRecordBinding(
		baseName: string,
		fields: readonly FieldInfo[],
		parseNodeId: NodeId,
		intern: (name: string) => StringId
	): SymbolId[] {
		const symbolIds: SymbolId[] = []
		for (const field of fields) {
			const flatName = `${baseName}_${field.name}`
			const nameId = intern(flatName)
			const symId = this.add({
				nameId,
				parseNodeId,
				typeId: field.typeId,
			})
			symbolIds.push(symId)
		}
		return symbolIds
	}

	*[Symbol.iterator](): Generator<[SymbolId, SymbolEntry]> {
		for (let i = 0; i < this.symbols.length; i++) {
			const entry = this.symbols[i]
			if (entry !== undefined) yield [symbolId(i), entry]
		}
	}
}

/**
 * Dense array storage for types.
 * Bootstrapped with primitive types at indices 0-4.
 * Append-only during the check phase.
 *
 * TinyWhale uses nominal types:
 * - Primitives (i32, i64, f32, f64) are first-class structural types
 * - All `type X = T` declarations create distinct (incompatible) types
 * - Type checking is O(1) via integer comparison
 */
export class TypeStore {
	private readonly types: TypeInfo[] = []
	private readonly nameToId: Map<string, TypeId> = new Map()

	constructor() {
		this.bootstrapBuiltins()
	}

	/**
	 * Initialize builtin types at fixed indices.
	 */
	private bootstrapBuiltins(): void {
		// Must be added in exact order to match BuiltinTypeId indices
		this.addBuiltin(TypeKind.None, 'none') // 0
		this.addBuiltin(TypeKind.I32, 'i32') // 1
		this.addBuiltin(TypeKind.I64, 'i64') // 2
		this.addBuiltin(TypeKind.F32, 'f32') // 3
		this.addBuiltin(TypeKind.F64, 'f64') // 4
	}

	private addBuiltin(kind: TypeKind, name: string): void {
		const id = typeId(this.types.length)
		const info: TypeInfo = {
			kind,
			name,
			parseNodeId: null,
			underlying: id, // Builtins reference themselves
		}
		this.types.push(info)
		this.nameToId.set(name, id)
	}

	/**
	 * Declare a distinct (nominal) type.
	 * Every call returns a FRESH TypeId, different from the underlying.
	 *
	 * Example: `type UserId = i32` creates a distinct type where:
	 * - TypeId is fresh (e.g., 5)
	 * - underlying is i32's TypeId (1)
	 * - UserId ≠ i32 at compile time
	 * - At WASM level, UserId is just i32
	 */
	declareDistinct(name: string, underlying: TypeId, parseNodeId: NodeId): TypeId {
		const id = typeId(this.types.length)
		const info: TypeInfo = {
			kind: TypeKind.Distinct,
			name,
			parseNodeId,
			underlying,
		}
		this.types.push(info)
		this.nameToId.set(name, id)
		return id
	}

	/**
	 * Look up a type by name.
	 * Returns undefined if not found.
	 */
	lookup(name: string): TypeId | undefined {
		return this.nameToId.get(name)
	}

	/**
	 * Get type info by ID.
	 * Throws if ID is invalid.
	 */
	get(id: TypeId): TypeInfo {
		if (id === BuiltinTypeId.Invalid) {
			throw new Error('Cannot get TypeInfo for Invalid sentinel')
		}
		const info = this.types[id]
		if (info === undefined) {
			throw new Error(`Invalid TypeId: ${id}`)
		}
		return info
	}

	/**
	 * Check if two types are equal.
	 * O(1) integer comparison - the core of nominal typing.
	 */
	areEqual(a: TypeId, b: TypeId): boolean {
		return a === b
	}

	/**
	 * Get human-readable type name for diagnostics.
	 */
	typeName(id: TypeId): string {
		if (id === BuiltinTypeId.Invalid) {
			return '<invalid>'
		}
		const info = this.types[id]
		return info?.name ?? `<unknown type ${id}>`
	}

	/**
	 * Unwrap distinct types to get the underlying WASM primitive.
	 * Used for code generation where UserId becomes i32.
	 */
	toWasmType(id: TypeId): TypeId {
		if (id === BuiltinTypeId.Invalid) {
			return BuiltinTypeId.Invalid
		}
		const info = this.types[id]
		if (!info) {
			return BuiltinTypeId.Invalid
		}
		if (info.kind === TypeKind.Distinct) {
			// Recursively unwrap (handles nested distinct types)
			return this.toWasmType(info.underlying)
		}
		return id
	}

	count(): number {
		return this.types.length
	}

	isValid(id: TypeId): boolean {
		return id >= 0 && id < this.types.length
	}

	/**
	 * Register a record type with fields.
	 */
	registerRecordType(name: string, fields: FieldInfo[], parseNodeId: NodeId | null): TypeId {
		const id = typeId(this.types.length)
		const info: TypeInfo = {
			fields,
			kind: TypeKind.Record,
			name,
			parseNodeId,
			underlying: id, // Records reference themselves
		}
		this.types.push(info)
		this.nameToId.set(name, id)
		return id
	}

	/**
	 * Check if a type is a record type.
	 */
	isRecordType(id: TypeId): boolean {
		const info = this.types[id]
		return info?.kind === TypeKind.Record
	}

	/**
	 * Get all fields of a record type.
	 */
	getFields(id: TypeId): readonly FieldInfo[] {
		const info = this.types[id]
		return info?.fields ?? []
	}

	/**
	 * Get a specific field by name.
	 */
	getField(id: TypeId, fieldName: string): FieldInfo | undefined {
		const fields = this.getFields(id)
		return fields.find((f) => f.name === fieldName)
	}

	*[Symbol.iterator](): Generator<[TypeId, TypeInfo]> {
		for (let i = 0; i < this.types.length; i++) {
			const info = this.types[i]
			if (info !== undefined) yield [typeId(i), info]
		}
	}
}
