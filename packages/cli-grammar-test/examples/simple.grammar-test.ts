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
	name: 'Simple Grammar Tests',
	startRule: 'Start',
	tests: (t) => {
		t.match(['1', '123', '9999'])
		t.reject(['abc', '', ' '])
		t.match('hello', { startRule: 'Word' })
	},
})

defineGrammarSuite({
	grammar: simpleGrammar,
	name: 'Word Rule Tests',
	startRule: 'Word',
	tests: (t) => {
		t.match(['a', 'hello', 'WORLD'])
		t.reject(['123', '!@#'])
	},
})
