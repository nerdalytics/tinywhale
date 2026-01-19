import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import {
	analyzeLexicalRules,
	analyzeNaming,
	analyzeNullable,
	analyzeReachability,
	analyzeRedundancy,
	analyzeShadows,
	analyzeSyntacticRules,
	findUnreachableRules,
} from '@tinywhale/grammar-test'
import * as ohm from 'ohm-js'

// Resolve path relative to this test file
// import.meta.dirname is available in Node.js 20.11+ / 22+
// Fallback for older environments or if TS complains (though we are on Node 25)
const DIRNAME = import.meta.dirname || path.dirname(new URL(import.meta.url).pathname)
const GRAMMAR_PATH = path.resolve(DIRNAME, '../src/parse/tinywhale.ohm')

test('Grammar Analysis', async (t) => {
	// 1. Ensure grammar file exists and load it
	assert.ok(fs.existsSync(GRAMMAR_PATH), `Grammar file not found at ${GRAMMAR_PATH}`)
	const source = fs.readFileSync(GRAMMAR_PATH, 'utf-8')
	const grammar = ohm.grammar(source)

	// 2. Run Analysis
	await t.test('Static Analysis', (t) => {
		const issues = [
			...analyzeReachability(grammar),
			...analyzeNullable(grammar),
			...analyzeNaming(grammar),
			...analyzeShadows(grammar),
			...analyzeRedundancy(grammar),
		]

		// Report issues
		if (issues.length > 0) {
			// We log them as diagnostics so they appear in the test output
			// but don't clutter standard output unless verbose
			t.diagnostic(`Found ${issues.length} grammar issues:`)

			// Group by severity
			const errors = issues.filter((i) => i.severity === 'error')
			const warnings = issues.filter((i) => i.severity === 'warning')
			const infos = issues.filter((i) => i.severity === 'info')

			if (errors.length > 0) {
				t.diagnostic(`Errors (${errors.length}):`)
				for (const i of errors) t.diagnostic(`  [!] ${i.code}: ${i.message}`)
			}
			if (warnings.length > 0) {
				t.diagnostic(`Warnings (${warnings.length}):`)
				for (const i of warnings) t.diagnostic(`  [W] ${i.code}: ${i.message}`)
			}
			if (infos.length > 0) {
				t.diagnostic(`Infos (${infos.length}):`)
				for (const i of infos) t.diagnostic(`  [i] ${i.code}: ${i.message}`)
			}

			// Fail on errors, but allow warnings/infos
			if (errors.length > 0) {
				assert.fail(`Found ${errors.length} grammar errors. See diagnostics for details.`)
			}
		}

		// Also collect stats
		const syntacticRules = analyzeSyntacticRules(grammar)
		const lexicalRules = analyzeLexicalRules(grammar)
		const unreachableRules = findUnreachableRules(grammar)

		t.diagnostic('Grammar Stats:')
		t.diagnostic(`  Syntactic Rules: ${syntacticRules.length}`)
		t.diagnostic(`  Lexical Rules: ${lexicalRules.length}`)
		t.diagnostic(`  Unreachable Rules: ${unreachableRules.length}`)
	})
})
