#!/usr/bin/env node

import { HelpCommand, Kernel, ListLoader } from '@adonisjs/ace'
import BuildCommand from './commands/build.js'

const version = '0.0.0'

async function main(): Promise<void> {
	const kernel = Kernel.create()

	kernel.info.set('binary', 'tinywhale')
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

	kernel.addLoader(new ListLoader([BuildCommand, HelpCommand]))

	kernel.on('finding:command', async () => {
		console.log(`TinyWhale v${version}`)
		console.log('')
		console.log('Usage: tinywhale [command] [options]')
		console.log('')
		console.log('Run "tinywhale --help" for available commands and options.')
		return true
	})

	await kernel.handle(process.argv.slice(2))
}

main().catch((error: unknown) => {
	console.error(error)
	process.exit(1)
})
