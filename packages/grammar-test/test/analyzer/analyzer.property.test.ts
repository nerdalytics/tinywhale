import { describe, it } from 'node:test'
import fc from 'fast-check'
import { grammar } from 'ohm-js'
import {
	analyzeLexicalRules,
	analyzeNaming,
	analyzeSyntacticRules,
} from '../../src/analyzer/naming.ts'
import { analyzeNullable, findNullableRules } from '../../src/analyzer/nullable.ts'
import { analyzeReachability, findUnreachableRules } from '../../src/analyzer/reachability.ts'
import { analyzeRedundancy } from '../../src/analyzer/redundancy.ts'
import { analyzeShadows } from '../../src/analyzer/shadows.ts'
import { extractRules, getRuleNames } from '../../src/analyzer/visitor.ts'

// Arbitrary for valid rule names (PascalCase for syntactic)
const syntacticRuleNameArb = fc
	.tuple(
		fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
		fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { maxLength: 8 })
	)
	.map(([first, rest]) => first + rest.join(''))

// Arbitrary for simple rule bodies
const simpleBodyArb = fc.oneof(
	fc.constant('digit'),
	fc.constant('letter'),
	fc.constant('digit+'),
	fc.constant('letter+'),
	fc.constant('digit*'),
	fc.constant('letter*'),
	fc.constant('"a"'),
	fc.constant('"b"'),
	fc.constant('"a" | "b"'),
	fc.constant('digit | letter')
)

// Generate a simple grammar with 1-5 rules
const simpleGrammarArb = fc
	.tuple(
		syntacticRuleNameArb,
		fc.array(fc.tuple(syntacticRuleNameArb, simpleBodyArb), { maxLength: 4, minLength: 0 })
	)
	.map(([startName, additionalRules]) => {
		const uniqueRules = new Map<string, string>()
		uniqueRules.set(startName, 'digit+')

		for (const [name, body] of additionalRules) {
			if (!uniqueRules.has(name) && name !== startName) {
				uniqueRules.set(name, body)
			}
		}

		const ruleStrings = [...uniqueRules.entries()].map(([name, body]) => `    ${name} = ${body}`)

		return `
  TestGrammar {
${ruleStrings.join('\n')}
  }
`
	})

// Grammars with known properties for testing
const nullableGrammarArb = fc.constantFrom(
	grammar('N1 { Start = digit* }'),
	grammar('N2 { Start = letter? }'),
	grammar('N3 { Start = "" }'),
	grammar('N4 { Start = &digit }'),
	grammar('N5 { Start = ~letter }')
)

const nonNullableGrammarArb = fc.constantFrom(
	grammar('NN1 { Start = digit+ }'),
	grammar('NN2 { Start = letter }'),
	grammar('NN3 { Start = "a" }'),
	grammar('NN4 { Start = digit letter }')
)

const unreachableGrammarArb = fc.constantFrom(
	grammar('U1 { Start = digit+ \n Unused = letter+ }'),
	grammar('U2 { Start = "a" \n Dead = "b" \n AlsoDead = "c" }')
)

const fullyReachableGrammarArb = fc.constantFrom(
	grammar('R1 { Start = Item+ \n Item = digit }'),
	grammar('R2 { Start = A B \n A = digit \n B = letter }'),
	grammar('R3 { Start = A | B \n A = digit \n B = letter }')
)

describe('Analyzer property tests', () => {
	describe('analyzeReachability invariants', () => {
		it('always returns array of issues', () => {
			fc.assert(
				fc.property(simpleGrammarArb, (grammarSource) => {
					try {
						const g = grammar(grammarSource)
						const issues = analyzeReachability(g)
						return Array.isArray(issues)
					} catch {
						// Grammar may be invalid, that's OK
						return true
					}
				})
			)
		})

		it('unreachable rules are subset of all rules', () => {
			fc.assert(
				fc.property(fc.oneof(unreachableGrammarArb, fullyReachableGrammarArb), (g) => {
					const allRules = getRuleNames(g)
					const unreachable = findUnreachableRules(g)
					return unreachable.every((rule) => allRules.includes(rule))
				})
			)
		})

		it('fully reachable grammars have no unreachable rules', () => {
			fc.assert(
				fc.property(fullyReachableGrammarArb, (g) => {
					const unreachable = findUnreachableRules(g)
					return unreachable.length === 0
				})
			)
		})

		it('start rule is never unreachable', () => {
			fc.assert(
				fc.property(fc.oneof(unreachableGrammarArb, fullyReachableGrammarArb), (g) => {
					const unreachable = findUnreachableRules(g)
					const allRules = getRuleNames(g)
					const startRule = allRules[0]
					return startRule === undefined || !unreachable.includes(startRule)
				})
			)
		})
	})

	describe('analyzeNullable invariants', () => {
		it('always returns array of issues', () => {
			fc.assert(
				fc.property(simpleGrammarArb, (grammarSource) => {
					try {
						const g = grammar(grammarSource)
						const issues = analyzeNullable(g)
						return Array.isArray(issues)
					} catch {
						return true
					}
				})
			)
		})

		it('known nullable grammars have nullable start rule', () => {
			fc.assert(
				fc.property(nullableGrammarArb, (g) => {
					const nullable = findNullableRules(g)
					const allRules = getRuleNames(g)
					const startRule = allRules[0]
					return startRule !== undefined && nullable.includes(startRule)
				})
			)
		})

		it('known non-nullable grammars have non-nullable start rule', () => {
			fc.assert(
				fc.property(nonNullableGrammarArb, (g) => {
					const nullable = findNullableRules(g)
					const allRules = getRuleNames(g)
					const startRule = allRules[0]
					return startRule === undefined || !nullable.includes(startRule)
				})
			)
		})

		it('nullable rules are subset of all rules', () => {
			fc.assert(
				fc.property(fc.oneof(nullableGrammarArb, nonNullableGrammarArb), (g) => {
					const allRules = getRuleNames(g)
					const nullable = findNullableRules(g)
					return nullable.every((rule) => allRules.includes(rule))
				})
			)
		})
	})

	describe('analyzeShadows invariants', () => {
		it('always returns array of issues', () => {
			fc.assert(
				fc.property(simpleGrammarArb, (grammarSource) => {
					try {
						const g = grammar(grammarSource)
						const issues = analyzeShadows(g)
						return Array.isArray(issues)
					} catch {
						return true
					}
				})
			)
		})

		it('all shadow issues have SHADOWED_ALTERNATIVE code', () => {
			fc.assert(
				fc.property(simpleGrammarArb, (grammarSource) => {
					try {
						const g = grammar(grammarSource)
						const issues = analyzeShadows(g)
						return issues.every((issue) => issue.code === 'SHADOWED_ALTERNATIVE')
					} catch {
						return true
					}
				})
			)
		})

		it('all shadow issues have warning severity', () => {
			fc.assert(
				fc.property(simpleGrammarArb, (grammarSource) => {
					try {
						const g = grammar(grammarSource)
						const issues = analyzeShadows(g)
						return issues.every((issue) => issue.severity === 'warning')
					} catch {
						return true
					}
				})
			)
		})
	})

	describe('analyzeRedundancy invariants', () => {
		it('always returns array of issues', () => {
			fc.assert(
				fc.property(simpleGrammarArb, (grammarSource) => {
					try {
						const g = grammar(grammarSource)
						const issues = analyzeRedundancy(g)
						return Array.isArray(issues)
					} catch {
						return true
					}
				})
			)
		})

		it('all redundancy issues have info severity', () => {
			fc.assert(
				fc.property(simpleGrammarArb, (grammarSource) => {
					try {
						const g = grammar(grammarSource)
						const issues = analyzeRedundancy(g)
						return issues.every((issue) => issue.severity === 'info')
					} catch {
						return true
					}
				})
			)
		})
	})

	describe('analyzeNaming invariants', () => {
		it('always returns array of issues', () => {
			fc.assert(
				fc.property(simpleGrammarArb, (grammarSource) => {
					try {
						const g = grammar(grammarSource)
						const issues = analyzeNaming(g)
						return Array.isArray(issues)
					} catch {
						return true
					}
				})
			)
		})

		it('lexical + syntactic rules cover all user rules', () => {
			fc.assert(
				fc.property(
					fc.oneof(nullableGrammarArb, nonNullableGrammarArb, fullyReachableGrammarArb),
					(g) => {
						const lexical = analyzeLexicalRules(g)
						const syntactic = analyzeSyntacticRules(g)
						const rules = extractRules(g)

						// All rules should be classified as either lexical or syntactic
						for (const [name] of rules) {
							const isLexical = lexical.includes(name)
							const isSyntactic = syntactic.includes(name)
							if (!isLexical && !isSyntactic) {
								return false
							}
						}
						return true
					}
				)
			)
		})
	})

	describe('visitor invariants', () => {
		it('extractRules returns map for any grammar', () => {
			fc.assert(
				fc.property(
					fc.oneof(nullableGrammarArb, nonNullableGrammarArb, fullyReachableGrammarArb),
					(g) => {
						const rules = extractRules(g)
						return rules instanceof Map && rules.size > 0
					}
				)
			)
		})

		it('getRuleNames returns non-empty array for any grammar', () => {
			fc.assert(
				fc.property(
					fc.oneof(nullableGrammarArb, nonNullableGrammarArb, fullyReachableGrammarArb),
					(g) => {
						const names = getRuleNames(g)
						return Array.isArray(names) && names.length > 0
					}
				)
			)
		})

		it('getRuleNames matches extractRules keys', () => {
			fc.assert(
				fc.property(
					fc.oneof(nullableGrammarArb, nonNullableGrammarArb, fullyReachableGrammarArb),
					(g) => {
						const rules = extractRules(g)
						const names = getRuleNames(g)
						return names.length === rules.size && names.every((name) => rules.has(name))
					}
				)
			)
		})
	})

	describe('issue structure invariants', () => {
		it('all issues have required fields', () => {
			fc.assert(
				fc.property(
					fc.oneof(
						nullableGrammarArb,
						nonNullableGrammarArb,
						fullyReachableGrammarArb,
						unreachableGrammarArb
					),
					(g) => {
						const allIssues = [
							...analyzeReachability(g),
							...analyzeNullable(g),
							...analyzeShadows(g),
							...analyzeRedundancy(g),
							...analyzeNaming(g),
						]

						return allIssues.every(
							(issue) =>
								typeof issue.code === 'string' &&
								typeof issue.message === 'string' &&
								typeof issue.severity === 'string' &&
								['error', 'warning', 'info'].includes(issue.severity)
						)
					}
				)
			)
		})
	})
})
