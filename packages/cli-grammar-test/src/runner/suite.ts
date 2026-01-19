import type { GrammarSuiteDefinition, SuiteResult } from '../types.ts'
import { GrammarTester } from './tester.ts'

const suiteRegistry: GrammarSuiteDefinition[] = []

export function defineGrammarSuite(definition: GrammarSuiteDefinition): void {
	suiteRegistry.push(definition)
}

export function runSuite(definition: GrammarSuiteDefinition): SuiteResult {
	const { grammar, name, startRule, tests } = definition
	const tester = new GrammarTester(grammar, name, startRule)
	tests(tester)
	return tester.run()
}

export function runAllSuites(): SuiteResult[] {
	return suiteRegistry.map(runSuite)
}

export function clearRegistry(): void {
	suiteRegistry.length = 0
}

export function getRegisteredSuites(): readonly GrammarSuiteDefinition[] {
	return suiteRegistry
}
