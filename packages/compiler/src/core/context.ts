/**
 * Unified compilation context that flows through all phases.
 * Contains all stores (tokens, nodes) and diagnostic collection.
 */

import { type NodeId, NodeStore } from './nodes.ts'
import { type TokenId, TokenStore } from './tokens.ts'

/**
 * Diagnostic severity levels.
 */
export const DiagnosticSeverity = {
	Error: 0,
	Note: 2,
	Warning: 1,
} as const

export type DiagnosticSeverity = (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity]

/**
 * A diagnostic message with location information.
 */
export interface Diagnostic {
	readonly severity: DiagnosticSeverity
	readonly message: string
	readonly line: number
	readonly column: number
	/** Token associated with this diagnostic (if available) */
	readonly tokenId?: TokenId
	/** Node associated with this diagnostic (if available) */
	readonly nodeId?: NodeId
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

	/** Token storage (populated by tokenizer) */
	readonly tokens: TokenStore

	/** Parse node storage (populated by parser) */
	readonly nodes: NodeStore

	/** Collected diagnostics */
	private readonly diagnostics: Diagnostic[] = []

	/** Track if any errors have been reported */
	private errorCount = 0

	constructor(source: string, filename = '<input>') {
		this.source = source
		this.filename = filename
		this.tokens = new TokenStore()
		this.nodes = new NodeStore()
	}

	/**
	 * Add a diagnostic.
	 */
	addDiagnostic(diagnostic: Diagnostic): void {
		this.diagnostics.push(diagnostic)
		if (diagnostic.severity === DiagnosticSeverity.Error) {
			this.errorCount++
		}
	}

	/**
	 * Add an error at a specific location.
	 */
	addError(line: number, column: number, message: string): void {
		this.addDiagnostic({
			column,
			line,
			message,
			severity: DiagnosticSeverity.Error,
		})
	}

	/**
	 * Add an error at a token's location.
	 */
	errorAtToken(tokenId: TokenId, message: string): void {
		const token = this.tokens.get(tokenId)
		this.addDiagnostic({
			column: token.column,
			line: token.line,
			message,
			severity: DiagnosticSeverity.Error,
			tokenId,
		})
	}

	/**
	 * Add an error at a node's location.
	 */
	errorAtNode(nodeId: NodeId, message: string): void {
		const node = this.nodes.get(nodeId)
		const token = this.tokens.get(node.tokenId)
		this.addDiagnostic({
			column: token.column,
			line: token.line,
			message,
			nodeId,
			severity: DiagnosticSeverity.Error,
			tokenId: node.tokenId,
		})
	}

	/**
	 * Add a warning at a specific location.
	 */
	addWarning(line: number, column: number, message: string): void {
		this.addDiagnostic({
			column,
			line,
			message,
			severity: DiagnosticSeverity.Warning,
		})
	}

	/**
	 * Check if any errors have been reported.
	 */
	hasErrors(): boolean {
		return this.errorCount > 0
	}

	/**
	 * Get the number of errors.
	 */
	getErrorCount(): number {
		return this.errorCount
	}

	/**
	 * Get all collected diagnostics.
	 */
	getDiagnostics(): readonly Diagnostic[] {
		return this.diagnostics
	}

	/**
	 * Get only error diagnostics.
	 */
	getErrors(): Diagnostic[] {
		return this.diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error)
	}

	/**
	 * Get a source line by line number (1-indexed).
	 * Useful for error context display.
	 */
	getSourceLine(line: number): string | undefined {
		const lines = this.source.split('\n')
		return lines[line - 1]
	}

	/**
	 * Format a diagnostic for display.
	 */
	formatDiagnostic(diagnostic: Diagnostic): string {
		const severityLabel =
			diagnostic.severity === DiagnosticSeverity.Error
				? 'error'
				: diagnostic.severity === DiagnosticSeverity.Warning
					? 'warning'
					: 'note'

		const location = `${this.filename}:${diagnostic.line}:${diagnostic.column}`
		const header = `${location}: ${severityLabel}: ${diagnostic.message}`

		const sourceLine = this.getSourceLine(diagnostic.line)
		if (sourceLine === undefined) {
			return header
		}

		// Build pointer line
		const pointer = `${' '.repeat(diagnostic.column - 1)}^`

		return `${header}\n  ${sourceLine}\n  ${pointer}`
	}

	/**
	 * Format all diagnostics for display.
	 */
	formatAllDiagnostics(): string {
		return this.diagnostics.map((d) => this.formatDiagnostic(d)).join('\n\n')
	}
}
