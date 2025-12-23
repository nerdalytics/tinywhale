import assert from 'node:assert'
import { describe, it } from 'node:test'
import { TypeStore } from '../../src/check/stores.ts'
import { BuiltinTypeId, type TypeInfo, TypeKind, typeId } from '../../src/check/types.ts'
import { nodeId } from '../../src/core/nodes.ts'

describe('check/TypeKind', () => {
	it('should have correct values for None', () => {
		assert.strictEqual(TypeKind.None, 0)
	})

	it('should have correct values for WASM primitives', () => {
		assert.strictEqual(TypeKind.I32, 1)
		assert.strictEqual(TypeKind.I64, 2)
		assert.strictEqual(TypeKind.F32, 3)
		assert.strictEqual(TypeKind.F64, 4)
	})

	it('should have correct value for Distinct', () => {
		assert.strictEqual(TypeKind.Distinct, 5)
	})
})

describe('check/BuiltinTypeId', () => {
	it('should have Invalid at -1', () => {
		assert.strictEqual(BuiltinTypeId.Invalid, -1)
	})

	it('should have None at index 0', () => {
		assert.strictEqual(BuiltinTypeId.None, 0)
	})

	it('should have WASM primitives at indices 1-4', () => {
		assert.strictEqual(BuiltinTypeId.I32, 1)
		assert.strictEqual(BuiltinTypeId.I64, 2)
		assert.strictEqual(BuiltinTypeId.F32, 3)
		assert.strictEqual(BuiltinTypeId.F64, 4)
	})
})

describe('check/typeId', () => {
	it('should create TypeId from number', () => {
		const id = typeId(5)
		assert.strictEqual(id, 5)
	})
})

describe('check/TypeStore', () => {
	describe('primitive bootstrapping', () => {
		it('should initialize with 5 builtin types', () => {
			const store = new TypeStore()
			assert.strictEqual(store.count(), 5)
		})

		it('should have none at index 0', () => {
			const store = new TypeStore()
			const info = store.get(BuiltinTypeId.None)
			assert.strictEqual(info.kind, TypeKind.None)
			assert.strictEqual(info.name, 'none')
		})

		it('should have i32 at index 1', () => {
			const store = new TypeStore()
			const info = store.get(BuiltinTypeId.I32)
			assert.strictEqual(info.kind, TypeKind.I32)
			assert.strictEqual(info.name, 'i32')
		})

		it('should have i64 at index 2', () => {
			const store = new TypeStore()
			const info = store.get(BuiltinTypeId.I64)
			assert.strictEqual(info.kind, TypeKind.I64)
			assert.strictEqual(info.name, 'i64')
		})

		it('should have f32 at index 3', () => {
			const store = new TypeStore()
			const info = store.get(BuiltinTypeId.F32)
			assert.strictEqual(info.kind, TypeKind.F32)
			assert.strictEqual(info.name, 'f32')
		})

		it('should have f64 at index 4', () => {
			const store = new TypeStore()
			const info = store.get(BuiltinTypeId.F64)
			assert.strictEqual(info.kind, TypeKind.F64)
			assert.strictEqual(info.name, 'f64')
		})

		it('should lookup primitives by name', () => {
			const store = new TypeStore()
			assert.strictEqual(store.lookup('i32'), BuiltinTypeId.I32)
			assert.strictEqual(store.lookup('i64'), BuiltinTypeId.I64)
			assert.strictEqual(store.lookup('f32'), BuiltinTypeId.F32)
			assert.strictEqual(store.lookup('f64'), BuiltinTypeId.F64)
			assert.strictEqual(store.lookup('none'), BuiltinTypeId.None)
		})

		it('should return undefined for unknown names', () => {
			const store = new TypeStore()
			assert.strictEqual(store.lookup('unknown'), undefined)
		})

		it('builtins should self-reference as underlying', () => {
			const store = new TypeStore()
			const i32Info = store.get(BuiltinTypeId.I32)
			assert.strictEqual(i32Info.underlying, BuiltinTypeId.I32)
		})

		it('builtins should have null parseNodeId', () => {
			const store = new TypeStore()
			const i32Info = store.get(BuiltinTypeId.I32)
			assert.strictEqual(i32Info.parseNodeId, null)
		})
	})

	describe('distinct types', () => {
		it('should create new TypeId for distinct type', () => {
			const store = new TypeStore()
			const distinctId = store.declareDistinct('UserId', BuiltinTypeId.I32, nodeId(0))

			assert.notStrictEqual(distinctId, BuiltinTypeId.I32)
			assert.strictEqual(store.count(), 6)
		})

		it('should track underlying type', () => {
			const store = new TypeStore()
			const distinctId = store.declareDistinct('UserId', BuiltinTypeId.I32, nodeId(0))
			const info = store.get(distinctId)

			assert.strictEqual(info.kind, TypeKind.Distinct)
			assert.strictEqual(info.underlying, BuiltinTypeId.I32)
		})

		it('should be lookupable by name', () => {
			const store = new TypeStore()
			const distinctId = store.declareDistinct('UserId', BuiltinTypeId.I32, nodeId(0))

			assert.strictEqual(store.lookup('UserId'), distinctId)
		})

		it('should store parseNodeId', () => {
			const store = new TypeStore()
			const distinctId = store.declareDistinct('UserId', BuiltinTypeId.I32, nodeId(42))
			const info = store.get(distinctId)

			assert.strictEqual(info.parseNodeId, 42)
		})

		it('different wrappers should have different TypeIds', () => {
			const store = new TypeStore()
			const userId = store.declareDistinct('UserId', BuiltinTypeId.I32, nodeId(0))
			const groupId = store.declareDistinct('GroupId', BuiltinTypeId.I32, nodeId(1))

			assert.notStrictEqual(userId, groupId)
			assert.notStrictEqual(userId, BuiltinTypeId.I32)
			assert.notStrictEqual(groupId, BuiltinTypeId.I32)
		})
	})

	describe('type equality', () => {
		it('should return true for same TypeId', () => {
			const store = new TypeStore()
			assert.strictEqual(store.areEqual(BuiltinTypeId.I32, BuiltinTypeId.I32), true)
		})

		it('should return false for different TypeIds', () => {
			const store = new TypeStore()
			assert.strictEqual(store.areEqual(BuiltinTypeId.I32, BuiltinTypeId.I64), false)
		})

		it('should distinguish distinct from underlying', () => {
			const store = new TypeStore()
			const distinctId = store.declareDistinct('UserId', BuiltinTypeId.I32, nodeId(0))

			assert.strictEqual(store.areEqual(distinctId, BuiltinTypeId.I32), false)
		})

		it('should distinguish different distinct types', () => {
			const store = new TypeStore()
			const userId = store.declareDistinct('UserId', BuiltinTypeId.I32, nodeId(0))
			const groupId = store.declareDistinct('GroupId', BuiltinTypeId.I32, nodeId(1))

			assert.strictEqual(store.areEqual(userId, groupId), false)
		})
	})

	describe('toWasmType', () => {
		it('should return primitive unchanged', () => {
			const store = new TypeStore()
			assert.strictEqual(store.toWasmType(BuiltinTypeId.I32), BuiltinTypeId.I32)
			assert.strictEqual(store.toWasmType(BuiltinTypeId.F64), BuiltinTypeId.F64)
		})

		it('should unwrap distinct to underlying', () => {
			const store = new TypeStore()
			const distinctId = store.declareDistinct('UserId', BuiltinTypeId.I32, nodeId(0))

			assert.strictEqual(store.toWasmType(distinctId), BuiltinTypeId.I32)
		})

		it('should recursively unwrap nested distinct', () => {
			const store = new TypeStore()
			const level1 = store.declareDistinct('Level1', BuiltinTypeId.F64, nodeId(0))
			const level2 = store.declareDistinct('Level2', level1, nodeId(1))

			assert.strictEqual(store.toWasmType(level2), BuiltinTypeId.F64)
		})

		it('should return Invalid for Invalid sentinel', () => {
			const store = new TypeStore()
			assert.strictEqual(store.toWasmType(BuiltinTypeId.Invalid), BuiltinTypeId.Invalid)
		})
	})

	describe('typeName', () => {
		it('should return primitive names', () => {
			const store = new TypeStore()
			assert.strictEqual(store.typeName(BuiltinTypeId.I32), 'i32')
			assert.strictEqual(store.typeName(BuiltinTypeId.None), 'none')
		})

		it('should return distinct type name', () => {
			const store = new TypeStore()
			const distinctId = store.declareDistinct('UserId', BuiltinTypeId.I32, nodeId(0))
			assert.strictEqual(store.typeName(distinctId), 'UserId')
		})

		it('should return <invalid> for Invalid sentinel', () => {
			const store = new TypeStore()
			assert.strictEqual(store.typeName(BuiltinTypeId.Invalid), '<invalid>')
		})
	})

	describe('error handling', () => {
		it('should throw for invalid TypeId', () => {
			const store = new TypeStore()
			assert.throws(() => store.get(typeId(100)), /Invalid TypeId/)
		})

		it('should throw when getting Invalid sentinel', () => {
			const store = new TypeStore()
			assert.throws(() => store.get(BuiltinTypeId.Invalid), /Invalid sentinel/)
		})
	})

	describe('validation', () => {
		it('should validate builtin IDs', () => {
			const store = new TypeStore()
			assert.strictEqual(store.isValid(BuiltinTypeId.None), true)
			assert.strictEqual(store.isValid(BuiltinTypeId.I32), true)
			assert.strictEqual(store.isValid(BuiltinTypeId.F64), true)
		})

		it('should invalidate out-of-range IDs', () => {
			const store = new TypeStore()
			assert.strictEqual(store.isValid(typeId(100)), false)
			assert.strictEqual(store.isValid(typeId(-1)), false)
		})
	})

	describe('iteration', () => {
		it('should iterate over all types', () => {
			const store = new TypeStore()
			const types: Array<[number, TypeInfo]> = []

			for (const [id, info] of store) {
				types.push([id, info])
			}

			assert.strictEqual(types.length, 5)
			assert.strictEqual(types[0]?.[0], 0)
			assert.strictEqual(types[0]?.[1].name, 'none')
			assert.strictEqual(types[1]?.[0], 1)
			assert.strictEqual(types[1]?.[1].name, 'i32')
		})

		it('should include distinct types in iteration', () => {
			const store = new TypeStore()
			store.declareDistinct('UserId', BuiltinTypeId.I32, nodeId(0))

			const types: Array<[number, TypeInfo]> = []
			for (const [id, info] of store) {
				types.push([id, info])
			}

			assert.strictEqual(types.length, 6)
			assert.strictEqual(types[5]?.[1].name, 'UserId')
		})
	})
})
