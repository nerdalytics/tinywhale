import type { Grammar, PExpr } from 'ohm-js'
import type { AnalysisIssue, PExprVisitor } from '../types.ts'
import { extractRules, walkPExpr } from './visitor.ts'

function createNullableVisitor(nullableRules: Set<string>): PExprVisitor<boolean> {
	return {
		onAlt: (children) => children.some((c) => c === true),
		onApp: (ruleName) => nullableRules.has(ruleName),
		onLex: (child) => child === true,
		onLookahead: () => true,
		onNot: () => true,
		onOpt: () => true,
		onParam: () => false,
		onPlus: (child) => child === true,
		onRange: () => false,
		onSeq: (children) => children.every((c) => c === true),
		onStar: () => true,
		onTerminal: (value) => value === '',
		onUnicodeChar: () => false,
	}
}

function isNullable(expr: PExpr, nullableRules: Set<string>): boolean {
	return walkPExpr(expr, createNullableVisitor(nullableRules)) === true
}

function runFixpoint(rules: Map<string, { body: PExpr }>): Set<string> {
	const nullable = new Set<string>()
	let changed = true

	while (changed) {
		changed = updateNullableSet(rules, nullable)
	}

	return nullable
}

function checkAndAddNullable(name: string, body: PExpr, nullable: Set<string>): boolean {
	if (nullable.has(name)) return false
	if (!isNullable(body, nullable)) return false
	nullable.add(name)
	return true
}

function updateNullableSet(rules: Map<string, { body: PExpr }>, nullable: Set<string>): boolean {
	let changed = false
	for (const [name, info] of rules) {
		if (checkAndAddNullable(name, info.body, nullable)) changed = true
	}
	return changed
}

export function findNullableRules(grammar: Grammar): string[] {
	const rules = extractRules(grammar) as Map<string, { body: PExpr }>
	return [...runFixpoint(rules)]
}

function shouldWarnNullable(name: string, rules: Map<string, unknown>): boolean {
	const isBuiltIn = !rules.has(name)
	const isIterationHelper = name.endsWith('_opt') || name.endsWith('_star')
	return !isBuiltIn && !isIterationHelper
}

export function analyzeNullable(grammar: Grammar): AnalysisIssue[] {
	const nullable = findNullableRules(grammar)
	const rules = extractRules(grammar)

	return nullable
		.filter((name) => shouldWarnNullable(name, rules))
		.map((rule) => ({
			aiHint: `Rule '${rule}' can match empty string. This may cause infinite loops.`,
			code: 'NULLABLE_RULE',
			message: `Rule '${rule}' can match the empty string`,
			rule,
			severity: 'info' as const,
		}))
}
