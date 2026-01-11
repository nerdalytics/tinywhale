import { describe, it } from 'node:test'
import fc from 'fast-check'
import { CompilationContext } from '../../src/core/context.ts'
import { NodeKind } from '../../src/core/nodes.ts'
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

	describe('structural properties', () => {
		it('when succeeded, root node is always Program', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					const ctx = new CompilationContext(input)
					tokenize(ctx)
					const result = parse(ctx)
					if (result.succeeded && result.rootNode !== undefined) {
						const root = ctx.nodes.get(result.rootNode)
						return root.kind === NodeKind.Program
					}
					return true
				}),
				{ numRuns: 1000 }
			)
		})

		it('when succeeded, node count is at least 1', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					const ctx = new CompilationContext(input)
					tokenize(ctx)
					const result = parse(ctx)
					if (result.succeeded) {
						return ctx.nodes.count() >= 1
					}
					return true
				}),
				{ numRuns: 1000 }
			)
		})

		it('when succeeded, root subtreeSize equals total node count', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					const ctx = new CompilationContext(input)
					tokenize(ctx)
					const result = parse(ctx)
					if (result.succeeded && result.rootNode !== undefined) {
						const root = ctx.nodes.get(result.rootNode)
						return root.subtreeSize === ctx.nodes.count()
					}
					return true
				}),
				{ numRuns: 1000 }
			)
		})

		it('every node has subtreeSize >= 1', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					const ctx = new CompilationContext(input)
					tokenize(ctx)
					const result = parse(ctx)
					if (result.succeeded) {
						for (const [, node] of ctx.nodes) {
							if (node.subtreeSize < 1) return false
						}
					}
					return true
				}),
				{ numRuns: 1000 }
			)
		})

		it('all node tokenIds reference valid tokens', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					const ctx = new CompilationContext(input)
					tokenize(ctx)
					const result = parse(ctx)
					if (result.succeeded) {
						const tokenCount = ctx.tokens.count()
						for (const [, node] of ctx.nodes) {
							if (node.tokenId < 0 || node.tokenId >= tokenCount) {
								return false
							}
						}
					}
					return true
				}),
				{ numRuns: 1000 }
			)
		})
	})
})
