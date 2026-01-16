import { describe, it } from 'node:test'
import fc from 'fast-check'
import { check } from '../src/check/checker.ts'
import { TypeStore } from '../src/check/stores.ts'
import { BuiltinTypeId } from '../src/check/types.ts'
import { emit } from '../src/codegen/index.ts'
import { CompilationContext } from '../src/core/context.ts'
import { tokenize } from '../src/lex/tokenizer.ts'
import { parse } from '../src/parse/parser.ts'

// ============================================================================
// Arbitraries
// ============================================================================

const primitiveTypeArb = fc.constantFrom('i32', 'i64', 'f32', 'f64')

/** Map primitive string to BuiltinTypeId */
function primitiveToTypeId(prim: string): (typeof BuiltinTypeId)[keyof typeof BuiltinTypeId] {
	switch (prim) {
		case 'i32':
			return BuiltinTypeId.I32
		case 'i64':
			return BuiltinTypeId.I64
		case 'f32':
			return BuiltinTypeId.F32
		case 'f64':
			return BuiltinTypeId.F64
		default:
			return BuiltinTypeId.I32
	}
}

/** Generate a valid literal for a given type */
function literalForType(type: string, value: number): string {
	if (type === 'f32' || type === 'f64') {
		return `${Math.abs(value)}.0`
	}
	return `${Math.abs(value)}`
}

/** Generate a list literal with N elements */
function generateListLiteral(type: string, values: number[]): string {
	return `[${values.map((v) => literalForType(type, v)).join(', ')}]`
}

/** Generate valid list program source */
function generateListProgram(type: string, size: number, values: number[]): string {
	const literal = generateListLiteral(type, values.slice(0, size))
	return `arr: ${type}[]<size=${size}> = ${literal}\npanic\n`
}

/** Generate list program with index access */
function generateListWithAccess(type: string, size: number, values: number[], index: number): string {
	const literal = generateListLiteral(type, values.slice(0, size))
	return `arr: ${type}[]<size=${size}> = ${literal}\nx: ${type} = arr[${index}]\npanic\n`
}

// ============================================================================
// TypeStore Algebraic Properties
// ============================================================================

describe('list types/TypeStore properties', () => {
	it('list type interning: same (elementType, size) → same TypeId', () => {
		fc.assert(
			fc.property(
				primitiveTypeArb,
				fc.integer({ max: 10, min: 1 }),
				(elementType, size) => {
					const store = new TypeStore()
					const elementTypeId = primitiveToTypeId(elementType)

					const id1 = store.registerListType(elementTypeId, size)
					const id2 = store.registerListType(elementTypeId, size)

					return id1 === id2
				}
			),
			{ numRuns: 200 }
		)
	})

	it('list type distinctness: different sizes → different TypeIds', () => {
		fc.assert(
			fc.property(
				primitiveTypeArb,
				fc.tuple(fc.integer({ max: 10, min: 1 }), fc.integer({ max: 10, min: 1 })).filter(
					([a, b]) => a !== b
				),
				(elementType, [size1, size2]) => {
					const store = new TypeStore()
					const elementTypeId = primitiveToTypeId(elementType)

					const id1 = store.registerListType(elementTypeId, size1)
					const id2 = store.registerListType(elementTypeId, size2)

					return id1 !== id2
				}
			),
			{ numRuns: 200 }
		)
	})

	it('list type distinctness: different element types → different TypeIds', () => {
		fc.assert(
			fc.property(
				fc.tuple(primitiveTypeArb, primitiveTypeArb).filter(([a, b]) => a !== b),
				fc.integer({ max: 10, min: 1 }),
				([type1, type2], size) => {
					const store = new TypeStore()
					const typeId1 = primitiveToTypeId(type1)
					const typeId2 = primitiveToTypeId(type2)

					const id1 = store.registerListType(typeId1, size)
					const id2 = store.registerListType(typeId2, size)

					return id1 !== id2
				}
			),
			{ numRuns: 200 }
		)
	})

	it('isListType returns true for registered list types', () => {
		fc.assert(
			fc.property(
				primitiveTypeArb,
				fc.integer({ max: 10, min: 1 }),
				(elementType, size) => {
					const store = new TypeStore()
					const elementTypeId = primitiveToTypeId(elementType)
					const listTypeId = store.registerListType(elementTypeId, size)

					return store.isListType(listTypeId)
				}
			),
			{ numRuns: 200 }
		)
	})

	it('isListType returns false for primitive types', () => {
		fc.assert(
			fc.property(primitiveTypeArb, (type) => {
				const store = new TypeStore()
				const typeId = primitiveToTypeId(type)

				return !store.isListType(typeId)
			}),
			{ numRuns: 100 }
		)
	})

	it('getListSize returns correct size', () => {
		fc.assert(
			fc.property(
				primitiveTypeArb,
				fc.integer({ max: 100, min: 1 }),
				(elementType, size) => {
					const store = new TypeStore()
					const elementTypeId = primitiveToTypeId(elementType)
					const listTypeId = store.registerListType(elementTypeId, size)

					return store.getListSize(listTypeId) === size
				}
			),
			{ numRuns: 200 }
		)
	})

	it('getListElementType returns correct element type', () => {
		fc.assert(
			fc.property(
				primitiveTypeArb,
				fc.integer({ max: 10, min: 1 }),
				(elementType, size) => {
					const store = new TypeStore()
					const elementTypeId = primitiveToTypeId(elementType)
					const listTypeId = store.registerListType(elementTypeId, size)

					return store.getListElementType(listTypeId) === elementTypeId
				}
			),
			{ numRuns: 200 }
		)
	})
})

// ============================================================================
// Bounds Checking Properties
// ============================================================================

describe('list types/bounds checking properties', () => {
	it('soundness: valid indices [0, size-1] produce no errors', () => {
		fc.assert(
			fc.property(
				primitiveTypeArb,
				fc.integer({ max: 5, min: 1 }), // size
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 5, minLength: 5 }),
				(type, size, values) => {
					// Test all valid indices
					for (let index = 0; index < size; index++) {
						const source = generateListWithAccess(type, size, values, index)
						const ctx = new CompilationContext(source)
						tokenize(ctx)
						const parseResult = parse(ctx)
						if (!parseResult.succeeded) return true

						const checkResult = check(ctx)
						if (!checkResult.succeeded) {
							// Check if failure is due to bounds (shouldn't be)
							const diags = ctx.getDiagnostics()
							if (diags.some((d) => d.def.code === 'TWCHECK034')) {
								return false // Bounds error on valid index!
							}
						}
					}
					return true
				}
			),
			{ numRuns: 50 }
		)
	})

	it('completeness: index >= size produces TWCHECK034', () => {
		fc.assert(
			fc.property(
				primitiveTypeArb,
				fc.integer({ max: 5, min: 1 }), // size
				fc.integer({ max: 10, min: 0 }), // offset beyond size
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 5, minLength: 5 }),
				(type, size, offset, values) => {
					const outOfBoundsIndex = size + offset
					const source = generateListWithAccess(type, size, values, outOfBoundsIndex)
					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					check(ctx)
					const diags = ctx.getDiagnostics()
					return diags.some((d) => d.def.code === 'TWCHECK034')
				}
			),
			{ numRuns: 100 }
		)
	})

	it('index exactly at boundary (size) produces error', () => {
		fc.assert(
			fc.property(
				primitiveTypeArb,
				fc.integer({ max: 5, min: 1 }),
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 5, minLength: 5 }),
				(type, size, values) => {
					const source = generateListWithAccess(type, size, values, size) // index == size
					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					check(ctx)
					const diags = ctx.getDiagnostics()
					return diags.some((d) => d.def.code === 'TWCHECK034')
				}
			),
			{ numRuns: 100 }
		)
	})
})

// ============================================================================
// List Literal Properties
// ============================================================================

describe('list types/list literal properties', () => {
	it('literal element count matching declared size compiles successfully', () => {
		fc.assert(
			fc.property(
				primitiveTypeArb,
				fc.integer({ max: 5, min: 1 }),
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 5, minLength: 5 }),
				(type, size, values) => {
					const source = generateListProgram(type, size, values)
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

	it('literal element count < declared size produces TWCHECK037', () => {
		fc.assert(
			fc.property(
				primitiveTypeArb,
				fc.integer({ max: 5, min: 2 }), // size >= 2
				fc.integer({ max: 3, min: 1 }), // shortage
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 5, minLength: 5 }),
				(type, size, shortage, values) => {
					const actualCount = Math.max(1, size - shortage)
					const literal = generateListLiteral(type, values.slice(0, actualCount))
					const source = `arr: ${type}[]<size=${size}> = ${literal}\npanic\n`

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					check(ctx)
					const diags = ctx.getDiagnostics()
					return diags.some((d) => d.def.code === 'TWCHECK037')
				}
			),
			{ numRuns: 100 }
		)
	})

	it('literal element count > declared size produces TWCHECK037', () => {
		fc.assert(
			fc.property(
				primitiveTypeArb,
				fc.integer({ max: 3, min: 1 }), // size
				fc.integer({ max: 3, min: 1 }), // surplus
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 6, minLength: 6 }),
				(type, size, surplus, values) => {
					const actualCount = size + surplus
					const literal = generateListLiteral(type, values.slice(0, actualCount))
					const source = `arr: ${type}[]<size=${size}> = ${literal}\npanic\n`

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					check(ctx)
					const diags = ctx.getDiagnostics()
					return diags.some((d) => d.def.code === 'TWCHECK037')
				}
			),
			{ numRuns: 100 }
		)
	})
})

// ============================================================================
// Codegen Properties
// ============================================================================

describe('list types/codegen properties', () => {
	it('list of size N produces exactly N flattened locals', () => {
		fc.assert(
			fc.property(
				primitiveTypeArb,
				fc.integer({ max: 5, min: 1 }),
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 5, minLength: 5 }),
				(type, size, values) => {
					const source = generateListProgram(type, size, values)
					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					// Check symbol count
					const symbolCount = ctx.symbols?.localCount() ?? 0
					return symbolCount === size
				}
			),
			{ numRuns: 100 }
		)
	})

	it('all list literal values appear in WAT output', () => {
		fc.assert(
			fc.property(
				fc.constantFrom('i32'), // Use i32 for simpler matching
				fc.integer({ max: 4, min: 1 }),
				fc.array(fc.integer({ max: 999, min: 100 }), { maxLength: 4, minLength: 4 }), // Use 100-999 range
				(type, size, values) => {
					const actualValues = values.slice(0, size)
					const source = generateListProgram(type, size, actualValues)

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					const emitResult = emit(ctx)
					if (!emitResult.valid) return true

					// All values should appear in WAT
					for (const value of actualValues) {
						if (!emitResult.text.includes(`i32.const ${value}`)) {
							return false
						}
					}
					return true
				}
			),
			{ numRuns: 50 }
		)
	})

	it('WAT contains correct number of local.set for list init', () => {
		fc.assert(
			fc.property(
				primitiveTypeArb,
				fc.integer({ max: 4, min: 1 }),
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 4, minLength: 4 }),
				(type, size, values) => {
					const source = generateListProgram(type, size, values)

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					const emitResult = emit(ctx)
					if (!emitResult.valid) return true

					const localSetCount = (emitResult.text.match(/local\.set/g) || []).length
					return localSetCount === size
				}
			),
			{ numRuns: 50 }
		)
	})

	it('index access emits local.get', () => {
		fc.assert(
			fc.property(
				primitiveTypeArb,
				fc.integer({ max: 3, min: 1 }),
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 3, minLength: 3 }),
				(type, size, values) => {
					const source = generateListWithAccess(type, size, values, 0)

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					const emitResult = emit(ctx)
					if (!emitResult.valid) return true

					return emitResult.text.includes('local.get')
				}
			),
			{ numRuns: 50 }
		)
	})
})

// ============================================================================
// End-to-End Properties
// ============================================================================

describe('list types/end-to-end properties', () => {
	it('valid list programs produce valid WASM magic number', () => {
		fc.assert(
			fc.property(
				primitiveTypeArb,
				fc.integer({ max: 4, min: 1 }),
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 4, minLength: 4 }),
				(type, size, values) => {
					const source = generateListProgram(type, size, values)

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					const emitResult = emit(ctx)
					if (!emitResult.valid) return true

					return (
						emitResult.binary[0] === 0x00 &&
						emitResult.binary[1] === 0x61 &&
						emitResult.binary[2] === 0x73 &&
						emitResult.binary[3] === 0x6d
					)
				}
			),
			{ numRuns: 100 }
		)
	})

	it('same list program produces identical binary (determinism)', () => {
		fc.assert(
			fc.property(
				primitiveTypeArb,
				fc.integer({ max: 4, min: 1 }),
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 4, minLength: 4 }),
				(type, size, values) => {
					const source = generateListProgram(type, size, values)

					const ctx1 = new CompilationContext(source)
					const ctx2 = new CompilationContext(source)

					tokenize(ctx1)
					tokenize(ctx2)

					const parse1 = parse(ctx1)
					const parse2 = parse(ctx2)
					if (!parse1.succeeded || !parse2.succeeded) return true

					const check1 = check(ctx1)
					const check2 = check(ctx2)
					if (!check1.succeeded || !check2.succeeded) return true

					const emit1 = emit(ctx1)
					const emit2 = emit(ctx2)
					if (!emit1.valid || !emit2.valid) return true

					if (emit1.binary.length !== emit2.binary.length) return false
					for (let i = 0; i < emit1.binary.length; i++) {
						if (emit1.binary[i] !== emit2.binary[i]) return false
					}
					return true
				}
			),
			{ numRuns: 50 }
		)
	})

	it('WAT contains (module for valid list programs', () => {
		fc.assert(
			fc.property(
				primitiveTypeArb,
				fc.integer({ max: 3, min: 1 }),
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 3, minLength: 3 }),
				(type, size, values) => {
					const source = generateListProgram(type, size, values)

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					const emitResult = emit(ctx)
					if (!emitResult.valid) return true

					return emitResult.text.includes('(module')
				}
			),
			{ numRuns: 50 }
		)
	})
})

// ============================================================================
// List with Arithmetic Properties
// ============================================================================

describe('list types/arithmetic properties', () => {
	it('list element arithmetic produces correct WASM type operation', () => {
		fc.assert(
			fc.property(
				primitiveTypeArb,
				fc.integer({ max: 100, min: 1 }),
				fc.integer({ max: 100, min: 1 }),
				(type, listValue, addend) => {
					const lit = literalForType(type, addend)
					const source = `arr: ${type}[]<size=1> = [${literalForType(type, listValue)}]\nresult: ${type} = arr[0] + ${lit}\npanic\n`

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					const emitResult = emit(ctx)
					if (!emitResult.valid) return true

					// Should contain type-specific add instruction
					const expectedOp = `${type}.add`
					return emitResult.text.includes(expectedOp)
				}
			),
			{ numRuns: 50 }
		)
	})

	it('comparison on list element produces i32 result', () => {
		fc.assert(
			fc.property(
				primitiveTypeArb,
				fc.integer({ max: 100, min: 0 }),
				(type, listValue) => {
					// Compare list element to itself to avoid type mismatch with literals
					const source = `arr: ${type}[]<size=1> = [${literalForType(type, listValue)}]\nresult: i32 = arr[0] < arr[0]\npanic\n`

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					// Comparison result is i32 - should succeed
					return checkResult.succeeded
				}
			),
			{ numRuns: 50 }
		)
	})
})

// ============================================================================
// Multiple List Bindings Properties
// ============================================================================

describe('list types/multiple bindings properties', () => {
	it('N list bindings of size M produce N*M locals', () => {
		fc.assert(
			fc.property(
				fc.integer({ max: 3, min: 1 }), // binding count
				fc.integer({ max: 3, min: 1 }), // size
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 9, minLength: 9 }),
				(bindingCount, size, values) => {
					const bindings = Array.from({ length: bindingCount }, (_, i) => {
						const startIdx = i * size
						const literal = generateListLiteral('i32', values.slice(startIdx, startIdx + size))
						return `arr${i}: i32[]<size=${size}> = ${literal}`
					}).join('\n')
					const source = `${bindings}\npanic\n`

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					const symbolCount = ctx.symbols?.localCount() ?? 0
					return symbolCount === bindingCount * size
				}
			),
			{ numRuns: 50 }
		)
	})

	it('multiple list types with same size are interned', () => {
		fc.assert(
			fc.property(
				fc.integer({ max: 3, min: 1 }), // size
				fc.integer({ max: 3, min: 1 }), // binding count
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 9, minLength: 9 }),
				(size, bindingCount, values) => {
					const bindings = Array.from({ length: bindingCount }, (_, i) => {
						const startIdx = i * size
						const literal = generateListLiteral('i32', values.slice(startIdx, startIdx + size))
						return `arr${i}: i32[]<size=${size}> = ${literal}`
					}).join('\n')
					const source = `${bindings}\npanic\n`

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					// Should have 5 builtins + 1 list type (interned)
					const typeCount = ctx.types?.count() ?? 0
					return typeCount === 6
				}
			),
			{ numRuns: 30 }
		)
	})
})
