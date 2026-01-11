/**
 * Parse node storage using dense arrays with integer IDs.
 * Nodes are stored in postorder - children precede their parent.
 * This enables O(1) child range lookup via subtreeSize.
 */

import type { TokenId } from './tokens.ts'

/** Node kinds - one per grammar production. */
export const NodeKind = {
	BinaryExpr: 104,
	BindingPattern: 202,
	CompareChain: 106,
	DedentLine: 1,
	FloatLiteral: 103,

	// Expressions (100-149)
	Identifier: 100,
	// Line types (0-9)
	IndentedLine: 0,
	IntLiteral: 101,
	LiteralPattern: 201,
	MatchArm: 13,
	MatchExpr: 12,
	OrPattern: 203,

	// Statements (10-99)
	PanicStatement: 10,
	ParenExpr: 105,

	// Program root (255)
	Program: 255,
	RootLine: 2,

	// Type annotations (150-199)
	TypeAnnotation: 150,
	UnaryExpr: 102,
	VariableBinding: 11,

	// Patterns (200-249)
	WildcardPattern: 200,
} as const

export type NodeKind = (typeof NodeKind)[keyof typeof NodeKind]

/** Check if a node kind is an expression (100-149) */
export function isExpressionNode(kind: NodeKind): boolean {
	return kind >= 100 && kind < 150
}

/** Check if a node kind is a statement (10-99) */
export function isStatementNode(kind: NodeKind): boolean {
	return kind >= 10 && kind < 100
}

/** Check if a node kind is a pattern (200-249) */
export function isPatternNode(kind: NodeKind): boolean {
	return kind >= 200 && kind < 250
}

/** Check if a node kind is a terminator (ends control flow) */
export function isTerminator(kind: NodeKind): boolean {
	return kind === NodeKind.PanicStatement
}

/**
 * Branded type for node IDs.
 * Provides type safety while remaining a plain number at runtime.
 */
export type NodeId = number & { readonly __brand: 'NodeId' }

export function nodeId(n: number): NodeId {
	return n as NodeId
}

export function prevNodeId(id: NodeId): NodeId {
	return (id - 1) as NodeId
}

export function offsetNodeId(id: NodeId, offset: number): NodeId {
	return (id + offset) as NodeId
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
			start: offsetNodeId(id, -childCount),
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
		let pos = offsetNodeId(start, count - 1)

		while (pos >= start) {
			const child = this.nodes[pos]
			if (child === undefined) break
			yield [pos, child]
			// Move backwards past this child's subtree to find previous sibling
			pos = offsetNodeId(pos, -child.subtreeSize)
		}
	}

	/**
	 * Iterate over all nodes in a subtree (inclusive of root).
	 * Returns nodes in postorder (natural storage order).
	 */
	*iterateSubtree(id: NodeId): Generator<[NodeId, ParseNode]> {
		const node = this.get(id)
		const start = offsetNodeId(id, -node.subtreeSize + 1)
		for (let i = start; i <= id; i = offsetNodeId(i, 1)) {
			const n = this.nodes[i]
			if (n !== undefined) yield [i, n]
		}
	}

	*[Symbol.iterator](): Generator<[NodeId, ParseNode]> {
		for (let i = 0; i < this.nodes.length; i++) {
			const node = this.nodes[i]
			if (node !== undefined) yield [i as NodeId, node]
		}
	}
}
