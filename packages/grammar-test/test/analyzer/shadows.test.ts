import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { grammar } from 'ohm-js'
import { analyzeShadows } from '../../src/analyzer/shadows.ts'

describe('analyzeShadows', () => {
	it('should detect overlapping terminals', () => {
		const g = grammar(`
			Simple {
				Start = "a" | "a"
			}
		`)

		const issues = analyzeShadows(g)
		assert.equal(issues.length, 1)
		assert.equal(issues[0]?.code, 'SHADOWED_ALTERNATIVE')
	})

	it('should not report non-overlapping alternatives', () => {
		const g = grammar(`
			Simple {
				Start = "a" | "b"
			}
		`)

		const issues = analyzeShadows(g)
		assert.equal(issues.length, 0)
	})

	it('should detect overlapping through rule references', () => {
		const g = grammar(`
			Simple {
				Start = A | B
				A = "x"
				B = "x"
			}
		`)

		const issues = analyzeShadows(g)
		assert.equal(issues.length, 1)
	})

	it('should detect multiple overlaps', () => {
		const g = grammar(`
			Simple {
				Start = "a" | "a" | "a"
			}
		`)

		const issues = analyzeShadows(g)
		// 3 pairs: (1,2), (1,3), (2,3)
		assert.equal(issues.length, 3)
	})

	it('should include overlap details in message', () => {
		const g = grammar(`
			Simple {
				Start = "abc" | "axy"
			}
		`)

		const issues = analyzeShadows(g)
		assert.equal(issues.length, 1)
		assert.ok(issues[0]?.message.includes('alternatives 1 and 2'))
	})

	it('should have warning severity', () => {
		const g = grammar(`
			Simple {
				Start = "a" | "a"
			}
		`)

		const issues = analyzeShadows(g)
		assert.equal(issues[0]?.severity, 'warning')
	})

	it('should not report issues for non-Alt rules', () => {
		const g = grammar(`
			Simple {
				Start = "a" "b"
			}
		`)

		const issues = analyzeShadows(g)
		assert.equal(issues.length, 0)
	})

	it('should handle ranges', () => {
		const g = grammar(`
			Simple {
				Start = "a".."z" | "a".."z"
			}
		`)

		const issues = analyzeShadows(g)
		assert.equal(issues.length, 1)
	})
})
