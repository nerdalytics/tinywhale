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

export const TWCHECK010: DiagnosticDef = {
	code: 'TWCHECK010',
	description: 'The type name is not recognized.',
	message: 'unknown type `{found}`',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Valid types are: i32, i64, f32, f64',
}

export const TWCHECK012: DiagnosticDef = {
	code: 'TWCHECK012',
	description: 'The expression type does not match the declared type.',
	message: 'type mismatch: expected `{expected}`, found `{found}`',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Change the expression to produce a value of type `{expected}`.',
}

export const TWCHECK013: DiagnosticDef = {
	code: 'TWCHECK013',
	description: 'This variable has not been declared.',
	message: 'undefined variable `{name}`',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Declare the variable before using it.',
}

export const TWCHECK014: DiagnosticDef = {
	code: 'TWCHECK014',
	description: 'The integer literal value is too large for the declared type.',
	message: 'integer literal `{value}` exceeds `{type}` bounds',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Use a smaller value or a larger type.',
}

export const TWCHECK015: DiagnosticDef = {
	code: 'TWCHECK015',
	description:
		'Negating a variable or expression is not yet supported. Only literal values can be negated.',
	message: 'non-literal negation not yet supported',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Use a negated literal value directly, like `-42`.',
}

export const TWCHECK016: DiagnosticDef = {
	code: 'TWCHECK016',
	description: 'A float literal cannot be assigned to an integer type.',
	message: 'type mismatch: expected `{expected}`, found `{found}`',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Use an integer literal, or change the type annotation to f32 or f64.',
}

export const TWCHECK017: DiagnosticDef = {
	code: 'TWCHECK017',
	description: 'The float literal value is too large for the declared type.',
	message: 'float literal `{value}` exceeds `{type}` bounds',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Use a smaller value or change the type to f64.',
}

export const TWCHECK018: DiagnosticDef = {
	code: 'TWCHECK018',
	description: 'Integer literal patterns can only match integer types (i32, i64).',
	message: 'pattern type mismatch: `{patternType}` pattern cannot match `{scrutineeType}`',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Use a wildcard pattern `_` or binding pattern for non-integer scrutinees.',
}

export const TWCHECK019: DiagnosticDef = {
	code: 'TWCHECK019',
	description: 'A match arm was found outside of a match expression.',
	message: 'match arm outside match expression',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Match arms must be indented under a `match` expression.',
}

export const TWCHECK020: DiagnosticDef = {
	code: 'TWCHECK020',
	description: 'Match expression must have a catch-all pattern as the last arm.',
	message: 'non-exhaustive match: missing catch-all pattern',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Add a wildcard pattern `_` or binding pattern as the last arm.',
}

export const TWCHECK021: DiagnosticDef = {
	code: 'TWCHECK021',
	description:
		'This operator only works with integer types (i32, i64), but got a floating-point type.',
	message: 'integer-only operator `{op}` used with `{type}`',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Use an integer type or a different operator.',
}

export const TWCHECK022: DiagnosticDef = {
	code: 'TWCHECK022',
	description: 'Binary operators require both operands to have the same type.',
	message: 'operand type mismatch: `{left}` vs `{right}`',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Ensure both operands have the same type.',
}

export const TWCHECK023: DiagnosticDef = {
	code: 'TWCHECK023',
	description: 'Adjacent != operators in a comparison chain are ambiguous.',
	message: 'adjacent != operators in comparison chain',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Break this into separate comparisons joined with &&.',
}

export const TWCHECK024: DiagnosticDef = {
	code: 'TWCHECK024',
	description: 'Logical operators require integer operands (i32 or i64).',
	message: 'logical operator `{op}` used with `{type}`',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Convert to an integer type before using logical operators.',
}

export const TWCHECK025: DiagnosticDef = {
	code: 'TWCHECK025',
	description: 'Division by zero is undefined behavior.',
	message: 'division by zero',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Use a non-zero divisor.',
}

export const TWCHECK026: DiagnosticDef = {
	code: 'TWCHECK026',
	description: 'A record type cannot have two fields with the same name.',
	message: 'duplicate field `{name}` in type `{typeName}`',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Rename one of the fields to have a unique name.',
}

export const TWCHECK027: DiagnosticDef = {
	code: 'TWCHECK027',
	description: 'A required field is missing from the record initializer.',
	message: 'missing field `{name}` in record `{typeName}`',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Add the missing field to the initializer.',
}

export const TWCHECK028: DiagnosticDef = {
	code: 'TWCHECK028',
	description: 'The field does not exist on the record type.',
	message: 'unknown field `{name}` in record `{typeName}`',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Check the type definition for valid field names.',
}

export const TWCHECK029: DiagnosticDef = {
	code: 'TWCHECK029',
	description: 'A field cannot be initialized more than once in a record literal.',
	message: 'duplicate field `{name}` in record initializer',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Remove the duplicate field initialization.',
}

export const TWCHECK030: DiagnosticDef = {
	code: 'TWCHECK030',
	description: 'The field does not exist on the record type being accessed.',
	message: 'unknown field `{name}` in type `{typeName}`',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Check the type definition for valid field names.',
}

export const TWCHECK031: DiagnosticDef = {
	code: 'TWCHECK031',
	description: 'Field access requires a record type, but got a primitive type.',
	message: 'cannot access field `{name}` on non-record type `{typeName}`',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Only record types have fields. Use a record type or remove the field access.',
}

export const TWCHECK032: DiagnosticDef = {
	code: 'TWCHECK032',
	description: 'A record type cannot contain itself directly or indirectly.',
	message: 'recursive type: field `{field}` creates cycle via `{type}`',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Consider using a different data structure.',
}

export const TWCHECK033: DiagnosticDef = {
	code: 'TWCHECK033',
	description: 'Nested record initializer type must match field declaration.',
	message: 'type mismatch: field expects `{expected}`, got `{got}`',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Use the correct type name that matches the field declaration.',
}

export const TWCHECK034: DiagnosticDef = {
	code: 'TWCHECK034',
	description: 'The constant index exceeds the declared size of the list.',
	message: 'index out of bounds: index {index} >= size {size}',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Use an index between 0 and {maxIndex}.',
}

export const TWCHECK035: DiagnosticDef = {
	code: 'TWCHECK035',
	description:
		'Variable indices cannot be statically verified to be within bounds without additional proof.',
	message: 'cannot prove index bounds for variable access',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Use a constant index or add bounds checking.',
}

export const TWCHECK036: DiagnosticDef = {
	code: 'TWCHECK036',
	description: 'List size annotations must specify a positive integer value.',
	message: 'list size must be a positive integer',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Use a positive integer like `<size=4>`.',
}

export const TWCHECK037: DiagnosticDef = {
	code: 'TWCHECK037',
	description: 'The number of elements in the list literal does not match the declared size.',
	message: 'list literal length {found} does not match declared size {expected}',
	severity: DiagnosticSeverity.Error,
	suggestion: 'Provide exactly {expected} elements or change the size annotation.',
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

export const COMPILER_DIAGNOSTICS = {
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
	TWCHECK034,
	TWCHECK035,
	TWCHECK036,
	TWCHECK037,
	TWCHECK050,
	TWGEN001,
	TWLEX001,
	TWLEX002,
	TWLEX003,
	TWLEX004,
	TWLEX005,
	TWPARSE001,
} as const

export type CompilerDiagnosticCode = keyof typeof COMPILER_DIAGNOSTICS
