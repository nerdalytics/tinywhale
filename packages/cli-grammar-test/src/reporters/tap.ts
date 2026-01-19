import type { Reporter, SuiteConfig, SuiteResult, TestResult } from '../types.ts'

export class TapReporter implements Reporter {
	private lines: string[] = []
	private testNumber = 0
	private totalTests = 0

	onSuiteStart(config: SuiteConfig): void {
		this.lines.push(`# Suite: ${config.name}`)
	}

	onTestResult(result: TestResult): void {
		this.testNumber++
		this.totalTests++

		const status = result.passed ? 'ok' : 'not ok'
		const inputPreview = truncateInput(result.input)
		const description = `${result.expected} "${inputPreview}"`

		this.lines.push(`${status} ${this.testNumber} - ${description}`)

		if (!result.passed) {
			this.lines.push(`  ---`)
			this.lines.push(`  expected: ${result.expected}`)
			this.lines.push(`  actual: ${result.actual}`)
			if (result.trace !== undefined) {
				this.lines.push(`  trace: ${result.trace.split('\n')[0]}`)
			}
			this.lines.push(`  ...`)
		}
	}

	onSuiteEnd(_result: SuiteResult): void {
		this.lines.push('')
	}

	getOutput(): string {
		const header = `TAP version 14\n1..${this.totalTests}`
		return `${header}\n${this.lines.join('\n')}`
	}
}

function truncateInput(input: string, maxLen = 40): string {
	const escaped = input.replace(/\n/g, '\\n').replace(/\t/g, '\\t')
	return escaped.length > maxLen ? `${escaped.slice(0, maxLen)}...` : escaped
}

export function createTapReporter(): TapReporter {
	return new TapReporter()
}
