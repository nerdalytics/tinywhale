import assert from 'node:assert'
import { describe, it } from 'node:test'
import fc from 'fast-check'
import { check } from '../../src/check/checker.ts'
import { TypeStore } from '../../src/check/stores.ts'
import { BuiltinTypeId } from '../../src/check/types.ts'
import { CompilationContext } from '../../src/core/context.ts'
import { tokenize } from '../../src/lex/tokenizer.ts'
import { parse } from '../../src/parse/parser.ts'

describe('check/type-hints TypeStore', () => {
	it('registerRefinedType creates distinct type from base', () => {
		const store = new TypeStore()
		const refinedId = store.registerRefinedType(BuiltinTypeId.I32, { min: 0n })

		assert.ok(refinedId !== BuiltinTypeId.I32, 'refined type should be distinct')
	})

	it('refined types with same constraints are interned', () => {
		const store = new TypeStore()
		const id1 = store.registerRefinedType(BuiltinTypeId.I32, { min: 0n })
		const id2 = store.registerRefinedType(BuiltinTypeId.I32, { min: 0n })

		assert.strictEqual(id1, id2, 'same constraints should produce same TypeId')
	})

	it('refined types with different constraints are distinct', () => {
		const store = new TypeStore()
		const id1 = store.registerRefinedType(BuiltinTypeId.I32, { min: 0n })
		const id2 = store.registerRefinedType(BuiltinTypeId.I32, { min: 1n })

		assert.ok(id1 !== id2, 'different constraints should produce different TypeIds')
	})

	it('getConstraints returns constraint metadata', () => {
		const store = new TypeStore()
		const refinedId = store.registerRefinedType(BuiltinTypeId.I32, { max: 100n, min: 0n })

		const constraints = store.getConstraints(refinedId)
		assert.deepStrictEqual(constraints, { max: 100n, min: 0n })
	})

	it('isRefinedType returns true for refined types', () => {
		const store = new TypeStore()
		const refinedId = store.registerRefinedType(BuiltinTypeId.I32, { min: 0n })

		assert.ok(store.isRefinedType(refinedId))
		assert.ok(!store.isRefinedType(BuiltinTypeId.I32))
	})

	it('typeName includes constraints', () => {
		const store = new TypeStore()
		const refinedId = store.registerRefinedType(BuiltinTypeId.I32, { max: 100n, min: 0n })

		const name = store.typeName(refinedId)
		assert.ok(name.includes('min=0'), 'should include min constraint')
		assert.ok(name.includes('max=100'), 'should include max constraint')
	})
})

// Arbitraries for property tests
const integerBaseTypeArb = fc.constantFrom(BuiltinTypeId.I32, BuiltinTypeId.I64)

const constraintsArb = fc.record({
	max: fc.option(fc.bigInt({ max: 1000n, min: -1000n }), { nil: undefined }),
	min: fc.option(fc.bigInt({ max: 1000n, min: -1000n }), { nil: undefined }),
})

describe('check/type-hints TypeStore properties', () => {
	it('refined types with identical constraints are always interned', () => {
		fc.assert(
			fc.property(integerBaseTypeArb, constraintsArb, (baseType, constraints) => {
				const store = new TypeStore()
				const id1 = store.registerRefinedType(baseType, constraints)
				const id2 = store.registerRefinedType(baseType, constraints)
				return id1 === id2
			}),
			{ numRuns: 100 }
		)
	})

	it('refined types with different min are always distinct', () => {
		fc.assert(
			fc.property(
				integerBaseTypeArb,
				fc.bigInt({ max: 100n, min: -100n }),
				fc.bigInt({ max: 100n, min: -100n }).filter((n) => n !== 0n),
				(baseType, min1, offset) => {
					const store = new TypeStore()
					const id1 = store.registerRefinedType(baseType, { min: min1 })
					const id2 = store.registerRefinedType(baseType, { min: min1 + offset })
					return id1 !== id2
				}
			),
			{ numRuns: 100 }
		)
	})

	it('refined types with different max are always distinct', () => {
		fc.assert(
			fc.property(
				integerBaseTypeArb,
				fc.bigInt({ max: 100n, min: -100n }),
				fc.bigInt({ max: 100n, min: -100n }).filter((n) => n !== 0n),
				(baseType, max1, offset) => {
					const store = new TypeStore()
					const id1 = store.registerRefinedType(baseType, { max: max1 })
					const id2 = store.registerRefinedType(baseType, { max: max1 + offset })
					return id1 !== id2
				}
			),
			{ numRuns: 100 }
		)
	})

	it('getConstraints returns exact constraints registered', () => {
		fc.assert(
			fc.property(integerBaseTypeArb, constraintsArb, (baseType, constraints) => {
				const store = new TypeStore()
				const id = store.registerRefinedType(baseType, constraints)
				const retrieved = store.getConstraints(id)

				if (retrieved === undefined) return false
				return retrieved.min === constraints.min && retrieved.max === constraints.max
			}),
			{ numRuns: 100 }
		)
	})

	it('toWasmType unwraps refined type to primitive', () => {
		fc.assert(
			fc.property(integerBaseTypeArb, constraintsArb, (baseType, constraints) => {
				const store = new TypeStore()
				const refinedId = store.registerRefinedType(baseType, constraints)
				return store.toWasmType(refinedId) === baseType
			}),
			{ numRuns: 100 }
		)
	})

	it('different base types with same constraints produce distinct refined types', () => {
		fc.assert(
			fc.property(constraintsArb, (constraints) => {
				const store = new TypeStore()
				const i32Refined = store.registerRefinedType(BuiltinTypeId.I32, constraints)
				const i64Refined = store.registerRefinedType(BuiltinTypeId.I64, constraints)
				return i32Refined !== i64Refined
			}),
			{ numRuns: 50 }
		)
	})
})

describe('check/type-hints resolution', () => {
	function compileAndCheck(source: string): CompilationContext {
		const ctx = new CompilationContext(source)
		tokenize(ctx)
		parse(ctx)
		check(ctx)
		return ctx
	}

	it('resolves i32<min=0> to refined type', () => {
		const ctx = compileAndCheck('x: i32<min=0> = 5\npanic')
		assert.ok(
			!ctx.hasErrors(),
			`expected no errors, got: ${ctx.getDiagnostics().map((d) => d.message)}`
		)
	})

	it('resolves i32<min=0, max=100> to refined type', () => {
		const ctx = compileAndCheck('x: i32<min=0, max=100> = 50\npanic')
		assert.ok(
			!ctx.hasErrors(),
			`expected no errors, got: ${ctx.getDiagnostics().map((d) => d.message)}`
		)
	})

	it('resolves i64<min=-1000> to refined type', () => {
		const ctx = compileAndCheck('x: i64<min=-1000> = 0\npanic')
		assert.ok(
			!ctx.hasErrors(),
			`expected no errors, got: ${ctx.getDiagnostics().map((d) => d.message)}`
		)
	})

	it('refined type assignment is compatible with literal in range', () => {
		const ctx = compileAndCheck('x: i32<min=0, max=100> = 50\npanic')
		assert.ok(!ctx.hasErrors(), 'literal 50 should be valid for i32<min=0, max=100>')
	})
})
