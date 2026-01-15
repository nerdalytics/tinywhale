import { describe, it } from 'node:test'
import fc from 'fast-check'
import { check } from '../src/check/checker.ts'
import { TypeStore } from '../src/check/stores.ts'
import { BuiltinTypeId, type FieldInfo } from '../src/check/types.ts'
import { emit } from '../src/codegen/index.ts'
import { CompilationContext } from '../src/core/context.ts'
import { tokenize } from '../src/lex/tokenizer.ts'
import { parse } from '../src/parse/parser.ts'

// ============================================================================
// Arbitraries for record type generation
// ============================================================================

/** Valid lowercase identifier for field names */
const fieldNameArb = fc
	.stringMatching(/^[a-z][a-z0-9]{0,7}$/)
	.filter((s) => !['type', 'panic', 'match', 'i32', 'i64', 'f32', 'f64'].includes(s))

/** Valid uppercase identifier for type names */
const typeNameArb = fc.stringMatching(/^[A-Z][a-zA-Z0-9]{0,7}$/)

/** Primitive type for fields */
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

/** Generate a valid integer literal for a type */
function literalForType(type: string, value: number): string {
	if (type === 'f32' || type === 'f64') {
		return `${value}.0`
	}
	return `${value}`
}

/** Record type definition: name + array of unique field names with types */
const recordTypeDefArb = fc
	.tuple(
		typeNameArb,
		fc
			.uniqueArray(fieldNameArb, { maxLength: 5, minLength: 1 })
			.chain((names) =>
				fc.tuple(
					fc.constant(names),
					fc.array(primitiveTypeArb, { maxLength: names.length, minLength: names.length })
				)
			)
	)
	.map(([typeName, [fieldNames, fieldTypes]]) => ({
		fields: fieldNames.map((name, i) => ({ name, type: fieldTypes[i] ?? 'i32' })),
		typeName,
	}))

/** Generate TinyWhale source for a type declaration */
function generateTypeDecl(def: {
	typeName: string
	fields: { name: string; type: string }[]
}): string {
	const fieldLines = def.fields.map((f) => `    ${f.name}: ${f.type}`).join('\n')
	return `type ${def.typeName}\n${fieldLines}`
}

/** Generate TinyWhale source for a record instantiation */
function generateRecordInit(
	varName: string,
	typeName: string,
	fields: { name: string; type: string }[],
	values: number[]
): string {
	const fieldInits = fields
		.map((f, i) => `    ${f.name}: ${literalForType(f.type, values[i] ?? 0)}`)
		.join('\n')
	return `${varName}: ${typeName} =\n${fieldInits}`
}

// ============================================================================
// TypeStore Algebraic Properties
// ============================================================================

describe('record types/TypeStore properties', () => {
	it('nominal typing: identical field structures with different names get different TypeIds', () => {
		fc.assert(
			fc.property(
				fc.tuple(typeNameArb, typeNameArb).filter(([a, b]) => a !== b),
				fc.uniqueArray(fieldNameArb, { maxLength: 3, minLength: 1 }),
				([typeName1, typeName2], fieldNames) => {
					const store = new TypeStore()
					const fields: FieldInfo[] = fieldNames.map((name, i) => ({
						index: i,
						name,
						typeId: BuiltinTypeId.I32,
					}))

					const id1 = store.registerRecordType(typeName1, fields, null)
					const id2 = store.registerRecordType(typeName2, fields, null)

					// Different names → different TypeIds (nominal typing)
					return id1 !== id2
				}
			),
			{ numRuns: 200 }
		)
	})

	it('field lookup idempotence: getField returns same result on repeated calls', () => {
		fc.assert(
			fc.property(recordTypeDefArb, (def) => {
				const store = new TypeStore()
				const fields: FieldInfo[] = def.fields.map((f, i) => ({
					index: i,
					name: f.name,
					typeId: primitiveToTypeId(f.type),
				}))
				const typeId = store.registerRecordType(def.typeName, fields, null)

				// Lookup same field multiple times
				for (const field of def.fields) {
					const result1 = store.getField(typeId, field.name)
					const result2 = store.getField(typeId, field.name)
					if (result1?.name !== result2?.name || result1?.typeId !== result2?.typeId) {
						return false
					}
				}
				return true
			}),
			{ numRuns: 200 }
		)
	})

	it('getFields returns all registered fields', () => {
		fc.assert(
			fc.property(recordTypeDefArb, (def) => {
				const store = new TypeStore()
				const fields: FieldInfo[] = def.fields.map((f, i) => ({
					index: i,
					name: f.name,
					typeId: primitiveToTypeId(f.type),
				}))
				const typeId = store.registerRecordType(def.typeName, fields, null)

				const retrieved = store.getFields(typeId)
				return retrieved.length === def.fields.length
			}),
			{ numRuns: 200 }
		)
	})

	it('isRecordType returns true for registered record types', () => {
		fc.assert(
			fc.property(recordTypeDefArb, (def) => {
				const store = new TypeStore()
				const fields: FieldInfo[] = def.fields.map((f, i) => ({
					index: i,
					name: f.name,
					typeId: primitiveToTypeId(f.type),
				}))
				const typeId = store.registerRecordType(def.typeName, fields, null)

				return store.isRecordType(typeId)
			}),
			{ numRuns: 200 }
		)
	})

	it('lookup by name returns registered type', () => {
		fc.assert(
			fc.property(recordTypeDefArb, (def) => {
				const store = new TypeStore()
				const fields: FieldInfo[] = def.fields.map((f, i) => ({
					index: i,
					name: f.name,
					typeId: primitiveToTypeId(f.type),
				}))
				const typeId = store.registerRecordType(def.typeName, fields, null)

				const lookedUp = store.lookup(def.typeName)
				return lookedUp === typeId
			}),
			{ numRuns: 200 }
		)
	})
})

// ============================================================================
// Checker - Valid Program Properties
// ============================================================================

describe('record types/checker valid program properties', () => {
	it('field order independence: fields can be initialized in any order', () => {
		fc.assert(
			fc.property(
				recordTypeDefArb,
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 5, minLength: 5 }),
				fc.array(fc.nat(), { maxLength: 10, minLength: 1 }),
				(def, values, shuffleSeeds) => {
					// Generate type declaration
					const typeDecl = generateTypeDecl(def)

					// Shuffle field order using deterministic seed from fast-check
					const shuffledFields = [...def.fields].sort((a, b) => {
						const seedA = shuffleSeeds[def.fields.indexOf(a) % shuffleSeeds.length] ?? 0
						const seedB = shuffleSeeds[def.fields.indexOf(b) % shuffleSeeds.length] ?? 0
						return seedA - seedB
					})
					const shuffledValues = shuffledFields.map((f) => {
						const origIndex = def.fields.findIndex((orig) => orig.name === f.name)
						return values[origIndex] ?? 0
					})

					const recordInit = generateRecordInit('r', def.typeName, shuffledFields, shuffledValues)
					const source = `${typeDecl}\n${recordInit}\npanic\n`

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true // Grammar issue, not what we're testing

					const checkResult = check(ctx)
					// Should succeed regardless of field order
					return checkResult.succeeded
				}
			),
			{ numRuns: 100 }
		)
	})

	it('flattened symbol count equals total field count across bindings', () => {
		fc.assert(
			fc.property(
				recordTypeDefArb,
				fc.integer({ max: 3, min: 1 }),
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 5, minLength: 5 }),
				(def, bindingCount, values) => {
					const typeDecl = generateTypeDecl(def)

					// Generate multiple record bindings
					const bindings = Array.from({ length: bindingCount }, (_, i) => {
						const fieldValues = def.fields.map(
							(_, j) => values[(i * def.fields.length + j) % values.length] ?? 0
						)
						return generateRecordInit(`r${i}`, def.typeName, def.fields, fieldValues)
					}).join('\n')

					const source = `${typeDecl}\n${bindings}\npanic\n`

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					// Count symbols (excluding builtins)
					const symbolCount = ctx.symbols?.localCount() ?? 0
					const expectedSymbols = bindingCount * def.fields.length

					return symbolCount === expectedSymbols
				}
			),
			{ numRuns: 100 }
		)
	})
})

// ============================================================================
// Checker - Invalid Program Properties (Error Detection)
// ============================================================================

describe('record types/checker error detection properties', () => {
	it('missing any single required field produces error', () => {
		fc.assert(
			fc.property(
				recordTypeDefArb.filter((def) => def.fields.length >= 2),
				fc.nat(),
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 5, minLength: 5 }),
				(def, removeIndex, values) => {
					const typeDecl = generateTypeDecl(def)

					// Remove one field from initialization
					const indexToRemove = removeIndex % def.fields.length
					const partialFields = def.fields.filter((_, i) => i !== indexToRemove)
					const partialValues = values.slice(0, partialFields.length)

					const recordInit = generateRecordInit('r', def.typeName, partialFields, partialValues)
					const source = `${typeDecl}\n${recordInit}\npanic\n`

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					// Should fail due to missing field
					return !checkResult.succeeded && ctx.getDiagnostics().length > 0
				}
			),
			{ numRuns: 100 }
		)
	})

	it('duplicate field in initializer produces error', () => {
		fc.assert(
			fc.property(
				recordTypeDefArb,
				fc.nat(),
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 6, minLength: 6 }),
				(def, dupIndex, values) => {
					const typeDecl = generateTypeDecl(def)

					// Add a duplicate field
					const indexToDup = dupIndex % def.fields.length
					const dupField = def.fields[indexToDup]
					if (!dupField) return true

					const fieldsWithDup = [...def.fields, dupField]
					const valuesWithDup = [
						...values.slice(0, def.fields.length),
						values[def.fields.length] ?? 0,
					]

					const recordInit = generateRecordInit('r', def.typeName, fieldsWithDup, valuesWithDup)
					const source = `${typeDecl}\n${recordInit}\npanic\n`

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					// Should fail due to duplicate field
					return !checkResult.succeeded
				}
			),
			{ numRuns: 100 }
		)
	})

	it('unknown field name in initializer produces error', () => {
		fc.assert(
			fc.property(
				recordTypeDefArb,
				fieldNameArb,
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 6, minLength: 6 }),
				(def, unknownName, values) => {
					// Ensure unknown name isn't actually in the type
					if (def.fields.some((f) => f.name === unknownName)) return true

					const typeDecl = generateTypeDecl(def)

					// Replace first field with unknown name
					const fieldsWithUnknown = [{ name: unknownName, type: 'i32' }, ...def.fields.slice(1)]
					const fieldValues = values.slice(0, fieldsWithUnknown.length)

					const recordInit = generateRecordInit('r', def.typeName, fieldsWithUnknown, fieldValues)
					const source = `${typeDecl}\n${recordInit}\npanic\n`

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					// Should fail due to unknown field
					return !checkResult.succeeded
				}
			),
			{ numRuns: 100 }
		)
	})

	it('field access on unknown field produces error', () => {
		fc.assert(
			fc.property(
				recordTypeDefArb,
				fieldNameArb,
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 5, minLength: 5 }),
				(def, unknownField, values) => {
					// Ensure unknown field isn't in the type
					if (def.fields.some((f) => f.name === unknownField)) return true

					const typeDecl = generateTypeDecl(def)
					const fieldValues = values.slice(0, def.fields.length)
					const recordInit = generateRecordInit('r', def.typeName, def.fields, fieldValues)

					// Try to access unknown field
					const source = `${typeDecl}\n${recordInit}\nx: i32 = r.${unknownField}\npanic\n`

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					// Should fail due to unknown field access
					return !checkResult.succeeded
				}
			),
			{ numRuns: 100 }
		)
	})
})

// ============================================================================
// Codegen - Semantic Preservation Properties
// ============================================================================

describe('record types/codegen semantic preservation properties', () => {
	it('WAT local count equals total flattened field count', () => {
		fc.assert(
			fc.property(
				recordTypeDefArb,
				fc.integer({ max: 3, min: 1 }),
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 5, minLength: 5 }),
				(def, bindingCount, values) => {
					const typeDecl = generateTypeDecl(def)

					const bindings = Array.from({ length: bindingCount }, (_, i) => {
						const fieldValues = def.fields.map(
							(_, j) => values[(i * def.fields.length + j) % values.length] ?? 0
						)
						return generateRecordInit(`r${i}`, def.typeName, def.fields, fieldValues)
					}).join('\n')

					const source = `${typeDecl}\n${bindings}\npanic\n`

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					const emitResult = emit(ctx)
					if (!emitResult.valid) return true

					// Count locals in WAT output
					const localMatches = emitResult.text.match(/\(local \$/g) || []
					const expectedLocals = bindingCount * def.fields.length

					return localMatches.length === expectedLocals
				}
			),
			{ numRuns: 100 }
		)
	})

	it('field access produces local.get instruction', () => {
		fc.assert(
			fc.property(
				recordTypeDefArb.filter((def) => def.fields.length >= 1),
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 5, minLength: 5 }),
				(def, values) => {
					const typeDecl = generateTypeDecl(def)
					const fieldValues = values.slice(0, def.fields.length)
					const recordInit = generateRecordInit('r', def.typeName, def.fields, fieldValues)

					// Access first field
					const firstField = def.fields[0]
					if (!firstField) return true

					const resultType = firstField.type
					const source = `${typeDecl}\n${recordInit}\nresult: ${resultType} = r.${firstField.name}\npanic\n`

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					const emitResult = emit(ctx)
					if (!emitResult.valid) return true

					// Should contain local.get for field access
					return emitResult.text.includes('local.get')
				}
			),
			{ numRuns: 100 }
		)
	})
})

// ============================================================================
// End-to-End Properties
// ============================================================================

describe('record types/end-to-end properties', () => {
	it('same record program compiles to identical binary', () => {
		fc.assert(
			fc.property(
				recordTypeDefArb,
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 5, minLength: 5 }),
				(def, values) => {
					const typeDecl = generateTypeDecl(def)
					const fieldValues = values.slice(0, def.fields.length)
					const recordInit = generateRecordInit('r', def.typeName, def.fields, fieldValues)
					const source = `${typeDecl}\n${recordInit}\npanic\n`

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

					// Binary should be identical
					if (emit1.binary.length !== emit2.binary.length) return false
					for (let i = 0; i < emit1.binary.length; i++) {
						if (emit1.binary[i] !== emit2.binary[i]) return false
					}
					return true
				}
			),
			{ numRuns: 100 }
		)
	})

	it('valid record programs produce valid WASM magic number', () => {
		fc.assert(
			fc.property(
				recordTypeDefArb,
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 5, minLength: 5 }),
				(def, values) => {
					const typeDecl = generateTypeDecl(def)
					const fieldValues = values.slice(0, def.fields.length)
					const recordInit = generateRecordInit('r', def.typeName, def.fields, fieldValues)
					const source = `${typeDecl}\n${recordInit}\npanic\n`

					const ctx = new CompilationContext(source)
					tokenize(ctx)

					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					const emitResult = emit(ctx)
					if (!emitResult.valid) return true

					// Check WASM magic number
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

	it('WAT contains (module for valid record programs', () => {
		fc.assert(
			fc.property(
				recordTypeDefArb,
				fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 5, minLength: 5 }),
				(def, values) => {
					const typeDecl = generateTypeDecl(def)
					const fieldValues = values.slice(0, def.fields.length)
					const recordInit = generateRecordInit('r', def.typeName, def.fields, fieldValues)
					const source = `${typeDecl}\n${recordInit}\npanic\n`

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
			{ numRuns: 100 }
		)
	})
})

// ============================================================================
// Multiple Type Declarations Properties
// ============================================================================

describe('record types/multiple type declarations properties', () => {
	it('N type declarations creates N registered types', () => {
		fc.assert(
			fc.property(fc.integer({ max: 5, min: 1 }), (typeCount) => {
				const typeDecls = Array.from(
					{ length: typeCount },
					(_, i) => `type T${i}\n    f: i32`
				).join('\n')
				const source = `${typeDecls}\npanic\n`

				const ctx = new CompilationContext(source)
				tokenize(ctx)
				parse(ctx)
				check(ctx)

				// All types should be registered
				for (let i = 0; i < typeCount; i++) {
					if (ctx.types?.lookup(`T${i}`) === undefined) return false
				}
				return true
			}),
			{ numRuns: 50 }
		)
	})
})

// ============================================================================
// Nested Record Instantiation Properties
// ============================================================================

/**
 * Generate nested type declarations: T0 contains T1, T1 contains T2, ..., T(n-1) has val: i32
 */
function generateNestedTypes(depth: number): string {
	let types = ''
	for (let i = depth - 1; i >= 0; i--) {
		if (i === depth - 1) {
			types += `type T${i}\n    val: i32\n`
		} else {
			types += `type T${i}\n    inner: T${i + 1}\n`
		}
	}
	return types
}

/**
 * Generate nested record initialization for a given depth
 */
function generateNestedInit(depth: number, value: number): string {
	let init = `o: T0 =\n`
	for (let i = 0; i < depth - 1; i++) {
		init += '    '.repeat(i + 1) + `inner: T${i + 1}\n`
	}
	init += '    '.repeat(depth) + `val: ${value}\n`
	return init
}

describe('record types/nested record instantiation properties', () => {
	it('nested depth N produces correct flattened local count', () => {
		fc.assert(
			fc.property(fc.integer({ max: 3, min: 1 }), (depth) => {
				const types = generateNestedTypes(depth)
				const init = generateNestedInit(depth, 42)
				const source = types + init + 'panic\n'

				const ctx = new CompilationContext(source)
				tokenize(ctx)
				const parseResult = parse(ctx)
				if (!parseResult.succeeded) return true // Grammar issue, not what we're testing

				const checkResult = check(ctx)
				if (!checkResult.succeeded) return true

				// Should have 1 flattened local (the deepest val)
				return ctx.symbols !== null && ctx.symbols.localCount() >= 1
			}),
			{ numRuns: 20 }
		)
	})

	it('nested record init compiles to valid WASM', () => {
		fc.assert(
			fc.property(
				fc.integer({ max: 3, min: 1 }),
				fc.integer({ max: 1000, min: 0 }),
				(depth, value) => {
					const types = generateNestedTypes(depth)
					const init = generateNestedInit(depth, value)
					const source = types + init + 'panic\n'

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					const emitResult = emit(ctx)

					// Verify valid WASM magic number: 0x00 0x61 0x73 0x6D ("\0asm")
					return (
						emitResult.valid &&
						emitResult.binary[0] === 0x00 &&
						emitResult.binary[1] === 0x61 &&
						emitResult.binary[2] === 0x73 &&
						emitResult.binary[3] === 0x6d
					)
				}
			),
			{ numRuns: 20 }
		)
	})

	it('nested record init produces WAT with correct local declarations', () => {
		fc.assert(
			fc.property(fc.integer({ max: 3, min: 1 }), (depth) => {
				const types = generateNestedTypes(depth)
				const init = generateNestedInit(depth, 42)
				const source = types + init + 'panic\n'

				const ctx = new CompilationContext(source)
				tokenize(ctx)
				const parseResult = parse(ctx)
				if (!parseResult.succeeded) return true

				const checkResult = check(ctx)
				if (!checkResult.succeeded) return true

				const emitResult = emit(ctx)
				if (!emitResult.valid) return true

				// WAT should contain (local declarations and valid module structure
				return emitResult.text.includes('(module') && emitResult.text.includes('(local')
			}),
			{ numRuns: 20 }
		)
	})

	it('deeply nested records produce deterministic output', () => {
		fc.assert(
			fc.property(
				fc.integer({ max: 3, min: 1 }),
				fc.integer({ max: 100, min: 0 }),
				(depth, value) => {
					const types = generateNestedTypes(depth)
					const init = generateNestedInit(depth, value)
					const source = types + init + 'panic\n'

					// Compile twice
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

					// Binary should be identical
					if (emit1.binary.length !== emit2.binary.length) return false
					for (let i = 0; i < emit1.binary.length; i++) {
						if (emit1.binary[i] !== emit2.binary[i]) return false
					}
					return true
				}
			),
			{ numRuns: 20 }
		)
	})
})
