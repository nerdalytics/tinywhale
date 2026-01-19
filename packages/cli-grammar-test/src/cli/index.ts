#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { grammar } from 'ohm-js'
import { analyzeLexicalRules, analyzeNaming, analyzeSyntacticRules } from '../analyzer/naming.ts'
import { analyzeNullable, findNullableRules } from '../analyzer/nullable.ts'
import { analyzeReachability, findUnreachableRules } from '../analyzer/reachability.ts'
import { analyzeRedundancy } from '../analyzer/redundancy.ts'
import { analyzeShadows } from '../analyzer/shadows.ts'
import { createJsonReporter } from '../reporters/json.ts'
import { createSpecReporter } from '../reporters/spec.ts'
import { createTapReporter } from '../reporters/tap.ts'
import { clearRegistry, getRegisteredSuites, runSuite } from '../runner/suite.ts'
import type { AnalysisIssue, AnalysisResult, Reporter } from '../types.ts'

interface CliArgs {
	values: {
		help?: boolean
		format?: string
		reporter?: string
	}
	positionals: string[]
}

function printUsage(): void {
	console.log(`
Usage: tw-grammar-test <command> [options]

Commands:
  analyze <grammar>   Analyze grammar for issues
  test [files...]     Run grammar tests

Options:
  --help, -h          Show this help message
  --format, -f        Output format for analyze: spec (default), json
  --reporter, -r      Reporter for test: spec (default), json, tap

Test files should export or call defineGrammarSuite() to register test suites.
If no files specified, searches for *.grammar-test.ts files in current directory.
`)
}

function loadGrammar(path: string): ReturnType<typeof grammar> {
	const source = readFileSync(path, 'utf-8')
	return grammar(source)
}

function runAnalysis(grammarPath: string): AnalysisResult {
	const g = loadGrammar(grammarPath)
	const issues: AnalysisIssue[] = []

	issues.push(...analyzeReachability(g))
	issues.push(...analyzeNullable(g))
	issues.push(...analyzeNaming(g))
	issues.push(...analyzeShadows(g))
	issues.push(...analyzeRedundancy(g))

	const syntacticRules = analyzeSyntacticRules(g)
	const lexicalRules = analyzeLexicalRules(g)
	const unreachableRules = findUnreachableRules(g)
	const nullableRules = findNullableRules(g)

	return {
		grammarName: g.name,
		issues,
		ruleCount: syntacticRules.length + lexicalRules.length,
		stats: {
			lexicalRules,
			nullableRules,
			reachableRules: syntacticRules.length + lexicalRules.length - unreachableRules.length,
			syntacticRules,
			unreachableRules,
		},
	}
}

function getSeverityIcon(severity: string): string {
	if (severity === 'error') return '\u2717'
	if (severity === 'warning') return '!'
	return 'i'
}

function formatIssueLine(issue: AnalysisIssue): string {
	return `  [${getSeverityIcon(issue.severity)}] ${issue.code}: ${issue.message}`
}

function formatIssuesSection(issues: AnalysisIssue[]): string[] {
	if (issues.length === 0) return ['No issues found.']
	return [`Issues (${issues.length}):`, ...issues.map(formatIssueLine)]
}

function formatAnalysisSpec(result: AnalysisResult): string {
	const header = [
		`Grammar: ${result.grammarName}`,
		`Rules: ${result.ruleCount} (${result.stats.reachableRules} reachable)`,
		'',
	]
	return [...header, ...formatIssuesSection(result.issues)].join('\n')
}

function formatAnalysisJson(result: AnalysisResult): string {
	return JSON.stringify(result, null, 2)
}

function handleAnalyze(args: CliArgs): void {
	const grammarPath = args.positionals[1]
	if (grammarPath === undefined) {
		console.error('Error: Grammar file path required')
		process.exit(1)
	}

	const result = runAnalysis(grammarPath)
	const format = args.values.format ?? 'spec'

	if (format === 'json') {
		console.log(formatAnalysisJson(result))
	} else {
		console.log(formatAnalysisSpec(result))
	}
}

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

async function loadTestFiles(files: string[]): Promise<void> {
	for (const file of files) {
		const absolutePath = resolve(file)
		await import(absolutePath)
	}
}

function runSuitesWithReporter(reporter: Reporter): { passed: number; failed: number } {
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

function exitWithError(message: string, detail?: string): never {
	console.error(`Error: ${message}`)
	if (detail !== undefined) console.error(detail)
	process.exit(1)
}

function resolveTestFiles(args: CliArgs): string[] {
	const testFiles = args.positionals.slice(1)
	return testFiles.length > 0 ? testFiles : findTestFiles(process.cwd())
}

async function loadAndValidateTestFiles(files: string[]): Promise<void> {
	if (files.length === 0) {
		exitWithError(
			'No test files found',
			'Provide test files as arguments or create *.grammar-test.ts files'
		)
	}

	clearRegistry()

	try {
		await loadTestFiles(files)
	} catch (err) {
		exitWithError('Error loading test files:', String(err))
	}

	if (getRegisteredSuites().length === 0) {
		exitWithError(
			'No test suites registered',
			'Test files should call defineGrammarSuite() to register suites'
		)
	}
}

async function handleTest(args: CliArgs): Promise<void> {
	const filesToRun = resolveTestFiles(args)
	await loadAndValidateTestFiles(filesToRun)

	const reporter = getReporter(args.values.reporter ?? 'spec')
	const { passed, failed } = runSuitesWithReporter(reporter)

	console.log(reporter.getOutput())
	console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`)

	if (failed > 0) process.exit(1)
}

async function main(): Promise<void> {
	const args = parseArgs({
		allowPositionals: true,
		options: {
			format: { short: 'f', type: 'string' },
			help: { short: 'h', type: 'boolean' },
			reporter: { short: 'r', type: 'string' },
		},
	}) as CliArgs

	if (args.values.help === true) {
		printUsage()
		return
	}

	const command = args.positionals[0]

	switch (command) {
		case 'analyze':
			handleAnalyze(args)
			break
		case 'test':
			await handleTest(args)
			break
		default:
			printUsage()
			break
	}
}

main().catch((err) => {
	console.error('Unexpected error:', err)
	process.exit(1)
})
