import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { args, BaseCommand, flags } from '@adonisjs/ace'
import { type CompileResult, type CompileWarning, compile } from '@tinywhale/compiler'
import {
	formatCompileError,
	formatInvalidTargetError,
	formatReadError,
	formatValidationError,
	formatWriteError,
	getOutputContent,
	isValidTarget,
	type OutputTarget,
	resolveOutputPath,
} from '../utils.ts'

export default class BuildCommand extends BaseCommand {
	static override commandName = 'build'
	static override description = 'Compile a TinyWhale source file to WebAssembly'

	@args.string({ description: 'Input .tw file to compile' })
	declare input: string

	@flags.string({ alias: 'o', description: 'Output directory (created if not exists)' })
	declare output?: string

	@flags.string({
		alias: 't',
		default: 'wasm',
		description: 'Output format: wasm (binary) or wat (text)',
	})
	declare target: string

	@flags.boolean({ description: 'Run optimization passes' })
	declare optimize: boolean

	private async readSourceFile(): Promise<string | null> {
		try {
			return await readFile(this.input, 'utf-8')
		} catch (error: unknown) {
			this.logger.error(formatReadError(this.input, error))
			this.exitCode = 1
			return null
		}
	}

	private displayWarnings(warnings: CompileWarning[]): void {
		for (const warning of warnings) {
			this.logger.warning(warning.formattedMessage)
		}
	}

	private compileSource(source: string): CompileResult | null {
		try {
			const result = compile(source, { filename: this.input, optimize: this.optimize })
			this.displayWarnings(result.warnings)
			if (!result.valid) {
				this.logger.error(formatValidationError())
				this.exitCode = 1
				return null
			}
			return result
		} catch (error: unknown) {
			this.logger.error(formatCompileError(error))
			this.exitCode = 1
			return null
		}
	}

	private validateTarget(): boolean {
		if (!isValidTarget(this.target)) {
			this.logger.error(formatInvalidTargetError(this.target))
			this.exitCode = 1
			return false
		}
		return true
	}

	private async writeOutputFile(
		outputPath: string,
		content: Uint8Array | string
	): Promise<boolean> {
		try {
			await writeFile(outputPath, content)
			return true
		} catch (error: unknown) {
			this.logger.error(formatWriteError(error))
			return false
		}
	}

	private async emitOutput(result: CompileResult): Promise<void> {
		const target = this.target as OutputTarget
		const dir = this.output ?? '.'

		await mkdir(dir, { recursive: true })

		const outputPath = resolveOutputPath(this.input, this.output, target)
		const content = getOutputContent(result, target)
		const written = await this.writeOutputFile(outputPath, content)
		if (!written) {
			this.exitCode = 1
		}
	}

	override async run(): Promise<void> {
		if (!this.validateTarget()) return

		const source = await this.readSourceFile()
		if (source === null) return

		const result = this.compileSource(source)
		if (result === null) return

		await this.emitOutput(result)
	}
}
