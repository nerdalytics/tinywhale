import { readFile, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { args, BaseCommand, flags } from '@adonisjs/ace'
import { IndentationError, parse, preprocess } from '@tinywhale/compiler'

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export default class BuildCommand extends BaseCommand {
	static commandName = 'build'
	static description = 'Compile a TinyWhale source file and output the AST'

	@args.string({ description: 'Input .tw file to compile' })
	declare input: string

	@flags.string({ alias: 'o', description: 'Output file (defaults to stdout)' })
	declare output?: string

	async run(): Promise<void> {
		let source: string

		try {
			source = await readFile(this.input, 'utf-8')
		} catch (error: unknown) {
			if (isNodeError(error) && error.code === 'ENOENT') {
				this.logger.error(`File not found: ${this.input}`)
			} else {
				this.logger.error(`Cannot read file: ${getErrorMessage(error)}`)
			}
			this.exitCode = 1
			return
		}

		let preprocessed: string
		try {
			preprocessed = await preprocess(Readable.from(source))
		} catch (error: unknown) {
			if (error instanceof IndentationError) {
				this.logger.error(error.message)
			} else {
				this.logger.error(`Preprocessing failed: ${getErrorMessage(error)}`)
			}
			this.exitCode = 1
			return
		}

		const result = parse(preprocessed)
		const json = JSON.stringify(result, null, '\t')

		if (this.output) {
			try {
				await writeFile(this.output, json, 'utf-8')
			} catch (error: unknown) {
				this.logger.error(`Cannot write to ${this.output}: ${getErrorMessage(error)}`)
				this.exitCode = 1
				return
			}
		} else {
			console.log(json)
		}

		if (!result.succeeded) {
			this.exitCode = 1
		}
	}
}
