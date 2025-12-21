/**
 * CLI diagnostic definitions.
 *
 * Error code format: TWCLI<NUMBER>
 * - TWCLI: CLI errors (001-099)
 */

import { type DiagnosticDef, DiagnosticSeverity } from './types.ts'

// =============================================================================
// CLI ERRORS (TWCLI001-099)
// =============================================================================

export const TWCLI001: DiagnosticDef = {
	code: 'TWCLI001',
	description: "TinyWhale couldn't find a file at this path.",
	message: 'file not found: {path}',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Double-check the path and make sure the file exists.',
}

export const TWCLI002: DiagnosticDef = {
	code: 'TWCLI002',
	description: "The file exists but TinyWhale can't open it.",
	message: 'cannot read file: {reason}',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Check that you have read permission for this file.',
}

export const TWCLI003: DiagnosticDef = {
	code: 'TWCLI003',
	description: "TinyWhale couldn't save the output file.",
	message: 'cannot write file: {reason}',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Check that you have write permission for the output directory.',
}

export const TWCLI004: DiagnosticDef = {
	code: 'TWCLI004',
	description: "TinyWhale doesn't recognize this output format.",
	message: 'unknown target "{target}"',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Use `--target wasm` for binary or `--target wat` for text.',
}

export const TWCLI005: DiagnosticDef = {
	code: 'TWCLI005',
	description: "The compiled WebAssembly didn't pass validation. This shouldn't happen!",
	message: 'generated wasm is invalid',
	severity: DiagnosticSeverity.Error,
	suggestion: 'This is a compiler bug—please report it at github.com/tinywhale/tinywhale/issues.',
}

export const TWCLI006: DiagnosticDef = {
	code: 'TWCLI006',
	description: 'Something unexpected went wrong during compilation.',
	message: 'compilation failed: {reason}',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Check your source file, or report this if it seems like a bug.',
}

// =============================================================================
// CATALOG
// =============================================================================

export const CLI_DIAGNOSTICS = {
	TWCLI001,
	TWCLI002,
	TWCLI003,
	TWCLI004,
	TWCLI005,
	TWCLI006,
} as const

export type CliDiagnosticCode = keyof typeof CLI_DIAGNOSTICS
