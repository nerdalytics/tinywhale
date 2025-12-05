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
  type Position,
  type IndentToken,
  type Segment,
  type SegmentType,
  type ParsedLine,
  type ParseResult,
  // Backwards compatibility
  type SourcePosition,
  type IndentInfo,
} from './grammar/index.js';
