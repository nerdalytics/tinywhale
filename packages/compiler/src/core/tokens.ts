/**
 * Token storage using dense arrays with integer IDs.
 * Carbon-style data-oriented design for cache efficiency.
 */

/** Token kinds - small integer discriminant. */
export const TokenKind = {
	Colon: 3,
	Dedent: 1,

	// Special (255)
	Eof: 255,
	Equals: 4,
	F32: 13,
	F64: 14,
	FloatLiteral: 102,
	I32: 11,
	I64: 12,

	// Identifiers and literals (100-199)
	Identifier: 100,
	// Structural tokens (0-9)
	Indent: 0,
	IntLiteral: 101,
	Minus: 5,
	Newline: 2,

	// Keywords (10-99)
	Panic: 10,
} as const

export type TokenKind = (typeof TokenKind)[keyof typeof TokenKind]

export type TokenId = number & { readonly __brand: 'TokenId' }

export function tokenId(n: number): TokenId {
	return n as TokenId
}

/**
 * A single token - fixed size, no pointers.
 * Payload meaning depends on kind:
 * - Indent/Dedent: indent level
 * - Future identifiers: index into string table
 * - Future literals: index into literal table
 */
export interface Token {
	readonly kind: TokenKind
	readonly line: number
	readonly column: number
	readonly payload: number
}

/**
 * Dense array storage for tokens.
 * Append-only during tokenization phase.
 */
export class TokenStore {
	private readonly tokens: Token[] = []

	add(token: Token): TokenId {
		const id = this.tokens.length as TokenId
		this.tokens.push(token)
		return id
	}

	get(id: TokenId): Token {
		const token = this.tokens[id]
		if (token === undefined) {
			throw new Error(`Invalid TokenId: ${id}`)
		}
		return token
	}

	count(): number {
		return this.tokens.length
	}

	isValid(id: TokenId): boolean {
		return id >= 0 && id < this.tokens.length
	}

	*[Symbol.iterator](): Generator<[TokenId, Token]> {
		for (let i = 0; i < this.tokens.length; i++) {
			const token = this.tokens[i]
			if (token !== undefined) yield [i as TokenId, token]
		}
	}

	/** Returns tokens in range [start, end). */
	slice(start: TokenId, end: TokenId): Token[] {
		return this.tokens.slice(start, end)
	}
}
