import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { grammar } from 'ohm-js'
import { createTester, GrammarTester } from '../../src/runner/tester.ts'

const simpleGrammar = grammar(`
  Simple {
    Start = digit+
    Word = letter+
  }
`)

describe('GrammarTester', () => {
	describe('match()', () => {
		it('should accept valid inputs', () => {
			const tester = createTester(simpleGrammar, 'test', 'Start')
			tester.match('123')
			const result = tester.run()

			assert.equal(result.passed, 1)
			assert.equal(result.failed, 0)
		})

		it('should accept multiple inputs', () => {
			const tester = createTester(simpleGrammar, 'test', 'Start')
			tester.match(['1', '12', '123'])
			const result = tester.run()

			assert.equal(result.passed, 3)
			assert.equal(result.failed, 0)
		})

		it('should fail for invalid inputs', () => {
			const tester = createTester(simpleGrammar, 'test', 'Start')
			tester.match('abc')
			const result = tester.run()

			assert.equal(result.passed, 0)
			assert.equal(result.failed, 1)
			assert.equal(result.results[0]?.errorMessage, 'Expected input to match but it was rejected')
		})

		it('should allow overriding start rule', () => {
			const tester = createTester(simpleGrammar, 'test', 'Start')
			tester.match('abc', { startRule: 'Word' })
			const result = tester.run()

			assert.equal(result.passed, 1)
			assert.equal(result.failed, 0)
		})
	})

	describe('reject()', () => {
		it('should accept inputs that fail to match', () => {
			const tester = createTester(simpleGrammar, 'test', 'Start')
			tester.reject('abc')
			const result = tester.run()

			assert.equal(result.passed, 1)
			assert.equal(result.failed, 0)
		})

		it('should fail for inputs that match', () => {
			const tester = createTester(simpleGrammar, 'test', 'Start')
			tester.reject('123')
			const result = tester.run()

			assert.equal(result.passed, 0)
			assert.equal(result.failed, 1)
			assert.equal(result.results[0]?.errorMessage, 'Expected input to be rejected but it matched')
		})

		it('should accept multiple inputs', () => {
			const tester = createTester(simpleGrammar, 'test', 'Start')
			tester.reject(['a', 'ab', 'abc'])
			const result = tester.run()

			assert.equal(result.passed, 3)
			assert.equal(result.failed, 0)
		})
	})

	describe('fluent API', () => {
		it('should chain match and reject calls', () => {
			const result = createTester(simpleGrammar, 'test', 'Start')
				.match(['1', '12', '123'])
				.reject(['a', 'ab', 'abc'])
				.run()

			assert.equal(result.total, 6)
			assert.equal(result.passed, 6)
			assert.equal(result.failed, 0)
		})
	})

	describe('trace()', () => {
		it('should return success message for matching input', () => {
			const tester = createTester(simpleGrammar, 'test', 'Start')
			const trace = tester.trace('123')

			assert.equal(trace, 'Match succeeded')
		})

		it('should return failure trace for non-matching input', () => {
			const tester = createTester(simpleGrammar, 'test', 'Start')
			const trace = tester.trace('abc')

			assert.ok(trace.includes('Line 1'))
		})
	})

	describe('run()', () => {
		it('should return suite result with timing', () => {
			const result = createTester(simpleGrammar, 'my-suite', 'Start').match('1').run()

			assert.equal(result.name, 'my-suite')
			assert.equal(typeof result.duration, 'number')
			assert.ok(result.duration >= 0)
		})

		it('should include trace on failure', () => {
			const result = createTester(simpleGrammar, 'test', 'Start').match('abc').run()

			const failedResult = result.results[0]
			assert.ok(failedResult !== undefined)
			assert.ok(failedResult.trace !== undefined)
		})
	})
})

describe('createTester', () => {
	it('should create a GrammarTester instance', () => {
		const tester = createTester(simpleGrammar, 'test')
		assert.ok(tester instanceof GrammarTester)
	})
})
