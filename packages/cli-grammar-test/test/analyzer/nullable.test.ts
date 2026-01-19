import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { grammar } from 'ohm-js'
import { analyzeNullable, findNullableRules } from '../../src/analyzer/nullable.ts'

describe('findNullableRules', () => {
	it('should detect Star as nullable', () => {
		const g = grammar(`
			Simple {
				Start = digit*
			}
		`)

		const nullable = findNullableRules(g)
		assert.ok(nullable.includes('Start'))
	})

	it('should detect Opt as nullable', () => {
		const g = grammar(`
			Simple {
				Start = digit?
			}
		`)

		const nullable = findNullableRules(g)
		assert.ok(nullable.includes('Start'))
	})

	it('should not detect Plus as nullable', () => {
		const g = grammar(`
			Simple {
				Start = digit+
			}
		`)

		const nullable = findNullableRules(g)
		assert.ok(!nullable.includes('Start'))
	})

	it('should detect empty terminal as nullable', () => {
		const g = grammar(`
			Simple {
				Start = ""
			}
		`)

		const nullable = findNullableRules(g)
		assert.ok(nullable.includes('Start'))
	})

	it('should detect lookahead as nullable', () => {
		const g = grammar(`
			Simple {
				Start = &digit
			}
		`)

		const nullable = findNullableRules(g)
		assert.ok(nullable.includes('Start'))
	})

	it('should detect negation as nullable', () => {
		const g = grammar(`
			Simple {
				Start = ~digit
			}
		`)

		const nullable = findNullableRules(g)
		assert.ok(nullable.includes('Start'))
	})

	it('should propagate nullability through rule references', () => {
		const g = grammar(`
			Simple {
				Start = Empty
				Empty = ""
			}
		`)

		const nullable = findNullableRules(g)
		assert.ok(nullable.includes('Start'))
		assert.ok(nullable.includes('Empty'))
	})

	it('should detect nullable alternative', () => {
		const g = grammar(`
			Simple {
				Start = digit | ""
			}
		`)

		const nullable = findNullableRules(g)
		assert.ok(nullable.includes('Start'))
	})

	it('should detect nullable sequence (all elements nullable)', () => {
		const g = grammar(`
			Simple {
				Start = digit* letter*
			}
		`)

		const nullable = findNullableRules(g)
		assert.ok(nullable.includes('Start'))
	})

	it('should not detect non-nullable sequence', () => {
		const g = grammar(`
			Simple {
				Start = digit* letter+
			}
		`)

		const nullable = findNullableRules(g)
		assert.ok(!nullable.includes('Start'))
	})
})

describe('analyzeNullable', () => {
	it('should generate issues for nullable rules', () => {
		const g = grammar(`
			Simple {
				Start = digit*
			}
		`)

		const issues = analyzeNullable(g)
		assert.equal(issues.length, 1)
		assert.equal(issues[0]?.code, 'NULLABLE_RULE')
		assert.equal(issues[0]?.rule, 'Start')
		assert.equal(issues[0]?.severity, 'info')
	})

	it('should include AI hint', () => {
		const g = grammar(`
			Simple {
				Start = digit*
			}
		`)

		const issues = analyzeNullable(g)
		assert.ok(issues[0]?.aiHint?.includes('empty string'))
	})
})
