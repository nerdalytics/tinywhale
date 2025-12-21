import assert from 'node:assert'
import { describe, it } from 'node:test'
import { CompilationContext } from '../../src/core/context.ts'
import { type NodeId, NodeKind } from '../../src/core/nodes.ts'
import { tokenize } from '../../src/lex/tokenizer.ts'
import { parse } from '../../src/parse/parser.ts'

/**
 * Helper to tokenize and parse in one step.
 */
function tokenizeAndParse(source: string): CompilationContext {
	const ctx = new CompilationContext(source)
	tokenize(ctx)
	parse(ctx)
	return ctx
}

describe('parse/parser', () => {
	describe('basic parsing', () => {
		it('should parse empty input', () => {
			const ctx = tokenizeAndParse('')
			parse(ctx)

			// Note: we called parse twice, but that's ok for this test
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should parse single panic statement', () => {
			const ctx = new CompilationContext('panic')
			tokenize(ctx)
			const result = parse(ctx)

			assert.strictEqual(result.succeeded, true)
			assert.notStrictEqual(result.rootNode, undefined)

			// Should have: PanicStatement, RootLine, Program
			assert.strictEqual(ctx.nodes.count(), 3)
		})

		it('should create Program node as root', () => {
			const ctx = new CompilationContext('panic')
			tokenize(ctx)
			const result = parse(ctx)

			assert.ok(result.rootNode !== undefined, 'rootNode should be defined')
			const rootNode = ctx.nodes.get(result.rootNode)
			assert.strictEqual(rootNode.kind, NodeKind.Program)
		})

		it('should create RootLine for unindented statement', () => {
			const ctx = new CompilationContext('panic')
			tokenize(ctx)
			parse(ctx)

			// Find RootLine node
			let hasRootLine = false
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.RootLine) hasRootLine = true
			}
			assert.strictEqual(hasRootLine, true)
		})

		it('should create PanicStatement node', () => {
			const ctx = new CompilationContext('panic')
			tokenize(ctx)
			parse(ctx)

			// Find PanicStatement node
			let hasPanic = false
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.PanicStatement) hasPanic = true
			}
			assert.strictEqual(hasPanic, true)
		})
	})

	describe('indented lines', () => {
		it('should create IndentedLine for indented statement', () => {
			const ctx = new CompilationContext('panic\n\tpanic')
			tokenize(ctx)
			parse(ctx)

			let hasIndentedLine = false
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.IndentedLine) hasIndentedLine = true
			}
			assert.strictEqual(hasIndentedLine, true)
		})

		it('should create DedentLine for dedented statement', () => {
			const ctx = new CompilationContext('panic\n\tpanic\npanic')
			tokenize(ctx)
			parse(ctx)

			let hasDedentLine = false
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.DedentLine) hasDedentLine = true
			}
			assert.strictEqual(hasDedentLine, true)
		})
	})

	describe('postorder structure', () => {
		it('should store nodes in postorder (children before parent)', () => {
			const ctx = new CompilationContext('panic')
			tokenize(ctx)
			parse(ctx)

			// Order should be: PanicStatement(0), RootLine(1), Program(2)
			assert.strictEqual(ctx.nodes.get(0 as NodeId).kind, NodeKind.PanicStatement)
			assert.strictEqual(ctx.nodes.get(1 as NodeId).kind, NodeKind.RootLine)
			assert.strictEqual(ctx.nodes.get(2 as NodeId).kind, NodeKind.Program)
		})

		it('should have correct subtreeSize for leaf nodes', () => {
			const ctx = new CompilationContext('panic')
			tokenize(ctx)
			parse(ctx)

			const panicNode = ctx.nodes.get(0 as NodeId)
			assert.strictEqual(panicNode.subtreeSize, 1)
		})

		it('should have correct subtreeSize for RootLine', () => {
			const ctx = new CompilationContext('panic')
			tokenize(ctx)
			parse(ctx)

			const rootLineNode = ctx.nodes.get(1 as NodeId)
			assert.strictEqual(rootLineNode.subtreeSize, 2) // self + panic
		})

		it('should have correct subtreeSize for Program', () => {
			const ctx = new CompilationContext('panic')
			tokenize(ctx)
			parse(ctx)

			const programNode = ctx.nodes.get(2 as NodeId)
			assert.strictEqual(programNode.subtreeSize, 3) // self + rootline + panic
		})
	})

	describe('multiple statements', () => {
		it('should parse multiple panic statements', () => {
			const ctx = new CompilationContext('panic\npanic\npanic')
			tokenize(ctx)
			parse(ctx)

			let panicCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.PanicStatement) panicCount++
			}
			assert.strictEqual(panicCount, 3)
		})

		it('should have correct Program subtreeSize for multiple lines', () => {
			const ctx = new CompilationContext('panic\npanic')
			tokenize(ctx)
			const result = parse(ctx)

			// 2 panics + 2 rootlines + 1 program = 5 nodes
			assert.strictEqual(ctx.nodes.count(), 5)

			assert.ok(result.rootNode !== undefined, 'rootNode should be defined')
			const programNode = ctx.nodes.get(result.rootNode)
			assert.strictEqual(programNode.subtreeSize, 5)
		})
	})

	describe('nested structure', () => {
		it('should parse nested indent/dedent', () => {
			const ctx = new CompilationContext('panic\n\tpanic\n\t\tpanic\npanic')
			tokenize(ctx)
			const result = parse(ctx)

			assert.strictEqual(result.succeeded, true)
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should iterate children of Program correctly', () => {
			const ctx = new CompilationContext('panic\npanic')
			tokenize(ctx)
			const result = parse(ctx)

			assert.ok(result.rootNode !== undefined, 'rootNode should be defined')
			const children: number[] = []
			for (const [_id, node] of ctx.nodes.iterateChildren(result.rootNode)) {
				children.push(node.kind)
			}

			// Should have 2 RootLine children (in reverse order due to postorder iteration)
			assert.strictEqual(children.length, 2)
			assert.strictEqual(children[0], NodeKind.RootLine)
			assert.strictEqual(children[1], NodeKind.RootLine)
		})
	})

	describe('comments', () => {
		it('should skip comment-only lines', () => {
			const ctx = new CompilationContext('# comment\npanic')
			tokenize(ctx)
			const result = parse(ctx)

			assert.strictEqual(result.succeeded, true)

			// Should have 1 panic statement
			let panicCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.PanicStatement) panicCount++
			}
			assert.strictEqual(panicCount, 1)
		})

		it('should handle inline comments', () => {
			const ctx = new CompilationContext('panic # comment')
			tokenize(ctx)
			const result = parse(ctx)

			assert.strictEqual(result.succeeded, true)
		})
	})

	describe('error handling', () => {
		it('should report tokenization errors', () => {
			const ctx = new CompilationContext('\t\tpanic') // Invalid jump
			tokenize(ctx)

			assert.strictEqual(ctx.hasErrors(), true)
		})
	})

	describe('token association', () => {
		it('should associate nodes with tokens', () => {
			const ctx = new CompilationContext('panic')
			tokenize(ctx)
			parse(ctx)

			// PanicStatement should have a valid tokenId
			const panicNode = ctx.nodes.get(0 as NodeId)
			assert.strictEqual(ctx.tokens.isValid(panicNode.tokenId), true)
		})
	})
})
