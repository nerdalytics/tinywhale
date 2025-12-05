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
  type Segment,
} from '../src/grammar/index.ts';
import { preprocess } from '../src/preprocessor/index.ts';

function streamFromString(text: string): Readable {
  return Readable.from(text);
}

/** Helper to get text content from segments */
function getContent(segments: Segment[]): string {
  return segments.map(s => s.type === 'comment' ? `#${s.content}#` : s.content).join('');
}

/** Helper to get raw text (ignoring comments) */
function getTextOnly(segments: Segment[]): string {
  return segments.filter(s => s.type === 'text').map(s => s.content).join('');
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
      const result = match('⟨1,1⟩⇥hello\n');
      assert.ok(result.succeeded());
    });

    it('should match single DEDENT token', () => {
      const result = match('⟨2,0⟩⇤hello\n');
      assert.ok(result.succeeded());
    });

    it('should match INDENT followed by DEDENT', () => {
      const input = 'hello\n⟨2,1⟩⇥world\n⟨3,0⟩⇤back\n';
      const result = match(input);
      assert.ok(result.succeeded());
    });

    it('should match blank lines', () => {
      const result = match('hello\n\nworld\n');
      assert.ok(result.succeeded());
    });

    it('should match EOF dedents', () => {
      const result = match('hello\n⟨2,1⟩⇥world\n⟨2,0⟩⇤');
      assert.ok(result.succeeded());
    });

    it('should match line comments', () => {
      const result = match('# this is a comment\n');
      assert.ok(result.succeeded());
    });

    it('should match inline comments', () => {
      const result = match('text # comment # more text\n');
      assert.ok(result.succeeded());
    });

    it('should match empty comment (##)', () => {
      const result = match('##\n');
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
      assert.strictEqual(result.lines[0].segments[0].content, 'hello');
      assert.strictEqual(result.lines[0].indentTokens.length, 0);
    });

    it('should parse single INDENT token', () => {
      const result = parse('⟨1,1⟩⇥hello\n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 1);

      const line = result.lines[0];
      assert.strictEqual(line.segments[0].content, 'hello');
      assert.strictEqual(line.indentTokens.length, 1);
      assert.strictEqual(line.indentTokens[0].type, 'indent');
      assert.deepStrictEqual(line.indentTokens[0].position, {
        line: 1,
        level: 1,
      });
    });

    it('should parse DEDENT token', () => {
      const result = parse('⟨2,0⟩⇤hello\n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 1);

      const line = result.lines[0];
      assert.strictEqual(line.segments[0].content, 'hello');
      assert.strictEqual(line.indentTokens.length, 1);
      assert.strictEqual(line.indentTokens[0].type, 'dedent');
    });

    it('should parse multiple dedent tokens on same line', () => {
      const result = parse('⟨1,0⟩⇤⟨1,0⟩⇤hello\n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 1);
      assert.strictEqual(result.lines[0].indentTokens.length, 2);
      assert.strictEqual(result.lines[0].indentTokens[0].type, 'dedent');
      assert.strictEqual(result.lines[0].indentTokens[1].type, 'dedent');
    });

    it('should parse complex indentation sequence', () => {
      const input = [
        'root',
        '⟨2,1⟩⇥child1',
        '⟨3,2⟩⇥grandchild',
        '⟨4,0⟩⇤⟨4,0⟩⇤sibling',
        '',
      ].join('\n');

      const result = parse(input);
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 4);

      // root - no indent
      assert.strictEqual(result.lines[0].segments[0].content, 'root');
      assert.strictEqual(result.lines[0].indentTokens.length, 0);

      // child1 - one INDENT (level 1)
      assert.strictEqual(result.lines[1].segments[0].content, 'child1');
      assert.strictEqual(result.lines[1].indentTokens.length, 1);
      assert.strictEqual(result.lines[1].indentTokens[0].type, 'indent');
      assert.strictEqual(result.lines[1].indentTokens[0].position.level, 1);

      // grandchild - one more INDENT (level 2)
      assert.strictEqual(result.lines[2].segments[0].content, 'grandchild');
      assert.strictEqual(result.lines[2].indentTokens[0].position.level, 2);

      // sibling - two DEDENTs
      assert.strictEqual(result.lines[3].segments[0].content, 'sibling');
      assert.strictEqual(result.lines[3].indentTokens.length, 2);
    });
  });

  describe('comment parsing', () => {
    it('should parse full line comment', () => {
      const result = parse('# this is a comment\n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 1);
      assert.strictEqual(result.lines[0].segments.length, 1);
      assert.strictEqual(result.lines[0].segments[0].type, 'comment');
      assert.strictEqual(result.lines[0].segments[0].content, ' this is a comment');
    });

    it('should parse inline toggle comment', () => {
      const result = parse('text # comment # more\n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines[0].segments.length, 3);
      assert.strictEqual(result.lines[0].segments[0].type, 'text');
      assert.strictEqual(result.lines[0].segments[0].content, 'text ');
      assert.strictEqual(result.lines[0].segments[1].type, 'comment');
      assert.strictEqual(result.lines[0].segments[1].content, ' comment ');
      assert.strictEqual(result.lines[0].segments[2].type, 'text');
      assert.strictEqual(result.lines[0].segments[2].content, ' more');
    });

    it('should parse empty comment (##)', () => {
      const result = parse('##\n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines[0].segments.length, 1);
      assert.strictEqual(result.lines[0].segments[0].type, 'comment');
      assert.strictEqual(result.lines[0].segments[0].content, '');
    });

    it('should parse multiple inline toggles', () => {
      // a # b # c # d → text, comment, text, comment
      const result = parse('a # b # c # d\n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines[0].segments.length, 4);
      assert.strictEqual(result.lines[0].segments[0].type, 'text');
      assert.strictEqual(result.lines[0].segments[1].type, 'comment');
      assert.strictEqual(result.lines[0].segments[2].type, 'text');
      assert.strictEqual(result.lines[0].segments[3].type, 'comment');
    });

    it('should parse comment with indentation', () => {
      const result = parse('⟨1,1⟩⇥# indented comment\n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines[0].indentTokens.length, 1);
      assert.strictEqual(result.lines[0].segments[0].type, 'comment');
      assert.strictEqual(result.lines[0].segments[0].content, ' indented comment');
    });

    it('should parse comment before dedent', () => {
      const result = parse('text # comment\n⟨2,0⟩⇤back\n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 2);
      assert.strictEqual(result.lines[0].segments[1].type, 'comment');
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
      const matchResult = TinyWhaleGrammar.match('⟨5,2⟩⇥', 'indentToken');
      assert.ok(matchResult.succeeded());

      const token: IndentToken = sem(matchResult).toIndentToken();
      assert.strictEqual(token.type, 'indent');
      assert.deepStrictEqual(token.position, {
        line: 5,
        level: 2,
      });
    });

    it('should extract position from dedent token', () => {
      const sem = createSemantics();
      const matchResult = TinyWhaleGrammar.match('⟨10,0⟩⇤', 'dedentToken');
      assert.ok(matchResult.succeeded());

      const token: IndentToken = sem(matchResult).toIndentToken();
      assert.strictEqual(token.type, 'dedent');
      assert.strictEqual(token.position.line, 10);
      assert.strictEqual(token.position.level, 0);
    });
  });

  describe('preprocessor integration', () => {
    it('should parse preprocessed tab-indented file', async () => {
      const source = '# top\n\t# child\n\t\t# nested\n';
      const stream = streamFromString(source);
      const preprocessed = await preprocess(stream);

      const result = parse(preprocessed);
      assert.strictEqual(result.succeeded, true);

      const contentLines = result.lines.filter(l => l.segments.length > 0);
      assert.strictEqual(contentLines.length, 3);

      // First line - no indent, comment
      assert.strictEqual(contentLines[0].indentTokens.length, 0);
      assert.strictEqual(contentLines[0].segments[0].type, 'comment');

      // Second line - one INDENT
      assert.strictEqual(contentLines[1].indentTokens.length, 1);
      assert.strictEqual(contentLines[1].indentTokens[0].type, 'indent');

      // Third line - one more INDENT
      assert.strictEqual(contentLines[2].indentTokens.length, 1);
      assert.strictEqual(contentLines[2].indentTokens[0].type, 'indent');
    });

    it('should parse preprocessed space-indented file', async () => {
      const source = '# top\n  # child\n    # nested\n';
      const stream = streamFromString(source);
      const preprocessed = await preprocess(stream);

      const result = parse(preprocessed);
      assert.strictEqual(result.succeeded, true);

      const contentLines = result.lines.filter(l => l.segments.length > 0);
      assert.strictEqual(contentLines.length, 3);

      // Check INDENT positions encode indent levels
      assert.strictEqual(contentLines[1].indentTokens[0].position.level, 1);
      assert.strictEqual(contentLines[2].indentTokens[0].position.level, 2);
    });

    it('should handle file with no indentation', async () => {
      const source = '# line1\n# line2\n# line3\n';
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
      const source = '# root\n\t# child\n\t\t# grandchild\n';
      const stream = streamFromString(source);
      const preprocessed = await preprocess(stream);

      // Should have DEDENTs at EOF
      assert.ok(preprocessed.includes('⇤'));

      const result = parse(preprocessed);
      assert.strictEqual(result.succeeded, true);

      // Find lines with DEDENT tokens
      const dedentLines = result.lines.filter(
        l => l.indentTokens.some(t => t.type === 'dedent')
      );
      assert.ok(dedentLines.length > 0);
    });

    it('should handle dedent back to root level', async () => {
      const source = '# root\n\t# child1\n# root2\n';
      const stream = streamFromString(source);
      const preprocessed = await preprocess(stream);

      const result = parse(preprocessed);
      assert.strictEqual(result.succeeded, true);

      // Find lines with root2 content (has DEDENT)
      const hasRoot2 = result.lines.some(l =>
        l.segments.some(s => s.content.includes('root2')) &&
        l.indentTokens.some(t => t.type === 'dedent')
      );
      assert.ok(hasRoot2);
    });
  });

  describe('edge cases', () => {
    it('should handle multiple blank lines', () => {
      const result = parse('\n\n\n# hello\n\n\n');
      assert.strictEqual(result.succeeded, true);
      const nonBlank = result.lines.filter(l => l.segments.length > 0);
      assert.strictEqual(nonBlank.length, 1);
    });

    it('should handle input without trailing newline', () => {
      const result = parse('hello');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines.length, 1);
      assert.strictEqual(result.lines[0].segments[0].content, 'hello');
    });

    it('should handle large position numbers', () => {
      const result = parse('⟨999,100⟩⇥content\n');
      assert.strictEqual(result.succeeded, true);
      assert.strictEqual(result.lines[0].indentTokens[0].position.line, 999);
      assert.strictEqual(result.lines[0].indentTokens[0].position.level, 100);
    });
  });
});
