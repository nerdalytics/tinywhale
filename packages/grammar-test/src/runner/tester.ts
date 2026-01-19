import type { Grammar, MatchResult } from 'ohm-js'
import type { GrammarTesterInterface, SuiteResult, TestCase, TestResult } from '../types.ts'

function getTraceFromFailure(matchResult: MatchResult): string | undefined {
	return matchResult.failed() ? matchResult.message : undefined
}

function getErrorMessage(shouldMatch: boolean): string {
	return shouldMatch
		? `Expected input to match but it was rejected`
		: `Expected input to be rejected but it matched`
}

function runSingleTest(grammar: Grammar, testCase: TestCase): TestResult {
	const { input, startRule, shouldMatch } = testCase
	const matchResult = grammar.match(input, startRule)
	const succeeded = matchResult.succeeded()
	const passed = shouldMatch === succeeded

	return {
		actual: succeeded ? 'matched' : 'rejected',
		errorMessage: passed ? undefined : getErrorMessage(shouldMatch),
		expected: shouldMatch ? 'match' : 'reject',
		input,
		passed,
		startRule,
		trace: passed ? undefined : getTraceFromFailure(matchResult),
	}
}

export class GrammarTester implements GrammarTesterInterface {
	private grammar: Grammar
	private suiteName: string
	private defaultStartRule: string | undefined
	private testCases: TestCase[] = []

	constructor(grammar: Grammar, name: string, startRule?: string) {
		this.grammar = grammar
		this.suiteName = name
		this.defaultStartRule = startRule
	}

	match(inputs: string | string[], options?: { startRule?: string }): this {
		const inputArray = Array.isArray(inputs) ? inputs : [inputs]
		const startRule = options?.startRule ?? this.defaultStartRule

		for (const input of inputArray) {
			this.testCases.push({ input, shouldMatch: true, startRule })
		}

		return this
	}

	reject(inputs: string | string[], options?: { startRule?: string }): this {
		const inputArray = Array.isArray(inputs) ? inputs : [inputs]
		const startRule = options?.startRule ?? this.defaultStartRule

		for (const input of inputArray) {
			this.testCases.push({ input, shouldMatch: false, startRule })
		}

		return this
	}

	trace(input: string, startRule?: string): string {
		const rule = startRule ?? this.defaultStartRule
		const matchResult = this.grammar.match(input, rule)
		if (matchResult.failed()) {
			return matchResult.message
		}
		return 'Match succeeded'
	}

	run(): SuiteResult {
		const startTime = performance.now()
		const results: TestResult[] = []

		for (const testCase of this.testCases) {
			results.push(runSingleTest(this.grammar, testCase))
		}

		const duration = performance.now() - startTime
		const passed = results.filter((r) => r.passed).length
		const failed = results.filter((r) => !r.passed).length

		return {
			duration,
			failed,
			name: this.suiteName,
			passed,
			results,
			total: results.length,
		}
	}
}

export function createTester(grammar: Grammar, name: string, startRule?: string): GrammarTester {
	return new GrammarTester(grammar, name, startRule)
}
