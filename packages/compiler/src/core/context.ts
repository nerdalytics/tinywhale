/**
 * Unified compilation context that flows through all phases.
 * Contains all stores (tokens, nodes, insts) and diagnostic collection.
 */

import type { InstStore, SymbolStore, TypeStore } from '../check/stores.ts'
import {
	type DiagnosticArgs,
	type DiagnosticCode,
	type DiagnosticDef,
	DiagnosticSeverity,
	getDiagnostic,
	interpolateMessage,
} from './diagnostics.ts'
import { type NodeId, NodeStore } from './nodes.ts'
import { type TokenId, TokenStore } from './tokens.ts'

// Re-export for backwards compatibility
export { DiagnosticSeverity } from './diagnostics.ts'

/**
 * A diagnostic message with location information.
 */
export interface Diagnostic {
	/** The diagnostic definition from the catalog */
	readonly def: DiagnosticDef
	/** Interpolated message with arguments applied */
	readonly message: string
	/** Line number (1-indexed) */
	readonly line: number
	/** Column number (1-indexed) */
	readonly column: number
	/** Template arguments used for message interpolation */
	readonly args?: DiagnosticArgs
	/** Token associated with this diagnostic (if available) */
	readonly tokenId?: TokenId
	/** Node associated with this diagnostic (if available) */
	readonly nodeId?: NodeId
	/** Override the default suggestion text */
	readonly suggestionOverride?: string
}

/**
 * Branded type for string IDs.
 * Used for identifier names interned in StringStore.
 */
export type StringId = number & { readonly __brand: 'StringId' }

export function stringId(n: number): StringId {
	return n as StringId
}

/**
 * Dense array storage for interned strings.
 * Used for identifier names - same string always returns same ID.
 */
export class StringStore {
	private readonly strings: string[] = []
	private readonly stringToId: Map<string, StringId> = new Map()

	/** Intern a string, returning its ID. Same string always returns same ID. */
	intern(s: string): StringId {
		const existing = this.stringToId.get(s)
		if (existing !== undefined) return existing

		const id = stringId(this.strings.length)
		this.strings.push(s)
		this.stringToId.set(s, id)
		return id
	}

	get(id: StringId): string {
		const s = this.strings[id]
		if (s === undefined) throw new Error(`Invalid StringId: ${id}`)
		return s
	}

	count(): number {
		return this.strings.length
	}

	isValid(id: StringId): boolean {
		return id >= 0 && id < this.strings.length
	}
}

/**
 * The unified compilation context.
 * Passed through all compilation phases.
 *
 * Design principles:
 * - Append-only: phases add to stores, never mutate previous phase data
 * - Centralized diagnostics: all errors collected in one place
 * - No ownership games: stores are plain arrays with integer IDs
 */
export class CompilationContext {
	/** Original source code */
	readonly source: string

	/** Source filename for error messages */
	readonly filename: string

	/** Interned strings for identifier names (populated by tokenizer) */
	readonly strings: StringStore

	/** Token storage (populated by tokenizer) */
	readonly tokens: TokenStore

	/** Parse node storage (populated by parser) */
	readonly nodes: NodeStore

	/** Instruction storage (populated by checker) */
	insts: InstStore | null = null

	/** Symbol storage for variable bindings (populated by checker) */
	symbols: SymbolStore | null = null

	/** Type storage (populated by checker) */
	types: TypeStore | null = null

	/** Collected diagnostics */
	private readonly diagnostics: Diagnostic[] = []

	/** Track if any errors have been reported */
	private errorCount = 0

	constructor(source: string, filename = '<input>') {
		this.source = source
		this.filename = filename
		this.strings = new StringStore()
		this.tokens = new TokenStore()
		this.nodes = new NodeStore()
	}

	// ===========================================================================
	// NEW API: Emit diagnostics with codes
	// ===========================================================================

	/**
	 * Emit a diagnostic by code at a specific location.
	 */
	emit(code: DiagnosticCode, line: number, column: number, args?: DiagnosticArgs): void {
		const def = getDiagnostic(code)
		const message = interpolateMessage(def.message, args)
		this.addDiagnosticInternal({
			column,
			def,
			line,
			message,
			...(args ? { args } : {}),
		})
	}

	/**
	 * Emit a diagnostic by code at a token's location.
	 */
	emitAtToken(code: DiagnosticCode, tokenId: TokenId, args?: DiagnosticArgs): void {
		const token = this.tokens.get(tokenId)
		const def = getDiagnostic(code)
		const message = interpolateMessage(def.message, args)
		this.addDiagnosticInternal({
			column: token.column,
			def,
			line: token.line,
			message,
			tokenId,
			...(args ? { args } : {}),
		})
	}

	/**
	 * Emit a diagnostic by code at a node's location.
	 */
	emitAtNode(code: DiagnosticCode, nodeId: NodeId, args?: DiagnosticArgs): void {
		const node = this.nodes.get(nodeId)
		const token = this.tokens.get(node.tokenId)
		const def = getDiagnostic(code)
		const message = interpolateMessage(def.message, args)
		this.addDiagnosticInternal({
			column: token.column,
			def,
			line: token.line,
			message,
			nodeId,
			tokenId: node.tokenId,
			...(args ? { args } : {}),
		})
	}

	/**
	 * Emit a diagnostic at a node's location with a custom suggestion override.
	 */
	emitAtNodeWithSuggestion(
		code: DiagnosticCode,
		nodeId: NodeId,
		suggestionOverride: string,
		args?: DiagnosticArgs
	): void {
		const node = this.nodes.get(nodeId)
		const token = this.tokens.get(node.tokenId)
		const def = getDiagnostic(code)
		const message = interpolateMessage(def.message, args)
		this.addDiagnosticInternal({
			column: token.column,
			def,
			line: token.line,
			message,
			nodeId,
			suggestionOverride,
			tokenId: node.tokenId,
			...(args ? { args } : {}),
		})
	}

	// ===========================================================================
	// LEGACY API: Kept for backwards compatibility (will be removed)
	// ===========================================================================

	/** @deprecated */
	addDiagnostic(
		diagnostic: Omit<Diagnostic, 'def' | 'args'> & { severity: DiagnosticSeverity }
	): void {
		// Create a synthetic def for legacy calls
		const syntheticDef: DiagnosticDef = {
			code: 'LEGACY',
			description: '',
			message: diagnostic.message,
			severity: diagnostic.severity,
		}
		this.addDiagnosticInternal({
			column: diagnostic.column,
			def: syntheticDef,
			line: diagnostic.line,
			message: diagnostic.message,
			...(diagnostic.nodeId !== undefined ? { nodeId: diagnostic.nodeId } : {}),
			...(diagnostic.tokenId !== undefined ? { tokenId: diagnostic.tokenId } : {}),
		})
	}

	/** @deprecated */
	addError(line: number, column: number, message: string): void {
		const syntheticDef: DiagnosticDef = {
			code: 'LEGACY',
			description: '',
			message,
			severity: DiagnosticSeverity.Error,
		}
		this.addDiagnosticInternal({
			column,
			def: syntheticDef,
			line,
			message,
		})
	}

	/** @deprecated */
	errorAtToken(tokenId: TokenId, message: string): void {
		const token = this.tokens.get(tokenId)
		const syntheticDef: DiagnosticDef = {
			code: 'LEGACY',
			description: '',
			message,
			severity: DiagnosticSeverity.Error,
		}
		this.addDiagnosticInternal({
			column: token.column,
			def: syntheticDef,
			line: token.line,
			message,
			tokenId,
		})
	}

	/** @deprecated */
	errorAtNode(nodeId: NodeId, message: string): void {
		const node = this.nodes.get(nodeId)
		const token = this.tokens.get(node.tokenId)
		const syntheticDef: DiagnosticDef = {
			code: 'LEGACY',
			description: '',
			message,
			severity: DiagnosticSeverity.Error,
		}
		this.addDiagnosticInternal({
			column: token.column,
			def: syntheticDef,
			line: token.line,
			message,
			nodeId,
			tokenId: node.tokenId,
		})
	}

	/** @deprecated */
	addWarning(line: number, column: number, message: string): void {
		const syntheticDef: DiagnosticDef = {
			code: 'LEGACY',
			description: '',
			message,
			severity: DiagnosticSeverity.Warning,
		}
		this.addDiagnosticInternal({
			column,
			def: syntheticDef,
			line,
			message,
		})
	}

	/** @deprecated */
	warningAtNode(nodeId: NodeId, message: string): void {
		const node = this.nodes.get(nodeId)
		const token = this.tokens.get(node.tokenId)
		const syntheticDef: DiagnosticDef = {
			code: 'LEGACY',
			description: '',
			message,
			severity: DiagnosticSeverity.Warning,
		}
		this.addDiagnosticInternal({
			column: token.column,
			def: syntheticDef,
			line: token.line,
			message,
			nodeId,
			tokenId: node.tokenId,
		})
	}

	// ===========================================================================
	// INTERNAL
	// ===========================================================================

	private addDiagnosticInternal(diagnostic: Diagnostic): void {
		this.diagnostics.push(diagnostic)
		if (diagnostic.def.severity === DiagnosticSeverity.Error) {
			this.errorCount++
		}
	}

	// ===========================================================================
	// QUERY METHODS
	// ===========================================================================

	hasErrors(): boolean {
		return this.errorCount > 0
	}

	getErrorCount(): number {
		return this.errorCount
	}

	getDiagnostics(): readonly Diagnostic[] {
		return this.diagnostics
	}

	getErrors(): Diagnostic[] {
		return this.diagnostics.filter((d) => d.def.severity === DiagnosticSeverity.Error)
	}

	getSourceLine(line: number): string | undefined {
		const lines = this.source.split('\n')
		return lines[line - 1]
	}

	// ===========================================================================
	// FORMATTING
	// ===========================================================================

	private getSeverityLabel(severity: DiagnosticSeverity): string {
		const labels: Record<DiagnosticSeverity, string> = {
			[DiagnosticSeverity.Error]: 'error',
			[DiagnosticSeverity.Warning]: 'warning',
			[DiagnosticSeverity.Note]: 'note',
		}
		return labels[severity]
	}

	private buildSourceContext(
		diagnostic: Diagnostic,
		sourceLine: string
	): { emptyPrefix: string; lines: string[] } {
		const lineNumWidth = String(diagnostic.line).length
		const pad = ' '.repeat(lineNumWidth)
		const linePrefix = ` ${diagnostic.line} | `
		const emptyPrefix = ` ${pad} | `
		const pointer = `${' '.repeat(diagnostic.column - 1)}^`

		return {
			emptyPrefix,
			lines: [emptyPrefix, `${linePrefix}${sourceLine}`, `${emptyPrefix}${pointer}`],
		}
	}

	/**
	 * Format a diagnostic for display (Rust-style output).
	 *
	 * Example:
	 * ```
	 * error[TWCHECK001]: unexpected indentation
	 *   --> examples/test.tw:4:2
	 *    |
	 *  4 |     panic
	 *    |     ^^^^^
	 *    |
	 *    = help: remove the indentation or define a function/struct to create a scope
	 * ```
	 */
	formatDiagnostic(diagnostic: Diagnostic): string {
		const { def } = diagnostic
		const severityLabel = this.getSeverityLabel(def.severity)
		const codeDisplay = def.code !== 'LEGACY' ? `[${def.code}]` : ''
		const header = `${severityLabel}${codeDisplay}: ${diagnostic.message}`
		const location = `  --> ${this.filename}:${diagnostic.line}:${diagnostic.column}`

		const sourceLine = this.getSourceLine(diagnostic.line)
		if (sourceLine === undefined) {
			return `${header}\n${location}`
		}

		const { emptyPrefix, lines: contextLines } = this.buildSourceContext(diagnostic, sourceLine)
		const lines = [header, location, ...contextLines]

		const suggestionText = diagnostic.suggestionOverride ?? def.suggestion
		if (suggestionText) {
			const suggestion = interpolateMessage(suggestionText, diagnostic.args)
			lines.push(emptyPrefix, `   = help: ${suggestion}`)
		}

		return lines.join('\n')
	}

	formatAllDiagnostics(): string {
		return this.diagnostics.map((d) => this.formatDiagnostic(d)).join('\n\n')
	}
}
