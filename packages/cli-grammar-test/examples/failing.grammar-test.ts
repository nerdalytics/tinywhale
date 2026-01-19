import { grammar } from 'ohm-js'
import { defineGrammarSuite } from '../dist/index.js'

const simpleGrammar = grammar(`
  Simple {
    Start = digit+
    Word = letter+
  }
`)

defineGrammarSuite({
	grammar: simpleGrammar,
	name: 'Failing Tests Demo',
	startRule: 'Start',
	tests: (t) => {
		// These pass
		t.match(['1', '123'])

		// These will fail - expecting match but input is rejected
		t.match(['abc', 'hello'])

		// These pass
		t.reject(['!@#'])

		// This will fail - expecting reject but input matches
		t.reject(['999'])
	},
})
