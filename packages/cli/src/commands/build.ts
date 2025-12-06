import { readFile, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { args, BaseCommand, flags } from '@adonisjs/ace'
import { IndentationError, parse, preprocess } from '@tinywhale/compiler'

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
		} catch (error) {
			const err = error as NodeJS.ErrnoException
			if (err.code === 'ENOENT') {
				this.logger.error(`File not found: ${this.input}`)
			} else {
				this.logger.error(`Cannot read file: ${err.message}`)
			}
			this.exitCode = 1
			return
		}

		let preprocessed: string
		try {
			preprocessed = await preprocess(Readable.from(source))
		} catch (error) {
			if (error instanceof IndentationError) {
				this.logger.error(error.message)
			} else {
				this.logger.error(`Preprocessing failed: ${(error as Error).message}`)
			}
			this.exitCode = 1
			return
		}

		const result = parse(preprocessed)
		const json = JSON.stringify(result, null, '\t')

		if (this.output) {
			try {
				await writeFile(this.output, json, 'utf-8')
			} catch (error) {
				this.logger.error(`Cannot write to ${this.output}: ${(error as Error).message}`)
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
