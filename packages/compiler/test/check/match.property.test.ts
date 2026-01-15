import { describe, it } from 'node:test'
import fc from 'fast-check'
import { check } from '../../src/check/checker.ts'
import { emit } from '../../src/codegen/index.ts'
import { CompilationContext } from '../../src/core/context.ts'
import { tokenize } from '../../src/lex/tokenizer.ts'
import { parse } from '../../src/parse/parser.ts'

// ============================================================================
// Arbitraries
// ============================================================================

const intTypeArb = fc.constantFrom('i32', 'i64')

/** Generate N distinct literal patterns */
function distinctLiterals(count: number, seed: number): number[] {
	const literals: number[] = []
	for (let i = 0; i < count; i++) {
		literals.push((seed + i * 7) % 100) // Simple deterministic spread
	}
	return [...new Set(literals)].slice(0, count)
}

// ============================================================================
// Match Expression Properties
// ============================================================================

describe('match expressions/compilation properties', () => {
	it('match with wildcard pattern compiles to valid WASM', () => {
		fc.assert(
			fc.property(
				intTypeArb,
				fc.integer({ max: 100, min: 0 }),
				fc.integer({ max: 100, min: 0 }),
				(type, scrutinee, result) => {
					const source = `x: ${type} = ${scrutinee}
result: ${type} = match x
	_ -> ${result}
panic
`
					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					const emitResult = emit(ctx)

					return (
						emitResult.valid &&
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

	it('match with literal patterns + wildcard compiles to valid WASM', () => {
		fc.assert(
			fc.property(
				intTypeArb,
				fc.integer({ max: 5, min: 1 }), // Number of literal arms
				fc.integer({ max: 100, min: 0 }), // Scrutinee value
				fc.integer({ max: 100, min: 0 }), // Seed for literals
				(type, armCount, scrutinee, seed) => {
					const literals = distinctLiterals(armCount, seed)
					const arms = literals.map((lit, i) => `	${lit} -> ${(i + 1) * 10}`).join('\n')
					const source = `x: ${type} = ${scrutinee}
result: ${type} = match x
${arms}
	_ -> 0
panic
`
					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					const emitResult = emit(ctx)
					return emitResult.valid
				}
			),
			{ numRuns: 50 }
		)
	})

	it('match produces deterministic output', () => {
		fc.assert(
			fc.property(
				intTypeArb,
				fc.integer({ max: 3, min: 1 }),
				fc.integer({ max: 100, min: 0 }),
				fc.integer({ max: 100, min: 0 }),
				(type, armCount, scrutinee, seed) => {
					const literals = distinctLiterals(armCount, seed)
					const arms = literals.map((lit, i) => `	${lit} -> ${(i + 1) * 10}`).join('\n')
					const source = `x: ${type} = ${scrutinee}
result: ${type} = match x
${arms}
	_ -> 0
panic
`
					const ctx1 = new CompilationContext(source)
					const ctx2 = new CompilationContext(source)

					tokenize(ctx1)
					tokenize(ctx2)
					parse(ctx1)
					parse(ctx2)

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
			{ numRuns: 30 }
		)
	})
})

// ============================================================================
// Exhaustiveness Properties
// ============================================================================

describe('match expressions/exhaustiveness properties', () => {
	it('match without catch-all pattern produces error', () => {
		fc.assert(
			fc.property(
				intTypeArb,
				fc.integer({ max: 5, min: 1 }),
				fc.integer({ max: 100, min: 0 }),
				fc.integer({ max: 100, min: 0 }),
				(type, armCount, scrutinee, seed) => {
					const literals = distinctLiterals(armCount, seed)
					// No wildcard at end - should fail
					const arms = literals.map((lit, i) => `	${lit} -> ${(i + 1) * 10}`).join('\n')
					const source = `x: ${type} = ${scrutinee}
result: ${type} = match x
${arms}
panic
`
					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					// Should fail due to non-exhaustive match
					return !checkResult.succeeded
				}
			),
			{ numRuns: 50 }
		)
	})

	it('wildcard as last arm makes match exhaustive', () => {
		fc.assert(
			fc.property(
				intTypeArb,
				fc.integer({ max: 5, min: 0 }),
				fc.integer({ max: 100, min: 0 }),
				fc.integer({ max: 100, min: 0 }),
				(type, literalCount, scrutinee, seed) => {
					const literals = distinctLiterals(literalCount, seed)
					const arms = literals.map((lit, i) => `	${lit} -> ${(i + 1) * 10}`).join('\n')
					const armsWithWildcard = arms ? `${arms}\n	_ -> 0` : '	_ -> 0'
					const source = `x: ${type} = ${scrutinee}
result: ${type} = match x
${armsWithWildcard}
panic
`
					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					// Should succeed with wildcard
					return checkResult.succeeded
				}
			),
			{ numRuns: 50 }
		)
	})

	it('binding pattern as last arm makes match exhaustive', () => {
		fc.assert(
			fc.property(
				intTypeArb,
				fc.integer({ max: 3, min: 0 }),
				fc.integer({ max: 100, min: 0 }),
				fc.integer({ max: 100, min: 0 }),
				(type, literalCount, scrutinee, seed) => {
					const literals = distinctLiterals(literalCount, seed)
					const arms = literals.map((lit, i) => `	${lit} -> ${(i + 1) * 10}`).join('\n')
					// Use binding pattern (variable name) instead of wildcard
					const armsWithBinding = arms ? `${arms}\n	other -> 0` : '	other -> 0'
					const source = `x: ${type} = ${scrutinee}
result: ${type} = match x
${armsWithBinding}
panic
`
					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					// Should succeed with binding pattern
					return checkResult.succeeded
				}
			),
			{ numRuns: 50 }
		)
	})
})

// ============================================================================
// Type Checking Properties
// ============================================================================

describe('match expressions/type checking properties', () => {
	it('arm body type must match declared result type', () => {
		fc.assert(
			fc.property(
				fc.tuple(intTypeArb, intTypeArb).filter(([a, b]) => a !== b),
				fc.integer({ max: 100, min: 0 }),
				([declaredType, bodyType], scrutinee) => {
					// Declare result as one type, but arm body produces different type
					const source = `x: ${declaredType} = ${scrutinee}
result: ${declaredType} = match x
	_ -> y
y: ${bodyType} = 42
panic
`
					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					// Should fail due to type mismatch
					return !checkResult.succeeded
				}
			),
			{ numRuns: 30 }
		)
	})

	it('all arms must have consistent types', () => {
		fc.assert(
			fc.property(intTypeArb, fc.integer({ max: 100, min: 0 }), (type, scrutinee) => {
				// All literal values match the type
				const source = `x: ${type} = ${scrutinee}
result: ${type} = match x
	0 -> 10
	1 -> 20
	_ -> 30
panic
`
				const ctx = new CompilationContext(source)
				tokenize(ctx)
				const parseResult = parse(ctx)
				if (!parseResult.succeeded) return true

				const checkResult = check(ctx)
				// Should succeed with consistent types
				return checkResult.succeeded
			}),
			{ numRuns: 50 }
		)
	})
})

// ============================================================================
// Multiple Match Properties
// ============================================================================

describe('match expressions/multiple match properties', () => {
	it('sequential match expressions compile correctly', () => {
		fc.assert(
			fc.property(
				intTypeArb,
				fc.integer({ max: 3, min: 1 }),
				fc.integer({ max: 100, min: 0 }),
				(type, matchCount, scrutinee) => {
					const matches = Array.from(
						{ length: matchCount },
						(_, i) => `r${i}: ${type} = match x
	${i} -> ${(i + 1) * 10}
	_ -> 0`
					).join('\n')

					const source = `x: ${type} = ${scrutinee}
${matches}
panic
`
					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					const emitResult = emit(ctx)
					return emitResult.valid
				}
			),
			{ numRuns: 30 }
		)
	})

	it('match result can be used in subsequent code', () => {
		fc.assert(
			fc.property(
				intTypeArb,
				fc.integer({ max: 100, min: 0 }),
				fc.integer({ max: 100, min: 0 }),
				(type, scrutinee, multiplier) => {
					const source = `x: ${type} = ${scrutinee}
result: ${type} = match x
	_ -> ${multiplier}
doubled: ${type} = result + result
panic
`
					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					const emitResult = emit(ctx)
					return emitResult.valid
				}
			),
			{ numRuns: 50 }
		)
	})
})

// ============================================================================
// WAT Output Properties
// ============================================================================

describe('match expressions/WAT output properties', () => {
	it('match arm literal values appear in WAT output', () => {
		fc.assert(
			fc.property(
				fc.integer({ max: 5, min: 2 }),
				fc.integer({ max: 100, min: 0 }),
				(armCount, scrutinee) => {
					// Use distinct values in 200-299 range to avoid false positives
					const arms = Array.from({ length: armCount }, (_, i) => `	${i} -> ${200 + i * 10}`)
						.join('\n')
					const source = `x: i32 = ${scrutinee}
result: i32 = match x
${arms}
	_ -> 999
panic
`
					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					if (!checkResult.succeeded) return true

					const emitResult = emit(ctx)
					if (!emitResult.valid) return true

					// All arm result values should appear in WAT
					for (let i = 0; i < armCount; i++) {
						if (!emitResult.text.includes(`i32.const ${200 + i * 10}`)) {
							return false
						}
					}
					// Default arm value should appear
					return emitResult.text.includes('i32.const 999')
				}
			),
			{ numRuns: 30 }
		)
	})
})
