/**
 * Core data structures for the TinyWhale compiler.
 * Carbon-style data-oriented design with dense arrays and integer IDs.
 */

export {
	CompilationContext,
	type Diagnostic,
} from './context.ts'
export {
	DIAGNOSTICS,
	type DiagnosticArgs,
	type DiagnosticCode,
	type DiagnosticDef,
	DiagnosticSeverity,
	getDiagnostic,
	interpolateMessage,
	isValidDiagnosticCode,
} from './diagnostics.ts'
export {
	type NodeId,
	type NodeIdRange,
	NodeKind,
	NodeStore,
	nodeId,
	type ParseNode,
} from './nodes.ts'
export { type Token, type TokenId, TokenKind, TokenStore, tokenId } from './tokens.ts'
