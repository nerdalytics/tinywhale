import assert from 'node:assert'
import { describe, it } from 'node:test'
import { CompilationContext } from '../../src/core/context.ts'
import { TokenKind } from '../../src/core/tokens.ts'
import { tokenize } from '../../src/lex/tokenizer.ts'

function getTokenKinds(ctx: CompilationContext): TokenKind[] {
	const kinds: TokenKind[] = []
	for (const [, token] of ctx.tokens) {
		kinds.push(token.kind)
	}
	return kinds
}

describe('lex/tokenizer', () => {
	describe('basic tokenization', () => {
		it('should tokenize empty input', () => {
			const ctx = new CompilationContext('')
			const result = tokenize(ctx)

			assert.strictEqual(result.succeeded, true)
			assert.strictEqual(ctx.tokens.count(), 1) // Just EOF
			assert.strictEqual(ctx.tokens.get(0 as never).kind, TokenKind.Eof)
		})

		it('should tokenize single line without indentation', () => {
			const ctx = new CompilationContext('panic')
			const result = tokenize(ctx)

			assert.strictEqual(result.succeeded, true)
			// Should have: Panic, Newline, EOF
			assert.strictEqual(ctx.tokens.count(), 3)
			assert.strictEqual(ctx.tokens.get(0 as never).kind, TokenKind.Panic)
			assert.strictEqual(ctx.tokens.get(1 as never).kind, TokenKind.Newline)
			assert.strictEqual(ctx.tokens.get(2 as never).kind, TokenKind.Eof)
		})

		it('should tokenize panic with correct line and column', () => {
			const ctx = new CompilationContext('panic')
			tokenize(ctx)

			const panicToken = ctx.tokens.get(0 as never)
			assert.strictEqual(panicToken.kind, TokenKind.Panic)
			assert.strictEqual(panicToken.line, 1)
			assert.strictEqual(panicToken.column, 1)
		})

		it('should not tokenize panicMode as panic keyword', () => {
			const ctx = new CompilationContext('panicMode')
			tokenize(ctx)

			// Should have: Newline, EOF (no Panic token)
			let hasPanic = false
			for (const [, token] of ctx.tokens) {
				if (token.kind === TokenKind.Panic) hasPanic = true
			}
			assert.strictEqual(hasPanic, false)
		})
	})

	describe('indentation', () => {
		it('should emit INDENT token for leading tab', () => {
			const ctx = new CompilationContext('\tpanic')
			const result = tokenize(ctx)

			assert.strictEqual(result.succeeded, true)
			assert.strictEqual(ctx.tokens.get(0 as never).kind, TokenKind.Indent)
			assert.strictEqual(ctx.tokens.get(0 as never).payload, 1) // level 1
		})

		it('should emit INDENT token for leading spaces', () => {
			const ctx = new CompilationContext('  panic')
			const result = tokenize(ctx)

			assert.strictEqual(result.succeeded, true)
			assert.strictEqual(ctx.tokens.get(0 as never).kind, TokenKind.Indent)
		})

		it('should emit DEDENT tokens when unindenting', () => {
			const ctx = new CompilationContext('\tpanic\npanic')
			const result = tokenize(ctx)

			assert.strictEqual(result.succeeded, true)

			// Find DEDENT token
			let hasDedent = false
			for (const [, token] of ctx.tokens) {
				if (token.kind === TokenKind.Dedent) hasDedent = true
			}
			assert.strictEqual(hasDedent, true)
		})

		it('should emit multiple DEDENT tokens for multi-level unindent', () => {
			// Valid multi-level: 0 -> 1 -> 2 -> 0
			const ctx = new CompilationContext('panic\n\tpanic\n\t\tpanic\npanic')
			const result = tokenize(ctx)

			assert.strictEqual(result.succeeded, true)

			// Count DEDENT tokens (should be 2 when going from level 2 to 0)
			let dedentCount = 0
			for (const [, token] of ctx.tokens) {
				if (token.kind === TokenKind.Dedent) dedentCount++
			}
			assert.strictEqual(dedentCount, 2)
		})

		it('should emit EOF dedents', () => {
			const ctx = new CompilationContext('\tpanic')
			tokenize(ctx)

			// Should have: Indent, Panic, Newline, Dedent, EOF
			const tokens: number[] = []
			for (const [, token] of ctx.tokens) {
				tokens.push(token.kind)
			}

			assert.deepStrictEqual(tokens, [
				TokenKind.Indent,
				TokenKind.Panic,
				TokenKind.Newline,
				TokenKind.Dedent,
				TokenKind.Eof,
			])
		})
	})

	describe('comments', () => {
		it('should skip comment-only lines', () => {
			const ctx = new CompilationContext('# this is a comment')
			tokenize(ctx)

			// Should have: Newline, EOF (no Panic)
			let hasPanic = false
			for (const [, token] of ctx.tokens) {
				if (token.kind === TokenKind.Panic) hasPanic = true
			}
			assert.strictEqual(hasPanic, false)
		})

		it('should handle inline comments', () => {
			const ctx = new CompilationContext('panic # comment')
			tokenize(ctx)

			// Should still have Panic token
			assert.strictEqual(ctx.tokens.get(0 as never).kind, TokenKind.Panic)
		})

		it('should handle toggle comments', () => {
			const ctx = new CompilationContext('panic # comment # more')
			tokenize(ctx)

			assert.strictEqual(ctx.tokens.get(0 as never).kind, TokenKind.Panic)
		})
	})

	describe('mixed indentation errors', () => {
		it('should report error for mixed tabs and spaces', () => {
			const ctx = new CompilationContext('\tpanic\n  panic')
			const result = tokenize(ctx)

			assert.strictEqual(result.succeeded, false)
			assert.strictEqual(ctx.hasErrors(), true)
		})

		it('should report error for mixed on same line', () => {
			const ctx = new CompilationContext('\t panic')
			const result = tokenize(ctx)

			assert.strictEqual(result.succeeded, false)
			assert.strictEqual(ctx.hasErrors(), true)
		})
	})

	describe('indent jump validation', () => {
		it('should report error for indent jump > 1 level', () => {
			const ctx = new CompilationContext('\t\tpanic') // Jump from 0 to 2
			const result = tokenize(ctx)

			assert.strictEqual(result.succeeded, false)
			assert.strictEqual(ctx.hasErrors(), true)
		})

		it('should allow single level indent', () => {
			const ctx = new CompilationContext('panic\n\tpanic')
			const result = tokenize(ctx)

			assert.strictEqual(result.succeeded, true)
		})
	})

	describe('space indentation', () => {
		it('should detect indent unit from first indent', () => {
			const ctx = new CompilationContext('panic\n  panic\n    panic')
			const result = tokenize(ctx)

			assert.strictEqual(result.succeeded, true)

			// Count indent tokens
			let indentCount = 0
			for (const [, token] of ctx.tokens) {
				if (token.kind === TokenKind.Indent) indentCount++
			}
			assert.strictEqual(indentCount, 2)
		})

		it('should report error for inconsistent space indent', () => {
			const ctx = new CompilationContext('panic\n  panic\n   panic') // 2 then 3
			const result = tokenize(ctx)

			assert.strictEqual(result.succeeded, false)
		})
	})

	describe('directive mode', () => {
		it('should respect use spaces directive', () => {
			const ctx = new CompilationContext('"use spaces"\n  panic')
			const result = tokenize(ctx, { mode: 'directive' })

			assert.strictEqual(result.succeeded, true)
			// Should have indent token
			let hasIndent = false
			for (const [, token] of ctx.tokens) {
				if (token.kind === TokenKind.Indent) hasIndent = true
			}
			assert.strictEqual(hasIndent, true)
		})

		it('should default to tabs in directive mode', () => {
			const ctx = new CompilationContext('\tpanic')
			const result = tokenize(ctx, { mode: 'directive' })

			assert.strictEqual(result.succeeded, true)
		})
	})

	describe('multiple lines', () => {
		it('should tokenize multiple panic statements', () => {
			const ctx = new CompilationContext('panic\npanic\npanic')
			tokenize(ctx)

			let panicCount = 0
			for (const [, token] of ctx.tokens) {
				if (token.kind === TokenKind.Panic) panicCount++
			}
			assert.strictEqual(panicCount, 3)
		})

		it('should handle blank lines', () => {
			const ctx = new CompilationContext('panic\n\npanic')
			const result = tokenize(ctx)

			assert.strictEqual(result.succeeded, true)
		})

		it('should preserve line numbers', () => {
			const ctx = new CompilationContext('panic\n\npanic')
			tokenize(ctx)

			const panicTokens = []
			for (const [, token] of ctx.tokens) {
				if (token.kind === TokenKind.Panic) {
					panicTokens.push(token.line)
				}
			}
			assert.deepStrictEqual(panicTokens, [1, 3])
		})
	})

	describe('arithmetic operators', () => {
		it('should tokenize plus', () => {
			const ctx = new CompilationContext('x:i32 = 1 + 2')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.Plus))
		})

		it('should tokenize minus', () => {
			const ctx = new CompilationContext('x:i32 = 1 - 2')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.Minus))
		})

		it('should tokenize star', () => {
			const ctx = new CompilationContext('x:i32 = 1 * 2')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.Star))
		})

		it('should tokenize slash', () => {
			const ctx = new CompilationContext('x:i32 = 1 / 2')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.Slash))
		})

		it('should tokenize percent', () => {
			const ctx = new CompilationContext('x:i32 = 5 % 3')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.Percent))
		})

		it('should tokenize percent percent', () => {
			const ctx = new CompilationContext('x:i32 = 5 %% 3')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.PercentPercent))
		})
	})

	describe('bitwise operators', () => {
		it('should tokenize ampersand', () => {
			const ctx = new CompilationContext('x:i32 = 1 & 2')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.Ampersand))
		})

		it('should tokenize pipe', () => {
			const ctx = new CompilationContext('x:i32 = 1 | 2')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.Pipe))
		})

		it('should tokenize caret', () => {
			const ctx = new CompilationContext('x:i32 = 1 ^ 2')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.Caret))
		})

		it('should tokenize tilde', () => {
			const ctx = new CompilationContext('x:i32 = ~1')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.Tilde))
		})

		it('should tokenize less less (left shift)', () => {
			const ctx = new CompilationContext('x:i32 = 1 << 2')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.LessLess))
		})

		it('should tokenize greater greater (right shift)', () => {
			const ctx = new CompilationContext('x:i32 = 4 >> 1')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.GreaterGreater))
		})

		it('should tokenize greater greater greater (unsigned right shift)', () => {
			const ctx = new CompilationContext('x:i32 = 4 >>> 1')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.GreaterGreaterGreater))
		})

		it('should not confuse >> with >>>', () => {
			const ctx = new CompilationContext('x:i32 = 4 >> 1')
			tokenize(ctx)
			const kinds = getTokenKinds(ctx)
			assert.ok(kinds.includes(TokenKind.GreaterGreater))
			assert.ok(!kinds.includes(TokenKind.GreaterGreaterGreater))
		})
	})

	describe('comparison operators', () => {
		it('should tokenize less than', () => {
			const ctx = new CompilationContext('x:i32 = 1 < 2')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.LessThan))
		})

		it('should tokenize greater than', () => {
			const ctx = new CompilationContext('x:i32 = 2 > 1')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.GreaterThan))
		})

		it('should tokenize less equal', () => {
			const ctx = new CompilationContext('x:i32 = 1 <= 2')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.LessEqual))
		})

		it('should tokenize greater equal', () => {
			const ctx = new CompilationContext('x:i32 = 2 >= 1')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.GreaterEqual))
		})

		it('should tokenize equal equal', () => {
			const ctx = new CompilationContext('x:i32 = 1 == 1')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.EqualEqual))
		})

		it('should tokenize bang equal', () => {
			const ctx = new CompilationContext('x:i32 = 1 != 2')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.BangEqual))
		})

		it('should not confuse = with ==', () => {
			const ctx = new CompilationContext('x:i32 = 1 == 2')
			tokenize(ctx)
			const kinds = getTokenKinds(ctx)
			assert.ok(kinds.includes(TokenKind.Equals))
			assert.ok(kinds.includes(TokenKind.EqualEqual))
		})
	})

	describe('logical operators', () => {
		it('should tokenize ampersand ampersand', () => {
			const ctx = new CompilationContext('x:i32 = 1 && 2')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.AmpersandAmpersand))
		})

		it('should tokenize pipe pipe', () => {
			const ctx = new CompilationContext('x:i32 = 1 || 2')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.PipePipe))
		})

		it('should not confuse & with &&', () => {
			const ctx = new CompilationContext('x:i32 = 1 & 2')
			tokenize(ctx)
			const kinds = getTokenKinds(ctx)
			assert.ok(kinds.includes(TokenKind.Ampersand))
			assert.ok(!kinds.includes(TokenKind.AmpersandAmpersand))
		})

		it('should not confuse | with ||', () => {
			const ctx = new CompilationContext('x:i32 = 1 | 2')
			tokenize(ctx)
			const kinds = getTokenKinds(ctx)
			assert.ok(kinds.includes(TokenKind.Pipe))
			assert.ok(!kinds.includes(TokenKind.PipePipe))
		})
	})

	describe('parentheses', () => {
		it('should tokenize left paren', () => {
			const ctx = new CompilationContext('x:i32 = (1)')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.LParen))
		})

		it('should tokenize right paren', () => {
			const ctx = new CompilationContext('x:i32 = (1)')
			tokenize(ctx)
			assert.ok(getTokenKinds(ctx).includes(TokenKind.RParen))
		})

		it('should tokenize nested parentheses', () => {
			const ctx = new CompilationContext('x:i32 = ((1 + 2) * 3)')
			tokenize(ctx)
			const kinds = getTokenKinds(ctx)
			const lparenCount = kinds.filter((k) => k === TokenKind.LParen).length
			const rparenCount = kinds.filter((k) => k === TokenKind.RParen).length
			assert.strictEqual(lparenCount, 2)
			assert.strictEqual(rparenCount, 2)
		})
	})
})
