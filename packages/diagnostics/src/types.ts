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
 * Diagnostic definition in the catalog.
 */
export interface DiagnosticDef {
	readonly code: string
	readonly severity: DiagnosticSeverity
	readonly message: string
	readonly description: string
	readonly suggestion?: string
}

/**
 * Template arguments for diagnostic messages.
 */
export type DiagnosticArgs = Record<string, string | number>
