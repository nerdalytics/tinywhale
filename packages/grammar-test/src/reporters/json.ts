import type { Reporter, SuiteConfig, SuiteResult, TestResult } from '../types.ts'

interface JsonTestResult {
	input: string
	startRule: string | undefined
	expected: 'match' | 'reject'
	actual: 'matched' | 'rejected'
	passed: boolean
	trace: string | undefined
	errorMessage: string | undefined
	aiHint: string | undefined
}

interface JsonSuiteResult {
	name: string
	passed: number
	failed: number
	total: number
	duration: number
	results: JsonTestResult[]
}

export class JsonReporter implements Reporter {
	private currentSuite: JsonSuiteResult | undefined
	private suites: JsonSuiteResult[] = []

	onSuiteStart(config: SuiteConfig): void {
		this.currentSuite = {
			duration: 0,
			failed: 0,
			name: config.name,
			passed: 0,
			results: [],
			total: 0,
		}
	}

	onTestResult(result: TestResult): void {
		if (this.currentSuite === undefined) return

		const jsonResult: JsonTestResult = {
			actual: result.actual,
			aiHint: generateAiHint(result),
			errorMessage: result.errorMessage,
			expected: result.expected,
			input: result.input,
			passed: result.passed,
			startRule: result.startRule,
			trace: result.trace,
		}

		this.currentSuite.results.push(jsonResult)
	}

	onSuiteEnd(result: SuiteResult): void {
		if (this.currentSuite === undefined) return

		this.currentSuite.passed = result.passed
		this.currentSuite.failed = result.failed
		this.currentSuite.total = result.total
		this.currentSuite.duration = result.duration

		this.suites.push(this.currentSuite)
		this.currentSuite = undefined
	}

	getOutput(): string {
		return JSON.stringify({ suites: this.suites }, null, 2)
	}
}

const HINT_UNEXPECTED_MATCH = `Input unexpectedly matched. Grammar may be too permissive.`

function getHintKey(expected: string, actual: string): string {
	return `${expected}:${actual}`
}

function generateAiHint(result: TestResult): string | undefined {
	if (result.passed) return undefined

	const key = getHintKey(result.expected, result.actual)
	if (key === 'match:rejected')
		return `Input was rejected. Check grammar rules for: ${extractKeywords(result.input)}`
	if (key === 'reject:matched') return HINT_UNEXPECTED_MATCH

	return undefined
}

function extractKeywords(input: string): string {
	const words = input.split(/\s+/).filter((w) => w.length > 0)
	return words.slice(0, 3).join(', ')
}

export function createJsonReporter(): JsonReporter {
	return new JsonReporter()
}
