import type { IndentType, LineIndentInfo } from './types.ts'
import { classifyWhitespace, updateIndentType } from './whitespace.ts'

/**
 * Analyzes a line's leading whitespace.
 * Throws IndentationError if mixed indentation is found on the same line.
 */
export function analyzeLineIndent(line: string, lineNumber: number): LineIndentInfo {
	if (line.length === 0) {
		return { count: 0, type: null }
	}

	let indentEnd = 0
	let indentType: IndentType | null = null

	while (indentEnd < line.length) {
		const charType = classifyWhitespace(line.charAt(indentEnd))
		if (charType === null) break

		indentType = updateIndentType(indentType, charType, lineNumber, indentEnd + 1)
		indentEnd++
	}

	return { count: indentEnd, type: indentType }
}

/**
 * Parses a "use spaces" directive from a line.
 * Returns 'space' if directive found, null otherwise.
 */
export function parseDirective(line: string): IndentType | null {
	const trimmed = line.trim()
	if (trimmed === '"use spaces"' || trimmed === "'use spaces'") {
		return 'space'
	}
	return null
}
