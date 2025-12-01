import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Readable } from 'node:stream';
import {
  TinyWhaleGrammar,
  grammars,
  parse,
  match,
  createSemantics,
  type IndentInfo,
} from '../src/grammar/index.ts';
import { preprocess } from '../src/preprocessor/index.ts';

function streamFromString(text: string): Readable {
  return Readable.from(text);
}

describe('grammar', () => {
  describe('grammar loading', () => {
    it('should load TinyWhale grammar', () => {
      assert.ok(TinyWhaleGrammar);
      assert.strictEqual(typeof TinyWhaleGrammar.match, 'function');
    });

    it('should export grammars object', () => {
      assert.ok(grammars['TinyWhale']);
    });
  });

  describe('match function', () => {
    it('should match empty input', () => {
      const result = match('');
      assert.ok(result.succeeded());
    });

    it('should match content without indentation', () => {
      const result = match('hello\nworld\n');
      assert.ok(result.succeeded());
    });

    it('should match single tab indent token', () => {
      const result = match('indent_tab:1,1;1,1 hello');
      assert.ok(result.succeeded());
    });

    it('should match single space indent token', () => {
      const result = match('indent_space:1,1;1,2 hello');
      assert.ok(result.succeeded());
    });

    it('should match multiple tab indent token', () => {
      const result = match('indent_tab:1,1;1,3 hello');
      assert.ok(result.succeeded());
    });

    it('should match multiple lines with indent tokens', () => {
      const input = 'hello\nindent_tab:2,1;2,1 world\nindent_tab:3,1;3,2 nested\n';
      const result = match(input);
      assert.ok(result.succeeded());
    });

    it('should treat malformed indent token as content line', () => {
      // Malformed indent tokens are parsed as regular content lines
      const result = match('indent_tab hello\n');
      assert.ok(result.succeeded());
      // Parse and verify it's treated as content, not indented line
      const parsed = parse('indent_tab hello\n');
      assert.strictEqual(parsed.lines[0].indent, null);
      assert.strictEqual(parsed.lines[0].content, 'indent_tab hello');
    });

    it('should match blank lines', () => {
      const result = match('hello\n\nworld\n');
      assert.ok(result.succeeded());
    });
  });

  describe('parse function', () => {
    it('should parse empty input', () => {
      const result = parse('');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 0);
    });

    it('should parse content without indentation', () => {
      const result = parse('hello\nworld\n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 2);
      assert.strictEqual(result.lines[0].content, 'hello');
      assert.strictEqual(result.lines[0].indent, null);
      assert.strictEqual(result.lines[1].content, 'world');
      assert.strictEqual(result.lines[1].indent, null);
    });

    it('should parse single line with tab indent', () => {
      const result = parse('indent_tab:1,1;1,1 hello');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 1);

      const line = result.lines[0];
      assert.strictEqual(line.content, 'hello');
      assert.ok(line.indent);
      assert.strictEqual(line.indent.type, 'tab');
      assert.strictEqual(line.indent.depth, 1);
      assert.deepStrictEqual(line.indent.start, { line: 1, column: 1 });
      assert.deepStrictEqual(line.indent.end, { line: 1, column: 1 });
    });

    it('should parse single line with space indent', () => {
      const result = parse('indent_space:1,1;1,4 hello');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 1);

      const line = result.lines[0];
      assert.strictEqual(line.content, 'hello');
      assert.ok(line.indent);
      assert.strictEqual(line.indent.type, 'space');
      assert.strictEqual(line.indent.depth, 4);
      assert.deepStrictEqual(line.indent.start, { line: 1, column: 1 });
      assert.deepStrictEqual(line.indent.end, { line: 1, column: 4 });
    });

    it('should parse multiple indented lines with varying depths', () => {
      const input = [
        'hello',
        'indent_tab:2,1;2,1 level1',
        'indent_tab:3,1;3,2 level2',
        'indent_tab:4,1;4,1 back',
        'done',
        '',
      ].join('\n');

      const result = parse(input);
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 5);

      assert.strictEqual(result.lines[0].content, 'hello');
      assert.strictEqual(result.lines[0].indent, null);

      assert.strictEqual(result.lines[1].content, 'level1');
      assert.strictEqual(result.lines[1].indent?.depth, 1);

      assert.strictEqual(result.lines[2].content, 'level2');
      assert.strictEqual(result.lines[2].indent?.depth, 2);

      assert.strictEqual(result.lines[3].content, 'back');
      assert.strictEqual(result.lines[3].indent?.depth, 1);

      assert.strictEqual(result.lines[4].content, 'done');
      assert.strictEqual(result.lines[4].indent, null);
    });

    it('should preserve line numbers from indent tokens', () => {
      const input = [
        'line1',
        '',
        'indent_tab:3,1;3,1 line3',
        '',
        'indent_space:5,1;5,2 line5',
        '',
      ].join('\n');

      const result = parse(input);
      assert.strictEqual(result.succeeded, true);

      const indentedLines = result.lines.filter((l) => l.indent !== null);
      assert.strictEqual(indentedLines.length, 2);
      assert.strictEqual(indentedLines[0].lineNumber, 3);
      assert.strictEqual(indentedLines[1].lineNumber, 5);
    });

    it('should treat invalid indent prefix as content line', () => {
      // Invalid indent prefix is parsed as regular content
      const result = parse('indent_bad:1,1;1,1 hello\n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines[0].indent, null);
      assert.strictEqual(result.lines[0].content, 'indent_bad:1,1;1,1 hello');
    });
  });

  describe('semantics', () => {
    it('should allow creating multiple semantics instances', () => {
      const sem1 = createSemantics();
      const sem2 = createSemantics();
      assert.notStrictEqual(sem1, sem2);
    });

    it('should extract indent info correctly', () => {
      const sem = createSemantics();
      const matchResult = TinyWhaleGrammar.match('indent_tab:5,1;5,3', 'indentToken');
      assert.ok(matchResult.succeeded());

      const info: IndentInfo = sem(matchResult).toIndentInfo();
      assert.strictEqual(info.type, 'tab');
      assert.strictEqual(info.depth, 3);
      assert.deepStrictEqual(info.start, { line: 5, column: 1 });
      assert.deepStrictEqual(info.end, { line: 5, column: 3 });
    });

    it('should extract content from indented line via parse', () => {
      const result = parse('indent_tab:1,1;1,1 hello world\n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 1);
      assert.strictEqual(result.lines[0].content, 'hello world');
    });

    it('should extract content from non-indented line via parse', () => {
      const result = parse('hello world\n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 1);
      assert.strictEqual(result.lines[0].content, 'hello world');
    });
  });

  describe('preprocessor integration', () => {
    it('should parse preprocessed tab-indented file', async () => {
      const source = 'hello\n\tworld\n\t\tnested\n';
      const stream = streamFromString(source);
      const preprocessed = await preprocess(stream);

      const result = parse(preprocessed);
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 3);

      assert.strictEqual(result.lines[0].content, 'hello');
      assert.strictEqual(result.lines[0].indent, null);

      assert.strictEqual(result.lines[1].content, 'world');
      assert.strictEqual(result.lines[1].indent?.type, 'tab');
      assert.strictEqual(result.lines[1].indent?.depth, 1);

      assert.strictEqual(result.lines[2].content, 'nested');
      assert.strictEqual(result.lines[2].indent?.type, 'tab');
      assert.strictEqual(result.lines[2].indent?.depth, 2);
    });

    it('should parse preprocessed space-indented file', async () => {
      const source = 'hello\n  world\n    nested\n';
      const stream = streamFromString(source);
      const preprocessed = await preprocess(stream);

      const result = parse(preprocessed);
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 3);

      assert.strictEqual(result.lines[0].content, 'hello');
      assert.strictEqual(result.lines[0].indent, null);

      assert.strictEqual(result.lines[1].content, 'world');
      assert.strictEqual(result.lines[1].indent?.type, 'space');
      assert.strictEqual(result.lines[1].indent?.depth, 2);

      assert.strictEqual(result.lines[2].content, 'nested');
      assert.strictEqual(result.lines[2].indent?.type, 'space');
      assert.strictEqual(result.lines[2].indent?.depth, 4);
    });

    it('should handle file with no indentation', async () => {
      const source = 'line1\nline2\nline3\n';
      const stream = streamFromString(source);
      const preprocessed = await preprocess(stream);

      const result = parse(preprocessed);
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 3);
      assert.ok(result.lines.every((l) => l.indent === null));
    });

    it('should handle empty file', async () => {
      const source = '';
      const stream = streamFromString(source);
      const preprocessed = await preprocess(stream);

      const result = parse(preprocessed);
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 0);
    });

    it('should handle complex indentation patterns', async () => {
      const source = [
        'root',
        '\tchild1',
        '\t\tgrandchild1',
        '\t\tgrandchild2',
        '\tchild2',
        '\t\tgrandchild3',
        '\t\t\tgreatgrand',
        'root2',
        '',
      ].join('\n');

      const stream = streamFromString(source);
      const preprocessed = await preprocess(stream);

      const result = parse(preprocessed);
      assert.strictEqual(result.succeeded, true);

      // Extract depths
      const depths = result.lines.map((l) => l.indent?.depth ?? 0);
      assert.deepStrictEqual(depths, [0, 1, 2, 2, 1, 2, 3, 0]);
    });

    it('should preserve content with special characters', async () => {
      const source = '\thello "world" 123 !@#\n';
      const stream = streamFromString(source);
      const preprocessed = await preprocess(stream);

      const result = parse(preprocessed);
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 1);
      assert.strictEqual(result.lines[0].content, 'hello "world" 123 !@#');
    });
  });

  describe('edge cases', () => {
    it('should handle line with only indent token (empty content)', () => {
      const result = parse('indent_tab:1,1;1,1 \n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 1);
      assert.strictEqual(result.lines[0].content, '');
    });

    it('should handle multiple blank lines', () => {
      const result = parse('\n\n\nhello\n\n\n');
      assert.strictEqual(result.succeeded, true);
      // Only non-blank lines are returned
      const nonBlank = result.lines.filter((l) => l.content !== '');
      assert.strictEqual(nonBlank.length, 1);
      assert.strictEqual(nonBlank[0].content, 'hello');
    });

    it('should handle input without trailing newline', () => {
      const result = parse('hello');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 1);
      assert.strictEqual(result.lines[0].content, 'hello');
    });

    it('should handle large indent depths', () => {
      const result = parse('indent_space:1,1;1,100 deep');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines[0].indent?.depth, 100);
    });

    it('should handle large line numbers', () => {
      const result = parse('indent_tab:9999,1;9999,5 late');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines[0].indent?.start.line, 9999);
    });
  });
});
