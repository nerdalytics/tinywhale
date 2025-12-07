import { basename, join } from 'node:path'
import { CompileError, type CompileResult } from '@tinywhale/compiler'

export type OutputTarget = 'wasm' | 'wat'

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error
}

export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export function formatReadError(filePath: string, error: unknown): string {
	if (isNodeError(error) && error.code === 'ENOENT') {
		return `File not found: ${filePath}`
	}
	return `Cannot read file: ${getErrorMessage(error)}`
}

export function formatCompileError(error: unknown): string {
	if (error instanceof CompileError) {
		return error.message
	}
	return `Compilation failed: ${getErrorMessage(error)}`
}

export function isValidTarget(value: string): value is OutputTarget {
	return value === 'wasm' || value === 'wat'
}

export function resolveOutputFilename(inputPath: string, target: OutputTarget): string {
	return `${basename(inputPath, '.tw')}.${target}`
}

export function resolveOutputPath(
	inputPath: string,
	outputDir: string | undefined,
	target: OutputTarget
): string {
	const filename = resolveOutputFilename(inputPath, target)
	const dir = outputDir ?? '.'
	return join(dir, filename)
}

export function getOutputContent(result: CompileResult, target: OutputTarget): Uint8Array | string {
	return target === 'wat' ? result.text : result.binary
}
