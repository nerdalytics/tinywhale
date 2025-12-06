import type { ProcessingState } from './state.ts'
import type { IndentType } from './types.ts'

/**
 * Error thrown when mixed indentation is detected.
 */
export class IndentationError extends Error {
	readonly line: number
	readonly column: number
	readonly expected: IndentType
	readonly found: IndentType

	constructor(
		message: string,
		line: number,
		column: number,
		expected: IndentType,
		found: IndentType
	) {
		super(message)
		this.name = 'IndentationError'
		this.line = line
		this.column = column
		this.expected = expected
		this.found = found
	}
}

/**
 * Throws a mixed indentation error with appropriate message.
 */
export function throwMixedIndentError(
	lineNumber: number,
	column: number,
	expected: IndentType,
	found: IndentType
): never {
	const expectedName = expected === 'tab' ? 'tabs' : 'spaces'
	const foundName = found === 'tab' ? 'tab' : 'space'
	throw new IndentationError(
		`${lineNumber}:${column} Mixed indentation: found ${foundName} after ${expectedName}. Use ${expectedName} only for indentation on this line.`,
		lineNumber,
		column,
		expected,
		found
	)
}

/**
 * Builds context message for indentation mismatch errors.
 */
export function buildIndentContextMessage(plural: string, state: ProcessingState): string {
	if (state.indentEstablishedAt?.source === 'directive') {
		return state.indentEstablishedAt.line === 0
			? `File uses ${plural} by default (no "use spaces" directive at the top of file found).`
			: `File uses ${plural} ("use spaces" directive on line ${state.indentEstablishedAt.line}).`
	}
	return `File uses ${plural} (first indented line: ${state.indentEstablishedAt?.line}).`
}

/**
 * Throws an indentation mismatch error.
 */
export function throwIndentMismatchError(
	lineNumber: number,
	expected: IndentType,
	found: IndentType,
	state: ProcessingState
): never {
	const plural = expected === 'tab' ? 'tabs' : 'spaces'
	const foundPlural = found === 'tab' ? 'tabs' : 'spaces'
	const context = buildIndentContextMessage(plural, state)
	throw new IndentationError(
		`${lineNumber}:1 Unexpected ${foundPlural}. ${context} Convert this line to use ${plural}.`,
		lineNumber,
		1,
		expected,
		found
	)
}
