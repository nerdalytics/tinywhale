/**
 * Core data structures for the TinyWhale compiler.
 * Carbon-style data-oriented design with dense arrays and integer IDs.
 */

// Compilation context and diagnostics
export {
	CompilationContext,
	type Diagnostic,
	DiagnosticSeverity,
} from './context.ts'

// Node types and storage
export {
	type NodeId,
	type NodeIdRange,
	NodeKind,
	NodeStore,
	nodeId,
	type ParseNode,
} from './nodes.ts'
// Token types and storage
export { type Token, type TokenId, TokenKind, TokenStore, tokenId } from './tokens.ts'
