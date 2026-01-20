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
	type TypeConstraints,
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
 * A scope frame holds bindings visible within that scope.
 */
interface ScopeFrame {
	readonly bindings: Map<StringId, SymbolId>
}

/**
 * Dense array storage for symbols (variable bindings).
 * Supports shadowing: same name can be bound multiple times,
 * each with a fresh local index.
 */
export class SymbolStore {
	private readonly symbols: SymbolEntry[] = []
	private readonly scopeStack: ScopeFrame[] = []
	private nextLocalIndex = 0
	private readonly listBindings: Map<StringId, TypeId> = new Map()

	constructor() {
		// Push global scope - never popped
		this.scopeStack.push({ bindings: new Map() })
	}

	add(entry: Omit<SymbolEntry, 'localIndex'>): SymbolId {
		const localIndex = this.nextLocalIndex++
		const id = symbolId(this.symbols.length)
		const fullEntry: SymbolEntry = { ...entry, localIndex }

		// Store in flat array (codegen needs all symbols)
		this.symbols.push(fullEntry)

		// Register in current scope's bindings
		const currentScope = this.scopeStack[this.scopeStack.length - 1]!
		currentScope.bindings.set(entry.nameId, id)

		return id
	}

	lookupByName(nameId: StringId): SymbolId | undefined {
		return this.nameToSymbol.get(nameId)
	}

	get(id: SymbolId): SymbolEntry {
		const entry = this.symbols[id]
		if (entry === undefined) {
			throw new Error(`Invalid SymbolId: ${id}`)
		}
		return entry
	}

	count(): number {
		return this.symbols.length
	}

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

	/**
	 * Create flattened symbols for a list binding.
	 * For arr: [i32; 3] creates $arr_0, $arr_1, $arr_2 locals.
	 *
	 * @param baseName - The variable name (e.g., "arr")
	 * @param listTypeId - The list type ID
	 * @param parseNodeId - Parse node of the binding for diagnostics
	 * @param intern - Function to intern strings (e.g., context.strings.intern)
	 * @param types - TypeStore to resolve list metadata
	 * @returns Array of SymbolIds for the flattened locals
	 */
	declareListBinding(
		baseName: string,
		listTypeId: TypeId,
		parseNodeId: NodeId,
		intern: (name: string) => StringId,
		types: TypeStore
	): SymbolId[] {
		const size = types.getListSize(listTypeId)
		const elementTypeId = types.getListElementType(listTypeId)

		if (size === undefined || elementTypeId === undefined) {
			return []
		}

		const baseNameId = intern(baseName)
		this.listBindings.set(baseNameId, listTypeId)

		const symbolIds: SymbolId[] = []
		for (let i = 0; i < size; i++) {
			const flatName = `${baseName}_${i}`
			const nameId = intern(flatName)
			const symId = this.add({
				nameId,
				parseNodeId,
				typeId: elementTypeId,
			})
			symbolIds.push(symId)
		}
		return symbolIds
	}

	getListBinding(nameId: StringId): TypeId | undefined {
		return this.listBindings.get(nameId)
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

	private bootstrapBuiltins(): void {
		this.addBuiltin(TypeKind.None, 'none')
		this.addBuiltin(TypeKind.I32, 'i32')
		this.addBuiltin(TypeKind.I64, 'i64')
		this.addBuiltin(TypeKind.F32, 'f32')
		this.addBuiltin(TypeKind.F64, 'f64')
	}

	private addBuiltin(kind: TypeKind, name: string): void {
		const id = typeId(this.types.length)
		const info: TypeInfo = {
			kind,
			name,
			parseNodeId: null,
			underlying: id,
		}
		this.types.push(info)
		this.nameToId.set(name, id)
	}

	/**
	 * Every call returns a FRESH TypeId, different from the underlying.
	 * Example: `type UserId = i32` creates distinct type where UserId ≠ i32 at compile time.
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

	lookup(name: string): TypeId | undefined {
		return this.nameToId.get(name)
	}

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

	areEqual(a: TypeId, b: TypeId): boolean {
		return a === b
	}

	typeName(id: TypeId): string {
		if (id === BuiltinTypeId.Invalid) {
			return '<invalid>'
		}
		const info = this.types[id]
		return info?.name ?? `<unknown type ${id}>`
	}

	toWasmType(id: TypeId): TypeId {
		if (id === BuiltinTypeId.Invalid) {
			return BuiltinTypeId.Invalid
		}
		const info = this.types[id]
		if (!info) {
			return BuiltinTypeId.Invalid
		}
		if (info.kind === TypeKind.Distinct || info.kind === TypeKind.Refined) {
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

	registerRecordType(name: string, fields: FieldInfo[], parseNodeId: NodeId | null): TypeId {
		const id = typeId(this.types.length)
		const info: TypeInfo = {
			fields,
			kind: TypeKind.Record,
			name,
			parseNodeId,
			underlying: id,
		}
		this.types.push(info)
		this.nameToId.set(name, id)
		return id
	}

	isRecordType(id: TypeId): boolean {
		const info = this.types[id]
		return info?.kind === TypeKind.Record
	}

	getFields(id: TypeId): readonly FieldInfo[] {
		const info = this.types[id]
		return info?.fields ?? []
	}

	getField(id: TypeId, fieldName: string): FieldInfo | undefined {
		const fields = this.getFields(id)
		return fields.find((f) => f.name === fieldName)
	}

	private readonly listTypeCache: Map<string, TypeId> = new Map()

	registerListType(elementTypeId: TypeId, size: number): TypeId {
		const cacheKey = `${elementTypeId}:${size}`
		const existing = this.listTypeCache.get(cacheKey)
		if (existing !== undefined) {
			return existing
		}

		const elementInfo = this.get(elementTypeId)
		const name = `[${elementInfo.name}; ${size}]`

		const id = typeId(this.types.length)
		const info: TypeInfo = {
			elementTypeId,
			kind: TypeKind.List,
			listSize: size,
			name,
			parseNodeId: null,
			underlying: id,
		}
		this.types.push(info)
		this.listTypeCache.set(cacheKey, id)
		return id
	}

	isListType(id: TypeId): boolean {
		const info = this.types[id]
		return info?.kind === TypeKind.List
	}

	getListSize(id: TypeId): number | undefined {
		const info = this.types[id]
		if (info?.kind !== TypeKind.List) {
			return undefined
		}
		return info.listSize
	}

	getListElementType(id: TypeId): TypeId | undefined {
		const info = this.types[id]
		if (info?.kind !== TypeKind.List) {
			return undefined
		}
		return info.elementTypeId
	}

	private readonly refinedTypeCache: Map<string, TypeId> = new Map()

	/**
	 * Register a refined type with constraints (min/max).
	 * Refined types are interned - same base + constraints = same TypeId.
	 */
	registerRefinedType(baseTypeId: TypeId, constraints: TypeConstraints): TypeId {
		const cacheKey = this.makeRefinedTypeCacheKey(baseTypeId, constraints)
		const existing = this.refinedTypeCache.get(cacheKey)
		if (existing !== undefined) {
			return existing
		}

		const baseInfo = this.get(baseTypeId)
		const name = this.makeRefinedTypeName(baseInfo.name, constraints)

		const id = typeId(this.types.length)
		const info: TypeInfo = {
			constraints,
			kind: TypeKind.Refined,
			name,
			parseNodeId: null,
			underlying: baseTypeId,
		}
		this.types.push(info)
		this.refinedTypeCache.set(cacheKey, id)
		return id
	}

	private makeRefinedTypeCacheKey(baseTypeId: TypeId, constraints: TypeConstraints): string {
		const parts = [`${baseTypeId}`]
		if (constraints.min !== undefined) {
			parts.push(`min=${constraints.min}`)
		}
		if (constraints.max !== undefined) {
			parts.push(`max=${constraints.max}`)
		}
		return parts.join(':')
	}

	private makeRefinedTypeName(baseName: string, constraints: TypeConstraints): string {
		const parts: string[] = []
		if (constraints.min !== undefined) {
			parts.push(`min=${constraints.min}`)
		}
		if (constraints.max !== undefined) {
			parts.push(`max=${constraints.max}`)
		}
		return `${baseName}<${parts.join(', ')}>`
	}

	isRefinedType(id: TypeId): boolean {
		const info = this.types[id]
		return info?.kind === TypeKind.Refined
	}

	getConstraints(id: TypeId): TypeConstraints | undefined {
		const info = this.types[id]
		if (info?.kind !== TypeKind.Refined) {
			return undefined
		}
		return info.constraints
	}

	*[Symbol.iterator](): Generator<[TypeId, TypeInfo]> {
		for (let i = 0; i < this.types.length; i++) {
			const info = this.types[i]
			if (info !== undefined) yield [typeId(i), info]
		}
	}
}
