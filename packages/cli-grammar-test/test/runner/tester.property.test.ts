import { describe, it } from 'node:test'
import fc from 'fast-check'
import { grammar } from 'ohm-js'
import { createTester } from '../../src/runner/tester.ts'

const simpleGrammar = grammar(`
  Simple {
    Start = digit+
    Word = letter+
    Mixed = (digit | letter)+
  }
`)

// Arbitrary for digit strings (should match Start rule)
const digitStringArb = fc
	.array(fc.integer({ max: 9, min: 0 }), { maxLength: 20, minLength: 1 })
	.map((digits) => digits.join(''))

// Arbitrary for letter strings (should match Word rule)
const letterStringArb = fc
	.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')), {
		maxLength: 20,
		minLength: 1,
	})
	.map((letters) => letters.join(''))

// Arbitrary for alphanumeric strings (should match Mixed rule)
const alphanumericStringArb = fc
	.array(
		fc.constantFrom(...'0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
		{
			maxLength: 20,
			minLength: 1,
		}
	)
	.map((chars) => chars.join(''))

// Arbitrary for non-matching strings (symbols only)
const symbolOnlyStringArb = fc
	.array(fc.constantFrom(...'!@#$%^&*()_+-=[]{}|;:,.<>?'.split('')), {
		maxLength: 20,
		minLength: 1,
	})
	.map((chars) => chars.join(''))

describe('GrammarTester property tests', () => {
	describe('match() invariants', () => {
		it('digit strings always match Start rule', () => {
			fc.assert(
				fc.property(digitStringArb, (input) => {
					const result = createTester(simpleGrammar, 'test', 'Start').match(input).run()
					return result.passed === 1 && result.failed === 0
				})
			)
		})

		it('letter strings always match Word rule', () => {
			fc.assert(
				fc.property(letterStringArb, (input) => {
					const result = createTester(simpleGrammar, 'test', 'Word').match(input).run()
					return result.passed === 1 && result.failed === 0
				})
			)
		})

		it('alphanumeric strings always match Mixed rule', () => {
			fc.assert(
				fc.property(alphanumericStringArb, (input) => {
					const result = createTester(simpleGrammar, 'test', 'Mixed').match(input).run()
					return result.passed === 1 && result.failed === 0
				})
			)
		})
	})

	describe('reject() invariants', () => {
		it('symbol-only strings always rejected by Start rule', () => {
			fc.assert(
				fc.property(symbolOnlyStringArb, (input) => {
					const result = createTester(simpleGrammar, 'test', 'Start').reject(input).run()
					return result.passed === 1 && result.failed === 0
				})
			)
		})

		it('symbol-only strings always rejected by Word rule', () => {
			fc.assert(
				fc.property(symbolOnlyStringArb, (input) => {
					const result = createTester(simpleGrammar, 'test', 'Word').reject(input).run()
					return result.passed === 1 && result.failed === 0
				})
			)
		})
	})

	describe('structural invariants', () => {
		it('total always equals passed + failed', () => {
			fc.assert(
				fc.property(fc.array(fc.string(), { maxLength: 10 }), (inputs) => {
					const result = createTester(simpleGrammar, 'test', 'Start').match(inputs).run()
					return result.total === result.passed + result.failed
				})
			)
		})

		it('results array length equals total', () => {
			fc.assert(
				fc.property(fc.array(fc.string(), { maxLength: 10 }), (inputs) => {
					const result = createTester(simpleGrammar, 'test', 'Start').match(inputs).run()
					return result.results.length === result.total
				})
			)
		})

		it('duration is non-negative', () => {
			fc.assert(
				fc.property(fc.array(fc.string(), { maxLength: 10 }), (inputs) => {
					const result = createTester(simpleGrammar, 'test', 'Start').match(inputs).run()
					return result.duration >= 0
				})
			)
		})

		it('each result has consistent passed/actual relationship', () => {
			fc.assert(
				fc.property(fc.array(fc.string(), { maxLength: 10 }), (inputs) => {
					const result = createTester(simpleGrammar, 'test', 'Start').match(inputs).run()
					return result.results.every((r) => {
						if (r.passed) {
							return r.expected === 'match' ? r.actual === 'matched' : r.actual === 'rejected'
						}
						return r.expected === 'match' ? r.actual === 'rejected' : r.actual === 'matched'
					})
				})
			)
		})
	})

	describe('never throws', () => {
		it('match() never throws on arbitrary input', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					try {
						createTester(simpleGrammar, 'test', 'Start').match(input).run()
						return true
					} catch {
						return false
					}
				})
			)
		})

		it('reject() never throws on arbitrary input', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					try {
						createTester(simpleGrammar, 'test', 'Start').reject(input).run()
						return true
					} catch {
						return false
					}
				})
			)
		})

		it('trace() never throws on arbitrary input', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					try {
						createTester(simpleGrammar, 'test', 'Start').trace(input)
						return true
					} catch {
						return false
					}
				})
			)
		})
	})

	describe('trace consistency', () => {
		it('trace returns string for any input', () => {
			fc.assert(
				fc.property(fc.string(), (input) => {
					const trace = createTester(simpleGrammar, 'test', 'Start').trace(input)
					return typeof trace === 'string' && trace.length > 0
				})
			)
		})
	})
})
