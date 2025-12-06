import type { Position } from './types.ts'

/**
 * Unicode characters for INDENT and DEDENT tokens.
 */
export const INDENT_CHAR = '⇥' // U+21E5 RIGHTWARDS ARROW TO BAR
export const DEDENT_CHAR = '⇤' // U+21E4 LEFTWARDS ARROW TO BAR

/**
 * Creates a position string in the format ⟨line,level⟩
 */
export function formatPosition(pos: Position): string {
	return `⟨${pos.line},${pos.level}⟩`
}

/**
 * Creates an INDENT token with position.
 */
export function createIndentToken(pos: Position): string {
	return `${formatPosition(pos)}${INDENT_CHAR}`
}

/**
 * Creates a DEDENT token with position.
 */
export function createDedentToken(pos: Position): string {
	return `${formatPosition(pos)}${DEDENT_CHAR}`
}
