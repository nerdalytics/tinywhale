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

function formatReadError(filePath: string, error: unknown): string {
	if (isNodeError(error) && error.code === 'ENOENT') {
		return `File not found: ${filePath}`
	}
	return `Cannot read file: ${getErrorMessage(error)}`
}

export default class BuildCommand extends BaseCommand {
	static override commandName = 'build'
	static override description = 'Compile a TinyWhale source file and output the AST'

	@args.string({ description: 'Input .tw file to compile' })
	declare input: string

	@flags.string({ alias: 'o', description: 'Output file (defaults to stdout)' })
	declare output?: string

	private async readSourceFile(): Promise<string | null> {
		try {
			return await readFile(this.input, 'utf-8')
		} catch (error: unknown) {
			this.logger.error(formatReadError(this.input, error))
			this.exitCode = 1
			return null
		}
	}

	private async preprocessSource(source: string): Promise<string | null> {
		try {
			return await preprocess(Readable.from(source))
		} catch (error: unknown) {
			if (error instanceof IndentationError) {
				this.logger.error(error.message)
			} else {
				this.logger.error(`Preprocessing failed: ${getErrorMessage(error)}`)
			}
			this.exitCode = 1
			return null
		}
	}

	private async writeOutput(json: string): Promise<boolean> {
		if (!this.output) {
			console.log(json)
			return true
		}
		try {
			await writeFile(this.output, json, 'utf-8')
			return true
		} catch (error: unknown) {
			this.logger.error(`Cannot write to ${this.output}: ${getErrorMessage(error)}`)
			return false
		}
	}

	override async run(): Promise<void> {
		const source = await this.readSourceFile()
		if (source === null) return

		const preprocessed = await this.preprocessSource(source)
		if (preprocessed === null) return

		const result = parse(preprocessed)
		const json = JSON.stringify(result, null, '\t')

		const written = await this.writeOutput(json)
		if (!written) {
			this.exitCode = 1
			return
		}

		if (!result.succeeded) {
			this.exitCode = 1
		}
	}
}
