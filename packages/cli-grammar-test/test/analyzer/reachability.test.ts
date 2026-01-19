import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { grammar } from 'ohm-js'
import { analyzeReachability, findUnreachableRules } from '../../src/analyzer/reachability.ts'

describe('analyzeReachability', () => {
	it('should find no issues when all rules are reachable', () => {
		const g = grammar(`
			Simple {
				Start = Item+
				Item = digit
			}
		`)

		const issues = analyzeReachability(g)
		assert.equal(issues.length, 0)
	})

	it('should detect unreachable rules', () => {
		const g = grammar(`
			Simple {
				Start = digit+
				Unused = letter+
			}
		`)

		const issues = analyzeReachability(g)
		assert.equal(issues.length, 1)
		assert.equal(issues[0]?.code, 'UNREACHABLE_RULE')
		assert.equal(issues[0]?.rule, 'Unused')
		assert.equal(issues[0]?.severity, 'warning')
	})

	it('should follow nested rule references', () => {
		const g = grammar(`
			Simple {
				Start = Middle
				Middle = Inner
				Inner = digit
			}
		`)

		const issues = analyzeReachability(g)
		assert.equal(issues.length, 0)
	})

	it('should handle alternatives', () => {
		const g = grammar(`
			Simple {
				Start = A | B
				A = digit
				B = letter
			}
		`)

		const issues = analyzeReachability(g)
		assert.equal(issues.length, 0)
	})

	it('should handle sequences', () => {
		const g = grammar(`
			Simple {
				Start = A B
				A = digit
				B = letter
			}
		`)

		const issues = analyzeReachability(g)
		assert.equal(issues.length, 0)
	})

	it('should handle Star/Plus/Opt', () => {
		const g = grammar(`
			Simple {
				Start = A* B+ C?
				A = digit
				B = letter
				C = "_"
			}
		`)

		const issues = analyzeReachability(g)
		assert.equal(issues.length, 0)
	})
})

describe('findUnreachableRules', () => {
	it('should return list of unreachable rule names', () => {
		const g = grammar(`
			Simple {
				Start = digit+
				Unused = letter+
				AlsoUnused = "_"
			}
		`)

		const unreachable = findUnreachableRules(g)
		assert.deepEqual(unreachable.sort(), ['AlsoUnused', 'Unused'])
	})

	it('should return empty array when all rules reachable', () => {
		const g = grammar(`
			Simple {
				Start = Item
				Item = digit
			}
		`)

		const unreachable = findUnreachableRules(g)
		assert.deepEqual(unreachable, [])
	})
})
