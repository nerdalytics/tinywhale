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
  describe('INDENT/DEDENT tokenization', () => {
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

    it('should emit INDENT token for leading tab', async () => {
      const stream = streamFromString('\thello\n');
      const result = await preprocess(stream);
      // Should have INDENT token with position (line 1, level 1), then content, then EOF DEDENT
      assert.ok(result.includes('⟨1,1⟩⇥'));
      assert.ok(result.includes('hello'));
      assert.ok(result.includes('⇤')); // EOF dedent
    });

    it('should emit INDENT token for leading spaces', async () => {
      const stream = streamFromString('  hello\n');
      const result = await preprocess(stream);
      // Position should encode level 1 (first indent establishes unit)
      assert.ok(result.includes('⟨1,1⟩⇥'));
      assert.ok(result.includes('hello'));
    });

    it('should emit INDENT/DEDENT for nested structure', async () => {
      const stream = streamFromString('root\n\tchild\nback\n');
      const result = await preprocess(stream);
      // root - no token
      // child - INDENT
      // back - DEDENT
      assert.ok(result.includes('⇥')); // INDENT for child
      assert.ok(result.includes('⇤')); // DEDENT for back
    });

    it('should emit multiple INDENTs for deeper nesting', async () => {
      const stream = streamFromString('a\n\tb\n\t\tc\n');
      const result = await preprocess(stream);
      // Count INDENT tokens
      const indentCount = (result.match(/⇥/g) || []).length;
      assert.strictEqual(indentCount, 2); // One for b, one for c
    });

    it('should emit multiple DEDENTs when jumping back multiple levels', async () => {
      const stream = streamFromString('a\n\tb\n\t\tc\na2\n');
      const result = await preprocess(stream);
      // a2 should be preceded by 2 DEDENTs
      const dedentCount = (result.match(/⇤/g) || []).length;
      assert.ok(dedentCount >= 2); // At least 2 for jumping from c back to root
    });

    it('should preserve empty lines', async () => {
      const stream = streamFromString('hello\n\nworld\n');
      const result = await preprocess(stream);
      assert.ok(result.includes('\n\n')); // Empty line preserved
    });

    it('should generate EOF dedents', async () => {
      const stream = streamFromString('\thello\n');
      const result = await preprocess(stream);
      // Should have DEDENT at end to close the indent
      const lines = result.split('\n');
      const lastNonEmpty = lines.filter(l => l.length > 0).pop();
      assert.ok(lastNonEmpty?.includes('⇤'));
    });

    it('should handle indentation on first line', async () => {
      const stream = streamFromString('\tfirst\nsecond\n');
      const result = await preprocess(stream);
      assert.ok(result.startsWith('⟨1,1⟩⇥'));
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
      assert.ok(result.includes('⇥')); // INDENT token
      assert.ok(result.includes('world'));
    });

    it('should respect "use spaces" directive with double quotes', async () => {
      const stream = streamFromString('"use spaces"\nhello\n  world\n');
      const result = await preprocess(stream, { mode: 'directive' });
      assert.ok(result.includes('⇥')); // INDENT token
      assert.ok(result.includes('world'));
    });

    it('should respect "use spaces" directive with single quotes', async () => {
      const stream = streamFromString("'use spaces'\nhello\n  world\n");
      const result = await preprocess(stream, { mode: 'directive' });
      assert.ok(result.includes('⇥'));
      assert.ok(result.includes('world'));
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
      assert.ok(!result.includes('use spaces'));
      assert.ok(result.includes('hello'));
    });
  });

  describe('detect mode (default)', () => {
    it('should detect tabs from first indented line', async () => {
      const stream = streamFromString('hello\n\tworld\n\tnested\n');
      const result = await preprocess(stream);
      // Should have 2 INDENT tokens (one for world, one for nested at same level)
      // Actually nested is at same level as world, so no second indent
      assert.ok(result.includes('⇥'));
      assert.ok(result.includes('world'));
      assert.ok(result.includes('nested'));
    });

    it('should detect spaces from first indented line', async () => {
      const stream = streamFromString('hello\n  world\n  nested\n');
      const result = await preprocess(stream);
      assert.ok(result.includes('⇥'));
    });

    it('should allow files with no indentation', async () => {
      const stream = streamFromString('hello\nworld\ndone\n');
      const result = await preprocess(stream);
      assert.strictEqual(result, 'hello\nworld\ndone\n');
    });
  });

  describe('level encoding', () => {
    it('should encode level 1 for single tab', async () => {
      const stream = streamFromString('\thello\n');
      const result = await preprocess(stream);
      // 1 tab = level 1
      assert.ok(result.includes('⟨1,1⟩⇥'));
    });

    it('should encode level 2 for two tabs (incremental)', async () => {
      const stream = streamFromString('a\n\tb\n\t\thello\n');
      const result = await preprocess(stream);
      // Line 2: level 1, Line 3: level 2
      assert.ok(result.includes('⟨2,1⟩⇥')); // entering level 1
      assert.ok(result.includes('⟨3,2⟩⇥')); // entering level 2
    });

    it('should encode level 1 for spaces (unit detected)', async () => {
      const stream = streamFromString('    hello\n');
      const result = await preprocess(stream);
      // 4 spaces = level 1 (unit = 4)
      assert.ok(result.includes('⟨1,1⟩⇥'));
    });

    it('should encode DEDENT positions correctly', async () => {
      const stream = streamFromString('\thello\nworld\n');
      const result = await preprocess(stream);
      // DEDENT at line 2, level 0
      assert.ok(result.includes('⟨2,0⟩⇤'));
    });

    it('should detect indent unit from first indent (2 spaces)', async () => {
      const stream = streamFromString('a\n  b\n    c\n');
      const result = await preprocess(stream);
      // 2 spaces = unit, so 4 spaces = level 2
      assert.ok(result.includes('⟨2,1⟩⇥')); // level 1
      assert.ok(result.includes('⟨3,2⟩⇥')); // level 2
    });

    it('should detect indent unit from first indent (4 spaces)', async () => {
      const stream = streamFromString('a\n    b\n        c\n');
      const result = await preprocess(stream);
      // 4 spaces = unit, so 8 spaces = level 2
      assert.ok(result.includes('⟨2,1⟩⇥')); // level 1
      assert.ok(result.includes('⟨3,2⟩⇥')); // level 2
    });
  });

  describe('indent jump errors', () => {
    it('should throw on jumping more than one level with tabs', async () => {
      const stream = streamFromString('a\n\t\tb\n');
      await assert.rejects(
        () => preprocess(stream),
        (err: IndentationError) => {
          // From level 0, jumping to 2 tabs = level 2
          assert.ok(err.message.includes('Use 1 tab, not 2'));
          return true;
        }
      );
    });

    it('should throw on jumping more than one level with spaces', async () => {
      const stream = streamFromString('a\n    b\n            c\n');
      await assert.rejects(
        () => preprocess(stream),
        (err: IndentationError) => {
          // 4 spaces = unit, then 12 spaces = +8, not +4
          assert.ok(err.message.includes('Add 4 spaces, not 8'));
          return true;
        }
      );
    });

    it('should throw on inconsistent space indentation', async () => {
      const stream = streamFromString('a\n  b\n   c\n');
      await assert.rejects(
        () => preprocess(stream),
        (err: IndentationError) => {
          assert.ok(err.message.includes('2-space indentation'));
          return true;
        }
      );
    });

    it('should throw on invalid dedent (mismatched spaces)', async () => {
      const stream = streamFromString('a\n   b\n      c\n  d\n');
      await assert.rejects(
        () => preprocess(stream),
        (err: IndentationError) => {
          // Valid levels: 0, 3, 6 spaces
          assert.ok(err.message.includes('Unindent to 0, 3, 6 spaces'));
          return true;
        }
      );
    });
  });

  describe('fixture file streaming', () => {
    it('should process tabs-only.tw fixture', async () => {
      const stream = createReadStream(fixturesPath('tabs-only.tw'), 'utf-8');
      const result = await preprocess(stream);
      // Should have INDENT tokens
      assert.ok(result.includes('⇥'));
      // Should have content (comments)
      assert.ok(result.includes('# top level'));
      assert.ok(result.includes('# indented'));
      assert.ok(result.includes('# nested'));
    });

    it('should process spaces-only.tw fixture', async () => {
      const stream = createReadStream(fixturesPath('spaces-only.tw'), 'utf-8');
      const result = await preprocess(stream);
      assert.ok(result.includes('⇥'));
      assert.ok(result.includes('# top level'));
    });

    it('should process no-indent.tw fixture', async () => {
      const stream = createReadStream(fixturesPath('no-indent.tw'), 'utf-8');
      const result = await preprocess(stream);
      assert.strictEqual(result, '# first\n# second\n# third\n');
    });

    it('should process empty.tw fixture', async () => {
      const stream = createReadStream(fixturesPath('empty.tw'), 'utf-8');
      const result = await preprocess(stream);
      assert.strictEqual(result, '');
    });

    it('should reject mixed-indent.tw fixture', async () => {
      const stream = createReadStream(fixturesPath('mixed-indent.tw'), 'utf-8');
      await assert.rejects(
        () => preprocess(stream),
        (err: IndentationError) => {
          assert.strictEqual(err.name, 'IndentationError');
          return true;
        }
      );
    });
  });
});
