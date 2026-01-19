#!/usr/bin/env node

import { HelpCommand, Kernel, ListLoader } from '@adonisjs/ace'
import StartCommand from './commands/start.ts'

const version = '0.0.0'

const kernel = Kernel.create()

kernel.info.set('binary', 'tinywhale-lsp')
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

kernel.addLoader(new ListLoader([StartCommand, HelpCommand]))

kernel.on('finding:command', async (): Promise<boolean> => {
	console.log(`tinywhale-lsp v${version}`)
	console.log('')
	console.log('Usage: tinywhale-lsp <command> [options]')
	console.log('')
	console.log('Commands:')
	console.log('  start    Start the language server')
	console.log('')
	console.log('Run "tinywhale-lsp --help" for available commands and options.')
	return true
})

try {
	await kernel.handle(process.argv.slice(2))
} catch (error: unknown) {
	console.error(error)
	process.exit(1)
}
