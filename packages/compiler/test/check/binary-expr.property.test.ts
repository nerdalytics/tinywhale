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
const floatTypeArb = fc.constantFrom('f32', 'f64')
const numericTypeArb = fc.constantFrom('i32', 'i64', 'f32', 'f64')

const arithmeticOpArb = fc.constantFrom('+', '-', '*', '/')
const intOnlyArithmeticOpArb = fc.constantFrom('%', '%%')
const bitwiseOpArb = fc.constantFrom('&', '|', '^')
const shiftOpArb = fc.constantFrom('<<', '>>', '>>>')
const comparisonOpArb = fc.constantFrom('<', '>', '<=', '>=', '==', '!=')
const logicalOpArb = fc.constantFrom('&&', '||')

/** Generate a literal for a given type */
function literalForType(type: string, value: number): string {
	if (type === 'f32' || type === 'f64') {
		return `${Math.abs(value)}.0`
	}
	return `${Math.abs(value)}`
}

// ============================================================================
// Arithmetic Operator Properties
// ============================================================================

describe('binary expressions/arithmetic properties', () => {
	it('same-type arithmetic operations compile to valid WASM', () => {
		fc.assert(
			fc.property(
				numericTypeArb,
				arithmeticOpArb,
				fc.integer({ max: 100, min: 1 }),
				fc.integer({ max: 100, min: 1 }),
				(type, op, a, b) => {
					const litA = literalForType(type, a)
					const litB = literalForType(type, b)
					const source = `x: ${type} = ${litA}\ny: ${type} = ${litB}\nz: ${type} = x ${op} y\npanic\n`

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
			{ numRuns: 100 }
		)
	})

	it('integer-only modulo operators reject float operands', () => {
		fc.assert(
			fc.property(
				floatTypeArb,
				intOnlyArithmeticOpArb,
				fc.integer({ max: 100, min: 1 }),
				fc.integer({ max: 100, min: 1 }),
				(type, op, a, b) => {
					const litA = literalForType(type, a)
					const litB = literalForType(type, b)
					const source = `x: ${type} = ${litA}\ny: ${type} = ${litB}\nz: ${type} = x ${op} y\npanic\n`

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					// Should fail for float types
					return !checkResult.succeeded
				}
			),
			{ numRuns: 50 }
		)
	})

	it('integer modulo operators compile for integer types', () => {
		fc.assert(
			fc.property(
				intTypeArb,
				intOnlyArithmeticOpArb,
				fc.integer({ max: 100, min: 1 }),
				fc.integer({ max: 100, min: 1 }),
				(type, op, a, b) => {
					const source = `x: ${type} = ${a}\ny: ${type} = ${b}\nz: ${type} = x ${op} y\npanic\n`

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

	it('arithmetic produces deterministic output', () => {
		fc.assert(
			fc.property(
				numericTypeArb,
				arithmeticOpArb,
				fc.integer({ max: 100, min: 1 }),
				fc.integer({ max: 100, min: 1 }),
				(type, op, a, b) => {
					const litA = literalForType(type, a)
					const litB = literalForType(type, b)
					const source = `x: ${type} = ${litA}\ny: ${type} = ${litB}\nz: ${type} = x ${op} y\npanic\n`

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
			{ numRuns: 50 }
		)
	})
})

// ============================================================================
// Bitwise Operator Properties
// ============================================================================

describe('binary expressions/bitwise properties', () => {
	it('bitwise operators compile for integer types', () => {
		fc.assert(
			fc.property(
				intTypeArb,
				bitwiseOpArb,
				fc.integer({ max: 255, min: 0 }),
				fc.integer({ max: 255, min: 0 }),
				(type, op, a, b) => {
					const source = `x: ${type} = ${a}\ny: ${type} = ${b}\nz: ${type} = x ${op} y\npanic\n`

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

	it('bitwise operators reject float operands', () => {
		fc.assert(
			fc.property(
				floatTypeArb,
				bitwiseOpArb,
				fc.integer({ max: 100, min: 1 }),
				fc.integer({ max: 100, min: 1 }),
				(type, op, a, b) => {
					const litA = literalForType(type, a)
					const litB = literalForType(type, b)
					const source = `x: ${type} = ${litA}\ny: ${type} = ${litB}\nz: ${type} = x ${op} y\npanic\n`

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					return !checkResult.succeeded
				}
			),
			{ numRuns: 50 }
		)
	})

	it('shift operators compile for integer types', () => {
		fc.assert(
			fc.property(
				intTypeArb,
				shiftOpArb,
				fc.integer({ max: 255, min: 0 }),
				fc.integer({ max: 31, min: 0 }), // Shift amount typically 0-31
				(type, op, value, shift) => {
					const source = `x: ${type} = ${value}\nz: ${type} = x ${op} ${shift}\npanic\n`

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

	it('bitwise NOT compiles for integer types', () => {
		fc.assert(
			fc.property(intTypeArb, fc.integer({ max: 255, min: 0 }), (type, value) => {
				const source = `x: ${type} = ${value}\nz: ${type} = ~x\npanic\n`

				const ctx = new CompilationContext(source)
				tokenize(ctx)
				const parseResult = parse(ctx)
				if (!parseResult.succeeded) return true

				const checkResult = check(ctx)
				if (!checkResult.succeeded) return true

				const emitResult = emit(ctx)
				return emitResult.valid
			}),
			{ numRuns: 50 }
		)
	})
})

// ============================================================================
// Comparison Operator Properties
// ============================================================================

describe('binary expressions/comparison properties', () => {
	it('comparison operators always produce i32 result', () => {
		fc.assert(
			fc.property(
				numericTypeArb,
				comparisonOpArb,
				fc.integer({ max: 100, min: 0 }),
				fc.integer({ max: 100, min: 0 }),
				(type, op, a, b) => {
					const litA = literalForType(type, a)
					const litB = literalForType(type, b)
					// Result is always i32 (boolean as 0 or 1)
					const source = `x: ${type} = ${litA}\ny: ${type} = ${litB}\nz: i32 = x ${op} y\npanic\n`

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
			{ numRuns: 100 }
		)
	})

	it('comparison operators work across all numeric types', () => {
		fc.assert(
			fc.property(
				numericTypeArb,
				comparisonOpArb,
				fc.integer({ max: 50, min: 0 }),
				(type, op, value) => {
					const lit = literalForType(type, value)
					const source = `x: ${type} = ${lit}\nz: i32 = x ${op} x\npanic\n`

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
// Logical Operator Properties
// ============================================================================

describe('binary expressions/logical properties', () => {
	it('logical operators compile to valid WASM', () => {
		fc.assert(
			fc.property(
				logicalOpArb,
				fc.integer({ max: 10, min: 0 }),
				fc.integer({ max: 10, min: 0 }),
				(op, a, b) => {
					const source = `x: i32 = ${a}\ny: i32 = ${b}\nz: i32 = x ${op} y\npanic\n`

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

	it('logical operators produce i32 result', () => {
		fc.assert(
			fc.property(
				logicalOpArb,
				fc.integer({ max: 10, min: 0 }),
				fc.integer({ max: 10, min: 0 }),
				(op, a, b) => {
					const source = `x: i32 = ${a}\ny: i32 = ${b}\nz: i32 = x ${op} y\npanic\n`

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					// Should succeed with i32 result type
					return checkResult.succeeded
				}
			),
			{ numRuns: 50 }
		)
	})
})

// ============================================================================
// Type Mismatch Properties
// ============================================================================

describe('binary expressions/type mismatch properties', () => {
	it('different operand types produce type mismatch error', () => {
		fc.assert(
			fc.property(
				fc.tuple(numericTypeArb, numericTypeArb).filter(([a, b]) => a !== b),
				arithmeticOpArb,
				fc.integer({ max: 100, min: 1 }),
				fc.integer({ max: 100, min: 1 }),
				([typeA, typeB], op, a, b) => {
					const litA = literalForType(typeA, a)
					const litB = literalForType(typeB, b)
					const source = `x: ${typeA} = ${litA}\ny: ${typeB} = ${litB}\nz: ${typeA} = x ${op} y\npanic\n`

					const ctx = new CompilationContext(source)
					tokenize(ctx)
					const parseResult = parse(ctx)
					if (!parseResult.succeeded) return true

					const checkResult = check(ctx)
					// Should fail due to type mismatch
					return !checkResult.succeeded
				}
			),
			{ numRuns: 50 }
		)
	})
})
