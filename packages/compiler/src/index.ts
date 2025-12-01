import * as ohm from 'ohm-js';

export { ohm };
export {
  preprocess,
  IndentationError,
  type IndentMode,
  type PreprocessOptions,
} from './preprocessor/index.js';

export {
  TinyWhaleGrammar,
  grammars,
  parse,
  match,
  trace,
  createSemantics,
  semantics,
  type SourcePosition,
  type IndentInfo,
  type ParsedLine,
  type ParseResult,
} from './grammar/index.js';
