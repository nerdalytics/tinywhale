/**
 * Tokenizer that emits to TokenStore.
 * Ports preprocessor logic to data-oriented design.
 */

import type { CompilationContext } from '../core/context.ts'
import { TokenKind } from '../core/tokens.ts'

/**
 * Indentation type detected in a line.
 */
type IndentType = 'tab' | 'space'

/**
 * Result of tokenization.
 */
export interface TokenizeResult {
	succeeded: boolean
}

/**
 * Options for tokenization.
 */
export interface TokenizeOptions {
	/**
	 * Indentation mode:
	 * - 'detect': First indentation character sets file-wide type (default)
	 * - 'directive': Respects "use spaces" directive, defaults to tabs
	 */
	mode?: 'detect' | 'directive'
}

/**
 * Internal tokenizer state.
 */
interface TokenizerState {
	mode: 'detect' | 'directive'
	lineNumber: number
	expectedIndentType: IndentType | null
	indentUnit: number | null // For spaces: detected unit (2, 4, etc.)
	previousLevel: number
	previousSpaces: number
	directiveFound: boolean
	bufferedLines: Array<{
		line: string
		lineNumber: number
		indentCount: number
		indentType: IndentType | null
	}>
}

/**
 * UTF-8 Byte Order Mark (BOM) character.
 */
const UTF8_BOM = '\uFEFF'

/**
 * Classifies a whitespace character.
 */
function classifyWhitespace(char: string): IndentType | null {
	if (char === '\t') return 'tab'
	if (char === ' ') return 'space'
	return null
}

/**
 * Analyzes leading whitespace of a line.
 */
function analyzeLineIndent(
	line: string,
	lineNumber: number,
	context: CompilationContext
): { count: number; type: IndentType | null } {
	if (line.length === 0) {
		return { count: 0, type: null }
	}

	let indentEnd = 0
	let indentType: IndentType | null = null

	while (indentEnd < line.length) {
		const charType = classifyWhitespace(line.charAt(indentEnd))
		if (charType === null) break

		if (indentType === null) {
			indentType = charType
		} else if (charType !== indentType) {
			// Mixed indentation on same line
			context.addError(
				lineNumber,
				indentEnd + 1,
				`Mixed indentation: expected ${indentType}, found ${charType}`
			)
			return { count: indentEnd, type: indentType }
		}
		indentEnd++
	}

	return { count: indentEnd, type: indentType }
}

/**
 * Parses "use spaces" directive from a line.
 */
function parseDirective(line: string): IndentType | null {
	const trimmed = line.trim()
	if (trimmed === '"use spaces"' || trimmed === "'use spaces'") {
		return 'space'
	}
	return null
}

/**
 * Calculates indent level from whitespace count.
 */
function calculateIndentLevel(
	indentCount: number,
	indentType: IndentType | null,
	lineNumber: number,
	state: TokenizerState,
	context: CompilationContext
): number {
	if (indentCount === 0) {
		state.previousSpaces = 0
		return 0
	}

	if (indentType === 'tab') {
		return indentCount
	}

	// Space-based indentation
	const delta = indentCount - state.previousSpaces

	if (delta > 0) {
		// Indent
		if (state.indentUnit === null) {
			state.indentUnit = delta
		} else if (delta !== state.indentUnit) {
			context.addError(
				lineNumber,
				1,
				`File uses ${state.indentUnit}-space indentation. Add ${state.indentUnit} spaces, not ${delta}.`
			)
		}
	} else if (delta < 0) {
		// Dedent - check alignment
		if (state.indentUnit !== null && indentCount % state.indentUnit !== 0) {
			const validLevels: number[] = []
			for (let s = 0; s <= state.previousSpaces; s += state.indentUnit) {
				validLevels.push(s)
			}
			context.addError(lineNumber, 1, `Unindent to ${validLevels.join(', ')} spaces.`)
		}
	}

	state.previousSpaces = indentCount
	return state.indentUnit ? Math.floor(indentCount / state.indentUnit) : 0
}

/**
 * Checks if line content contains the panic keyword.
 * Returns column position (1-indexed) if found, or 0 if not.
 */
function findPanicKeyword(content: string): number {
	// Skip leading whitespace (already stripped by indent analysis)
	// Skip comments
	let pos = 0

	// Skip any whitespace
	while (pos < content.length && (content[pos] === ' ' || content[pos] === '\t')) {
		pos++
	}

	// Check for comment
	if (content[pos] === '#') {
		return 0 // Line is a comment
	}

	// Check for panic keyword
	if (content.startsWith('panic', pos)) {
		const afterPanic = pos + 5
		// Ensure it's not part of a larger identifier
		if (afterPanic >= content.length || !/[a-zA-Z0-9_]/.test(content[afterPanic]!)) {
			return pos + 1 // 1-indexed column
		}
	}

	return 0
}

/**
 * Strips a comment section from content.
 * Comments are # ... # or # ... EOL
 */
function stripComments(content: string): string {
	let result = ''
	let inComment = false

	for (let i = 0; i < content.length; i++) {
		if (content[i] === '#') {
			inComment = !inComment
		} else if (!inComment) {
			result += content[i]
		}
	}

	return result
}

/**
 * Processes a single line, emitting tokens to the context.
 */
function processLine(
	line: string,
	lineNumber: number,
	indentCount: number,
	indentType: IndentType | null,
	state: TokenizerState,
	context: CompilationContext
): void {
	const newLevel = calculateIndentLevel(indentCount, indentType, lineNumber, state, context)
	const content = line.slice(indentCount)
	const levelChanged = newLevel !== state.previousLevel

	// Validate indent jump
	if (newLevel > state.previousLevel + 1) {
		const expected = state.previousLevel + 1
		const unit = indentType === 'tab' ? 'tab' : 'spaces'
		context.addError(lineNumber, 1, `Use ${expected} ${unit}, not ${newLevel}.`)
	}

	// Emit INDENT tokens
	if (newLevel > state.previousLevel) {
		context.tokens.add({
			column: 1,
			kind: TokenKind.Indent,
			line: lineNumber,
			payload: newLevel,
		})
	}

	// Emit DEDENT tokens
	if (newLevel < state.previousLevel) {
		for (let i = state.previousLevel; i > newLevel; i--) {
			context.tokens.add({
				column: 1,
				kind: TokenKind.Dedent,
				line: lineNumber,
				payload: i - 1,
			})
		}
	}

	state.previousLevel = newLevel

	// Check for panic keyword in content
	const strippedContent = stripComments(content)
	const panicCol = findPanicKeyword(strippedContent)
	if (panicCol > 0) {
		context.tokens.add({
			column: indentCount + panicCol,
			kind: TokenKind.Panic,
			line: lineNumber,
			payload: 0,
		})
	}

	// Emit newline token (skip for empty lines with no content and no indent change)
	if (content.trim().length > 0 || levelChanged) {
		context.tokens.add({
			column: line.length + 1,
			kind: TokenKind.Newline,
			line: lineNumber,
			payload: 0,
		})
	}
}

/**
 * Validates indentation type consistency.
 */
function validateIndentType(
	indentType: IndentType | null,
	lineNumber: number,
	state: TokenizerState,
	context: CompilationContext
): void {
	if (indentType === null) return

	if (state.expectedIndentType === null) {
		state.expectedIndentType = indentType
	} else if (indentType !== state.expectedIndentType) {
		context.addError(
			lineNumber,
			1,
			`Expected ${state.expectedIndentType} indentation, found ${indentType}`
		)
	}
}

/**
 * Flushes buffered lines (used in directive mode).
 */
function flushBufferedLines(state: TokenizerState, context: CompilationContext): void {
	for (const buffered of state.bufferedLines) {
		validateIndentType(buffered.indentType, buffered.lineNumber, state, context)
		processLine(
			buffered.line,
			buffered.lineNumber,
			buffered.indentCount,
			buffered.indentType,
			state,
			context
		)
	}
	state.bufferedLines = []
}

/**
 * Generates EOF dedent tokens.
 */
function generateEofDedents(state: TokenizerState, context: CompilationContext): void {
	const lastLine = state.lineNumber
	for (let i = state.previousLevel; i > 0; i--) {
		context.tokens.add({
			column: 1,
			kind: TokenKind.Dedent,
			line: lastLine,
			payload: i - 1,
		})
	}
}

/**
 * Tokenizes source code, populating context.tokens.
 *
 * Converts indentation to INDENT/DEDENT tokens and identifies keywords.
 * This replaces the streaming preprocessor with a synchronous approach
 * since source is already loaded into CompilationContext.
 */
export function tokenize(
	context: CompilationContext,
	options: TokenizeOptions = {}
): TokenizeResult {
	const { mode = 'detect' } = options

	const state: TokenizerState = {
		bufferedLines: [],
		directiveFound: false,
		expectedIndentType: mode === 'directive' ? 'tab' : null,
		indentUnit: null,
		lineNumber: 0,
		mode,
		previousLevel: 0,
		previousSpaces: 0,
	}

	// Strip BOM if present
	let source = context.source
	if (source.startsWith(UTF8_BOM)) {
		source = source.slice(1)
	}

	// Split into lines
	const lines = source.split('\n')

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!
		state.lineNumber = i + 1

		// Check for directive
		const directive = parseDirective(line)
		if (directive !== null) {
			state.directiveFound = true
			if (state.mode === 'directive') {
				state.expectedIndentType = directive
			}
			flushBufferedLines(state, context)
			// Skip the directive line itself
			continue
		}

		// Analyze indentation
		const { count: indentCount, type: indentType } = analyzeLineIndent(
			line,
			state.lineNumber,
			context
		)

		// In directive mode, buffer lines until directive is found
		if (state.mode === 'directive' && !state.directiveFound) {
			state.bufferedLines.push({
				indentCount,
				indentType,
				line,
				lineNumber: state.lineNumber,
			})
		} else {
			validateIndentType(indentType, state.lineNumber, state, context)
			processLine(line, state.lineNumber, indentCount, indentType, state, context)
		}
	}

	// Flush any remaining buffered lines
	if (state.bufferedLines.length > 0) {
		flushBufferedLines(state, context)
	}

	// Generate EOF dedents
	generateEofDedents(state, context)

	// Add EOF token
	context.tokens.add({
		column: 1,
		kind: TokenKind.Eof,
		line: state.lineNumber,
		payload: 0,
	})

	return {
		succeeded: !context.hasErrors(),
	}
}
