import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CompilationContext } from '../src/core/context.ts'
import { TokenKind } from '../src/core/tokens.ts'
import { tokenize } from '../src/lex/tokenizer.ts'

describe('record types tokenization', () => {
	it('tokenizes type keyword', () => {
		const ctx = new CompilationContext('type Point')
		tokenize(ctx)
		const tokens = [...ctx.tokens]
		const typeToken = tokens.find(([, t]) => t.kind === TokenKind.Type)
		assert.ok(typeToken, 'should have Type token')
	})
})
