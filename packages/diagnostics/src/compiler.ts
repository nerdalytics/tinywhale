/**
 * Compiler diagnostic definitions.
 *
 * Error code format: TW<PHASE><NUMBER>
 * - TWLEX: Lexer errors (001-099)
 * - TWPARSE: Parser errors (001-099)
 * - TWCHECK: Checker errors (001-049), warnings (050-099)
 * - TWGEN: Codegen errors (001-099)
 */

import { type DiagnosticDef, DiagnosticSeverity } from './types.ts'

// =============================================================================
// LEXER ERRORS (TWLEX001-099)
// =============================================================================

export const TWLEX001: DiagnosticDef = {
	code: 'TWLEX001',
	description:
		"You're mixing tabs and spaces for indentation. TinyWhale needs one or the other to understand your code structure.",
	message: 'mixed tabs and spaces',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Pick either tabs or spaces and stick with it for the whole file.',
}

export const TWLEX002: DiagnosticDef = {
	code: 'TWLEX002',
	description:
		'Your first indent used {unit} spaces, so TinyWhale expects all indents to be multiples of {unit}.',
	message: 'unexpected indent size: expected {unit} spaces, found {found}',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Indent with {unit} spaces to match the rest of your file.',
}

export const TWLEX003: DiagnosticDef = {
	code: 'TWLEX003',
	description: "When you unindent, you need to go back to a column you've used before.",
	message: "unindent doesn't match any previous level",
	severity: DiagnosticSeverity.Error,
	suggestion: 'Try unindenting to column {validLevels}.',
}

export const TWLEX004: DiagnosticDef = {
	code: 'TWLEX004',
	description: 'You can only indent one level at a time. Going deeper requires nested blocks.',
	message: 'indented too far: jumped {found} levels instead of 1',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Indent just one level ({expected} {unit}) at a time.',
}

export const TWLEX005: DiagnosticDef = {
	code: 'TWLEX005',
	description:
		'This file started with {expected}, so TinyWhale expects you to keep using {expected} throughout.',
	message: 'expected {expected}, found {found}',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Use {expected} here to match the rest of your file.',
}

// =============================================================================
// PARSER ERRORS (TWPARSE001-099)
// =============================================================================

export const TWPARSE001: DiagnosticDef = {
	code: 'TWPARSE001',
	description: "TinyWhale couldn't understand this part of your code.",
	message: 'syntax error: {detail}',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Double-check for typos or missing keywords.',
}

// =============================================================================
// CHECKER ERRORS (TWCHECK001-049)
// =============================================================================

export const TWCHECK001: DiagnosticDef = {
	code: 'TWCHECK001',
	description:
		'Indented code needs to be inside something like a function. Right now, TinyWhale only supports top-level statements.',
	message: 'unexpected indentation',
	severity: DiagnosticSeverity.Error,
	suggestion:
		'Remove the indentation, or wrap this code in a function when that feature is available.',
}

// =============================================================================
// CHECKER WARNINGS (TWCHECK050-099)
// =============================================================================

export const TWCHECK050: DiagnosticDef = {
	code: 'TWCHECK050',
	description:
		'This code will never run because something above it (like `panic`) always exits first.',
	message: 'unreachable code',
	severity: DiagnosticSeverity.Warning,
	suggestion: 'You can safely remove this code, or move it before the exit point.',
}

// =============================================================================
// CODEGEN ERRORS (TWGEN001-099)
// =============================================================================

export const TWGEN001: DiagnosticDef = {
	code: 'TWGEN001',
	description: "Your file doesn't have any code to run.",
	message: 'empty program',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Add at least one statement, like `panic`, to get started.',
}

// =============================================================================
// CATALOG
// =============================================================================

/**
 * Central catalog of all compiler diagnostics.
 */
export const COMPILER_DIAGNOSTICS = {
	// Checker errors
	TWCHECK001,
	// Checker warnings
	TWCHECK050,
	// Codegen errors
	TWGEN001,
	// Lexer errors
	TWLEX001,
	TWLEX002,
	TWLEX003,
	TWLEX004,
	TWLEX005,
	// Parser errors
	TWPARSE001,
} as const

/**
 * All valid compiler diagnostic codes.
 */
export type CompilerDiagnosticCode = keyof typeof COMPILER_DIAGNOSTICS
