/**
 * Token storage using dense arrays with integer IDs.
 * Carbon-style data-oriented design for cache efficiency.
 */

/**
 * Token kinds - small integer discriminant.
 * Grouped by category for clarity.
 */
export const TokenKind = {
	Dedent: 1,

	// Future: Identifiers and literals (100-199)
	// Identifier: 100,
	// IntLiteral: 101,
	// StringLiteral: 102,

	// Special (255)
	Eof: 255,
	// Structural tokens (0-9)
	Indent: 0,
	Newline: 2,

	// Keywords (10-99)
	Panic: 10,
} as const

export type TokenKind = (typeof TokenKind)[keyof typeof TokenKind]

/**
 * Branded type for token IDs.
 * Provides type safety while remaining a plain number at runtime.
 */
export type TokenId = number & { readonly __brand: 'TokenId' }

/**
 * Creates a TokenId from a number.
 * Use sparingly - prefer getting IDs from TokenStore.add().
 */
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

	/**
	 * Add a token and return its ID.
	 */
	add(token: Token): TokenId {
		const id = this.tokens.length as TokenId
		this.tokens.push(token)
		return id
	}

	/**
	 * Get a token by ID.
	 * Throws if ID is out of bounds.
	 */
	get(id: TokenId): Token {
		const token = this.tokens[id]
		if (token === undefined) {
			throw new Error(`Invalid TokenId: ${id}`)
		}
		return token
	}

	/**
	 * Get token count.
	 */
	count(): number {
		return this.tokens.length
	}

	/**
	 * Check if a token ID is valid.
	 */
	isValid(id: TokenId): boolean {
		return id >= 0 && id < this.tokens.length
	}

	/**
	 * Iterate over all tokens with their IDs.
	 * Sequential access for cache-friendly traversal.
	 */
	*[Symbol.iterator](): Generator<[TokenId, Token]> {
		for (let i = 0; i < this.tokens.length; i++) {
			const token = this.tokens[i]
			if (token !== undefined) yield [i as TokenId, token]
		}
	}

	/**
	 * Get a slice of tokens by ID range.
	 * Useful for getting tokens in a specific range.
	 */
	slice(start: TokenId, end: TokenId): Token[] {
		return this.tokens.slice(start, end)
	}
}
