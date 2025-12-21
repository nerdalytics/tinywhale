/**
 * CLI diagnostic definitions.
 *
 * Error code format: TWCLI<NUMBER>
 * - TWCLI: CLI errors (001-099)
 */
import { type DiagnosticDef } from './types.ts'
export declare const TWCLI001: DiagnosticDef
export declare const TWCLI002: DiagnosticDef
export declare const TWCLI003: DiagnosticDef
export declare const TWCLI004: DiagnosticDef
export declare const TWCLI005: DiagnosticDef
export declare const TWCLI006: DiagnosticDef
/**
 * Central catalog of all CLI diagnostics.
 */
export declare const CLI_DIAGNOSTICS: {
	readonly TWCLI001: DiagnosticDef
	readonly TWCLI002: DiagnosticDef
	readonly TWCLI003: DiagnosticDef
	readonly TWCLI004: DiagnosticDef
	readonly TWCLI005: DiagnosticDef
	readonly TWCLI006: DiagnosticDef
}
/**
 * All valid CLI diagnostic codes.
 */
export type CliDiagnosticCode = keyof typeof CLI_DIAGNOSTICS
//# sourceMappingURL=cli.d.ts.map
