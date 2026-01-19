import type { Grammar, PExpr } from 'ohm-js'
import type { AnalysisIssue } from '../types.ts'
import { collectRuleReferences, extractRules } from './visitor.ts'

export function analyzeRedundancy(grammar: Grammar): AnalysisIssue[] {
	const rules = extractRules(grammar)
	const refCounts = computeReferenceCounts(rules)

	return [...findSingleUseRules(refCounts), ...findPassthroughRules(rules)]
}

function initializeCounts(rules: Map<string, unknown>): Map<string, number> {
	const counts = new Map<string, number>()
	for (const name of rules.keys()) {
		counts.set(name, 0)
	}
	return counts
}

function countReferences(rules: Map<string, { body: unknown }>, counts: Map<string, number>): void {
	for (const info of rules.values()) {
		const refs = collectRuleReferences(info.body as PExpr)
		for (const ref of refs) {
			const current = counts.get(ref) ?? 0
			counts.set(ref, current + 1)
		}
	}
}

function computeReferenceCounts(rules: Map<string, { body: unknown }>): Map<string, number> {
	const counts = initializeCounts(rules)
	countReferences(rules, counts)
	return counts
}

function isSpecialRule(name: string): boolean {
	return name.includes('_') || name === 'space' || name === 'spaces'
}

function findSingleUseRules(refCounts: Map<string, number>): AnalysisIssue[] {
	return [...refCounts.entries()]
		.filter(([name, count]) => count === 1 && !isSpecialRule(name))
		.map(([name]) => ({
			aiHint: `Rule '${name}' is only used once. Consider inlining it.`,
			code: 'SINGLE_USE_RULE',
			message: `Rule '${name}' is only referenced once`,
			rule: name,
			severity: 'info' as const,
		}))
}

function isPassthroughRule(expr: PExpr): boolean {
	return expr.constructor.name === 'Apply'
}

function findPassthroughRules(rules: Map<string, { body: unknown }>): AnalysisIssue[] {
	return [...rules.entries()]
		.filter(([, info]) => isPassthroughRule(info.body as PExpr))
		.map(([name]) => ({
			aiHint: `Rule '${name}' just delegates to another rule. Consider removing.`,
			code: 'PASSTHROUGH_RULE',
			message: `Rule '${name}' is a simple passthrough to another rule`,
			rule: name,
			severity: 'info' as const,
		}))
}
