import { basename, join } from 'node:path'
import { CompileError, type CompileResult } from '@tinywhale/compiler'
import {
	interpolateMessage,
	TWCLI001,
	TWCLI002,
	TWCLI003,
	TWCLI004,
	TWCLI005,
	TWCLI006,
} from '@tinywhale/diagnostics'

export type OutputTarget = 'wasm' | 'wat'

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error
}

export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export function formatReadError(filePath: string, error: unknown): string {
	if (isNodeError(error) && error.code === 'ENOENT') {
		const message = interpolateMessage(TWCLI001.message, { path: filePath })
		return `[${TWCLI001.code}] ${message}`
	}
	const message = interpolateMessage(TWCLI002.message, { reason: getErrorMessage(error) })
	return `[${TWCLI002.code}] ${message}`
}

export function formatWriteError(error: unknown): string {
	const message = interpolateMessage(TWCLI003.message, { reason: getErrorMessage(error) })
	return `[${TWCLI003.code}] ${message}`
}

export function formatInvalidTargetError(target: string): string {
	const message = interpolateMessage(TWCLI004.message, { target })
	return `[${TWCLI004.code}] ${message}`
}

export function formatValidationError(): string {
	return `[${TWCLI005.code}] ${TWCLI005.message}`
}

export function formatCompileError(error: unknown): string {
	if (error instanceof CompileError) {
		return error.message
	}
	const message = interpolateMessage(TWCLI006.message, { reason: getErrorMessage(error) })
	return `[${TWCLI006.code}] ${message}`
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
