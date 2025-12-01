import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Readable } from 'node:stream';
import {
  TinyWhaleGrammar,
  grammars,
  parse,
  match,
  createSemantics,
  type IndentToken,
  type Position,
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

    it('should match single INDENT token', () => {
      const result = match('⟨1,1,1⟩⇥hello\n');
      assert.ok(result.succeeded());
    });

    it('should match single DEDENT token', () => {
      const result = match('⟨2,1,0⟩⇤hello\n');
      assert.ok(result.succeeded());
    });

    it('should match multiple INDENT tokens', () => {
      const result = match('⟨1,1,1⟩⇥⟨1,1,2⟩⇥hello\n');
      assert.ok(result.succeeded());
    });

    it('should match INDENT followed by DEDENT', () => {
      const input = 'hello\n⟨2,1,1⟩⇥world\n⟨3,1,0⟩⇤back\n';
      const result = match(input);
      assert.ok(result.succeeded());
    });

    it('should match blank lines', () => {
      const result = match('hello\n\nworld\n');
      assert.ok(result.succeeded());
    });

    it('should match EOF dedents', () => {
      const result = match('hello\n⟨2,1,1⟩⇥world\n⟨2,1,0⟩⇤');
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
      assert.strictEqual(result.lines[0].indentTokens.length, 0);
      assert.strictEqual(result.lines[1].content, 'world');
    });

    it('should parse single INDENT token', () => {
      const result = parse('⟨1,1,4⟩⇥hello\n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 1);

      const line = result.lines[0];
      assert.strictEqual(line.content, 'hello');
      assert.strictEqual(line.indentTokens.length, 1);
      assert.strictEqual(line.indentTokens[0].type, 'indent');
      assert.deepStrictEqual(line.indentTokens[0].position, {
        line: 1,
        col: 1,
        len: 4,
      });
    });

    it('should parse DEDENT token', () => {
      const result = parse('⟨2,1,0⟩⇤hello\n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 1);

      const line = result.lines[0];
      assert.strictEqual(line.content, 'hello');
      assert.strictEqual(line.indentTokens.length, 1);
      assert.strictEqual(line.indentTokens[0].type, 'dedent');
    });

    it('should parse multiple indent tokens on same line', () => {
      const result = parse('⟨1,1,0⟩⇤⟨1,1,0⟩⇤hello\n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 1);
      assert.strictEqual(result.lines[0].indentTokens.length, 2);
      assert.strictEqual(result.lines[0].indentTokens[0].type, 'dedent');
      assert.strictEqual(result.lines[0].indentTokens[1].type, 'dedent');
    });

    it('should parse complex indentation sequence', () => {
      const input = [
        'root',
        '⟨2,1,1⟩⇥child1',
        '⟨3,1,2⟩⇥grandchild',
        '⟨4,1,0⟩⇤⟨4,1,0⟩⇤sibling',
        '',
      ].join('\n');

      const result = parse(input);
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 4);

      // root - no indent
      assert.strictEqual(result.lines[0].content, 'root');
      assert.strictEqual(result.lines[0].indentTokens.length, 0);

      // child1 - one INDENT
      assert.strictEqual(result.lines[1].content, 'child1');
      assert.strictEqual(result.lines[1].indentTokens.length, 1);
      assert.strictEqual(result.lines[1].indentTokens[0].type, 'indent');

      // grandchild - one more INDENT
      assert.strictEqual(result.lines[2].content, 'grandchild');
      assert.strictEqual(result.lines[2].indentTokens.length, 1);
      assert.strictEqual(result.lines[2].indentTokens[0].type, 'indent');

      // sibling - two DEDENTs
      assert.strictEqual(result.lines[3].content, 'sibling');
      assert.strictEqual(result.lines[3].indentTokens.length, 2);
      assert.strictEqual(result.lines[3].indentTokens[0].type, 'dedent');
      assert.strictEqual(result.lines[3].indentTokens[1].type, 'dedent');
    });
  });

  describe('semantics', () => {
    it('should allow creating multiple semantics instances', () => {
      const sem1 = createSemantics();
      const sem2 = createSemantics();
      assert.notStrictEqual(sem1, sem2);
    });

    it('should extract position from indent token', () => {
      const sem = createSemantics();
      const matchResult = TinyWhaleGrammar.match('⟨5,1,3⟩⇥', 'indent');
      assert.ok(matchResult.succeeded());

      const token: IndentToken = sem(matchResult).toIndentToken();
      assert.strictEqual(token.type, 'indent');
      assert.deepStrictEqual(token.position, {
        line: 5,
        col: 1,
        len: 3,
      });
    });

    it('should extract position from dedent token', () => {
      const sem = createSemantics();
      const matchResult = TinyWhaleGrammar.match('⟨10,1,0⟩⇤', 'dedent');
      assert.ok(matchResult.succeeded());

      const token: IndentToken = sem(matchResult).toIndentToken();
      assert.strictEqual(token.type, 'dedent');
      assert.strictEqual(token.position.line, 10);
    });
  });

  describe('preprocessor integration', () => {
    it('should parse preprocessed tab-indented file', async () => {
      const source = 'hello\n\tworld\n\t\tnested\n';
      const stream = streamFromString(source);
      const preprocessed = await preprocess(stream);

      const result = parse(preprocessed);
      assert.strictEqual(result.succeeded, true);

      // hello, world (with INDENT), nested (with INDENT), EOF DEDENTs
      const contentLines = result.lines.filter(l => l.content.length > 0);
      assert.strictEqual(contentLines.length, 3);

      // hello - no indent
      assert.strictEqual(contentLines[0].content, 'hello');
      assert.strictEqual(contentLines[0].indentTokens.length, 0);

      // world - one INDENT
      assert.strictEqual(contentLines[1].content, 'world');
      assert.strictEqual(contentLines[1].indentTokens.length, 1);
      assert.strictEqual(contentLines[1].indentTokens[0].type, 'indent');

      // nested - one more INDENT
      assert.strictEqual(contentLines[2].content, 'nested');
      assert.strictEqual(contentLines[2].indentTokens.length, 1);
      assert.strictEqual(contentLines[2].indentTokens[0].type, 'indent');
    });

    it('should parse preprocessed space-indented file', async () => {
      const source = 'hello\n  world\n    nested\n';
      const stream = streamFromString(source);
      const preprocessed = await preprocess(stream);

      const result = parse(preprocessed);
      assert.strictEqual(result.succeeded, true);

      const contentLines = result.lines.filter(l => l.content.length > 0);
      assert.strictEqual(contentLines.length, 3);

      // Check INDENT positions encode original whitespace length
      assert.strictEqual(contentLines[1].indentTokens[0].position.len, 2); // 2 spaces
      assert.strictEqual(contentLines[2].indentTokens[0].position.len, 4); // 4 spaces
    });

    it('should handle file with no indentation', async () => {
      const source = 'line1\nline2\nline3\n';
      const stream = streamFromString(source);
      const preprocessed = await preprocess(stream);

      const result = parse(preprocessed);
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 3);
      assert.ok(result.lines.every(l => l.indentTokens.length === 0));
    });

    it('should handle empty file', async () => {
      const source = '';
      const stream = streamFromString(source);
      const preprocessed = await preprocess(stream);

      const result = parse(preprocessed);
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 0);
    });

    it('should generate EOF dedents', async () => {
      const source = 'root\n\tchild\n\t\tgrandchild\n';
      const stream = streamFromString(source);
      const preprocessed = await preprocess(stream);

      // Should have 2 DEDENTs at EOF
      assert.ok(preprocessed.includes('⇤'));

      const result = parse(preprocessed);
      assert.strictEqual(result.succeeded, true);

      // Find lines with DEDENT tokens
      const dedentLines = result.lines.filter(
        l => l.indentTokens.some(t => t.type === 'dedent')
      );
      // EOF dedents should be on their own line(s)
      assert.ok(dedentLines.length > 0);
    });

    it('should handle dedent back to root level', async () => {
      const source = 'root\n\tchild1\nroot2\n';
      const stream = streamFromString(source);
      const preprocessed = await preprocess(stream);

      const result = parse(preprocessed);
      assert.strictEqual(result.succeeded, true);

      const contentLines = result.lines.filter(l => l.content.length > 0);
      // root2 should have a DEDENT before it
      const root2Line = contentLines.find(l => l.content === 'root2');
      assert.ok(root2Line);
      assert.strictEqual(root2Line.indentTokens.length, 1);
      assert.strictEqual(root2Line.indentTokens[0].type, 'dedent');
    });
  });

  describe('edge cases', () => {
    it('should handle line with only indent tokens', () => {
      const result = parse('⟨1,1,1⟩⇥\n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 1);
      assert.strictEqual(result.lines[0].content, '');
      assert.strictEqual(result.lines[0].indentTokens.length, 1);
    });

    it('should handle multiple blank lines', () => {
      const result = parse('\n\n\nhello\n\n\n');
      assert.strictEqual(result.succeeded, true);
      const nonBlank = result.lines.filter(l => l.content !== '');
      assert.strictEqual(nonBlank.length, 1);
      assert.strictEqual(nonBlank[0].content, 'hello');
    });

    it('should handle input without trailing newline', () => {
      const result = parse('hello');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 1);
      assert.strictEqual(result.lines[0].content, 'hello');
    });

    it('should handle large position numbers', () => {
      const result = parse('⟨999,100,200⟩⇥content\n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines[0].indentTokens[0].position.line, 999);
      assert.strictEqual(result.lines[0].indentTokens[0].position.col, 100);
      assert.strictEqual(result.lines[0].indentTokens[0].position.len, 200);
    });
  });
});
