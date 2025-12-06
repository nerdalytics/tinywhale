import type { Readable } from 'node:stream'
import { analyzeLineIndent, parseDirective } from './analysis.ts'
import type { ProcessingState } from './state.ts'
import { createProcessingState } from './state.ts'
import { createDedentToken, createIndentToken } from './tokens.ts'
import type { IndentType, LineIndentInfo, PreprocessOptions } from './types.ts'
import { handleSpaceIndentDelta, validateIndent, validateIndentJump } from './validation.ts'

export { analyzeLineIndent, parseDirective } from './analysis.ts'
// Re-export public API
export { IndentationError } from './errors.ts'
export type { ProcessingState } from './state.ts'
export { createProcessingState } from './state.ts'
// Re-export for testing
export { createDedentToken, createIndentToken, formatPosition } from './tokens.ts'
export type {
	IndentMode,
	IndentType,
	LineIndentInfo,
	Position,
	PreprocessOptions,
} from './types.ts'
export {
	handleSpaceIndentDelta,
	validateIndent,
	validateIndentJump,
	validateSpaceDedent,
	validateSpaceIndent,
} from './validation.ts'
export { classifyWhitespace, updateIndentType } from './whitespace.ts'

/**
 * UTF-8 Byte Order Mark (BOM) character.
 * Unnecessary for UTF-8 but sometimes added by editors. We strip it.
 */
const UTF8_BOM = '\uFEFF'

/**
 * Calculates indent level from whitespace count.
 * For tabs: level = count
 * For spaces: compares delta between lines to derive unit.
 */
export function calculateIndentLevel(
	indentInfo: LineIndentInfo,
	lineNumber: number,
	state: ProcessingState
): number {
	if (indentInfo.count === 0) {
		state.previousSpaces = 0
		return 0
	}

	if (indentInfo.type === 'tab') {
		return indentInfo.count
	}

	handleSpaceIndentDelta(indentInfo, lineNumber, state)
	state.previousSpaces = indentInfo.count
	return state.indentUnit ? indentInfo.count / state.indentUnit : 0
}

/**
 * Processes a single line and returns the tokenized version with INDENT/DEDENT tokens.
 */
export function processLine(
	line: string,
	lineNumber: number,
	indentInfo: LineIndentInfo,
	state: ProcessingState
): string {
	const newLevel = calculateIndentLevel(indentInfo, lineNumber, state)
	const content = line.slice(indentInfo.count)
	const tokens: string[] = []

	if (newLevel > state.previousLevel) {
		validateIndentJump(newLevel, state.previousLevel, lineNumber, indentInfo)
		tokens.push(createIndentToken({ level: newLevel, line: lineNumber }))
	} else if (newLevel < state.previousLevel) {
		for (let i = state.previousLevel; i > newLevel; i--) {
			tokens.push(createDedentToken({ level: 0, line: lineNumber }))
		}
	}

	state.previousLevel = newLevel
	tokens.push(content)
	return tokens.join('')
}

/**
 * Generates remaining DEDENT tokens at end of file.
 */
export function generateEofDedents(state: ProcessingState, lastLineNumber: number): string {
	const dedents: string[] = []
	for (let i = state.previousLevel; i > 0; i--) {
		dedents.push(createDedentToken({ level: 0, line: lastLineNumber }))
	}
	return dedents.join('')
}

/**
 * Processes and flushes all buffered lines.
 */
function flushBufferedLines(state: ProcessingState, processedLines: string[]): void {
	for (const buffered of state.bufferedLines) {
		validateIndent(buffered.indentInfo, buffered.lineNumber, state)
		processedLines.push(processLine(buffered.line, buffered.lineNumber, buffered.indentInfo, state))
	}
	state.bufferedLines = []
}

/**
 * Handles a directive found in a line.
 */
function handleDirective(directive: IndentType, lineNumber: number, state: ProcessingState): void {
	state.directiveFound = true
	state.directiveLine = lineNumber
	if (state.mode === 'directive') {
		state.expectedIndentType = directive
		state.indentEstablishedAt = { line: lineNumber, source: 'directive' }
	}
}

/**
 * Converts a chunk to string and strips BOM if first chunk.
 */
function chunkToString(chunk: unknown, state: ProcessingState): string {
	let str = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf-8')
	if (state.isFirstChunk) {
		if (str.startsWith(UTF8_BOM)) {
			str = str.slice(1)
		}
		state.isFirstChunk = false
	}
	return str
}

/**
 * Finalizes the result with EOF dedents and trailing newline handling.
 */
function finalizeResult(
	processedLines: string[],
	state: ProcessingState,
	hadTrailingNewline: boolean
): string {
	let result = processedLines.join('\n')

	const eofDedents = generateEofDedents(state, state.lineNumber)
	if (eofDedents) {
		result += `\n${eofDedents}`
	}

	if (hadTrailingNewline && state.lineNumber > 0) {
		return `${result}\n`
	}

	return result
}

/**
 * Processes a single source line.
 * Returns true if line was a directive and should be skipped.
 */
function processSourceLine(
	line: string,
	lineNumber: number,
	state: ProcessingState,
	processedLines: string[]
): boolean {
	const directive = parseDirective(line)
	if (directive !== null) {
		handleDirective(directive, lineNumber, state)
		flushBufferedLines(state, processedLines)
		return true
	}

	const indentInfo = analyzeLineIndent(line, lineNumber)

	if (state.mode === 'directive' && !state.directiveFound) {
		state.bufferedLines.push({ indentInfo, line, lineNumber })
	} else {
		validateIndent(indentInfo, lineNumber, state)
		processedLines.push(processLine(line, lineNumber, indentInfo, state))
	}
	return false
}

/**
 * Preprocesses source code by tokenizing indentation.
 *
 * This is the first phase of compilation that operates on raw text streams.
 * It replaces leading whitespace (tabs or spaces) with explicit INDENT (⇥)
 * and DEDENT (⇤) tokens that include position information.
 *
 * The preprocessor operates in two modes:
 * - 'detect' (default): First indentation character sets file-wide type
 * - 'directive': Respects "use spaces" directive, defaults to tabs
 *
 * Indentation rules:
 * - Mixed indentation (tabs and spaces in the same file) causes an error
 * - Can only increase indent by one level at a time (like Python)
 * - For tabs: 1 tab = 1 level
 * - For spaces: indent unit detected from first indent (e.g., 2 or 4 spaces)
 *   and must be consistent throughout the file
 *
 * Token format:
 *   INDENT: ⟨line,level⟩⇥
 *   DEDENT: ⟨line,level⟩⇤
 *
 * Examples:
 *   - ⟨2,1⟩⇥fn bar()    (indent at line 2, entering level 1)
 *   - ⟨4,0⟩⇤fn baz()    (dedent at line 4)
 *
 * @param stream - A readable stream of UTF-8 text
 * @param options - Preprocessor options
 * @returns The preprocessed text with INDENT/DEDENT tokens
 * @throws IndentationError if indentation rules are violated
 */
async function processStream(
	stream: Readable,
	state: ProcessingState,
	processedLines: string[]
): Promise<string> {
	let pendingChunk = ''
	for await (const chunk of stream) {
		const str = chunkToString(chunk, state)
		pendingChunk += str
		const lines = pendingChunk.split('\n')
		pendingChunk = lines.pop() ?? ''

		for (const line of lines) {
			state.lineNumber++
			processSourceLine(line, state.lineNumber, state, processedLines)
		}
	}
	return pendingChunk
}

export async function preprocess(
	stream: Readable,
	options: PreprocessOptions = {}
): Promise<string> {
	const { mode = 'detect' } = options
	const state = createProcessingState(mode)
	const processedLines: string[] = []

	const pendingChunk = await processStream(stream, state, processedLines)

	if (pendingChunk.length > 0) {
		state.lineNumber++
		processSourceLine(pendingChunk, state.lineNumber, state, processedLines)
	}

	if (state.bufferedLines.length > 0) {
		flushBufferedLines(state, processedLines)
	}

	return finalizeResult(processedLines, state, pendingChunk.length === 0)
}
