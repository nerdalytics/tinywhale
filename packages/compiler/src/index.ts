/**
 * TinyWhale Compiler Public API
 *
 * Data-oriented compiler architecture:
 * - Dense arrays with integer IDs (TokenStore, NodeStore)
 * - Postorder node storage for O(1) child range lookup
 * - Unified CompilationContext flowing through all phases
 */

import { CompilationContext } from './core/context.ts'
import { tokenize } from './lex/tokenizer.ts'
import { parse } from './parse/parser.ts'
import { CompileError, emit } from './codegen/index.ts'

// Core data structures
export {
	CompilationContext,
	type Diagnostic,
	DiagnosticSeverity,
} from './core/context.ts'
export { NodeKind, type NodeId, NodeStore, nodeId, type ParseNode } from './core/nodes.ts'
export { TokenKind, type Token, type TokenId, TokenStore, tokenId } from './core/tokens.ts'

// Tokenization (lexical analysis)
export { tokenize, type TokenizeOptions, type TokenizeResult } from './lex/tokenizer.ts'

// Parsing
export { matchOnly, parse, type ParseResult } from './parse/parser.ts'

// Code generation
export { CompileError, emit, type EmitOptions, type CompileResult } from './codegen/index.ts'

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
		const errors = context.getErrors()
		const message = errors.length > 0 ? errors[0]!.message : 'Tokenization failed'
		throw new CompileError(message)
	}

	// Phase 2: Parsing
	const parseResult = parse(context)
	if (!parseResult.succeeded) {
		const errors = context.getErrors()
		const message = errors.length > 0 ? errors[0]!.message : 'Parse failed'
		throw new CompileError(message)
	}

	// Phase 3: Emission
	return emit(context, { optimize: options.optimize })
}
