import * as ohm from 'ohm-js';

export { ohm };

export {
  createSemantics,
  grammars,
  type IndentInfo,
  type IndentToken,
  match,
  type ParsedLine,
  type ParseResult,
  type Position,
  parse,
  type Segment,
  type SegmentType,
  // Backwards compatibility
  type SourcePosition,
  semantics,
  TinyWhaleGrammar,
  trace,
} from './grammar/index.js';
export {
  IndentationError,
  type IndentMode,
  type PreprocessOptions,
  preprocess,
} from './preprocessor/index.js';
