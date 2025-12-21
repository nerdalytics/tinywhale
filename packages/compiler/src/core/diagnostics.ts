/**
 * Re-export diagnostic types and compiler definitions from shared package.
 */

// Types and utilities
// Compiler diagnostics
export {
	COMPILER_DIAGNOSTICS,
	type CompilerDiagnosticCode,
	type DiagnosticArgs,
	type DiagnosticDef,
	DiagnosticSeverity,
	interpolateMessage,
	TWCHECK001,
	TWCHECK050,
	TWGEN001,
	TWLEX001,
	TWLEX002,
	TWLEX003,
	TWLEX004,
	TWLEX005,
	TWPARSE001,
} from '@tinywhale/diagnostics'

// Re-export combined catalog for backwards compatibility
import { COMPILER_DIAGNOSTICS } from '@tinywhale/diagnostics'

/**
 * @deprecated Use COMPILER_DIAGNOSTICS or import directly from @tinywhale/diagnostics
 */
export const DIAGNOSTICS = COMPILER_DIAGNOSTICS

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
