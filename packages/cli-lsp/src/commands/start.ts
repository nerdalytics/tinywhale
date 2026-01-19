import { BaseCommand, flags } from '@adonisjs/ace'

export default class StartCommand extends BaseCommand {
	static override commandName = 'start'
	static override description = 'Start the TinyWhale language server'

	@flags.boolean({
		default: true,
		description: 'Use stdio for communication (default)',
	})
	declare stdio: boolean

	@flags.number({
		alias: 'p',
		description: 'Use TCP socket on specified port',
	})
	declare port?: number

	override async run(): Promise<void> {
		if (this.port !== undefined) {
			this.logger.info(`Starting language server on port ${this.port}...`)
			this.logger.warning('TCP mode not yet implemented')
			this.exitCode = 1
			return
		}

		this.logger.info('Starting language server on stdio...')
		this.logger.warning('Language server not yet implemented')
		this.logger.info('See @tinywhale/lsp package for implementation status')
	}
}
