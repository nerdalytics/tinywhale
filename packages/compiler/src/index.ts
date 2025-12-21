/**
 * TinyWhale Compiler Public API
 *
 * Data-oriented compiler architecture:
 * - Dense arrays with integer IDs (TokenStore, NodeStore)
 * - Postorder node storage for O(1) child range lookup
 * - Unified CompilationContext flowing through all phases
 */

import { check } from './check/checker.ts'
import { CompileError, emit } from './codegen/index.ts'
import { CompilationContext } from './core/context.ts'
import { tokenize } from './lex/tokenizer.ts'
import { parse } from './parse/parser.ts'

export {
	type CheckResult,
	check,
	type Inst,
	type InstId,
	InstKind,
	InstStore,
	instId,
	type Scope,
	type ScopeId,
	ScopeStore,
	scopeId,
	type TypeId,
	typeId,
} from './check/index.ts'
export {
	CompileError,
	type CompileResult,
	type CompileWarning,
	type EmitOptions,
	emit,
} from './codegen/index.ts'
// CompileOptions is exported from the compile function definition below
export {
	CompilationContext,
	type Diagnostic,
	DiagnosticSeverity,
} from './core/context.ts'
export { type NodeId, NodeKind, NodeStore, nodeId, type ParseNode } from './core/nodes.ts'
export { type Token, type TokenId, TokenKind, TokenStore, tokenId } from './core/tokens.ts'
export { type TokenizeOptions, type TokenizeResult, tokenize } from './lex/tokenizer.ts'
export { matchOnly, type ParseResult, parse } from './parse/parser.ts'

/**
 * Options for the compile function.
 */
export interface CompileOptions {
	/** Path to the source file (for error messages) */
	filename?: string
	/** Run optimization passes on the output */
	optimize?: boolean
}

/**
 * Get the formatted error message from the first diagnostic.
 */
function getFormattedError(context: CompilationContext, fallback: string): string {
	const error = context.getErrors()[0]
	if (!error) return fallback
	return context.formatDiagnostic(error)
}

/**
 * Run the emission phase with proper error formatting.
 */
function runEmitPhase(
	context: CompilationContext,
	optimize: boolean
): import('./codegen/index.ts').CompileResult {
	try {
		return emit(context, { optimize })
	} catch {
		if (context.hasErrors()) {
			throw new CompileError(getFormattedError(context, 'Emission failed'))
		}
		throw new CompileError('Emission failed')
	}
}

/**
 * Compile TinyWhale source to WebAssembly.
 *
 * This is the main entry point for compilation. It chains all phases:
 * 1. Tokenization (source → tokens)
 * 2. Parsing (tokens → AST nodes)
 * 3. Checking (semantic analysis, scope validation, reachability)
 * 4. Emission (nodes → WebAssembly)
 *
 * @param source - TinyWhale source code
 * @param options - Compilation options
 * @returns Compilation result with binary, text, and validation status
 * @throws {CompileError} If compilation fails
 */
export function compile(
	source: string,
	options: CompileOptions = {}
): import('./codegen/index.ts').CompileResult {
	const context = new CompilationContext(source, options.filename)

	// Phase 1: Tokenization
	const tokenResult = tokenize(context)
	if (!tokenResult.succeeded) {
		throw new CompileError(getFormattedError(context, 'Tokenization failed'))
	}

	// Phase 2: Parsing
	const parseResult = parse(context)
	if (!parseResult.succeeded) {
		throw new CompileError(getFormattedError(context, 'Parse failed'))
	}

	// Phase 3: Checking (semantic analysis)
	const checkResult = check(context)
	if (!checkResult.succeeded) {
		throw new CompileError(getFormattedError(context, 'Check failed'))
	}

	// Phase 4: Emission
	return runEmitPhase(context, options.optimize ?? false)
}
