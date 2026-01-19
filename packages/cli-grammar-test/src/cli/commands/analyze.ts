import { readFileSync } from 'node:fs'
import { args, BaseCommand, flags } from '@adonisjs/ace'
import type { AnalysisIssue, AnalysisResult } from '@tinywhale/grammar-test'
import {
	analyzeLexicalRules,
	analyzeNaming,
	analyzeNullable,
	analyzeReachability,
	analyzeRedundancy,
	analyzeShadows,
	analyzeSyntacticRules,
	findNullableRules,
	findUnreachableRules,
} from '@tinywhale/grammar-test'
import { grammar } from 'ohm-js'

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

export default class AnalyzeCommand extends BaseCommand {
	static override commandName = 'analyze'
	static override description = 'Analyze an Ohm grammar for potential issues'

	@args.string({ description: 'Path to the .ohm grammar file' })
	declare grammarPath: string

	@flags.string({
		alias: 'f',
		default: 'spec',
		description: 'Output format: spec (default) or json',
	})
	declare format: string

	private loadGrammar(): ReturnType<typeof grammar> | null {
		try {
			const source = readFileSync(this.grammarPath, 'utf-8')
			return grammar(source)
		} catch (error: unknown) {
			this.logger.error(`Failed to read grammar file: ${this.grammarPath}`)
			this.logger.error(String(error))
			this.exitCode = 1
			return null
		}
	}

	private runAnalysis(g: ReturnType<typeof grammar>): AnalysisResult {
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

	private formatSpec(result: AnalysisResult): void {
		this.logger.info(`Grammar: ${result.grammarName}`)
		this.logger.info(`Rules: ${result.ruleCount} (${result.stats.reachableRules} reachable)`)
		this.logger.info('')
		for (const line of formatIssuesSection(result.issues)) {
			this.logger.info(line)
		}
	}

	private formatJson(result: AnalysisResult): void {
		console.log(JSON.stringify(result, null, 2))
	}

	override async run(): Promise<void> {
		const g = this.loadGrammar()
		if (g === null) return

		const result = this.runAnalysis(g)

		if (this.format === 'json') {
			this.formatJson(result)
		} else {
			this.formatSpec(result)
		}

		const hasErrors = result.issues.some((i) => i.severity === 'error')
		if (hasErrors) {
			this.exitCode = 1
		}
	}
}
