export { analyzeLexicalRules, analyzeNaming, analyzeSyntacticRules } from './analyzer/naming.ts'
export { analyzeNullable, findNullableRules } from './analyzer/nullable.ts'
export { analyzeReachability, findUnreachableRules } from './analyzer/reachability.ts'
export { analyzeRedundancy } from './analyzer/redundancy.ts'
export { analyzeShadows } from './analyzer/shadows.ts'
export { collectRuleReferences, extractRules, getRuleNames, walkPExpr } from './analyzer/visitor.ts'
export { createJsonReporter, JsonReporter } from './reporters/json.ts'
export { createSpecReporter, SpecReporter } from './reporters/spec.ts'
export { createTapReporter, TapReporter } from './reporters/tap.ts'
export {
	clearRegistry,
	defineGrammarSuite,
	getRegisteredSuites,
	runAllSuites,
	runSuite,
} from './runner/suite.ts'
export { createTester, GrammarTester } from './runner/tester.ts'
export type {
	AnalysisIssue,
	AnalysisResult,
	AnalysisSeverity,
	AnalysisStats,
	GrammarSuiteDefinition,
	GrammarTesterInterface,
	MatchTraceResult,
	PExprVisitor,
	Reporter,
	RuleInfo,
	SuiteConfig,
	SuiteResult,
	TestCase,
	TestResult,
} from './types.ts'
