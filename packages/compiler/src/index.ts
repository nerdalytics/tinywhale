/**
 * TinyWhale Compiler Public API
 *
 * Data-oriented compiler architecture:
 * - Dense arrays with integer IDs (TokenStore, NodeStore)
 * - Postorder node storage for O(1) child range lookup
 * - Unified CompilationContext flowing through all phases
 */

import { CompileError, emit } from './codegen/index.ts'
import { CompilationContext } from './core/context.ts'
import { tokenize } from './lex/tokenizer.ts'
import { parse } from './parse/parser.ts'

// Code generation
export { CompileError, type CompileResult, type EmitOptions, emit } from './codegen/index.ts'
// Core data structures
export {
	CompilationContext,
	type Diagnostic,
	DiagnosticSeverity,
} from './core/context.ts'
export { type NodeId, NodeKind, NodeStore, nodeId, type ParseNode } from './core/nodes.ts'
export { type Token, type TokenId, TokenKind, TokenStore, tokenId } from './core/tokens.ts'
// Tokenization (lexical analysis)
export { type TokenizeOptions, type TokenizeResult, tokenize } from './lex/tokenizer.ts'
// Parsing
export { matchOnly, type ParseResult, parse } from './parse/parser.ts'

/**
 * Get the first error message from context or return a fallback.
 */
function getFirstErrorMessage(context: CompilationContext, fallback: string): string {
	return context.getErrors()[0]?.message ?? fallback
}

/**
 * Compile TinyWhale source to WebAssembly.
 *
 * This is the main entry point for compilation. It chains all phases:
 * 1. Tokenization (source → tokens)
 * 2. Parsing (tokens → AST nodes)
 * 3. Emission (nodes → WebAssembly)
 *
 * @param source - TinyWhale source code
 * @param options - Compilation options
 * @returns Compilation result with binary, text, and validation status
 * @throws {CompileError} If compilation fails
 */
export function compile(
	source: string,
	options: { optimize?: boolean } = {}
): import('./codegen/index.ts').CompileResult {
	const context = new CompilationContext(source)

	// Phase 1: Tokenization
	const tokenResult = tokenize(context)
	if (!tokenResult.succeeded) {
		throw new CompileError(getFirstErrorMessage(context, 'Tokenization failed'))
	}

	// Phase 2: Parsing
	const parseResult = parse(context)
	if (!parseResult.succeeded) {
		throw new CompileError(getFirstErrorMessage(context, 'Parse failed'))
	}

	// Phase 3: Emission
	return emit(context, { optimize: options.optimize ?? false })
}
