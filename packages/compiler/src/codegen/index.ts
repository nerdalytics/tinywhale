import binaryen from 'binaryen'

import { type CompilationContext, DiagnosticSeverity } from '../core/context.ts'
import type { DiagnosticCode } from '../core/diagnostics.ts'
import { type NodeId, NodeKind } from '../core/nodes.ts'

export class CompileError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'CompileError'
	}
}

export interface EmitOptions {
	optimize?: boolean
}

export interface CompileWarning {
	code: string
	message: string
	line: number
	column: number
}

export interface CompileResult {
	binary: Uint8Array
	text: string
	valid: boolean
	warnings: CompileWarning[]
}

function collectExpressions(
	mod: binaryen.Module,
	context: CompilationContext
): binaryen.ExpressionRef[] {
	const expressions: binaryen.ExpressionRef[] = []

	for (let i = 0; i < context.nodes.count(); i++) {
		const node = context.nodes.get(i as NodeId)

		switch (node.kind) {
			case NodeKind.PanicStatement:
				expressions.push(mod.unreachable())
				break
			case NodeKind.IndentedLine:
			case NodeKind.DedentLine:
			case NodeKind.RootLine:
			case NodeKind.Program:
				break
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

function emitResult(mod: binaryen.Module, warnings: CompileWarning[]): CompileResult {
	const valid = mod.validate() === 1
	const binary = mod.emitBinary()
	const text = mod.emitText()
	mod.dispose()
	return { binary, text, valid, warnings }
}

function extractWarnings(context: CompilationContext): CompileWarning[] {
	return context
		.getDiagnostics()
		.filter((d) => d.def.severity === DiagnosticSeverity.Warning)
		.map((d) => ({
			code: d.def.code,
			column: d.column,
			line: d.line,
			message: d.message,
		}))
}

/**
 * Emit WebAssembly from a compiled program.
 *
 * @param context - Compilation context with populated nodes
 * @param options - Emission options
 * @returns The compilation result containing binary, text, and validation status
 * @throws {CompileError} If the program is empty or contains unknown statement types
 */
export function emit(context: CompilationContext, options: EmitOptions = {}): CompileResult {
	const mod = new binaryen.Module()
	const expressions = collectExpressions(mod, context)

	if (expressions.length === 0) {
		mod.dispose()
		context.emit('TWGEN001' as DiagnosticCode, 1, 1, {})
		throw new CompileError('empty program')
	}

	const body = createFunctionBody(mod, expressions)
	setupStartFunction(mod, body)

	if (options.optimize) {
		mod.optimize()
	}

	const warnings = extractWarnings(context)
	return emitResult(mod, warnings)
}
