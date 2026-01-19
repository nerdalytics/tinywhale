#!/usr/bin/env node

import { HelpCommand, Kernel, ListLoader } from '@adonisjs/ace'
import AnalyzeCommand from './commands/analyze.ts'
import TestCommand from './commands/test.ts'

const version = '0.0.0'

const kernel = Kernel.create()

kernel.info.set('binary', 'tw-grammar-test')
kernel.info.set('version', version)

kernel.defineFlag('help', {
	alias: 'h',
	description: 'Display help information',
	type: 'boolean',
})

kernel.defineFlag('version', {
	alias: 'v',
	description: 'Display version number',
	type: 'boolean',
})

kernel.addLoader(new ListLoader([AnalyzeCommand, TestCommand, HelpCommand]))

kernel.on('finding:command', async (): Promise<boolean> => {
	console.log(`tw-grammar-test v${version}`)
	console.log('')
	console.log('Usage: tw-grammar-test <command> [options]')
	console.log('')
	console.log('Commands:')
	console.log('  analyze <grammar>   Analyze grammar for issues')
	console.log('  test [files...]     Run grammar tests')
	console.log('')
	console.log('Run "tw-grammar-test --help" for available commands and options.')
	return true
})

try {
	await kernel.handle(process.argv.slice(2))
} catch (error: unknown) {
	console.error(error)
	process.exit(1)
}
