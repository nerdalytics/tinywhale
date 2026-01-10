import type { CompilationContext } from '../core/context.ts'
import type { DiagnosticCode } from '../core/diagnostics.ts'
import { TokenKind } from '../core/tokens.ts'

type IndentType = 'tab' | 'space'

export interface TokenizeResult {
	succeeded: boolean
}

export interface TokenizeOptions {
	mode?: 'detect' | 'directive'
}

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

const UTF8_BOM = '\uFEFF'

function classifyWhitespace(char: string): IndentType | null {
	if (char === '\t') return 'tab'
	if (char === ' ') return 'space'
	return null
}

function findWhitespaceEnd(line: string): number {
	let pos = 0
	while (pos < line.length && classifyWhitespace(line.charAt(pos)) !== null) {
		pos++
	}
	return pos
}

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

function countLeadingWhitespace(line: string): {
	count: number
	type: IndentType | null
	mixedAt: number | null
} {
	const count = findWhitespaceEnd(line)
	const { type, mixedAt } = detectMixedIndent(line, count)
	return { count, mixedAt, type }
}

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
		const expected = result.type as string
		const found = result.type === 'tab' ? 'space' : 'tab'
		context.emit('TWLEX001' as DiagnosticCode, lineNumber, result.mixedAt, { expected, found })
	}

	return { count: result.count, type: result.type }
}

function parseDirective(line: string): IndentType | null {
	const trimmed = line.trim()
	if (trimmed === '"use spaces"' || trimmed === "'use spaces'") {
		return 'space'
	}
	return null
}

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
		// Point to where the size mismatch starts (after expected indent)
		const errorColumn = state.indentUnit + 1
		context.emit('TWLEX002' as DiagnosticCode, lineNumber, errorColumn, {
			found: delta,
			unit: state.indentUnit,
		})
	}
}

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
	// Point to where the invalid dedent ends
	const errorColumn = indentCount + 1
	context.emit('TWLEX003' as DiagnosticCode, lineNumber, errorColumn, {
		expected: validLevels[validLevels.length - 1] ?? 0,
		validLevels: validLevels.join(', '),
	})
}

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
 * Keyword map: string -> TokenKind
 * Type keywords are reserved and cannot be used as identifiers.
 */
const KEYWORDS: Record<string, (typeof TokenKind)[keyof typeof TokenKind]> = {
	f32: TokenKind.F32,
	f64: TokenKind.F64,
	i32: TokenKind.I32,
	i64: TokenKind.I64,
	match: TokenKind.Match,
	panic: TokenKind.Panic,
}

const SIMPLE_OPERATORS: Record<string, TokenKind | undefined> = {
	':': TokenKind.Colon,
	'=': TokenKind.Equals,
	'|': TokenKind.Pipe,
}

function getTokenKindForText(text: string): TokenKind | null {
	if (text === '_') return TokenKind.Underscore
	return KEYWORDS[text] ?? null
}

function isIdentifierStart(char: string): boolean {
	return /[a-zA-Z_]/.test(char)
}

function isIdentifierPart(char: string): boolean {
	return /[a-zA-Z0-9_]/.test(char)
}

function isDigit(char: string): boolean {
	return /[0-9]/.test(char)
}

function skipWhitespace(content: string, start: number): number {
	let pos = start
	while (pos < content.length && (content[pos] === ' ' || content[pos] === '\t')) {
		pos++
	}
	return pos
}

function validateIndentJump(
	newLevel: number,
	previousLevel: number,
	indentType: IndentType | null,
	indentUnit: number | null,
	lineNumber: number,
	context: CompilationContext
): void {
	if (newLevel <= previousLevel + 1) return
	const expected = previousLevel + 1
	const unit = indentType === 'tab' ? 'tab' : 'spaces'
	// Point to the first extra indent character
	const errorColumn = indentType === 'tab' ? expected + 1 : expected * (indentUnit ?? 1) + 1
	context.emit('TWLEX004' as DiagnosticCode, lineNumber, errorColumn, {
		expected,
		found: newLevel - previousLevel,
		unit,
	})
}

function emitIndentToken(
	newLevel: number,
	previousLevel: number,
	lineNumber: number,
	context: CompilationContext
): void {
	// Emit an Indent token for every indented line (level > 0),
	// not just when level increases. This ensures consecutive lines
	// at the same indent level each start with an indent marker,
	// which is needed for proper parsing of match arms and other
	// indented content.
	if (newLevel <= 0) return
	if (newLevel <= previousLevel) {
		context.tokens.add({ column: 1, kind: TokenKind.Indent, line: lineNumber, payload: newLevel })
		return
	}
	context.tokens.add({ column: 1, kind: TokenKind.Indent, line: lineNumber, payload: newLevel })
}

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
 * Tokenize identifier or keyword at position.
 * Returns the end position after the identifier.
 * Special case: standalone '_' is tokenized as Underscore (wildcard pattern).
 */
function tokenizeIdentifierOrKeyword(
	content: string,
	startPos: number,
	indentCount: number,
	lineNumber: number,
	context: CompilationContext
): number {
	let pos = startPos
	while (pos < content.length && isIdentifierPart(content[pos] as string)) {
		pos++
	}
	const text = content.slice(startPos, pos)
	const column = indentCount + startPos + 1
	const tokenKind = getTokenKindForText(text)

	if (tokenKind !== null) {
		context.tokens.add({ column, kind: tokenKind, line: lineNumber, payload: 0 })
	} else {
		const stringId = context.strings.intern(text)
		context.tokens.add({ column, kind: TokenKind.Identifier, line: lineNumber, payload: stringId })
	}
	return pos
}

function consumeDigits(content: string, pos: number): number {
	while (pos < content.length && isDigit(content[pos] as string)) {
		pos++
	}
	return pos
}

function hasDecimalPoint(content: string, pos: number): boolean {
	return (
		pos < content.length &&
		content[pos] === '.' &&
		pos + 1 < content.length &&
		isDigit(content[pos + 1] as string)
	)
}

function isExponentMarker(char: string): boolean {
	return char === 'e' || char === 'E'
}

function isSign(char: string): boolean {
	return char === '+' || char === '-'
}

/** Parse optional exponent part (e.g., e-10, E+5), return new position */
function consumeExponent(content: string, pos: number): number {
	if (pos >= content.length || !isExponentMarker(content[pos] as string)) return pos
	pos++
	if (pos < content.length && isSign(content[pos] as string)) pos++
	return consumeDigits(content, pos)
}

/**
 * Tokenize numeric literal (integer or float) at position.
 * Returns the end position after the literal.
 *
 * Integer: digit+ (("e" | "E") ("+" | "-")? digit+)?
 * Float: digit+ "." digit+ (("e" | "E") ("+" | "-")? digit+)?
 *
 * Note: Only the decimal point determines float vs integer.
 * Scientific notation is allowed for both: 1e10 is integer, 1.0e10 is float.
 */
function tokenizeNumericLiteral(
	content: string,
	startPos: number,
	indentCount: number,
	lineNumber: number,
	context: CompilationContext
): number {
	let pos = consumeDigits(content, startPos)
	const hasDecimal = hasDecimalPoint(content, pos)

	if (hasDecimal) {
		pos = consumeDigits(content, pos + 1) // skip '.' and consume fraction
	}

	// Exponent can appear with or without decimal
	pos = consumeExponent(content, pos)

	const text = content.slice(startPos, pos)
	const stringId = context.strings.intern(text)

	context.tokens.add({
		column: indentCount + startPos + 1,
		kind: hasDecimal ? TokenKind.FloatLiteral : TokenKind.IntLiteral,
		line: lineNumber,
		payload: stringId,
	})
	return pos
}

function getMinusOrArrowToken(content: string, pos: number): { kind: TokenKind; advance: number } {
	const isArrow = pos + 1 < content.length && content[pos + 1] === '>'
	return isArrow ? { advance: 2, kind: TokenKind.Arrow } : { advance: 1, kind: TokenKind.Minus }
}

function tokenizeOperator(
	char: string,
	pos: number,
	indentCount: number,
	lineNumber: number,
	context: CompilationContext,
	content: string
): number | null {
	const column = indentCount + pos + 1

	const simpleKind = SIMPLE_OPERATORS[char]
	if (simpleKind !== undefined) {
		context.tokens.add({ column, kind: simpleKind, line: lineNumber, payload: 0 })
		return pos + 1
	}

	if (char !== '-') return null

	const { advance, kind } = getMinusOrArrowToken(content, pos)
	context.tokens.add({ column, kind, line: lineNumber, payload: 0 })
	return pos + advance
}

interface TokenizeState {
	content: string
	indentCount: number
	lineNumber: number
	context: CompilationContext
}

function isWhitespace(char: string): boolean {
	return char === ' ' || char === '\t'
}

function handleKnownToken(char: string, pos: number, state: TokenizeState): number | null {
	const { content, context, indentCount, lineNumber } = state
	if (isIdentifierStart(char)) {
		return tokenizeIdentifierOrKeyword(content, pos, indentCount, lineNumber, context)
	}
	if (isDigit(char)) {
		return tokenizeNumericLiteral(content, pos, indentCount, lineNumber, context)
	}
	return tokenizeOperator(char, pos, indentCount, lineNumber, context, content)
}

function tokenizeSingleToken(char: string, pos: number, state: TokenizeState): number | 'break' {
	if (isWhitespace(char)) return skipWhitespace(state.content, pos)
	if (char === '#') return 'break'
	return handleKnownToken(char, pos, state) ?? pos + 1
}

/**
 * Tokenize all tokens from line content (after indent).
 */
function tokenizeContent(
	content: string,
	indentCount: number,
	lineNumber: number,
	context: CompilationContext
): void {
	const state: TokenizeState = { content, context, indentCount, lineNumber }
	let pos = 0

	while (pos < content.length) {
		const result = tokenizeSingleToken(content[pos] as string, pos, state)
		if (result === 'break') break
		pos = result
	}
}

function shouldEmitNewline(content: string, levelChanged: boolean): boolean {
	return content.trim().length > 0 || levelChanged
}

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

	validateIndentJump(
		newLevel,
		state.previousLevel,
		indentType,
		state.indentUnit,
		lineNumber,
		context
	)
	emitIndentToken(newLevel, state.previousLevel, lineNumber, context)
	emitDedentTokens(newLevel, state.previousLevel, lineNumber, context)
	state.previousLevel = newLevel

	tokenizeContent(content, indentCount, lineNumber, context)

	if (shouldEmitNewline(content, levelChanged)) {
		context.tokens.add({
			column: line.length + 1,
			kind: TokenKind.Newline,
			line: lineNumber,
			payload: 0,
		})
	}
}

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
		context.emit('TWLEX005' as DiagnosticCode, lineNumber, 1, {
			expected: state.expectedIndentType,
			found: indentType,
		})
	}
}

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

function stripBom(source: string): string {
	return source.startsWith(UTF8_BOM) ? source.slice(1) : source
}

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

function bufferLine(
	line: string,
	indentCount: number,
	indentType: IndentType | null,
	state: TokenizerState
): void {
	state.bufferedLines.push({ indentCount, indentType, line, lineNumber: state.lineNumber })
}

function shouldBufferLine(state: TokenizerState): boolean {
	return state.mode === 'directive' && !state.directiveFound
}

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

function finishTokenization(state: TokenizerState, context: CompilationContext): void {
	if (state.bufferedLines.length > 0) {
		flushBufferedLines(state, context)
	}
	generateEofDedents(state, context)
	context.tokens.add({ column: 1, kind: TokenKind.Eof, line: state.lineNumber, payload: 0 })
}

/**
 * Tokenizes source code, populating context.tokens.
 * Converts indentation to INDENT/DEDENT tokens and identifies keywords.
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
