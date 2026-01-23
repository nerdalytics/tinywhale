import assert from 'node:assert'
import { describe, it } from 'node:test'
import { NodeKind, NodeStore, nodeId, type ParseNode } from '../../src/core/nodes.ts'
import { tokenId } from '../../src/core/tokens.ts'

describe('core/nodes', () => {
	describe('NodeKind', () => {
		it('should have correct values for line types', () => {
			assert.strictEqual(NodeKind.IndentedLine, 0)
			assert.strictEqual(NodeKind.DedentLine, 1)
			assert.strictEqual(NodeKind.RootLine, 2)
		})

		it('should have correct value for expressions', () => {
			assert.strictEqual(NodeKind.PanicExpr, 118)
		})

		it('should have correct value for Program', () => {
			assert.strictEqual(NodeKind.Program, 255)
		})
	})

	describe('nodeId', () => {
		it('should create NodeId from number', () => {
			const id = nodeId(5)
			assert.strictEqual(id, 5)
		})
	})

	describe('NodeStore', () => {
		it('should start empty', () => {
			const store = new NodeStore()
			assert.strictEqual(store.count(), 0)
		})

		it('should add nodes and return sequential IDs', () => {
			const store = new NodeStore()
			const node1: ParseNode = {
				kind: NodeKind.PanicExpr,
				subtreeSize: 1,
				tokenId: tokenId(0),
			}
			const node2: ParseNode = {
				kind: NodeKind.RootLine,
				subtreeSize: 2,
				tokenId: tokenId(0),
			}

			const id1 = store.add(node1)
			const id2 = store.add(node2)

			assert.strictEqual(id1, 0)
			assert.strictEqual(id2, 1)
			assert.strictEqual(store.count(), 2)
		})

		it('should retrieve nodes by ID', () => {
			const store = new NodeStore()
			const node: ParseNode = {
				kind: NodeKind.PanicExpr,
				subtreeSize: 1,
				tokenId: tokenId(5),
			}

			const id = store.add(node)
			const retrieved = store.get(id)

			assert.strictEqual(retrieved.kind, NodeKind.PanicExpr)
			assert.strictEqual(retrieved.tokenId, 5)
			assert.strictEqual(retrieved.subtreeSize, 1)
		})

		it('should throw on invalid ID', () => {
			const store = new NodeStore()
			assert.throws(() => store.get(nodeId(0)), /Invalid NodeId/)
			assert.throws(() => store.get(nodeId(100)), /Invalid NodeId/)
		})

		it('should validate IDs correctly', () => {
			const store = new NodeStore()
			const node: ParseNode = {
				kind: NodeKind.Program,
				subtreeSize: 1,
				tokenId: tokenId(0),
			}
			const id = store.add(node)

			assert.strictEqual(store.isValid(id), true)
			assert.strictEqual(store.isValid(nodeId(1)), false)
			assert.strictEqual(store.isValid(nodeId(-1)), false)
		})

		it('should calculate child range correctly for leaf node', () => {
			const store = new NodeStore()
			const leaf: ParseNode = {
				kind: NodeKind.PanicExpr,
				subtreeSize: 1,
				tokenId: tokenId(0),
			}
			const id = store.add(leaf)

			const range = store.getChildRange(id)
			assert.strictEqual(range.start, 0)
			assert.strictEqual(range.count, 0)
		})

		it('should calculate child range correctly for parent node', () => {
			const store = new NodeStore()

			// Add child first (postorder)
			store.add({
				kind: NodeKind.PanicExpr,
				subtreeSize: 1,
				tokenId: tokenId(0),
			})

			// Add parent
			const parentId = store.add({
				kind: NodeKind.RootLine,
				subtreeSize: 2, // self + 1 child
				tokenId: tokenId(0),
			})

			const range = store.getChildRange(parentId)
			assert.strictEqual(range.start, 0)
			assert.strictEqual(range.count, 1)
		})

		it('should iterate children correctly', () => {
			const store = new NodeStore()

			// Postorder: children before parent
			// Structure: Program contains [RootLine1, RootLine2]
			// Storage order: panic1, line1, panic2, line2, program
			// Indices:       0       1      2       3      4

			// First panic expression (child of line1)
			store.add({
				kind: NodeKind.PanicExpr,
				subtreeSize: 1,
				tokenId: tokenId(0),
			})

			// First line (contains panic1)
			store.add({
				kind: NodeKind.RootLine,
				subtreeSize: 2,
				tokenId: tokenId(0),
			})

			// Second panic expression (child of line2)
			store.add({
				kind: NodeKind.PanicExpr,
				subtreeSize: 1,
				tokenId: tokenId(1),
			})

			// Second line (contains panic2)
			store.add({
				kind: NodeKind.RootLine,
				subtreeSize: 2,
				tokenId: tokenId(1),
			})

			// Program (contains both lines)
			const programId = store.add({
				kind: NodeKind.Program,
				subtreeSize: 5,
				tokenId: tokenId(0),
			})

			// Iterate direct children of program
			const children: Array<[number, ParseNode]> = []
			for (const [id, node] of store.iterateChildren(programId)) {
				children.push([id, node])
			}

			// Should get both RootLine nodes (indices 3 and 1, in reverse order)
			assert.strictEqual(children.length, 2)
			assert.strictEqual(children[0]?.[0], 3) // line2 first (reverse order)
			assert.strictEqual(children[0]?.[1].kind, NodeKind.RootLine)
			assert.strictEqual(children[1]?.[0], 1) // line1 second
			assert.strictEqual(children[1]?.[1].kind, NodeKind.RootLine)
		})

		it('should iterate subtree correctly', () => {
			const store = new NodeStore()

			// panic at index 0
			store.add({
				kind: NodeKind.PanicExpr,
				subtreeSize: 1,
				tokenId: tokenId(0),
			})

			// line at index 1
			const lineId = store.add({
				kind: NodeKind.RootLine,
				subtreeSize: 2,
				tokenId: tokenId(0),
			})

			// Iterate subtree of line
			const subtree: ParseNode[] = []
			for (const [, node] of store.iterateSubtree(lineId)) {
				subtree.push(node)
			}

			assert.strictEqual(subtree.length, 2)
			assert.strictEqual(subtree[0]!.kind, NodeKind.PanicExpr)
			assert.strictEqual(subtree[1]!.kind, NodeKind.RootLine)
		})

		it('should iterate over all nodes', () => {
			const store = new NodeStore()
			store.add({ kind: NodeKind.PanicExpr, subtreeSize: 1, tokenId: tokenId(0) })
			store.add({ kind: NodeKind.RootLine, subtreeSize: 2, tokenId: tokenId(0) })
			store.add({ kind: NodeKind.Program, subtreeSize: 3, tokenId: tokenId(0) })

			const collected: Array<[number, ParseNode]> = []
			for (const [id, node] of store) {
				collected.push([id, node])
			}

			assert.strictEqual(collected.length, 3)
			assert.strictEqual(collected[0]![0], 0)
			assert.strictEqual(collected[1]![0], 1)
			assert.strictEqual(collected[2]![0], 2)
		})
	})
})
