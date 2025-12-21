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
 * Finds the first non-whitespace position in a line.
 */
function findWhitespaceEnd(line: string): number {
	let pos = 0
	while (pos < line.length && classifyWhitespace(line.charAt(pos)) !== null) {
		pos++
	}
	return pos
}

/**
 * Detects if whitespace contains mixed tabs/spaces.
 * Returns the 1-indexed column of the first mixed character, or null.
 */
function detectMixedIndent(
	line: string,
	end: number
): { type: IndentType | null; mixedAt: number | null } {
	if (end === 0) return { mixedAt: null, type: null }

	const firstType = classifyWhitespace(line.charAt(0))
	for (let i = 1; i < end; i++) {
		if (classifyWhitespace(line.charAt(i)) !== firstType) {
			return { mixedAt: i + 1, type: firstType }
		}
	}
	return { mixedAt: null, type: firstType }
}

/**
 * Counts leading whitespace and detects mixed indentation.
 */
function countLeadingWhitespace(line: string): {
	count: number
	type: IndentType | null
	mixedAt: number | null
} {
	const count = findWhitespaceEnd(line)
	const { type, mixedAt } = detectMixedIndent(line, count)
	return { count, mixedAt, type }
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

	const result = countLeadingWhitespace(line)
	if (result.mixedAt !== null) {
		context.addError(
			lineNumber,
			result.mixedAt,
			`Mixed indentation: expected ${result.type}, found ${result.type === 'tab' ? 'space' : 'tab'}`
		)
	}

	return { count: result.count, type: result.type }
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
 * Validates and updates indent unit on indent.
 */
function handleSpaceIndent(
	delta: number,
	lineNumber: number,
	state: TokenizerState,
	context: CompilationContext
): void {
	if (state.indentUnit === null) {
		state.indentUnit = delta
		return
	}
	if (delta !== state.indentUnit) {
		context.addError(
			lineNumber,
			1,
			`File uses ${state.indentUnit}-space indentation. Add ${state.indentUnit} spaces, not ${delta}.`
		)
	}
}

/**
 * Validates alignment on dedent.
 */
function handleSpaceDedent(
	indentCount: number,
	lineNumber: number,
	state: TokenizerState,
	context: CompilationContext
): void {
	if (state.indentUnit === null) return
	if (indentCount % state.indentUnit === 0) return

	const validLevels: number[] = []
	for (let s = 0; s <= state.previousSpaces; s += state.indentUnit) {
		validLevels.push(s)
	}
	context.addError(lineNumber, 1, `Unindent to ${validLevels.join(', ')} spaces.`)
}

/**
 * Calculates indent level for space-based indentation.
 */
function calculateSpaceIndentLevel(
	indentCount: number,
	lineNumber: number,
	state: TokenizerState,
	context: CompilationContext
): number {
	const delta = indentCount - state.previousSpaces

	if (delta > 0) {
		handleSpaceIndent(delta, lineNumber, state, context)
	} else if (delta < 0) {
		handleSpaceDedent(indentCount, lineNumber, state, context)
	}

	state.previousSpaces = indentCount
	return state.indentUnit ? Math.floor(indentCount / state.indentUnit) : 0
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

	return calculateSpaceIndentLevel(indentCount, lineNumber, state, context)
}

/**
 * Skips leading whitespace in content.
 */
function skipWhitespace(content: string): number {
	let pos = 0
	while (pos < content.length && (content[pos] === ' ' || content[pos] === '\t')) {
		pos++
	}
	return pos
}

/**
 * Checks if panic keyword at position is a complete keyword (not part of identifier).
 */
function isPanicKeywordComplete(content: string, pos: number): boolean {
	const afterPanic = pos + 5
	if (afterPanic >= content.length) return true
	const charAfter = content[afterPanic]
	return charAfter === undefined || !/[a-zA-Z0-9_]/.test(charAfter)
}

/**
 * Checks if line content contains the panic keyword.
 * Returns column position (1-indexed) if found, or 0 if not.
 */
function findPanicKeyword(content: string): number {
	const pos = skipWhitespace(content)

	// Check for comment
	if (content[pos] === '#') return 0

	// Check for panic keyword
	if (content.startsWith('panic', pos) && isPanicKeywordComplete(content, pos)) {
		return pos + 1 // 1-indexed column
	}

	return 0
}

/**
 * Checks if a segment at given index is non-comment content.
 * Segments at even indices (0, 2, 4...) are content.
 */
function isContentSegment(index: number): boolean {
	return index % 2 === 0
}

/**
 * Strips a comment section from content.
 * Comments are # ... # or # ... EOL
 */
function stripComments(content: string): string {
	return content
		.split('#')
		.filter((_, i) => isContentSegment(i))
		.join('')
}

/**
 * Validates that indent doesn't jump more than one level.
 */
function validateIndentJump(
	newLevel: number,
	previousLevel: number,
	indentType: IndentType | null,
	lineNumber: number,
	context: CompilationContext
): void {
	if (newLevel <= previousLevel + 1) return
	const expected = previousLevel + 1
	const unit = indentType === 'tab' ? 'tab' : 'spaces'
	context.addError(lineNumber, 1, `Use ${expected} ${unit}, not ${newLevel}.`)
}

/**
 * Emits INDENT token if level increased.
 */
function emitIndentToken(
	newLevel: number,
	previousLevel: number,
	lineNumber: number,
	context: CompilationContext
): void {
	if (newLevel <= previousLevel) return
	context.tokens.add({ column: 1, kind: TokenKind.Indent, line: lineNumber, payload: newLevel })
}

/**
 * Emits DEDENT tokens for each level decreased.
 */
function emitDedentTokens(
	newLevel: number,
	previousLevel: number,
	lineNumber: number,
	context: CompilationContext
): void {
	for (let i = previousLevel; i > newLevel; i--) {
		context.tokens.add({ column: 1, kind: TokenKind.Dedent, line: lineNumber, payload: i - 1 })
	}
}

/**
 * Emits panic token if keyword found.
 */
function emitPanicToken(
	content: string,
	indentCount: number,
	lineNumber: number,
	context: CompilationContext
): void {
	const strippedContent = stripComments(content)
	const panicCol = findPanicKeyword(strippedContent)
	if (panicCol === 0) return
	context.tokens.add({
		column: indentCount + panicCol,
		kind: TokenKind.Panic,
		line: lineNumber,
		payload: 0,
	})
}

/**
 * Determines if newline token should be emitted.
 */
function shouldEmitNewline(content: string, levelChanged: boolean): boolean {
	return content.trim().length > 0 || levelChanged
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

	validateIndentJump(newLevel, state.previousLevel, indentType, lineNumber, context)
	emitIndentToken(newLevel, state.previousLevel, lineNumber, context)
	emitDedentTokens(newLevel, state.previousLevel, lineNumber, context)
	state.previousLevel = newLevel

	emitPanicToken(content, indentCount, lineNumber, context)

	if (shouldEmitNewline(content, levelChanged)) {
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
 * Strips UTF-8 BOM from source if present.
 */
function stripBom(source: string): string {
	return source.startsWith(UTF8_BOM) ? source.slice(1) : source
}

/**
 * Creates initial tokenizer state.
 */
function createTokenizerState(mode: 'detect' | 'directive'): TokenizerState {
	return {
		bufferedLines: [],
		directiveFound: false,
		expectedIndentType: mode === 'directive' ? 'tab' : null,
		indentUnit: null,
		lineNumber: 0,
		mode,
		previousLevel: 0,
		previousSpaces: 0,
	}
}

/**
 * Handles a directive line (e.g., "use spaces").
 * Returns true if directive was found and processed.
 */
function handleDirectiveLine(
	line: string,
	state: TokenizerState,
	context: CompilationContext
): boolean {
	const directive = parseDirective(line)
	if (directive === null) return false

	state.directiveFound = true
	if (state.mode === 'directive') {
		state.expectedIndentType = directive
	}
	flushBufferedLines(state, context)
	return true
}

/**
 * Buffers a line for later processing (directive mode).
 */
function bufferLine(
	line: string,
	indentCount: number,
	indentType: IndentType | null,
	state: TokenizerState
): void {
	state.bufferedLines.push({ indentCount, indentType, line, lineNumber: state.lineNumber })
}

/**
 * Determines if a line should be buffered.
 */
function shouldBufferLine(state: TokenizerState): boolean {
	return state.mode === 'directive' && !state.directiveFound
}

/**
 * Processes a single source line during tokenization.
 */
function processSourceLine(line: string, state: TokenizerState, context: CompilationContext): void {
	if (handleDirectiveLine(line, state, context)) return

	const { count: indentCount, type: indentType } = analyzeLineIndent(
		line,
		state.lineNumber,
		context
	)

	if (shouldBufferLine(state)) {
		bufferLine(line, indentCount, indentType, state)
		return
	}

	validateIndentType(indentType, state.lineNumber, state, context)
	processLine(line, state.lineNumber, indentCount, indentType, state, context)
}

/**
 * Finalizes tokenization by flushing buffers and adding EOF.
 */
function finishTokenization(state: TokenizerState, context: CompilationContext): void {
	if (state.bufferedLines.length > 0) {
		flushBufferedLines(state, context)
	}
	generateEofDedents(state, context)
	context.tokens.add({ column: 1, kind: TokenKind.Eof, line: state.lineNumber, payload: 0 })
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
	const state = createTokenizerState(mode)
	const source = stripBom(context.source)
	const lines = source.split('\n')

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		if (line === undefined) continue
		state.lineNumber = i + 1
		processSourceLine(line, state, context)
	}

	finishTokenization(state, context)
	return { succeeded: !context.hasErrors() }
}
