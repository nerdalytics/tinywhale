import assert from 'node:assert'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import {
	createSemantics,
	type IndentToken,
	match,
	parse,
	TinyWhaleGrammar,
} from '../src/grammar/index.ts'
import { preprocess } from '../src/preprocessor/index.ts'

function streamFromString(text: string): Readable {
	return Readable.from(text)
}

describe('grammar', () => {
	describe('grammar loading', () => {
		it('should load TinyWhale grammar', () => {
			assert.ok(TinyWhaleGrammar)
			assert.strictEqual(typeof TinyWhaleGrammar.match, 'function')
		})
	})

	describe('match function', () => {
		it('should match empty input', () => {
			const result = match('')
			assert.ok(result.succeeded())
		})

		it('should match single INDENT token', () => {
			const result = match('⟨1,1⟩⇥\n')
			assert.ok(result.succeeded())
		})

		it('should match single DEDENT token', () => {
			const result = match('⟨2,0⟩⇤\n')
			assert.ok(result.succeeded())
		})

		it('should match INDENT followed by DEDENT', () => {
			const input = '⟨1,1⟩⇥\n⟨2,0⟩⇤\n'
			const result = match(input)
			assert.ok(result.succeeded())
		})

		it('should match blank lines', () => {
			const result = match('\n\n\n')
			assert.ok(result.succeeded())
		})

		it('should match EOF dedents', () => {
			const result = match('⟨1,1⟩⇥\n⟨2,0⟩⇤')
			assert.ok(result.succeeded())
		})

		it('should skip line comments (treated as whitespace)', () => {
			const result = match('# this is a comment\n')
			assert.ok(result.succeeded())
		})

		it('should skip inline comments (treated as whitespace)', () => {
			// Multiple toggle comments: # ... # # ... #
			const result = match('⟨1,1⟩⇥ # comment # # more comment #\n')
			assert.ok(result.succeeded())
		})

		it('should skip empty comment (##)', () => {
			const result = match('##\n')
			assert.ok(result.succeeded())
		})

		it('should match indent token with surrounding comments', () => {
			const result = match('# before # ⟨1,1⟩⇥ # after\n')
			assert.ok(result.succeeded())
		})
	})

	describe('parse function', () => {
		it('should parse empty input', () => {
			const result = parse('')
			assert.strictEqual(result.succeeded, true)
			assert.strictEqual(result.lines.length, 0)
		})

		it('should parse blank lines only (skipped as whitespace)', () => {
			const result = parse('\n\n\n')
			assert.strictEqual(result.succeeded, true)
			assert.strictEqual(result.lines.length, 0) // no indent tokens
		})

		it('should parse single INDENT token', () => {
			const result = parse('⟨1,1⟩⇥\n')
			assert.strictEqual(result.succeeded, true)
			assert.strictEqual(result.lines.length, 1)

			const line = result.lines[0]
			assert.strictEqual(line.indentTokens.length, 1)
			assert.strictEqual(line.indentTokens[0].type, 'indent')
			assert.deepStrictEqual(line.indentTokens[0].position, {
				level: 1,
				line: 1,
			})
		})

		it('should parse DEDENT token', () => {
			const result = parse('⟨2,0⟩⇤\n')
			assert.strictEqual(result.succeeded, true)
			assert.strictEqual(result.lines.length, 1)

			const line = result.lines[0]
			assert.strictEqual(line.indentTokens.length, 1)
			assert.strictEqual(line.indentTokens[0].type, 'dedent')
		})

		it('should parse multiple dedent tokens on same line', () => {
			const result = parse('⟨1,0⟩⇤⟨1,0⟩⇤\n')
			assert.strictEqual(result.succeeded, true)
			assert.strictEqual(result.lines.length, 1)
			assert.strictEqual(result.lines[0].indentTokens.length, 2)
			assert.strictEqual(result.lines[0].indentTokens[0].type, 'dedent')
			assert.strictEqual(result.lines[0].indentTokens[1].type, 'dedent')
		})

		it('should parse complex indentation sequence', () => {
			const input = ['⟨1,1⟩⇥', '⟨2,2⟩⇥', '⟨3,0⟩⇤⟨3,0⟩⇤', ''].join('\n')

			const result = parse(input)
			assert.strictEqual(result.succeeded, true)
			assert.strictEqual(result.lines.length, 3)

			// Line 1 - one INDENT (level 1)
			assert.strictEqual(result.lines[0].indentTokens.length, 1)
			assert.strictEqual(result.lines[0].indentTokens[0].type, 'indent')
			assert.strictEqual(result.lines[0].indentTokens[0].position.level, 1)

			// Line 2 - one more INDENT (level 2)
			assert.strictEqual(result.lines[1].indentTokens[0].position.level, 2)

			// Line 3 - two DEDENTs
			assert.strictEqual(result.lines[2].indentTokens.length, 2)
		})

		it('should skip comments (not in AST)', () => {
			// Comments are treated as whitespace, so lines with only comments are blank
			const result = parse('# just a comment\n')
			assert.strictEqual(result.succeeded, true)
			assert.strictEqual(result.lines.length, 0) // comment-only line is blank
		})

		it('should parse indent token with comments around it', () => {
			const result = parse('# comment # ⟨1,1⟩⇥ # trailing\n')
			assert.strictEqual(result.succeeded, true)
			assert.strictEqual(result.lines.length, 1)
			assert.strictEqual(result.lines[0].indentTokens.length, 1)
			assert.strictEqual(result.lines[0].indentTokens[0].type, 'indent')
		})
	})

	describe('semantics', () => {
		it('should allow creating multiple semantics instances', () => {
			const sem1 = createSemantics()
			const sem2 = createSemantics()
			assert.notStrictEqual(sem1, sem2)
		})

		it('should extract position from indent token', () => {
			const sem = createSemantics()
			const matchResult = TinyWhaleGrammar.match('⟨5,2⟩⇥', 'indentToken')
			assert.ok(matchResult.succeeded())

			const token: IndentToken = sem(matchResult).toIndentToken()
			assert.strictEqual(token.type, 'indent')
			assert.deepStrictEqual(token.position, {
				level: 2,
				line: 5,
			})
		})

		it('should extract position from dedent token', () => {
			const sem = createSemantics()
			const matchResult = TinyWhaleGrammar.match('⟨10,0⟩⇤', 'dedentToken')
			assert.ok(matchResult.succeeded())

			const token: IndentToken = sem(matchResult).toIndentToken()
			assert.strictEqual(token.type, 'dedent')
			assert.strictEqual(token.position.line, 10)
			assert.strictEqual(token.position.level, 0)
		})
	})

	describe('preprocessor integration', () => {
		it('should parse preprocessed tab-indented file', async () => {
			const source = '# top\n\t# child\n\t\t# nested\n'
			const stream = streamFromString(source)
			const preprocessed = await preprocess(stream)

			const result = parse(preprocessed)
			assert.strictEqual(result.succeeded, true)

			// Comments are skipped, so we only see indent structure
			// Line 1: no indent (comment skipped)
			// Line 2: INDENT to level 1
			// Line 3: INDENT to level 2
			// EOF: DEDENTs back to 0
			const indentLines = result.lines.filter((l) =>
				l.indentTokens.some((t) => t.type === 'indent')
			)
			assert.strictEqual(indentLines.length, 2)
		})

		it('should parse preprocessed space-indented file', async () => {
			const source = '# top\n  # child\n    # nested\n'
			const stream = streamFromString(source)
			const preprocessed = await preprocess(stream)

			const result = parse(preprocessed)
			assert.strictEqual(result.succeeded, true)

			// Check INDENT positions encode indent levels
			const indentLines = result.lines.filter((l) =>
				l.indentTokens.some((t) => t.type === 'indent')
			)
			assert.strictEqual(indentLines[0].indentTokens[0].position.level, 1)
			assert.strictEqual(indentLines[1].indentTokens[0].position.level, 2)
		})

		it('should handle file with no indentation', async () => {
			const source = '# line1\n# line2\n# line3\n'
			const stream = streamFromString(source)
			const preprocessed = await preprocess(stream)

			const result = parse(preprocessed)
			assert.strictEqual(result.succeeded, true)
			// All comment-only lines become blank
			assert.strictEqual(result.lines.length, 0)
		})

		it('should handle empty file', async () => {
			const source = ''
			const stream = streamFromString(source)
			const preprocessed = await preprocess(stream)

			const result = parse(preprocessed)
			assert.strictEqual(result.succeeded, true)
			assert.strictEqual(result.lines.length, 0)
		})

		it('should generate EOF dedents', async () => {
			const source = '# root\n\t# child\n\t\t# grandchild\n'
			const stream = streamFromString(source)
			const preprocessed = await preprocess(stream)

			// Should have DEDENTs at EOF
			assert.ok(preprocessed.includes('⇤'))

			const result = parse(preprocessed)
			assert.strictEqual(result.succeeded, true)

			// Find lines with DEDENT tokens
			const dedentLines = result.lines.filter((l) =>
				l.indentTokens.some((t) => t.type === 'dedent')
			)
			assert.ok(dedentLines.length > 0)
		})

		it('should handle dedent back to root level', async () => {
			const source = '# root\n\t# child1\n# root2\n'
			const stream = streamFromString(source)
			const preprocessed = await preprocess(stream)

			const result = parse(preprocessed)
			assert.strictEqual(result.succeeded, true)

			// Should have a DEDENT line
			const dedentLines = result.lines.filter((l) =>
				l.indentTokens.some((t) => t.type === 'dedent')
			)
			assert.ok(dedentLines.length > 0)
		})
	})

	describe('edge cases', () => {
		it('should handle multiple blank lines', () => {
			const result = parse('\n\n\n⟨4,1⟩⇥\n\n\n')
			assert.strictEqual(result.succeeded, true)
			const nonBlank = result.lines.filter((l) => l.indentTokens.length > 0)
			assert.strictEqual(nonBlank.length, 1)
		})

		it('should handle input without trailing newline', () => {
			const result = parse('⟨1,1⟩⇥')
			assert.strictEqual(result.succeeded, true)
			assert.strictEqual(result.lines.length, 1)
		})

		it('should handle large position numbers', () => {
			const result = parse('⟨999,100⟩⇥\n')
			assert.strictEqual(result.succeeded, true)
			assert.strictEqual(result.lines[0].indentTokens[0].position.line, 999)
			assert.strictEqual(result.lines[0].indentTokens[0].position.level, 100)
		})

		it('should handle comment-only lines as blank', () => {
			// A line with only comments should be treated as blank
			const result = parse('# comment 1 # # comment 2 #\n')
			assert.strictEqual(result.succeeded, true)
			assert.strictEqual(result.lines.length, 0)
		})
	})
})
