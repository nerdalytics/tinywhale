/**
 * Token types for indentation.
 */
export type IndentType = 'tab' | 'space'

/**
 * Indentation mode for the preprocessor.
 * - 'detect': First indentation character encountered sets the file-wide type (default)
 * - 'directive': Respects "use spaces" directive, otherwise defaults to tabs
 */
export type IndentMode = 'detect' | 'directive'

/**
 * Options for the preprocessor.
 */
export interface PreprocessOptions {
	mode?: IndentMode
}

/**
 * Represents a position in the source text.
 * Line is 1-indexed. Level is the indent level (0 = root).
 */
export interface Position {
	line: number
	level: number
}

/**
 * Result of analyzing a line's indentation.
 */
export interface LineIndentInfo {
	type: IndentType | null
	count: number
}
