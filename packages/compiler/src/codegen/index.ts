import binaryen from 'binaryen'

import type { CompilationContext } from '../core/context.ts'
import { type NodeId, NodeKind } from '../core/nodes.ts'

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
 * Options for the emit function.
 */
export interface EmitOptions {
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

/**
 * Collects Binaryen expressions from the NodeStore.
 * Iterates all nodes looking for statement kinds.
 */
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
			// Line and Program nodes don't emit expressions themselves
			case NodeKind.IndentedLine:
			case NodeKind.DedentLine:
			case NodeKind.RootLine:
			case NodeKind.Program:
				// These are structural nodes, skip them
				break
		}
	}

	return expressions
}

/**
 * Creates a function body from collected expressions.
 */
function createFunctionBody(
	mod: binaryen.Module,
	expressions: binaryen.ExpressionRef[]
): binaryen.ExpressionRef {
	return expressions.length === 1
		? (expressions[0] as binaryen.ExpressionRef)
		: mod.block(null, expressions)
}

/**
 * Sets up the _start function with export and module start.
 */
function setupStartFunction(mod: binaryen.Module, body: binaryen.ExpressionRef): void {
	mod.addFunction('_start', binaryen.none, binaryen.none, [], body)
	mod.addFunctionExport('_start', '_start')
	const startFunc = mod.getFunction('_start')
	if (startFunc !== undefined) {
		mod.setStart(startFunc)
	}
}

/**
 * Emits the final compilation result.
 */
function emitResult(mod: binaryen.Module): CompileResult {
	const valid = mod.validate() === 1
	const binary = mod.emitBinary()
	const text = mod.emitText()
	mod.dispose()
	return { binary, text, valid }
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
		throw new CompileError('Empty program: at least one statement is required')
	}

	const body = createFunctionBody(mod, expressions)
	setupStartFunction(mod, body)

	if (options.optimize) {
		mod.optimize()
	}

	return emitResult(mod)
}
