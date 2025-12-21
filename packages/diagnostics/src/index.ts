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

import { CLI_DIAGNOSTICS } from './cli.ts'
import { COMPILER_DIAGNOSTICS } from './compiler.ts'

/**
 * All diagnostics from all packages.
 */
export const DIAGNOSTICS = {
	...COMPILER_DIAGNOSTICS,
	...CLI_DIAGNOSTICS,
} as const

/**
 * All valid diagnostic codes.
 */
export type DiagnosticCode = keyof typeof DIAGNOSTICS

/**
 * Get a diagnostic definition by code.
 */
export function getDiagnostic(code: DiagnosticCode): (typeof DIAGNOSTICS)[typeof code] {
	return DIAGNOSTICS[code]
}

/**
 * Check if a code is a valid diagnostic code.
 */
export function isValidDiagnosticCode(code: string): code is DiagnosticCode {
	return code in DIAGNOSTICS
}
