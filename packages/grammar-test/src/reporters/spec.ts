import type { Reporter, SuiteConfig, SuiteResult, TestResult } from '../types.ts'

function formatTestLine(result: TestResult): string {
	const marker = result.passed ? '\u2713' : '\u2717'
	const status = result.passed ? 'pass' : 'fail'
	const inputPreview = truncateInput(result.input)
	return `    ${marker} [${status}] ${result.expected} "${inputPreview}"`
}

export class SpecReporter implements Reporter {
	private lines: string[] = []

	onSuiteStart(config: SuiteConfig): void {
		this.lines.push(`\n  ${config.name}`)
	}

	onTestResult(result: TestResult): void {
		this.lines.push(formatTestLine(result))

		const shouldShowTrace = !result.passed && result.trace !== undefined
		if (shouldShowTrace) {
			this.lines.push(`      trace: ${result.trace?.split('\n')[0]}`)
		}
	}

	onSuiteEnd(result: SuiteResult): void {
		this.lines.push('')
		this.lines.push(`  ${result.passed} passing (${result.duration.toFixed(2)}ms)`)
		if (result.failed > 0) {
			this.lines.push(`  ${result.failed} failing`)
		}
	}

	getOutput(): string {
		return this.lines.join('\n')
	}
}

function truncateInput(input: string, maxLen = 40): string {
	const escaped = input.replace(/\n/g, '\\n').replace(/\t/g, '\\t')
	return escaped.length > maxLen ? `${escaped.slice(0, maxLen)}...` : escaped
}

export function createSpecReporter(): SpecReporter {
	return new SpecReporter()
}
