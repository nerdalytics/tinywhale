import { describe, it } from 'node:test'
import fc from 'fast-check'
import { compile, CompileError } from '../src/index.ts'

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
