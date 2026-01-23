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
	TWCHECK010,
	TWCHECK012,
	TWCHECK013,
	TWCHECK014,
	TWCHECK015,
	TWCHECK016,
	TWCHECK017,
	TWCHECK018,
	TWCHECK019,
	TWCHECK020,
	TWCHECK021,
	TWCHECK022,
	TWCHECK023,
	TWCHECK024,
	TWCHECK025,
	TWCHECK026,
	TWCHECK027,
	TWCHECK028,
	TWCHECK029,
	TWCHECK030,
	TWCHECK031,
	TWCHECK032,
	TWCHECK033,
	TWCHECK038,
	TWCHECK050,
	TWCHECK051,
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

export const DIAGNOSTICS = {
	...COMPILER_DIAGNOSTICS,
	...CLI_DIAGNOSTICS,
} as const

export type DiagnosticCode = keyof typeof DIAGNOSTICS

/** Retrieves diagnostic definition by code. Returns undefined for invalid codes. */
export function getDiagnostic(code: DiagnosticCode): (typeof DIAGNOSTICS)[typeof code] {
	return DIAGNOSTICS[code]
}

/** Type guard for validating diagnostic codes at runtime. */
export function isValidDiagnosticCode(code: string): code is DiagnosticCode {
	return code in DIAGNOSTICS
}
