import { describe, it } from 'node:test'
import fc from 'fast-check'
import { CompilationContext } from '../../src/core/context.ts'
import { tokenize } from '../../src/lex/tokenizer.ts'

describe('lex/tokenizer properties', () => {
	describe('safety properties', () => {
		it('never throws on arbitrary string input', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					const ctx = new CompilationContext(input)
					tokenize(ctx)
					return true
				}),
				{ numRuns: 1000 }
			)
		})

		it('always produces at least an EOF token', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					const ctx = new CompilationContext(input)
					tokenize(ctx)
					return ctx.tokens.count() >= 1
				}),
				{ numRuns: 1000 }
			)
		})
	})
})
