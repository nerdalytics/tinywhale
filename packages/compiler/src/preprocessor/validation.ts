import { IndentationError, throwIndentMismatchError } from './errors.ts'
import type { ProcessingState } from './state.ts'
import type { LineIndentInfo } from './types.ts'

/**
 * Validates indentation consistency and throws if mismatched.
 */
export function validateIndent(
	indentInfo: LineIndentInfo,
	lineNumber: number,
	state: ProcessingState
): void {
	if (indentInfo.type === null) {
		return
	}

	if (state.expectedIndentType === null) {
		state.expectedIndentType = indentInfo.type
		state.indentEstablishedAt = { line: lineNumber, source: 'detected' }
	} else if (indentInfo.type !== state.expectedIndentType) {
		throwIndentMismatchError(lineNumber, state.expectedIndentType, indentInfo.type, state)
	}
}

/**
 * Validates and sets the space indent unit on first indent, or checks consistency.
 */
export function validateSpaceIndent(
	delta: number,
	lineNumber: number,
	state: ProcessingState
): void {
	if (state.indentUnit === null) {
		state.indentUnit = delta
	} else if (delta !== state.indentUnit) {
		throw new IndentationError(
			`${lineNumber}:1 File uses ${state.indentUnit}-space indentation. Add ${state.indentUnit} spaces, not ${delta}.`,
			lineNumber,
			1,
			'space',
			'space'
		)
	}
}

/**
 * Validates that a space-based dedent aligns to a valid level.
 */
export function validateSpaceDedent(
	indentInfo: LineIndentInfo,
	lineNumber: number,
	state: ProcessingState
): void {
	if (state.indentUnit === null) return
	if (indentInfo.count % state.indentUnit === 0) return

	const validLevels: number[] = []
	for (let s = 0; s <= state.previousSpaces; s += state.indentUnit) {
		validLevels.push(s)
	}
	throw new IndentationError(
		`${lineNumber}:1 Unindent to ${validLevels.join(', ')} spaces.`,
		lineNumber,
		1,
		'space',
		'space'
	)
}

/**
 * Handles indent/dedent delta validation for space-based indentation.
 */
export function handleSpaceIndentDelta(
	indentInfo: LineIndentInfo,
	lineNumber: number,
	state: ProcessingState
): void {
	const delta = indentInfo.count - state.previousSpaces
	if (delta > 0) {
		validateSpaceIndent(delta, lineNumber, state)
	} else if (delta < 0) {
		validateSpaceDedent(indentInfo, lineNumber, state)
	}
}

/**
 * Validates that indent doesn't jump more than one level.
 */
export function validateIndentJump(
	newLevel: number,
	previousLevel: number,
	lineNumber: number,
	indentInfo: LineIndentInfo
): void {
	if (newLevel <= previousLevel + 1) return
	const expected = previousLevel + 1
	const unit = indentInfo.type === 'tab' ? 'tab' : 'spaces'
	throw new IndentationError(
		`${lineNumber}:1 Use ${expected} ${unit}, not ${newLevel}.`,
		lineNumber,
		1,
		indentInfo.type || 'tab',
		indentInfo.type || 'tab'
	)
}
