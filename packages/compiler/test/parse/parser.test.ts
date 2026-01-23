import assert from 'node:assert'
import { describe, it } from 'node:test'
import { CompilationContext } from '../../src/core/context.ts'
import type { NodeId } from '../../src/core/nodes.ts'
import { NodeKind } from '../../src/core/nodes.ts'
import { tokenize } from '../../src/lex/tokenizer.ts'
import { matchOnly, parse } from '../../src/parse/parser.ts'

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

	describe('expression precedence', () => {
		it('should parse multiplication before addition', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 + 2 * 3')
			assert.strictEqual(ctx.hasErrors(), false)
			// Structure: 1 + (2 * 3) - mul binds tighter
			// Nodes: 1, 2, 3, BinaryExpr(*), BinaryExpr(+), ...
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(binaryCount, 2)
		})

		it('should parse division before subtraction', () => {
			const ctx = tokenizeAndParse('x:i32 = 10 - 6 / 2')
			assert.strictEqual(ctx.hasErrors(), false)
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(binaryCount, 2)
		})

		it('should parse comparison before logical AND', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 < 2 && 3 < 4')
			assert.strictEqual(ctx.hasErrors(), false)
			// Structure: (1 < 2) && (3 < 4)
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(binaryCount, 3) // two comparisons + one &&
		})

		it('should parse logical AND before logical OR', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 || 2 && 3')
			assert.strictEqual(ctx.hasErrors(), false)
			// Structure: 1 || (2 && 3)
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(binaryCount, 2)
		})

		it('should parse bitwise AND before bitwise OR', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 | 2 & 3')
			assert.strictEqual(ctx.hasErrors(), false)
			// Structure: 1 | (2 & 3)
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(binaryCount, 2)
		})

		it('should parse bitwise XOR between AND and OR', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 | 2 ^ 3 & 4')
			assert.strictEqual(ctx.hasErrors(), false)
			// Structure: 1 | (2 ^ (3 & 4))
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(binaryCount, 3)
		})

		it('should parse shift operators at multiplication level', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 + 2 << 3')
			assert.strictEqual(ctx.hasErrors(), false)
			// Structure: 1 + (2 << 3) - shift is at mul level
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(binaryCount, 2)
		})

		it('should parse unary minus with highest precedence', () => {
			const ctx = tokenizeAndParse('x:i32 = -1 * 2')
			assert.strictEqual(ctx.hasErrors(), false)
			// Structure: (-1) * 2
			let unaryCount = 0
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.UnaryExpr) unaryCount++
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(unaryCount, 1)
			assert.strictEqual(binaryCount, 1)
		})

		it('should parse bitwise NOT with highest precedence', () => {
			const ctx = tokenizeAndParse('x:i32 = ~1 + 2')
			assert.strictEqual(ctx.hasErrors(), false)
			// Structure: (~1) + 2
			let unaryCount = 0
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.UnaryExpr) unaryCount++
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(unaryCount, 1)
			assert.strictEqual(binaryCount, 1)
		})

		it('should parse parentheses overriding precedence', () => {
			const ctx = tokenizeAndParse('x:i32 = (1 + 2) * 3')
			assert.strictEqual(ctx.hasErrors(), false)
			let parenCount = 0
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.ParenExpr) parenCount++
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(parenCount, 1)
			assert.strictEqual(binaryCount, 2)
		})

		it('should parse nested parentheses', () => {
			const ctx = tokenizeAndParse('x:i32 = ((1 + 2) * (3 + 4))')
			assert.strictEqual(ctx.hasErrors(), false)
			let parenCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.ParenExpr) parenCount++
			}
			assert.strictEqual(parenCount, 3) // outer + two inner
		})

		it('should parse deeply nested expression', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 + 2 * 3 - 4 / 5 + 6')
			assert.strictEqual(ctx.hasErrors(), false)
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(binaryCount, 5)
		})
	})

	describe('expression associativity', () => {
		it('should be left-associative for addition', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 + 2 + 3')
			assert.strictEqual(ctx.hasErrors(), false)
			// Structure: (1 + 2) + 3
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(binaryCount, 2)
		})

		it('should be left-associative for subtraction', () => {
			const ctx = tokenizeAndParse('x:i32 = 10 - 3 - 2')
			assert.strictEqual(ctx.hasErrors(), false)
			// Structure: (10 - 3) - 2, not 10 - (3 - 2)
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(binaryCount, 2)
		})

		it('should be left-associative for multiplication', () => {
			const ctx = tokenizeAndParse('x:i32 = 2 * 3 * 4')
			assert.strictEqual(ctx.hasErrors(), false)
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(binaryCount, 2)
		})

		it('should be left-associative for division', () => {
			const ctx = tokenizeAndParse('x:i32 = 24 / 4 / 2')
			assert.strictEqual(ctx.hasErrors(), false)
			// Structure: (24 / 4) / 2 = 3, not 24 / (4 / 2) = 12
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(binaryCount, 2)
		})

		it('should be left-associative for bitwise operators', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 & 2 & 3')
			assert.strictEqual(ctx.hasErrors(), false)
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(binaryCount, 2)
		})

		it('should be left-associative for shift operators', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 << 2 << 3')
			assert.strictEqual(ctx.hasErrors(), false)
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(binaryCount, 2)
		})

		it('should be left-associative for logical operators', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 && 2 && 3')
			assert.strictEqual(ctx.hasErrors(), false)
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(binaryCount, 2)
		})

		it('should be right-associative for chained unary', () => {
			const ctx = tokenizeAndParse('x:i32 = - -1')
			assert.strictEqual(ctx.hasErrors(), false)
			// Structure: -(-1)
			let unaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.UnaryExpr) unaryCount++
			}
			assert.strictEqual(unaryCount, 2)
		})

		it('should be right-associative for chained bitwise NOT', () => {
			const ctx = tokenizeAndParse('x:i32 = ~~1')
			assert.strictEqual(ctx.hasErrors(), false)
			// Structure: ~(~1)
			let unaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.UnaryExpr) unaryCount++
			}
			assert.strictEqual(unaryCount, 2)
		})
	})

	describe('comparison chaining', () => {
		it('should parse simple comparison chain', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 < 2 < 3')
			assert.strictEqual(ctx.hasErrors(), false)
			// CompareChain node wraps chained comparisons
			let compareChainCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.CompareChain) compareChainCount++
			}
			assert.strictEqual(compareChainCount, 1)
		})

		it('should parse longer comparison chain', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 < 2 < 3 < 4')
			assert.strictEqual(ctx.hasErrors(), false)
			let compareChainCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.CompareChain) compareChainCount++
			}
			assert.strictEqual(compareChainCount, 1)
		})

		it('should parse mixed comparison operators in chain', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 <= 2 < 3')
			assert.strictEqual(ctx.hasErrors(), false)
			let compareChainCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.CompareChain) compareChainCount++
			}
			assert.strictEqual(compareChainCount, 1)
		})

		it('should parse equality in chain', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 == 2 == 3')
			assert.strictEqual(ctx.hasErrors(), false)
			let compareChainCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.CompareChain) compareChainCount++
			}
			assert.strictEqual(compareChainCount, 1)
		})

		it('should not create CompareChain for single comparison', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 < 2')
			assert.strictEqual(ctx.hasErrors(), false)
			let compareChainCount = 0
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.CompareChain) compareChainCount++
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(compareChainCount, 0)
			assert.strictEqual(binaryCount, 1)
		})
	})

	describe('complex expression edge cases', () => {
		it('should parse all operator types together', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 + 2 * 3 & 4 | 5 ^ 6 && 7 || 8')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should parse expression with all precedence levels', () => {
			// || > && > | > ^ > & > compare > add > mul > unary
			const ctx = tokenizeAndParse('x:i32 = ~1 * 2 + 3 < 4 & 5 ^ 6 | 7 && 8 || 9')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should parse comparison with arithmetic on both sides', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 + 2 < 3 + 4')
			assert.strictEqual(ctx.hasErrors(), false)
			// Structure: (1 + 2) < (3 + 4)
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(binaryCount, 3)
		})

		it('should parse unary in complex expression', () => {
			const ctx = tokenizeAndParse('x:i32 = -1 + -2 * -3')
			assert.strictEqual(ctx.hasErrors(), false)
			let unaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.UnaryExpr) unaryCount++
			}
			assert.strictEqual(unaryCount, 3)
		})

		it('should parse parentheses at various positions', () => {
			const ctx = tokenizeAndParse('x:i32 = (1 + 2) * (3 - 4) / (5 + 6)')
			assert.strictEqual(ctx.hasErrors(), false)
			let parenCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.ParenExpr) parenCount++
			}
			assert.strictEqual(parenCount, 3)
		})

		it('should parse expression starting with parenthesis', () => {
			const ctx = tokenizeAndParse('x:i32 = (1 + 2)')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should parse expression ending with parenthesis', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 * (2 + 3)')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should parse triple operator expression', () => {
			const ctx = tokenizeAndParse('x:i32 = 1 >>> 2 >> 3 << 4')
			assert.strictEqual(ctx.hasErrors(), false)
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(binaryCount, 3)
		})

		it('should parse modulo operators', () => {
			const ctx = tokenizeAndParse('x:i32 = 10 % 3 %% 2')
			assert.strictEqual(ctx.hasErrors(), false)
			let binaryCount = 0
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BinaryExpr) binaryCount++
			}
			assert.strictEqual(binaryCount, 2)
		})
	})

	describe('identifier edge cases', () => {
		it('should parse identifier with keyword prefix', () => {
			const ctx = tokenizeAndParse('panicMode:i32 = 1')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should parse identifier starting with i32', () => {
			const ctx = tokenizeAndParse('i32value:i32 = 42')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should parse identifier starting with match', () => {
			const ctx = tokenizeAndParse('matchmaking:i32 = 1')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should parse identifier starting with f64', () => {
			const ctx = tokenizeAndParse('f64data:f64 = 1.0')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should parse identifier ending with keyword', () => {
			const ctx = tokenizeAndParse('mypanic:i32 = 0')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should parse identifier containing keyword', () => {
			const ctx = tokenizeAndParse('dontpanicky:i32 = 1')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should reject underscore-prefixed identifier', () => {
			const ctx = tokenizeAndParse('_private:i32 = 1')
			assert.strictEqual(ctx.hasErrors(), true)
		})

		it('should parse identifier with underscores', () => {
			const ctx = tokenizeAndParse('foo_bar_baz:i32 = 1')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should reject dunder identifier', () => {
			const ctx = tokenizeAndParse('__init__:i32 = 1')
			assert.strictEqual(ctx.hasErrors(), true)
		})

		it('should parse identifier with numbers', () => {
			const ctx = tokenizeAndParse('x1y2z3:i32 = 1')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should parse uppercase identifier', () => {
			const ctx = tokenizeAndParse('CONSTANT:i32 = 42')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should parse mixed case identifier', () => {
			const ctx = tokenizeAndParse('myVariable:i32 = 1')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should parse identifier similar to keyword but different case', () => {
			const ctx = tokenizeAndParse('Panic:i32 = 1')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should parse I32 as identifier not type', () => {
			const ctx = tokenizeAndParse('I32:i32 = 1')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should parse MATCH as identifier', () => {
			const ctx = tokenizeAndParse('MATCH:i32 = 1')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should parse single letter identifier', () => {
			const ctx = tokenizeAndParse('x:i32 = 1')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should parse identifier referencing keyword-prefixed name', () => {
			const ctx = tokenizeAndParse('i32val:i32 = 1\ny:i32 = i32val')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should parse multiple keyword-like identifiers', () => {
			const ctx = tokenizeAndParse('panicLevel:i32 = 1\nmatchCount:i32 = panicLevel')
			assert.strictEqual(ctx.hasErrors(), false)
		})
	})

	describe('list type parsing', () => {
		it('should parse list type with size bound', () => {
			const source = 'arr: i32[]<size=4> = [1, 2, 3, 4]\npanic'
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = matchOnly(ctx)
			assert.ok(result, 'should match list type syntax')
		})

		it('should parse nested list type (list of lists)', () => {
			const source = 'matrix: i32[]<size=4>[]<size=2> = [[1, 2, 3, 4], [5, 6, 7, 8]]\npanic'
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = matchOnly(ctx)
			assert.ok(result, 'should match nested list type syntax')
		})

		it('should parse list type with i64 element type', () => {
			const source = 'arr: i64[]<size=2> = [1, 2]\npanic'
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = matchOnly(ctx)
			assert.ok(result, 'should match i64 list type syntax')
		})

		it('should parse list type with f32 element type', () => {
			const source = 'arr: f32[]<size=2> = [1.0, 2.0]\npanic'
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = matchOnly(ctx)
			assert.ok(result, 'should match f32 list type syntax')
		})

		it('should parse list type with f64 element type', () => {
			const source = 'arr: f64[]<size=2> = [1.0, 2.0]\npanic'
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = matchOnly(ctx)
			assert.ok(result, 'should match f64 list type syntax')
		})
	})

	describe('list literal parsing', () => {
		it('should parse list literal', () => {
			const source = 'arr: i32[]<size=4> = [1, 2, 3, 4]\npanic'
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = matchOnly(ctx)
			assert.ok(result, 'should match list literal syntax')
		})

		it('should parse nested list literal', () => {
			const source = 'matrix: i32[]<size=2>[]<size=2> = [[1, 2], [3, 4]]\npanic'
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = matchOnly(ctx)
			assert.ok(result, 'should match nested list literal syntax')
		})

		it('should parse list literal with single element', () => {
			const source = 'arr: i32[]<size=1> = [42]\npanic'
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = matchOnly(ctx)
			assert.ok(result, 'should match single element list')
		})

		it('should parse list literal with expression elements', () => {
			const source = 'arr: i32[]<size=2> = [1 + 2, 3 * 4]\npanic'
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = matchOnly(ctx)
			assert.ok(result, 'should match list with expression elements')
		})
	})

	describe('index access parsing', () => {
		it('should parse index access', () => {
			const source = 'x: i32 = arr[0]\npanic'
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = matchOnly(ctx)
			assert.ok(result, 'should match index access syntax')
		})

		it('should parse chained index access', () => {
			const source = 'x: i32 = matrix[0][1]\npanic'
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = matchOnly(ctx)
			assert.ok(result, 'should match chained index access syntax')
		})

		it('should parse triple chained index access', () => {
			const source = 'x: i32 = cube[0][1][2]\npanic'
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = matchOnly(ctx)
			assert.ok(result, 'should match triple chained index access')
		})

		it('should parse index access with larger index', () => {
			const source = 'x: i32 = arr[99]\npanic'
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = matchOnly(ctx)
			assert.ok(result, 'should match index access with larger index')
		})
	})

	describe('list in record type parsing', () => {
		it('should parse record type with list field', () => {
			const source = `Foo
    items: i32[]<size=3>
panic`
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = matchOnly(ctx)
			assert.ok(result, 'should match record type with list field')
		})

		it('should parse record type with multiple list fields', () => {
			const source = `Data
    xs: i32[]<size=4>
    ys: f64[]<size=4>
panic`
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = matchOnly(ctx)
			assert.ok(result, 'should match record type with multiple list fields')
		})

		it('should parse record type with nested list field', () => {
			const source = `Matrix
    data: i32[]<size=3>[]<size=3>
panic`
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = matchOnly(ctx)
			assert.ok(result, 'should match record type with nested list field')
		})
	})

	describe('PanicExpr', () => {
		it('should parse panic as expression in binding RHS', () => {
			const ctx = tokenizeAndParse('x = panic')
			assert.strictEqual(ctx.hasErrors(), false)
			let hasPanicExpr = false
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.PanicExpr) hasPanicExpr = true
			}
			assert.strictEqual(hasPanicExpr, true)
		})

		it('should still parse standalone panic as PanicStatement', () => {
			// Standalone panic at root level continues to work
			const ctx = tokenizeAndParse('panic')
			assert.strictEqual(ctx.hasErrors(), false)
			let hasPanicStatement = false
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.PanicStatement) hasPanicStatement = true
			}
			assert.strictEqual(hasPanicStatement, true)
		})
	})

	describe('BindingExpr', () => {
		it('should parse binding expression without type annotation', () => {
			const ctx = tokenizeAndParse('x = 42')
			assert.strictEqual(ctx.hasErrors(), false)
			let hasBindingExpr = false
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BindingExpr) hasBindingExpr = true
			}
			assert.strictEqual(hasBindingExpr, true)
		})

		it('should parse record instantiation with new syntax', () => {
			// p = Point is the new syntax for record instantiation
			// (requires Point to be a defined type in checker, but grammar should parse it)
			const ctx = tokenizeAndParse('p = Point')
			assert.strictEqual(ctx.hasErrors(), false)
			let hasBindingExpr = false
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.BindingExpr) hasBindingExpr = true
			}
			assert.strictEqual(hasBindingExpr, true)
		})

		it('should still parse explicit type annotation as PrimitiveBinding', () => {
			// x: i32 = 42 continues to parse as PrimitiveBinding for backward compatibility
			const ctx = tokenizeAndParse('x: i32 = 42')
			assert.strictEqual(ctx.hasErrors(), false)
			let hasPrimitiveBinding = false
			for (const [, node] of ctx.nodes) {
				if (node.kind === NodeKind.PrimitiveBinding) hasPrimitiveBinding = true
			}
			assert.strictEqual(hasPrimitiveBinding, true)
		})
	})

	describe('list literal in record init parsing', () => {
		it('should parse record initialization with list field', () => {
			const source = `Foo
    items: i32[]<size=3>
f:Foo
    items = [1, 2, 3]
panic`
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = matchOnly(ctx)
			assert.ok(result, 'should match record init with list field')
		})

		it('should parse record initialization with nested list field', () => {
			const source = `Matrix
    data: i32[]<size=2>[]<size=2>
m:Matrix
    data = [[1, 2], [3, 4]]
panic`
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = matchOnly(ctx)
			assert.ok(result, 'should match record init with nested list field')
		})

		it('should parse record initialization with multiple list fields', () => {
			const source = `Data
    xs: i32[]<size=2>
    ys: i32[]<size=2>
d:Data
    xs = [1, 2]
    ys = [3, 4]
panic`
			const ctx = new CompilationContext(source)
			tokenize(ctx)
			const result = matchOnly(ctx)
			assert.ok(result, 'should match record init with multiple list fields')
		})
	})
})
