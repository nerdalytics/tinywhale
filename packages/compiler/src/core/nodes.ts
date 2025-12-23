/**
 * Parse node storage using dense arrays with integer IDs.
 * Nodes are stored in postorder - children precede their parent.
 * This enables O(1) child range lookup via subtreeSize.
 */

import type { TokenId } from './tokens.ts'

/**
 * Node kinds - one per grammar production.
 * Grouped by category for clarity.
 */
export const NodeKind = {
	DedentLine: 1,

	// Expressions (100-149)
	Identifier: 100,
	// Line types (0-9)
	IndentedLine: 0,
	IntLiteral: 101,

	// Statements (10-99)
	PanicStatement: 10,

	// Program root (255)
	Program: 255,
	RootLine: 2,

	// Type annotations (150-199)
	TypeAnnotation: 150,
	VariableBinding: 11,
} as const

export type NodeKind = (typeof NodeKind)[keyof typeof NodeKind]

/**
 * Branded type for node IDs.
 * Provides type safety while remaining a plain number at runtime.
 */
export type NodeId = number & { readonly __brand: 'NodeId' }

export function nodeId(n: number): NodeId {
	return n as NodeId
}

/**
 * Range of node IDs for child access.
 */
export interface NodeIdRange {
	readonly start: NodeId
	readonly count: number
}

/**
 * A single parse node - fixed size, no pointers.
 *
 * Stored in postorder: children precede parent.
 * subtreeSize encodes tree structure:
 * - For leaf nodes: subtreeSize = 1
 * - For parent nodes: subtreeSize = 1 + sum of children's subtreeSizes
 *
 * Children are the (subtreeSize - 1) nodes immediately preceding this node.
 */
export interface ParseNode {
	readonly kind: NodeKind
	/** Primary token for this node (for error reporting and source mapping) */
	readonly tokenId: TokenId
	/** Number of nodes in subtree including self */
	readonly subtreeSize: number
}

/**
 * Dense array storage for parse nodes (postorder).
 * Append-only during parsing phase.
 */
export class NodeStore {
	private readonly nodes: ParseNode[] = []

	add(node: ParseNode): NodeId {
		const id = this.nodes.length as NodeId
		this.nodes.push(node)
		return id
	}

	get(id: NodeId): ParseNode {
		const node = this.nodes[id]
		if (node === undefined) {
			throw new Error(`Invalid NodeId: ${id}`)
		}
		return node
	}

	count(): number {
		return this.nodes.length
	}

	isValid(id: NodeId): boolean {
		return id >= 0 && id < this.nodes.length
	}

	/**
	 * Get the range of child node IDs.
	 * In postorder storage, children are the (subtreeSize - 1) nodes
	 * immediately preceding this node.
	 */
	getChildRange(id: NodeId): NodeIdRange {
		const node = this.get(id)
		const childCount = node.subtreeSize - 1
		return {
			count: childCount,
			start: (id - childCount) as NodeId,
		}
	}

	/**
	 * Iterate over direct children of a node.
	 * In postorder, direct children are found by walking backwards from the
	 * end of the child range, skipping each child's subtree.
	 * Note: This yields children in reverse order (rightmost first).
	 */
	*iterateChildren(id: NodeId): Generator<[NodeId, ParseNode]> {
		const { start, count } = this.getChildRange(id)
		if (count === 0) return

		// Start at the end of the child range
		let pos = (start as number) + count - 1

		while (pos >= (start as number)) {
			const childId = pos as NodeId
			const child = this.nodes[childId]
			if (child === undefined) break
			yield [childId, child]
			// Move backwards past this child's subtree to find previous sibling
			pos -= child.subtreeSize
		}
	}

	/**
	 * Iterate over all nodes in a subtree (inclusive of root).
	 * Returns nodes in postorder (natural storage order).
	 */
	*iterateSubtree(id: NodeId): Generator<[NodeId, ParseNode]> {
		const node = this.get(id)
		const start = id - node.subtreeSize + 1
		for (let i = start; i <= id; i++) {
			const n = this.nodes[i]
			if (n !== undefined) yield [i as NodeId, n]
		}
	}

	*[Symbol.iterator](): Generator<[NodeId, ParseNode]> {
		for (let i = 0; i < this.nodes.length; i++) {
			const node = this.nodes[i]
			if (node !== undefined) yield [i as NodeId, node]
		}
	}
}
