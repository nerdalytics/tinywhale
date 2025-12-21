/**
 * @tinywhale/diagnostics
 *
 * Shared diagnostic types and definitions for TinyWhale packages.
 */
export {
	CLI_DIAGNOSTICS,
	type CliDiagnosticCode,
	TWCLI001,
	TWCLI002,
	TWCLI003,
	TWCLI004,
	TWCLI005,
	TWCLI006,
} from './cli.ts'
export {
	COMPILER_DIAGNOSTICS,
	type CompilerDiagnosticCode,
	TWCHECK001,
	TWCHECK050,
	TWGEN001,
	TWLEX001,
	TWLEX002,
	TWLEX003,
	TWLEX004,
	TWLEX005,
	TWPARSE001,
} from './compiler.ts'
export { interpolateMessage } from './interpolate.ts'
export {
	type DiagnosticArgs,
	type DiagnosticDef,
	DiagnosticSeverity,
	type DiagnosticSeverity as DiagnosticSeverityType,
} from './types.ts'
/**
 * All diagnostics from all packages.
 */
export declare const DIAGNOSTICS: {
	readonly TWCLI001: import('./types.ts').DiagnosticDef
	readonly TWCLI002: import('./types.ts').DiagnosticDef
	readonly TWCLI003: import('./types.ts').DiagnosticDef
	readonly TWCLI004: import('./types.ts').DiagnosticDef
	readonly TWCLI005: import('./types.ts').DiagnosticDef
	readonly TWCLI006: import('./types.ts').DiagnosticDef
	readonly TWCHECK001: import('./types.ts').DiagnosticDef
	readonly TWCHECK050: import('./types.ts').DiagnosticDef
	readonly TWGEN001: import('./types.ts').DiagnosticDef
	readonly TWLEX001: import('./types.ts').DiagnosticDef
	readonly TWLEX002: import('./types.ts').DiagnosticDef
	readonly TWLEX003: import('./types.ts').DiagnosticDef
	readonly TWLEX004: import('./types.ts').DiagnosticDef
	readonly TWLEX005: import('./types.ts').DiagnosticDef
	readonly TWPARSE001: import('./types.ts').DiagnosticDef
}
/**
 * All valid diagnostic codes.
 */
export type DiagnosticCode = keyof typeof DIAGNOSTICS
/**
 * Get a diagnostic definition by code.
 */
export declare function getDiagnostic(code: DiagnosticCode): (typeof DIAGNOSTICS)[typeof code]
/**
 * Check if a code is a valid diagnostic code.
 */
export declare function isValidDiagnosticCode(code: string): code is DiagnosticCode
//# sourceMappingURL=index.d.ts.map
