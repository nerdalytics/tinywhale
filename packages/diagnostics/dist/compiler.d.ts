/**
 * Compiler diagnostic definitions.
 *
 * Error code format: TW<PHASE><NUMBER>
 * - TWLEX: Lexer errors (001-099)
 * - TWPARSE: Parser errors (001-099)
 * - TWCHECK: Checker errors (001-049), warnings (050-099)
 * - TWGEN: Codegen errors (001-099)
 */
import { type DiagnosticDef } from './types.ts'
export declare const TWLEX001: DiagnosticDef
export declare const TWLEX002: DiagnosticDef
export declare const TWLEX003: DiagnosticDef
export declare const TWLEX004: DiagnosticDef
export declare const TWLEX005: DiagnosticDef
export declare const TWPARSE001: DiagnosticDef
export declare const TWCHECK001: DiagnosticDef
export declare const TWCHECK050: DiagnosticDef
export declare const TWGEN001: DiagnosticDef
/**
 * Central catalog of all compiler diagnostics.
 */
export declare const COMPILER_DIAGNOSTICS: {
	readonly TWCHECK001: DiagnosticDef
	readonly TWCHECK050: DiagnosticDef
	readonly TWGEN001: DiagnosticDef
	readonly TWLEX001: DiagnosticDef
	readonly TWLEX002: DiagnosticDef
	readonly TWLEX003: DiagnosticDef
	readonly TWLEX004: DiagnosticDef
	readonly TWLEX005: DiagnosticDef
	readonly TWPARSE001: DiagnosticDef
}
/**
 * All valid compiler diagnostic codes.
 */
export type CompilerDiagnosticCode = keyof typeof COMPILER_DIAGNOSTICS
//# sourceMappingURL=compiler.d.ts.map
