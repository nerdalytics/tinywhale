import type { Grammar } from 'ohm-js'
import type { AnalysisIssue } from '../types.ts'
import { getRuleNames } from './visitor.ts'

function isUppercase(char: string): boolean {
	return char === char.toUpperCase() && char !== char.toLowerCase()
}

function isLowercase(char: string): boolean {
	return char === char.toLowerCase() && char !== char.toUpperCase()
}

export function analyzeSyntacticRules(grammar: Grammar): string[] {
	return getRuleNames(grammar).filter((name) => {
		const first = name[0]
		return first !== undefined && isUppercase(first)
	})
}

export function analyzeLexicalRules(grammar: Grammar): string[] {
	return getRuleNames(grammar).filter((name) => {
		const first = name[0]
		return first !== undefined && isLowercase(first)
	})
}

function isInlineRuleName(name: string): boolean {
	return name.includes('_')
}

function createInvalidNameIssue(name: string): AnalysisIssue {
	return {
		aiHint: `Rule '${name}' starts with a non-letter. Use PascalCase or camelCase.`,
		code: 'INVALID_RULE_NAME',
		message: `Rule '${name}' has an invalid name format`,
		rule: name,
		severity: 'warning',
	}
}

function hasValidFirstChar(name: string): boolean {
	const first = name[0]
	if (first === undefined) return false
	return isUppercase(first) || isLowercase(first)
}

export function analyzeNaming(grammar: Grammar): AnalysisIssue[] {
	return getRuleNames(grammar)
		.filter((name) => !isInlineRuleName(name))
		.filter((name) => !hasValidFirstChar(name))
		.map(createInvalidNameIssue)
}
