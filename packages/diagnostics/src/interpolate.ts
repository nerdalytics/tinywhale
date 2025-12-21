import type { DiagnosticArgs } from './types.ts'

/**
 * Interpolate template arguments into a message.
 * Replaces {key} with the corresponding value from args.
 */
export function interpolateMessage(message: string, args?: DiagnosticArgs): string {
	if (!args) return message
	return message.replace(/\{(\w+)\}/g, (_, key: string) => {
		const value = args[key]
		return value !== undefined ? String(value) : `{${key}}`
	})
}
