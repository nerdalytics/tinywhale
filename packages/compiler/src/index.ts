import * as ohm from 'ohm-js'

export { ohm }

export {
	createSemantics,
	type IndentInfo,
	type IndentToken,
	match,
	type PanicStatementNode,
	type ParsedLine,
	type ParseResult,
	type Position,
	parse,
	// Backwards compatibility
	type SourcePosition,
	type Statement,
	type StatementNode,
	semantics,
	TinyWhaleGrammar,
	trace,
} from './grammar/index.ts'
export {
	IndentationError,
	type IndentMode,
	type PreprocessOptions,
	preprocess,
} from './preprocessor/index.ts'
