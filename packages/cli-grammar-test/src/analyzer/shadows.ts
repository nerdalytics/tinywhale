import type { Grammar, PExpr } from 'ohm-js'
import type { AnalysisIssue, PExprVisitor } from '../types.ts'
import { extractRules, walkPExpr } from './visitor.ts'

type PExprWithTerms = PExpr & { terms?: PExpr[] }

export function analyzeShadows(grammar: Grammar): AnalysisIssue[] {
	const rules = extractRules(grammar)
	const issues: AnalysisIssue[] = []

	for (const [name, info] of rules) {
		issues.push(...checkRuleForShadows(name, info.body as PExprWithTerms, rules))
	}

	return issues
}

function checkRuleForShadows(
	ruleName: string,
	expr: PExprWithTerms,
	rules: Map<string, { body: unknown }>
): AnalysisIssue[] {
	if (expr.constructor.name !== 'Alt') return []
	if (expr.terms === undefined) return []

	return findOverlappingAlternatives(ruleName, expr.terms, rules)
}

function findOverlappingAlternatives(
	ruleName: string,
	terms: PExpr[],
	rules: Map<string, { body: unknown }>
): AnalysisIssue[] {
	const issues: AnalysisIssue[] = []
	const firstSets = terms.map((term) => computeFirstSet(term, rules, new Set()))

	for (let i = 0; i < terms.length; i++) {
		issues.push(...checkPairwiseOverlaps(ruleName, i, firstSets))
	}

	return issues
}

function checkSinglePair(
	ruleName: string,
	i: number,
	j: number,
	setI: Set<string>,
	setJ: Set<string>
): AnalysisIssue | undefined {
	const overlap = findOverlap(setI, setJ)
	return overlap.length > 0 ? createShadowIssue(ruleName, i, j, overlap) : undefined
}

function checkPairwiseOverlaps(
	ruleName: string,
	i: number,
	firstSets: Set<string>[]
): AnalysisIssue[] {
	const setI = firstSets[i]
	if (setI === undefined) return []

	return firstSets
		.slice(i + 1)
		.map((setJ, idx) =>
			setJ !== undefined ? checkSinglePair(ruleName, i, i + 1 + idx, setI, setJ) : undefined
		)
		.filter((issue): issue is AnalysisIssue => issue !== undefined)
}

function createShadowIssue(
	ruleName: string,
	altIdx1: number,
	altIdx2: number,
	overlap: string[]
): AnalysisIssue {
	const overlapStr = overlap.slice(0, 3).join(', ')
	return {
		aiHint: `Alternative ${altIdx1 + 1} may shadow alternative ${altIdx2 + 1}. PEG uses ordered choice.`,
		code: 'SHADOWED_ALTERNATIVE',
		message: `In rule '${ruleName}': alternatives ${altIdx1 + 1} and ${altIdx2 + 1} overlap on: ${overlapStr}`,
		rule: ruleName,
		severity: 'warning',
	}
}

function addToFirstSet(firstSet: Set<string>, value: string): void {
	const first = value[0]
	if (first !== undefined) firstSet.add(first)
}

function computeFirstSet(
	expr: PExpr,
	rules: Map<string, { body: unknown }>,
	visited: Set<string>
): Set<string> {
	const firstSet = new Set<string>()

	const visitor: PExprVisitor<void> = {
		onApp: (ruleName) => processRuleReference(ruleName, rules, visited, firstSet),
		onRange: (from, to) => {
			firstSet.add(`[${from}-${to}]`)
		},
		onTerminal: (value) => addToFirstSet(firstSet, value),
		onUnicodeChar: (category) => {
			firstSet.add(`\\p{${category}}`)
		},
	}

	walkPExpr(expr, visitor)
	return firstSet
}

function processRuleReference(
	ruleName: string,
	rules: Map<string, { body: unknown }>,
	visited: Set<string>,
	firstSet: Set<string>
): void {
	if (visited.has(ruleName)) return
	visited.add(ruleName)

	const ruleInfo = rules.get(ruleName)
	if (ruleInfo === undefined) return

	const nested = computeFirstSet(ruleInfo.body as PExpr, rules, visited)
	for (const item of nested) firstSet.add(item)
}

function findOverlap(set1: Set<string>, set2: Set<string>): string[] {
	return [...set1].filter((item) => set2.has(item))
}
