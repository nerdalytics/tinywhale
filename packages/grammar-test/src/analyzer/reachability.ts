import type { Grammar } from 'ohm-js'
import type { AnalysisIssue } from '../types.ts'
import { collectRuleReferences, extractRules } from './visitor.ts'

export function findUnreachableRules(grammar: Grammar): string[] {
	const rules = extractRules(grammar)
	const ruleNames = new Set(rules.keys())
	const startRule = ruleNames.values().next().value as string | undefined

	if (startRule === undefined) return []

	const reachable = computeReachable(startRule, rules)
	return [...ruleNames].filter((name) => !reachable.has(name))
}

function processRule(
	current: string,
	rules: Map<string, { body: unknown }>,
	reachable: Set<string>
): string[] {
	const ruleInfo = rules.get(current)
	if (ruleInfo === undefined) return []

	const refs = collectRuleReferences(ruleInfo.body as Parameters<typeof collectRuleReferences>[0])
	return [...refs].filter((ref) => !reachable.has(ref))
}

function processQueueItem(
	current: string,
	rules: Map<string, { body: unknown }>,
	reachable: Set<string>,
	queue: string[]
): void {
	if (reachable.has(current)) return
	reachable.add(current)
	queue.push(...processRule(current, rules, reachable))
}

function computeReachable(startRule: string, rules: Map<string, { body: unknown }>): Set<string> {
	const reachable = new Set<string>()
	const queue = [startRule]

	while (queue.length > 0) {
		const current = queue.shift()
		if (current !== undefined) processQueueItem(current, rules, reachable, queue)
	}

	return reachable
}

export function analyzeReachability(grammar: Grammar): AnalysisIssue[] {
	return findUnreachableRules(grammar).map((rule) => ({
		aiHint: `Rule '${rule}' is never referenced. Consider removing it or adding a reference.`,
		code: 'UNREACHABLE_RULE',
		message: `Rule '${rule}' is not reachable from the start rule`,
		rule,
		severity: 'warning' as const,
	}))
}
