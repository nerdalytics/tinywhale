import { describe, it } from 'node:test'
import fc from 'fast-check'
import { CompilationContext } from '../../src/core/context.ts'
import { tokenize } from '../../src/lex/tokenizer.ts'
import { parse } from '../../src/parse/parser.ts'

describe('parse/parser properties', () => {
	describe('safety properties', () => {
		it('never throws on any tokenized input', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					const ctx = new CompilationContext(input)
					tokenize(ctx)
					parse(ctx)
					return true
				}),
				{ numRuns: 1000 }
			)
		})

		it('always returns a result with succeeded boolean', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					const ctx = new CompilationContext(input)
					tokenize(ctx)
					const result = parse(ctx)
					return typeof result.succeeded === 'boolean'
				}),
				{ numRuns: 1000 }
			)
		})

		it('if parsing fails, at least one diagnostic is emitted', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					const ctx = new CompilationContext(input)
					tokenize(ctx)
					const result = parse(ctx)
					if (!result.succeeded) {
						return ctx.getDiagnostics().length >= 1
					}
					return true
				}),
				{ numRuns: 1000 }
			)
		})
	})
})
