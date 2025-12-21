/**
 * Diagnostic severity levels.
 */
export declare const DiagnosticSeverity: {
	readonly Error: 0
	readonly Note: 2
	readonly Warning: 1
}
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
//# sourceMappingURL=types.d.ts.map
