import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { preprocess, IndentationError } from '../src/preprocessor/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function fixturesPath(name: string): string {
  return join(__dirname, 'fixtures', name);
}

function streamFromString(text: string): Readable {
  return Readable.from(text);
}

describe('preprocessor', () => {
  describe('indentation tokenization', () => {
    it('should handle empty input', async () => {
      const stream = streamFromString('');
      const result = await preprocess(stream);
      assert.strictEqual(result, '');
    });

    it('should pass through text without indentation unchanged', async () => {
      const stream = streamFromString('hello\nworld\ndone\n');
      const result = await preprocess(stream);
      assert.strictEqual(result, 'hello\nworld\ndone\n');
    });

    it('should tokenize leading tabs', async () => {
      const stream = streamFromString('\thello');
      const result = await preprocess(stream);
      assert.strictEqual(result, 'indent_tab:1,1;1,1 hello');
    });

    it('should tokenize multiple leading tabs', async () => {
      const stream = streamFromString('\t\thello');
      const result = await preprocess(stream);
      assert.strictEqual(result, 'indent_tab:1,1;1,2 hello');
    });

    it('should tokenize leading spaces', async () => {
      const stream = streamFromString('  hello');
      const result = await preprocess(stream);
      assert.strictEqual(result, 'indent_space:1,1;1,2 hello');
    });

    it('should tokenize multiple lines with tabs', async () => {
      const stream = streamFromString('hello\n\tworld\n\t\tnested\n');
      const result = await preprocess(stream);
      assert.strictEqual(
        result,
        'hello\nindent_tab:2,1;2,1 world\nindent_tab:3,1;3,2 nested\n'
      );
    });

    it('should tokenize multiple lines with spaces', async () => {
      const stream = streamFromString('hello\n  world\n    nested\n');
      const result = await preprocess(stream);
      assert.strictEqual(
        result,
        'hello\nindent_space:2,1;2,2 world\nindent_space:3,1;3,4 nested\n'
      );
    });

    it('should handle lines that return to no indentation', async () => {
      const stream = streamFromString('hello\n\tworld\nback\n');
      const result = await preprocess(stream);
      assert.strictEqual(result, 'hello\nindent_tab:2,1;2,1 world\nback\n');
    });

    it('should preserve empty lines', async () => {
      const stream = streamFromString('hello\n\nworld\n');
      const result = await preprocess(stream);
      assert.strictEqual(result, 'hello\n\nworld\n');
    });

    it('should handle indentation on first line', async () => {
      const stream = streamFromString('\tfirst\nsecond\n');
      const result = await preprocess(stream);
      assert.strictEqual(result, 'indent_tab:1,1;1,1 first\nsecond\n');
    });
  });

  describe('mixed indentation errors', () => {
    it('should throw on tab then space on same line', async () => {
      const stream = streamFromString('\t hello');
      await assert.rejects(
        () => preprocess(stream),
        (err: IndentationError) => {
          assert.strictEqual(err.name, 'IndentationError');
          assert.strictEqual(err.line, 1);
          assert.strictEqual(err.column, 2);
          assert.strictEqual(err.expected, 'tab');
          assert.strictEqual(err.found, 'space');
          return true;
        }
      );
    });

    it('should throw on space then tab on same line', async () => {
      const stream = streamFromString(' \thello');
      await assert.rejects(
        () => preprocess(stream),
        (err: IndentationError) => {
          assert.strictEqual(err.name, 'IndentationError');
          assert.strictEqual(err.line, 1);
          assert.strictEqual(err.column, 2);
          assert.strictEqual(err.expected, 'space');
          assert.strictEqual(err.found, 'tab');
          return true;
        }
      );
    });

    it('should throw on mixed indentation across lines (tabs then spaces)', async () => {
      const stream = streamFromString('hello\n\tworld\n  nested\n');
      await assert.rejects(
        () => preprocess(stream),
        (err: IndentationError) => {
          assert.strictEqual(err.name, 'IndentationError');
          assert.strictEqual(err.line, 3);
          assert.strictEqual(err.expected, 'tab');
          assert.strictEqual(err.found, 'space');
          return true;
        }
      );
    });

    it('should throw on mixed indentation across lines (spaces then tabs)', async () => {
      const stream = streamFromString('hello\n  world\n\tnested\n');
      await assert.rejects(
        () => preprocess(stream),
        (err: IndentationError) => {
          assert.strictEqual(err.name, 'IndentationError');
          assert.strictEqual(err.line, 3);
          assert.strictEqual(err.expected, 'space');
          assert.strictEqual(err.found, 'tab');
          return true;
        }
      );
    });
  });

  describe('directive mode', () => {
    it('should default to tabs when no directive present', async () => {
      const stream = streamFromString('hello\n  world\n');
      await assert.rejects(
        () => preprocess(stream, { mode: 'directive' }),
        (err: IndentationError) => {
          assert.strictEqual(err.expected, 'tab');
          assert.strictEqual(err.found, 'space');
          return true;
        }
      );
    });

    it('should allow tabs by default in directive mode', async () => {
      const stream = streamFromString('hello\n\tworld\n');
      const result = await preprocess(stream, { mode: 'directive' });
      assert.strictEqual(result, 'hello\nindent_tab:2,1;2,1 world\n');
    });

    it('should respect "use spaces" directive with double quotes', async () => {
      const stream = streamFromString('"use spaces"\nhello\n  world\n');
      const result = await preprocess(stream, { mode: 'directive' });
      assert.strictEqual(result, 'hello\nindent_space:3,1;3,2 world\n');
    });

    it('should respect "use spaces" directive with single quotes', async () => {
      const stream = streamFromString("'use spaces'\nhello\n  world\n");
      const result = await preprocess(stream, { mode: 'directive' });
      assert.strictEqual(result, 'hello\nindent_space:3,1;3,2 world\n');
    });

    it('should reject tabs when "use spaces" directive is present', async () => {
      const stream = streamFromString('"use spaces"\nhello\n\tworld\n');
      await assert.rejects(
        () => preprocess(stream, { mode: 'directive' }),
        (err: IndentationError) => {
          assert.strictEqual(err.expected, 'space');
          assert.strictEqual(err.found, 'tab');
          return true;
        }
      );
    });

    it('should strip directive line from output', async () => {
      const stream = streamFromString('"use spaces"\nhello\n');
      const result = await preprocess(stream, { mode: 'directive' });
      assert.strictEqual(result, 'hello\n');
    });

    it('should find directive after empty lines', async () => {
      const stream = streamFromString('\n\n\n\n\n"use spaces"\nhello\n  world\n');
      const result = await preprocess(stream, { mode: 'directive' });
      // Directive on line 6, content starts at line 7
      assert.strictEqual(result, 'hello\nindent_space:8,1;8,2 world\n');
    });

    it('should report correct line number for directive after empty lines', async () => {
      const stream = streamFromString('\n\n\n\n\n"use spaces"\nhello\n\tworld\n');
      await assert.rejects(
        () => preprocess(stream, { mode: 'directive' }),
        (err: IndentationError) => {
          assert.strictEqual(err.expected, 'space');
          assert.strictEqual(err.found, 'tab');
          assert.strictEqual(err.line, 8);
          // Error message should mention line 6 where directive is
          assert.match(err.message, /line 6/);
          return true;
        }
      );
    });

    it('should honor directive even when indentation appears before it', async () => {
      // File has tab indent on line 1, directive on line 2
      // The directive should be honored and tabs should cause an error
      const stream = streamFromString('\tindented\n"use spaces"\n\tindented again\n');
      await assert.rejects(
        () => preprocess(stream, { mode: 'directive' }),
        (err: IndentationError) => {
          assert.strictEqual(err.expected, 'space');
          assert.strictEqual(err.found, 'tab');
          // Should error on line 1 (the first tab indent)
          assert.strictEqual(err.line, 1);
          // Error message should mention line 2 where directive is
          assert.match(err.message, /line 2/);
          return true;
        }
      );
    });

    it('should process directive-after-indent.tw fixture', async () => {
      const stream = createReadStream(fixturesPath('directive-after-indent.tw'), 'utf-8');
      await assert.rejects(
        () => preprocess(stream, { mode: 'directive' }),
        (err: IndentationError) => {
          assert.strictEqual(err.expected, 'space');
          assert.strictEqual(err.found, 'tab');
          assert.strictEqual(err.line, 1);
          return true;
        }
      );
    });
  });

  describe('detect mode (default)', () => {
    it('should detect tabs from first indented line', async () => {
      const stream = streamFromString('hello\n\tworld\n\tnested\n');
      const result = await preprocess(stream);
      assert.strictEqual(
        result,
        'hello\nindent_tab:2,1;2,1 world\nindent_tab:3,1;3,1 nested\n'
      );
    });

    it('should detect spaces from first indented line', async () => {
      const stream = streamFromString('hello\n  world\n  nested\n');
      const result = await preprocess(stream);
      assert.strictEqual(
        result,
        'hello\nindent_space:2,1;2,2 world\nindent_space:3,1;3,2 nested\n'
      );
    });

    it('should allow files with no indentation', async () => {
      const stream = streamFromString('hello\nworld\ndone\n');
      const result = await preprocess(stream);
      assert.strictEqual(result, 'hello\nworld\ndone\n');
    });
  });

  describe('fixture file streaming', () => {
    it('should process tabs-only.tw fixture', async () => {
      const stream = createReadStream(fixturesPath('tabs-only.tw'), 'utf-8');
      const result = await preprocess(stream);
      assert.strictEqual(
        result,
        'hello\nindent_tab:2,1;2,1 world\nindent_tab:3,1;3,2 nested\nindent_tab:4,1;4,1 back\ndone\n'
      );
    });

    it('should process spaces-only.tw fixture', async () => {
      const stream = createReadStream(fixturesPath('spaces-only.tw'), 'utf-8');
      const result = await preprocess(stream);
      assert.strictEqual(
        result,
        'hello\nindent_space:2,1;2,2 world\nindent_space:3,1;3,4 nested\nindent_space:4,1;4,2 back\ndone\n'
      );
    });

    it('should process no-indent.tw fixture', async () => {
      const stream = createReadStream(fixturesPath('no-indent.tw'), 'utf-8');
      const result = await preprocess(stream);
      assert.strictEqual(result, 'hello\nworld\ndone\n');
    });

    it('should process empty.tw fixture', async () => {
      const stream = createReadStream(fixturesPath('empty.tw'), 'utf-8');
      const result = await preprocess(stream);
      assert.strictEqual(result, '');
    });

    it('should reject mixed-indent.tw fixture (mixed across lines)', async () => {
      const stream = createReadStream(fixturesPath('mixed-indent.tw'), 'utf-8');
      await assert.rejects(
        () => preprocess(stream),
        (err: IndentationError) => {
          assert.strictEqual(err.name, 'IndentationError');
          // Line 3 has spaces after line 2 has tabs
          assert.strictEqual(err.line, 3);
          assert.strictEqual(err.expected, 'tab');
          assert.strictEqual(err.found, 'space');
          return true;
        }
      );
    });

    it('should process uneven-spaces.tw fixture', async () => {
      const stream = createReadStream(fixturesPath('uneven-spaces.tw'), 'utf-8');
      const result = await preprocess(stream);
      assert.strictEqual(
        result,
        'hello\n' +
          'indent_space:2,1;2,1 one\n' +
          'indent_space:3,1;3,3 three\n' +
          'indent_space:4,1;4,5 five\n' +
          'indent_space:5,1;5,2 two\n' +
          'indent_space:6,1;6,7 seven\n' +
          'done\n'
      );
    });

    it('should handle UTF-8 BOM and recognize directive (with-bom.tw)', async () => {
      const stream = createReadStream(fixturesPath('with-bom.tw'), 'utf-8');
      const result = await preprocess(stream, { mode: 'directive' });
      // BOM should be stripped, directive recognized, spaces allowed
      assert.strictEqual(result, 'hello\nindent_space:3,1;3,2 world\n');
    });
  });
});
