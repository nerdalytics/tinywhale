import { describe, it } from 'node:test'
import fc from 'fast-check'
import { CompileError, compile } from '../src/index.ts'

// Generator for valid TinyWhale programs
const validProgramArb = fc.oneof(
	// Single panic
	fc.constant('panic\n'),
	// Multiple panics
	fc
		.integer({ max: 10, min: 1 })
		.map((n) => 'panic\n'.repeat(n)),
	// Variable binding with panic
	fc
		.tuple(fc.constantFrom('i32', 'i64', 'f32', 'f64'), fc.integer({ max: 1000, min: 0 }))
		.map(([type, value]) => {
			if (type === 'f32' || type === 'f64') {
				return `x:${type} = ${value}.0\npanic\n`
			}
			return `x:${type} = ${value}\npanic\n`
		}),
	// Multiple bindings with panic
	fc
		.integer({ max: 5, min: 1 })
		.map((n) => {
			const bindings = Array.from({ length: n }, (_, i) => `v${i}:i32 = ${i}`).join('\n')
			return `${bindings}\npanic\n`
		})
)

describe('compile/pipeline properties', () => {
	describe('safety properties', () => {
		it('never throws non-CompileError exceptions on arbitrary input', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					try {
						compile(input)
						return true
					} catch (e) {
						return e instanceof CompileError
					}
				}),
				{ numRuns: 1000 }
			)
		})

		it('always returns a result or throws CompileError', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					try {
						const result = compile(input)
						return (
							typeof result.valid === 'boolean' &&
							result.binary instanceof Uint8Array &&
							typeof result.text === 'string'
						)
					} catch (e) {
						return e instanceof CompileError
					}
				}),
				{ numRuns: 1000 }
			)
		})
	})

	describe('WASM validity properties', () => {
		it('binary starts with WASM magic number (\\0asm)', () => {
			fc.assert(
				fc.property(validProgramArb, (source) => {
					const result = compile(source)
					return (
						result.binary[0] === 0x00 &&
						result.binary[1] === 0x61 &&
						result.binary[2] === 0x73 &&
						result.binary[3] === 0x6d
					)
				}),
				{ numRuns: 100 }
			)
		})

		it('binary starts with WASM version 1', () => {
			fc.assert(
				fc.property(validProgramArb, (source) => {
					const result = compile(source)
					return (
						result.binary[4] === 0x01 &&
						result.binary[5] === 0x00 &&
						result.binary[6] === 0x00 &&
						result.binary[7] === 0x00
					)
				}),
				{ numRuns: 100 }
			)
		})

		it('WAT text contains (module', () => {
			fc.assert(
				fc.property(validProgramArb, (source) => {
					const result = compile(source)
					return result.text.includes('(module')
				}),
				{ numRuns: 100 }
			)
		})

		it('WAT text contains (export "_start"', () => {
			fc.assert(
				fc.property(validProgramArb, (source) => {
					const result = compile(source)
					return result.text.includes('(export "_start"')
				}),
				{ numRuns: 100 }
			)
		})
	})

	describe('consistency properties', () => {
		it('same source always produces identical binary', () => {
			fc.assert(
				fc.property(validProgramArb, (source) => {
					const result1 = compile(source)
					const result2 = compile(source)
					if (result1.binary.length !== result2.binary.length) return false
					for (let i = 0; i < result1.binary.length; i++) {
						if (result1.binary[i] !== result2.binary[i]) return false
					}
					return true
				}),
				{ numRuns: 100 }
			)
		})

		it('same source always produces identical WAT text', () => {
			fc.assert(
				fc.property(validProgramArb, (source) => {
					const result1 = compile(source)
					const result2 = compile(source)
					return result1.text === result2.text
				}),
				{ numRuns: 100 }
			)
		})

		it('optimized and non-optimized both produce valid WASM magic', () => {
			fc.assert(
				fc.property(validProgramArb, (source) => {
					const normal = compile(source, { optimize: false })
					const optimized = compile(source, { optimize: true })
					const checkMagic = (binary: Uint8Array) =>
						binary[0] === 0x00 &&
						binary[1] === 0x61 &&
						binary[2] === 0x73 &&
						binary[3] === 0x6d
					return checkMagic(normal.binary) && checkMagic(optimized.binary)
				}),
				{ numRuns: 100 }
			)
		})
	})
})
