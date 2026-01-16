import assert from 'node:assert'
import { describe, it } from 'node:test'
import fc from 'fast-check'
import { check } from '../../src/check/checker.ts'
import { TypeStore } from '../../src/check/stores.ts'
import { BuiltinTypeId } from '../../src/check/types.ts'
import { emit } from '../../src/codegen/index.ts'
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

const constraintsArb = fc
	.record({
		max: fc.option(fc.bigInt({ max: 1000n, min: -1000n }), { nil: undefined }),
		min: fc.option(fc.bigInt({ max: 1000n, min: -1000n }), { nil: undefined }),
	})
	.map(({ min, max }) => {
		const result: { min?: bigint; max?: bigint } = {}
		if (min !== undefined) result.min = min
		if (max !== undefined) result.max = max
		return result
	})

function compileAndCheck(source: string): CompilationContext {
	const ctx = new CompilationContext(source)
	tokenize(ctx)
	parse(ctx)
	check(ctx)
	return ctx
}

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

describe('check/type-hints diagnostics', () => {
	describe('TWCHECK040: invalid hint target', () => {
		it('errors when applying min/max to f32', () => {
			const ctx = compileAndCheck('x: f32<min=0> = 5.0\npanic')

			const diags = ctx.getDiagnostics()
			assert.ok(
				diags.some((d) => d.def.code === 'TWCHECK040'),
				`expected TWCHECK040, got: ${diags.map((d) => d.def.code)}`
			)
		})

		it('errors when applying min/max to f64', () => {
			const ctx = compileAndCheck('x: f64<max=100> = 50.0\npanic')

			const diags = ctx.getDiagnostics()
			assert.ok(
				diags.some((d) => d.def.code === 'TWCHECK040'),
				`expected TWCHECK040, got: ${diags.map((d) => d.def.code)}`
			)
		})
	})

	describe('TWCHECK041: literal constraint violation', () => {
		it('errors when literal violates min constraint', () => {
			const ctx = compileAndCheck('x: i32<min=0> = -1\npanic')

			const diags = ctx.getDiagnostics()
			assert.ok(
				diags.some((d) => d.def.code === 'TWCHECK041'),
				`expected TWCHECK041, got: ${diags.map((d) => d.def.code)}`
			)
		})

		it('errors when literal violates max constraint', () => {
			const ctx = compileAndCheck('x: i32<max=100> = 101\npanic')

			const diags = ctx.getDiagnostics()
			assert.ok(
				diags.some((d) => d.def.code === 'TWCHECK041'),
				`expected TWCHECK041, got: ${diags.map((d) => d.def.code)}`
			)
		})

		it('errors when literal violates both min and max', () => {
			const ctx = compileAndCheck('x: i32<min=0, max=100> = -5\npanic')

			const diags = ctx.getDiagnostics()
			assert.ok(
				diags.some((d) => d.def.code === 'TWCHECK041'),
				`expected TWCHECK041, got: ${diags.map((d) => d.def.code)}`
			)
		})

		it('errors when literal exceeds max with min also defined', () => {
			const ctx = compileAndCheck('x: i32<min=0, max=100> = 150\npanic')

			const diags = ctx.getDiagnostics()
			assert.ok(
				diags.some((d) => d.def.code === 'TWCHECK041'),
				`expected TWCHECK041, got: ${diags.map((d) => d.def.code)}`
			)
		})
	})
})

describe('check/type-hints type compatibility', () => {
	it('errors when assigning i32 to i32<min=0> without cast', () => {
		const source = `raw: i32 = 5
x: i32<min=0> = raw
panic`
		const ctx = new CompilationContext(source)
		tokenize(ctx)
		parse(ctx)
		check(ctx)

		const diags = ctx.getDiagnostics()
		assert.ok(
			diags.some((d) => d.def.code === 'TWCHECK012'),
			`expected TWCHECK012, got: ${diags.map((d) => d.def.code)}`
		)
	})

	it('errors when assigning i32<min=0> to i32<min=0, max=100> without cast', () => {
		const source = `x: i32<min=0> = 5
y: i32<min=0, max=100> = x
panic`
		const ctx = new CompilationContext(source)
		tokenize(ctx)
		parse(ctx)
		check(ctx)

		const diags = ctx.getDiagnostics()
		assert.ok(
			diags.some((d) => d.def.code === 'TWCHECK012'),
			`expected TWCHECK012, got: ${diags.map((d) => d.def.code)}`
		)
	})

	it('allows assigning literal that satisfies constraints', () => {
		const source = `x: i32<min=0, max=100> = 50
panic`
		const ctx = new CompilationContext(source)
		tokenize(ctx)
		parse(ctx)
		const result = check(ctx)

		assert.ok(result.succeeded)
	})
})

function generateRefinedProgram(
	type: 'i32' | 'i64',
	constraints: { min?: bigint; max?: bigint },
	value: bigint
): string {
	const hints = []
	if (constraints.min !== undefined) hints.push(`min=${constraints.min}`)
	if (constraints.max !== undefined) hints.push(`max=${constraints.max}`)
	const hintStr = hints.length > 0 ? `<${hints.join(', ')}>` : ''
	return `x: ${type}${hintStr} = ${value}\npanic\n`
}

describe('check/type-hints end-to-end properties', () => {
	it('soundness: values within constraints compile without errors', () => {
		fc.assert(
			fc.property(
				fc.constantFrom('i32' as const, 'i64' as const),
				fc.bigInt({ max: 100n, min: 0n }),
				fc.bigInt({ max: 200n, min: 100n }),
				(type, min, max) => {
					// Value in range [min, max]
					const value = min + (max - min) / 2n
					const source = generateRefinedProgram(type, { max, min }, value)

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					return checkResult.succeeded
				}
			),
			{ numRuns: 100 }
		)
	})

	it('completeness: values below min produce TWCHECK041', () => {
		fc.assert(
			fc.property(
				fc.constantFrom('i32' as const, 'i64' as const),
				fc.bigInt({ max: 100n, min: 1n }),
				fc.bigInt({ max: 10n, min: 1n }),
				(type, min, offset) => {
					const value = min - offset // Below min
					const source = generateRefinedProgram(type, { min }, value)

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					check(ctx)
					const diags = ctx.getDiagnostics()
					return diags.some((d) => d.def.code === 'TWCHECK041')
				}
			),
			{ numRuns: 100 }
		)
	})

	it('completeness: values above max produce TWCHECK041', () => {
		fc.assert(
			fc.property(
				fc.constantFrom('i32' as const, 'i64' as const),
				fc.bigInt({ max: 100n, min: 0n }),
				fc.bigInt({ max: 10n, min: 1n }),
				(type, max, offset) => {
					const value = max + offset // Above max
					const source = generateRefinedProgram(type, { max }, value)

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					check(ctx)
					const diags = ctx.getDiagnostics()
					return diags.some((d) => d.def.code === 'TWCHECK041')
				}
			),
			{ numRuns: 100 }
		)
	})

	it('valid refined programs produce valid WASM', () => {
		fc.assert(
			fc.property(
				fc.constantFrom('i32' as const, 'i64' as const),
				fc.bigInt({ max: 50n, min: 0n }),
				fc.bigInt({ max: 100n, min: 50n }),
				(type, min, max) => {
					const value = min + (max - min) / 2n
					const source = generateRefinedProgram(type, { max, min }, value)

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					const emitResult = emit(ctx)
					if (!emitResult.valid) return true

					// WASM magic number
					return (
						emitResult.binary[0] === 0x00 &&
						emitResult.binary[1] === 0x61 &&
						emitResult.binary[2] === 0x73 &&
						emitResult.binary[3] === 0x6d
					)
				}
			),
			{ numRuns: 50 }
		)
	})

	it('determinism: same program produces identical output', () => {
		fc.assert(
			fc.property(
				fc.constantFrom('i32' as const, 'i64' as const),
				fc.bigInt({ max: 50n, min: 0n }),
				fc.bigInt({ max: 100n, min: 50n }),
				(type, min, max) => {
					const value = min + (max - min) / 2n
					const source = generateRefinedProgram(type, { max, min }, value)

					const ctx1 = new CompilationContext(source)
					const ctx2 = new CompilationContext(source)

					tokenize(ctx1)
					tokenize(ctx2)

					const p1 = parse(ctx1)
					const p2 = parse(ctx2)
					if (!p1.succeeded || !p2.succeeded) return true

					const c1 = check(ctx1)
					const c2 = check(ctx2)
					if (!c1.succeeded || !c2.succeeded) return true

					const e1 = emit(ctx1)
					const e2 = emit(ctx2)
					if (!e1.valid || !e2.valid) return true

					if (e1.binary.length !== e2.binary.length) return false
					for (let i = 0; i < e1.binary.length; i++) {
						if (e1.binary[i] !== e2.binary[i]) return false
					}
					return true
				}
			),
			{ numRuns: 30 }
		)
	})
})
