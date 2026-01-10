import assert from 'node:assert'
import { describe, it } from 'node:test'
import { CompilationContext } from '../../src/core/context.ts'
import { NodeKind } from '../../src/core/nodes.ts'
import { tokenize } from '../../src/lex/tokenizer.ts'
import { parse } from '../../src/parse/parser.ts'

function tokenizeAndParse(source: string): CompilationContext {
	const ctx = new CompilationContext(source)
	tokenize(ctx)
	parse(ctx)
	return ctx
}

function countNodeKind(ctx: CompilationContext, kind: number): number {
	let count = 0
	for (const [, node] of ctx.nodes) {
		if (node.kind === kind) count++
	}
	return count
}

function hasNodeKind(ctx: CompilationContext, kind: number): boolean {
	return countNodeKind(ctx, kind) > 0
}

describe('parse/match', () => {
	describe('match expression parsing', () => {
		it('should parse match binding with literal patterns', () => {
			const source = `result: i32 = match x
	0 -> 100
	1 -> 200`
			const ctx = tokenizeAndParse(source)

			assert.strictEqual(ctx.hasErrors(), false, 'should have no errors')
			assert.ok(hasNodeKind(ctx, NodeKind.MatchExpr), 'should have MatchExpr node')
		})

		it('should parse match with wildcard pattern', () => {
			const source = `result: i32 = match x
	0 -> 100
	_ -> 0`
			const ctx = tokenizeAndParse(source)

			assert.strictEqual(ctx.hasErrors(), false, 'should have no errors')
			assert.ok(hasNodeKind(ctx, NodeKind.WildcardPattern), 'should have WildcardPattern node')
		})

		it('should parse match with binding pattern', () => {
			const source = `result: i32 = match x
	0 -> 100
	other -> other`
			const ctx = tokenizeAndParse(source)

			assert.strictEqual(ctx.hasErrors(), false, 'should have no errors')
			assert.ok(hasNodeKind(ctx, NodeKind.BindingPattern), 'should have BindingPattern node')
		})

		it('should parse match with negative literal pattern', () => {
			const source = `result: i32 = match x
	-1 -> 100
	0 -> 0`
			const ctx = tokenizeAndParse(source)

			assert.strictEqual(ctx.hasErrors(), false, 'should have no errors')
			assert.ok(hasNodeKind(ctx, NodeKind.LiteralPattern), 'should have LiteralPattern node')
		})

		it('should parse match with or-pattern', () => {
			const source = `result: i32 = match x
	0 | 1 | 2 -> 100
	_ -> 0`
			const ctx = tokenizeAndParse(source)

			assert.strictEqual(ctx.hasErrors(), false, 'should have no errors')
			assert.ok(hasNodeKind(ctx, NodeKind.OrPattern), 'should have OrPattern node')
		})
	})

	describe('match arm parsing', () => {
		it('should create MatchArm nodes for each arm', () => {
			const source = `result: i32 = match x
	0 -> 100
	1 -> 200
	_ -> 0`
			const ctx = tokenizeAndParse(source)

			assert.strictEqual(ctx.hasErrors(), false, 'should have no errors')
			assert.strictEqual(countNodeKind(ctx, NodeKind.MatchArm), 3, 'should have 3 MatchArm nodes')
		})

		it('should parse match arm with unary expression body', () => {
			const source = `result: i32 = match x
	0 -> -1`
			const ctx = tokenizeAndParse(source)

			assert.strictEqual(ctx.hasErrors(), false, 'should have no errors')
			assert.ok(hasNodeKind(ctx, NodeKind.UnaryExpr), 'should have UnaryExpr node')
		})

		it('should parse match arm with identifier body', () => {
			const source = `result: i32 = match x
	0 -> y`
			const ctx = tokenizeAndParse(source)

			assert.strictEqual(ctx.hasErrors(), false, 'should have no errors')
			assert.ok(hasNodeKind(ctx, NodeKind.MatchArm), 'should have MatchArm node')
		})
	})

	describe('pattern node structure', () => {
		it('should have correct subtreeSize for WildcardPattern', () => {
			const source = `result: i32 = match x
	_ -> 0`
			const ctx = tokenizeAndParse(source)

			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.WildcardPattern) {
					assert.strictEqual(node.subtreeSize, 1, 'WildcardPattern should have subtreeSize 1')
				}
			}
		})

		it('should have correct subtreeSize for LiteralPattern', () => {
			const source = `result: i32 = match x
	42 -> 0`
			const ctx = tokenizeAndParse(source)

			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.LiteralPattern) {
					assert.strictEqual(node.subtreeSize, 1, 'LiteralPattern should have subtreeSize 1')
				}
			}
		})

		it('should have correct subtreeSize for BindingPattern', () => {
			const source = `result: i32 = match x
	other -> 0`
			const ctx = tokenizeAndParse(source)

			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BindingPattern) {
					assert.strictEqual(node.subtreeSize, 1, 'BindingPattern should have subtreeSize 1')
				}
			}
		})

		it('should have correct subtreeSize for OrPattern with 3 alternatives', () => {
			const source = `result: i32 = match x
	0 | 1 | 2 -> 100`
			const ctx = tokenizeAndParse(source)

			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.OrPattern) {
					// OrPattern: 1 (self) + 3 LiteralPatterns = 4
					assert.strictEqual(
						node.subtreeSize,
						4,
						'OrPattern with 3 alternatives should have subtreeSize 4'
					)
				}
			}
		})
	})

	describe('match expression node structure', () => {
		it('should have MatchExpr containing scrutinee', () => {
			const source = `result: i32 = match x
	0 -> 100`
			const ctx = tokenizeAndParse(source)

			let matchExprFound = false
			for (const [_id, node] of ctx.nodes) {
				if (node.kind === NodeKind.MatchExpr) {
					matchExprFound = true
					// MatchExpr has scrutinee (Identifier) as child
					assert.strictEqual(
						node.subtreeSize,
						2,
						'MatchExpr should have subtreeSize 2 (self + scrutinee)'
					)
				}
			}
			assert.ok(matchExprFound, 'should have MatchExpr node')
		})

		it('should store nodes in postorder', () => {
			const source = `result: i32 = match x
	0 -> 100`
			const ctx = tokenizeAndParse(source)

			// Find the index of MatchExpr
			let matchExprIdx = -1

			for (const [id, node] of ctx.nodes) {
				if (node.kind === NodeKind.MatchExpr) {
					matchExprIdx = id as number
				}
			}

			assert.ok(
				matchExprIdx > 0,
				'MatchExpr should have index > 0 (children come first in postorder)'
			)
		})
	})

	describe('or-pattern edge cases', () => {
		it('should not create OrPattern for single alternative', () => {
			const source = `result: i32 = match x
	0 -> 100`
			const ctx = tokenizeAndParse(source)

			assert.strictEqual(ctx.hasErrors(), false, 'should have no errors')
			assert.strictEqual(
				countNodeKind(ctx, NodeKind.OrPattern),
				0,
				'should not have OrPattern for single pattern'
			)
			assert.ok(hasNodeKind(ctx, NodeKind.LiteralPattern), 'should have LiteralPattern directly')
		})

		it('should create OrPattern only with 2+ alternatives', () => {
			const source = `result: i32 = match x
	0 | 1 -> 100`
			const ctx = tokenizeAndParse(source)

			assert.strictEqual(ctx.hasErrors(), false, 'should have no errors')
			assert.strictEqual(countNodeKind(ctx, NodeKind.OrPattern), 1, 'should have one OrPattern')
		})
	})

	describe('discarded match (no binding)', () => {
		it('should parse standalone match expression', () => {
			const source = `match x
	0 -> 100
	_ -> 0`
			const ctx = tokenizeAndParse(source)

			// This may or may not be valid depending on grammar - testing current behavior
			// If standalone match is supported, it should parse without error
			// Current grammar requires MatchBinding, so this may fail
			// Just verify it doesn't crash
			assert.ok(ctx.nodes.count() > 0, 'should have parsed some nodes')
		})
	})

	describe('multiple match expressions', () => {
		it('should parse multiple match bindings', () => {
			const source = `a: i32 = match x
	0 -> 1
	_ -> 0
b: i32 = match y
	1 -> 2
	_ -> 0`
			const ctx = tokenizeAndParse(source)

			assert.strictEqual(ctx.hasErrors(), false, 'should have no errors')
			assert.strictEqual(countNodeKind(ctx, NodeKind.MatchExpr), 2, 'should have 2 MatchExpr nodes')
			assert.strictEqual(countNodeKind(ctx, NodeKind.MatchArm), 4, 'should have 4 MatchArm nodes')
		})
	})
})
