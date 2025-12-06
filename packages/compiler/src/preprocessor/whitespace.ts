import { throwMixedIndentError } from './errors.ts'
import type { IndentType } from './types.ts'

/**
 * Classifies a character as tab, space, or neither.
 */
export function classifyWhitespace(char: string): IndentType | null {
	if (char === '\t') return 'tab'
	if (char === ' ') return 'space'
	return null
}

/**
 * Updates indent type, throwing if mixed indentation detected.
 */
export function updateIndentType(
	current: IndentType | null,
	found: IndentType,
	lineNumber: number,
	column: number
): IndentType {
	if (current === null) return found
	if (found !== current) throwMixedIndentError(lineNumber, column, current, found)
	return current
}
