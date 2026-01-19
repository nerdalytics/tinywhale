import type { Grammar, MatchResult } from 'ohm-js'

export interface TestCase {
	input: string
	startRule: string | undefined
	shouldMatch: boolean
}

export interface TestResult {
	passed: boolean
	input: string
	startRule: string | undefined
	expected: 'match' | 'reject'
	actual: 'matched' | 'rejected'
	trace: string | undefined
	errorMessage: string | undefined
}

export interface SuiteConfig {
	name: string
	grammar: Grammar
	startRule: string | undefined
}

export interface SuiteResult {
	name: string
	passed: number
	failed: number
	total: number
	results: TestResult[]
	duration: number
}

export interface GrammarSuiteDefinition {
	name: string
	grammar: Grammar
	startRule: string | undefined
	tests: (tester: GrammarTesterInterface) => void
}

export interface GrammarTesterInterface {
	match(inputs: string | string[], options?: { startRule?: string }): this
	reject(inputs: string | string[], options?: { startRule?: string }): this
	trace(input: string, startRule?: string): string
	run(): SuiteResult
}

export interface Reporter {
	onSuiteStart(config: SuiteConfig): void
	onTestResult(result: TestResult): void
	onSuiteEnd(result: SuiteResult): void
	getOutput(): string
}

export type AnalysisSeverity = 'error' | 'warning' | 'info'

export interface AnalysisIssue {
	rule: string
	severity: AnalysisSeverity
	code: string
	message: string
	aiHint: string | undefined
}

export interface AnalysisResult {
	grammarName: string
	ruleCount: number
	issues: AnalysisIssue[]
	stats: AnalysisStats
}

export interface AnalysisStats {
	reachableRules: number
	unreachableRules: string[]
	nullableRules: string[]
	syntacticRules: string[]
	lexicalRules: string[]
}

export interface PExprVisitor<T> {
	onAlt?(children: T[]): T | undefined
	onSeq?(children: T[]): T | undefined
	onStar?(child: T): T | undefined
	onPlus?(child: T): T | undefined
	onOpt?(child: T): T | undefined
	onNot?(child: T): T | undefined
	onLookahead?(child: T): T | undefined
	onLex?(child: T): T | undefined
	onParam?(index: number): T | undefined
	onApp?(ruleName: string, args: T[]): T | undefined
	onRange?(from: string, to: string): T | undefined
	onTerminal?(value: string): T | undefined
	onUnicodeChar?(category: string): T | undefined
}

export interface RuleInfo {
	name: string
	body: unknown
	formals: string[]
	description: string
	source: unknown
}

export interface MatchTraceResult {
	succeeded: boolean
	trace: string
	matchResult: MatchResult
}
