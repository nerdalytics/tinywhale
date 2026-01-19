#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { grammar } from 'ohm-js'
import { analyzeLexicalRules, analyzeNaming, analyzeSyntacticRules } from '../analyzer/naming.ts'
import { analyzeNullable, findNullableRules } from '../analyzer/nullable.ts'
import { analyzeReachability, findUnreachableRules } from '../analyzer/reachability.ts'
import { analyzeRedundancy } from '../analyzer/redundancy.ts'
import { analyzeShadows } from '../analyzer/shadows.ts'
import type { AnalysisIssue, AnalysisResult } from '../types.ts'

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
  test [files...]     Run grammar tests (not yet implemented)

Options:
  --help, -h          Show this help message
  --format, -f        Output format for analyze: spec (default), json
  --reporter, -r      Reporter for test: spec (default), json, tap
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

function handleTest(_args: CliArgs): void {
	console.log('Test command not yet implemented. Use programmatic API.')
}

function main(): void {
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
			handleTest(args)
			break
		default:
			printUsage()
			break
	}
}

main()
