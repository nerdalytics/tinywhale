import binaryen from 'binaryen'

import type { ParseResult, Statement } from '../grammar/index.ts'

/**
 * Error thrown when compilation fails.
 */
export class CompileError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'CompileError'
	}
}

/**
 * Options for the compile function.
 */
export interface CompileOptions {
	/** Run Binaryen optimization passes (default: false) */
	optimize?: boolean
}

/**
 * Result of compiling a TinyWhale program to WebAssembly.
 */
export interface CompileResult {
	/** The compiled WebAssembly binary */
	binary: Uint8Array
	/** The WebAssembly text format (WAT) representation */
	text: string
	/** Whether the module passed validation */
	valid: boolean
}

function compileStatement(mod: binaryen.Module, stmt: Statement): binaryen.ExpressionRef {
	switch (stmt.type) {
		case 'panic':
			return mod.unreachable()
		default:
			throw new CompileError(`Unknown statement type: ${(stmt as Statement).type}`)
	}
}

function collectExpressions(
	mod: binaryen.Module,
	parseResult: ParseResult
): binaryen.ExpressionRef[] {
	const expressions: binaryen.ExpressionRef[] = []
	for (const line of parseResult.lines) {
		if (line.statement) {
			expressions.push(compileStatement(mod, line.statement))
		}
	}
	return expressions
}

function createFunctionBody(
	mod: binaryen.Module,
	expressions: binaryen.ExpressionRef[]
): binaryen.ExpressionRef {
	return expressions.length === 1
		? (expressions[0] as binaryen.ExpressionRef)
		: mod.block(null, expressions)
}

function setupStartFunction(mod: binaryen.Module, body: binaryen.ExpressionRef): void {
	mod.addFunction('_start', binaryen.none, binaryen.none, [], body)
	mod.addFunctionExport('_start', '_start')
	const startFunc = mod.getFunction('_start')
	if (startFunc !== undefined) {
		mod.setStart(startFunc)
	}
}

function emitResult(mod: binaryen.Module): CompileResult {
	const valid = mod.validate() === 1
	const binary = mod.emitBinary()
	const text = mod.emitText()
	mod.dispose()
	return { binary, text, valid }
}

/**
 * Compile a parsed TinyWhale program to WebAssembly.
 *
 * @param parseResult - The result of parsing a TinyWhale program
 * @param options - Compilation options
 * @returns The compilation result containing binary, text, and validation status
 * @throws {CompileError} If the program is empty or contains unknown statement types
 */
export function compile(parseResult: ParseResult, options: CompileOptions = {}): CompileResult {
	const mod = new binaryen.Module()
	const expressions = collectExpressions(mod, parseResult)

	if (expressions.length === 0) {
		mod.dispose()
		throw new CompileError('Empty program: at least one statement is required')
	}

	const body = createFunctionBody(mod, expressions)
	setupStartFunction(mod, body)

	if (options.optimize) {
		mod.optimize()
	}

	return emitResult(mod)
}
