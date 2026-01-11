import { describe, it } from 'node:test'
import fc from 'fast-check'
import { compile, CompileError } from '../src/index.ts'

// Generator for valid TinyWhale programs
const validProgramArb = fc.oneof(
	// Single panic
	fc.constant('panic\n'),
	// Multiple panics
	fc.integer({ min: 1, max: 10 }).map((n) => 'panic\n'.repeat(n)),
	// Variable binding with panic
	fc.tuple(
		fc.constantFrom('i32', 'i64', 'f32', 'f64'),
		fc.integer({ min: 0, max: 1000 })
	).map(([type, value]) => {
		if (type === 'f32' || type === 'f64') {
			return `x:${type} = ${value}.0\npanic\n`
		}
		return `x:${type} = ${value}\npanic\n`
	}),
	// Multiple bindings with panic
	fc.integer({ min: 1, max: 5 }).map((n) => {
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
})
