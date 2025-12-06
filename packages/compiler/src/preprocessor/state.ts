import type { IndentMode, IndentType, LineIndentInfo } from './types.ts'

/**
 * State tracked during streaming processing.
 */
export interface ProcessingState {
	mode: IndentMode
	lineNumber: number
	expectedIndentType: IndentType | null
	indentEstablishedAt: { line: number; source: 'directive' | 'detected' } | null
	directiveLine: number | null
	bufferedLines: { line: string; lineNumber: number; indentInfo: LineIndentInfo }[]
	directiveFound: boolean
	isFirstChunk: boolean
	previousLevel: number
	previousSpaces: number
	indentUnit: number | null
}

/**
 * Creates initial processing state for the given mode.
 */
export function createProcessingState(mode: IndentMode): ProcessingState {
	return {
		bufferedLines: [],
		directiveFound: false,
		directiveLine: null,
		expectedIndentType: mode === 'directive' ? 'tab' : null,
		indentEstablishedAt: mode === 'directive' ? { line: 0, source: 'directive' } : null,
		indentUnit: null,
		isFirstChunk: true,
		lineNumber: 0,
		mode,
		previousLevel: 0,
		previousSpaces: 0,
	}
}
