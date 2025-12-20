import assert from 'node:assert'
import { describe, it } from 'node:test'
import { type Token, TokenKind, TokenStore, tokenId } from '../../src/core/tokens.ts'

describe('core/tokens', () => {
	describe('TokenKind', () => {
		it('should have correct values for structural tokens', () => {
			assert.strictEqual(TokenKind.Indent, 0)
			assert.strictEqual(TokenKind.Dedent, 1)
			assert.strictEqual(TokenKind.Newline, 2)
		})

		it('should have correct value for keywords', () => {
			assert.strictEqual(TokenKind.Panic, 10)
		})

		it('should have correct value for Eof', () => {
			assert.strictEqual(TokenKind.Eof, 255)
		})
	})

	describe('tokenId', () => {
		it('should create TokenId from number', () => {
			const id = tokenId(5)
			assert.strictEqual(id, 5)
		})
	})

	describe('TokenStore', () => {
		it('should start empty', () => {
			const store = new TokenStore()
			assert.strictEqual(store.count(), 0)
		})

		it('should add tokens and return sequential IDs', () => {
			const store = new TokenStore()
			const token1: Token = { column: 1, kind: TokenKind.Indent, line: 1, payload: 1 }
			const token2: Token = { column: 5, kind: TokenKind.Panic, line: 1, payload: 0 }

			const id1 = store.add(token1)
			const id2 = store.add(token2)

			assert.strictEqual(id1, 0)
			assert.strictEqual(id2, 1)
			assert.strictEqual(store.count(), 2)
		})

		it('should retrieve tokens by ID', () => {
			const store = new TokenStore()
			const token: Token = { column: 5, kind: TokenKind.Panic, line: 3, payload: 42 }

			const id = store.add(token)
			const retrieved = store.get(id)

			assert.strictEqual(retrieved.kind, TokenKind.Panic)
			assert.strictEqual(retrieved.line, 3)
			assert.strictEqual(retrieved.column, 5)
			assert.strictEqual(retrieved.payload, 42)
		})

		it('should throw on invalid ID', () => {
			const store = new TokenStore()
			assert.throws(() => store.get(tokenId(0)), /Invalid TokenId/)
			assert.throws(() => store.get(tokenId(100)), /Invalid TokenId/)
		})

		it('should validate IDs correctly', () => {
			const store = new TokenStore()
			const token: Token = { column: 1, kind: TokenKind.Eof, line: 1, payload: 0 }
			const id = store.add(token)

			assert.strictEqual(store.isValid(id), true)
			assert.strictEqual(store.isValid(tokenId(1)), false)
			assert.strictEqual(store.isValid(tokenId(-1)), false)
		})

		it('should iterate over all tokens', () => {
			const store = new TokenStore()
			store.add({ column: 1, kind: TokenKind.Indent, line: 1, payload: 1 })
			store.add({ column: 5, kind: TokenKind.Panic, line: 1, payload: 0 })
			store.add({ column: 1, kind: TokenKind.Dedent, line: 2, payload: 0 })

			const collected: Array<[number, Token]> = []
			for (const [id, token] of store) {
				collected.push([id, token])
			}

			assert.strictEqual(collected.length, 3)
			assert.strictEqual(collected[0]![0], 0)
			assert.strictEqual(collected[0]![1].kind, TokenKind.Indent)
			assert.strictEqual(collected[1]![0], 1)
			assert.strictEqual(collected[1]![1].kind, TokenKind.Panic)
			assert.strictEqual(collected[2]![0], 2)
			assert.strictEqual(collected[2]![1].kind, TokenKind.Dedent)
		})

		it('should slice tokens by range', () => {
			const store = new TokenStore()
			store.add({ column: 1, kind: TokenKind.Indent, line: 1, payload: 1 })
			store.add({ column: 5, kind: TokenKind.Panic, line: 1, payload: 0 })
			store.add({ column: 1, kind: TokenKind.Dedent, line: 2, payload: 0 })
			store.add({ column: 1, kind: TokenKind.Eof, line: 3, payload: 0 })

			const slice = store.slice(tokenId(1), tokenId(3))

			assert.strictEqual(slice.length, 2)
			assert.strictEqual(slice[0]!.kind, TokenKind.Panic)
			assert.strictEqual(slice[1]!.kind, TokenKind.Dedent)
		})
	})
})
