import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { args, BaseCommand, flags } from '@adonisjs/ace'
import { createJsonReporter } from '../../reporters/json.ts'
import { createSpecReporter } from '../../reporters/spec.ts'
import { createTapReporter } from '../../reporters/tap.ts'
import { clearRegistry, getRegisteredSuites, runSuite } from '../../runner/suite.ts'
import type { Reporter } from '../../types.ts'

function isTestFile(filename: string): boolean {
	return filename.endsWith('.grammar-test.ts') || filename.endsWith('.grammar-test.js')
}

function readDirectorySafe(dir: string): string[] {
	try {
		return readdirSync(dir)
	} catch {
		return []
	}
}

function findTestFiles(dir: string): string[] {
	return readDirectorySafe(dir)
		.filter(isTestFile)
		.map((entry) => resolve(dir, entry))
}

function getReporter(name: string): Reporter {
	if (name === 'json') return createJsonReporter()
	if (name === 'tap') return createTapReporter()
	return createSpecReporter()
}

export default class TestCommand extends BaseCommand {
	static override commandName = 'test'
	static override description = 'Run grammar test suites'

	@args.spread({
		description: 'Test files to run (default: *.grammar-test.ts in cwd)',
		required: false,
	})
	declare files?: string[]

	@flags.string({
		alias: 'r',
		default: 'spec',
		description: 'Reporter format: spec (default), json, or tap',
	})
	declare reporter: string

	private resolveTestFiles(): string[] {
		if (this.files !== undefined && this.files.length > 0) {
			return this.files
		}
		return findTestFiles(process.cwd())
	}

	private async loadTestFiles(files: string[]): Promise<boolean> {
		for (const file of files) {
			try {
				const absolutePath = resolve(file)
				await import(absolutePath)
			} catch (error: unknown) {
				this.logger.error(`Failed to load test file: ${file}`)
				this.logger.error(String(error))
				this.exitCode = 1
				return false
			}
		}
		return true
	}

	private runSuitesWithReporter(reporter: Reporter): { passed: number; failed: number } {
		const suites = getRegisteredSuites()
		let totalPassed = 0
		let totalFailed = 0

		for (const definition of suites) {
			const config = {
				grammar: definition.grammar,
				name: definition.name,
				startRule: definition.startRule,
			}
			reporter.onSuiteStart(config)

			const result = runSuite(definition)
			for (const testResult of result.results) {
				reporter.onTestResult(testResult)
			}

			reporter.onSuiteEnd(result)
			totalPassed += result.passed
			totalFailed += result.failed
		}

		return { failed: totalFailed, passed: totalPassed }
	}

	override async run(): Promise<void> {
		const filesToRun = this.resolveTestFiles()

		if (filesToRun.length === 0) {
			this.logger.error('No test files found')
			this.logger.info('Provide test files as arguments or create *.grammar-test.ts files')
			this.exitCode = 1
			return
		}

		clearRegistry()

		const loaded = await this.loadTestFiles(filesToRun)
		if (!loaded) return

		const suites = getRegisteredSuites()
		if (suites.length === 0) {
			this.logger.error('No test suites registered')
			this.logger.info('Test files should call defineGrammarSuite() to register suites')
			this.exitCode = 1
			return
		}

		const reporter = getReporter(this.reporter)
		const { passed, failed } = this.runSuitesWithReporter(reporter)

		console.log(reporter.getOutput())
		this.logger.info('')
		this.logger.info(`${passed + failed} tests, ${passed} passed, ${failed} failed`)

		if (failed > 0) {
			this.exitCode = 1
		}
	}
}
