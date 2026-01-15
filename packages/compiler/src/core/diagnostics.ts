/**
 * Re-export diagnostic types and compiler definitions from shared package.
 */

import { COMPILER_DIAGNOSTICS } from '@tinywhale/diagnostics'

export {
	COMPILER_DIAGNOSTICS,
	type CompilerDiagnosticCode,
	type DiagnosticArgs,
	type DiagnosticDef,
	DiagnosticSeverity,
	interpolateMessage,
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
	TWCHECK050,
	TWGEN001,
	TWLEX001,
	TWLEX002,
	TWLEX003,
	TWLEX004,
	TWLEX005,
	TWPARSE001,
} from '@tinywhale/diagnostics'

/**
 * All valid diagnostic codes for the compiler.
 */
export type DiagnosticCode = keyof typeof COMPILER_DIAGNOSTICS

/**
 * Get a diagnostic definition by code.
 */
export function getDiagnostic(code: DiagnosticCode): (typeof COMPILER_DIAGNOSTICS)[typeof code] {
	return COMPILER_DIAGNOSTICS[code]
}

/**
 * Check if a code is a valid diagnostic code.
 */
export function isValidDiagnosticCode(code: string): code is DiagnosticCode {
	return code in COMPILER_DIAGNOSTICS
}
