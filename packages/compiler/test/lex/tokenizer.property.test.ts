import { describe, it } from 'node:test'
import fc from 'fast-check'
import { CompilationContext } from '../../src/core/context.ts'
import { TokenKind } from '../../src/core/tokens.ts'
import { tokenize } from '../../src/lex/tokenizer.ts'

function getTokenSequence(ctx: CompilationContext): Array<{ kind: number; line: number; column: number }> {
	const tokens: Array<{ kind: number; line: number; column: number }> = []
	for (const [, token] of ctx.tokens) {
		tokens.push({ kind: token.kind, line: token.line, column: token.column })
	}
	return tokens
}

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

		it('final token is always EOF', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					const ctx = new CompilationContext(input)
					tokenize(ctx)
					const lastIndex = ctx.tokens.count() - 1
					const lastToken = ctx.tokens.get(lastIndex as never)
					return lastToken.kind === TokenKind.Eof
				}),
				{ numRuns: 1000 }
			)
		})
	})

	describe('determinism properties', () => {
		it('same input always produces same token sequence', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					const ctx1 = new CompilationContext(input)
					const ctx2 = new CompilationContext(input)
					tokenize(ctx1)
					tokenize(ctx2)
					const tokens1 = getTokenSequence(ctx1)
					const tokens2 = getTokenSequence(ctx2)
					return JSON.stringify(tokens1) === JSON.stringify(tokens2)
				}),
				{ numRuns: 1000 }
			)
		})
	})

	describe('structural properties', () => {
		it('every token has valid line and column (>= 1)', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					const ctx = new CompilationContext(input)
					tokenize(ctx)
					for (const [, token] of ctx.tokens) {
						if (token.line < 1 || token.column < 1) {
							return false
						}
					}
					return true
				}),
				{ numRuns: 1000 }
			)
		})
	})

	describe('indentation properties', () => {
		it('INDENT count equals DEDENT count (balanced)', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					const ctx = new CompilationContext(input)
					tokenize(ctx)
					let indentCount = 0
					let dedentCount = 0
					for (const [, token] of ctx.tokens) {
						if (token.kind === TokenKind.Indent) indentCount++
						if (token.kind === TokenKind.Dedent) dedentCount++
					}
					return indentCount === dedentCount
				}),
				{ numRuns: 1000 }
			)
		})
	})
})
