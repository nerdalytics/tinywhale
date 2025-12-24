import binaryen from 'binaryen'

import { BuiltinTypeId, type Inst, InstKind, type TypeId } from '../check/types.ts'
import { type CompilationContext, DiagnosticSeverity, type FloatId } from '../core/context.ts'
import type { DiagnosticCode } from '../core/diagnostics.ts'

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
	formattedMessage: string
}

export interface CompileResult {
	binary: Uint8Array
	text: string
	valid: boolean
	warnings: CompileWarning[]
}

/**
 * Convert a TypeId to a binaryen type.
 */
function toBinaryenType(typeId: TypeId, context: CompilationContext): binaryen.Type {
	// Unwrap distinct types to get the underlying WASM primitive
	const wasmTypeId = context.types?.toWasmType(typeId) ?? typeId

	switch (wasmTypeId) {
		case BuiltinTypeId.I32:
			return binaryen.i32
		case BuiltinTypeId.I64:
			return binaryen.i64
		case BuiltinTypeId.F32:
			return binaryen.f32
		case BuiltinTypeId.F64:
			return binaryen.f64
		default:
			return binaryen.none
	}
}

/**
 * Build the locals array for the function.
 * Each symbol becomes a WASM local at its localIndex.
 */
function buildLocals(context: CompilationContext): binaryen.Type[] {
	if (!context.symbols) return []

	const locals: binaryen.Type[] = []
	for (const [, symbol] of context.symbols) {
		const binaryenType = toBinaryenType(symbol.typeId, context)
		while (locals.length <= symbol.localIndex) {
			locals.push(binaryen.none)
		}
		locals[symbol.localIndex] = binaryenType
	}
	return locals
}

function emitIntConst(
	mod: binaryen.Module,
	inst: Inst,
	context: CompilationContext
): binaryen.ExpressionRef {
	const binaryenType = toBinaryenType(inst.typeId, context)
	if (binaryenType === binaryen.i64) {
		return mod.i64.const(inst.arg0, inst.arg1)
	}
	return mod.i32.const(inst.arg0)
}

/**
 * Emit a float constant instruction.
 * arg0 contains the FloatId referencing the float value in FloatStore.
 */
function emitFloatConst(
	mod: binaryen.Module,
	inst: Inst,
	context: CompilationContext
): binaryen.ExpressionRef {
	const floatId = inst.arg0 as FloatId
	const value = context.floats.get(floatId)
	const binaryenType = toBinaryenType(inst.typeId, context)

	if (binaryenType === binaryen.f64) {
		return mod.f64.const(value)
	}
	return mod.f32.const(value)
}

function emitVarRef(
	mod: binaryen.Module,
	inst: Inst,
	context: CompilationContext
): binaryen.ExpressionRef | null {
	const symId = inst.arg0
	const symbol = context.symbols?.get(symId as import('../check/types.ts').SymbolId)
	if (!symbol) return null
	const binaryenType = toBinaryenType(symbol.typeId, context)
	return mod.local.get(symbol.localIndex, binaryenType)
}

function emitBind(
	mod: binaryen.Module,
	inst: Inst,
	valueMap: Map<number, binaryen.ExpressionRef>,
	context: CompilationContext
): binaryen.ExpressionRef | null {
	const symId = inst.arg0
	const initInstId = inst.arg1
	const symbol = context.symbols?.get(symId as import('../check/types.ts').SymbolId)
	if (!symbol) return null

	const initExpr = valueMap.get(initInstId)
	if (initExpr === undefined) return null

	return mod.local.set(symbol.localIndex, initExpr)
}

/**
 * Emit an instruction and return its expression (if it produces a value).
 */
function emitInstruction(
	mod: binaryen.Module,
	inst: Inst,
	valueMap: Map<number, binaryen.ExpressionRef>,
	context: CompilationContext
): binaryen.ExpressionRef | null {
	switch (inst.kind) {
		case InstKind.Unreachable:
			return mod.unreachable()
		case InstKind.IntConst:
			return emitIntConst(mod, inst, context)
		case InstKind.FloatConst:
			return emitFloatConst(mod, inst, context)
		case InstKind.VarRef:
			return emitVarRef(mod, inst, context)
		case InstKind.Bind:
			return emitBind(mod, inst, valueMap, context)
		default:
			return null
	}
}

function isValueProducer(kind: import('../check/types.ts').InstKind): boolean {
	return kind === InstKind.IntConst || kind === InstKind.FloatConst || kind === InstKind.VarRef
}

function isStatement(kind: import('../check/types.ts').InstKind): boolean {
	return kind === InstKind.Unreachable || kind === InstKind.Bind
}

function processInstruction(
	instId: number,
	inst: Inst,
	mod: binaryen.Module,
	valueMap: Map<number, binaryen.ExpressionRef>,
	expressions: binaryen.ExpressionRef[],
	context: CompilationContext
): void {
	const expr = emitInstruction(mod, inst, valueMap, context)
	if (expr === null) return

	if (isValueProducer(inst.kind)) {
		valueMap.set(instId, expr)
	}
	if (isStatement(inst.kind)) {
		expressions.push(expr)
	}
}

/**
 * Collect expressions from semantic instructions.
 */
function collectExpressions(
	mod: binaryen.Module,
	context: CompilationContext
): binaryen.ExpressionRef[] {
	const expressions: binaryen.ExpressionRef[] = []
	const valueMap = new Map<number, binaryen.ExpressionRef>()

	if (!context.insts) return expressions

	for (const [instId, inst] of context.insts) {
		processInstruction(instId as number, inst, mod, valueMap, expressions, context)
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

function setupStartFunction(
	mod: binaryen.Module,
	body: binaryen.ExpressionRef,
	locals: binaryen.Type[]
): void {
	mod.addFunction('_start', binaryen.none, binaryen.none, locals, body)
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
			formattedMessage: context.formatDiagnostic(d),
			line: d.line,
			message: d.message,
		}))
}

/**
 * Emit WebAssembly from a compiled program.
 *
 * @throws {CompileError} If the program is empty
 */
export function emit(context: CompilationContext, options: EmitOptions = {}): CompileResult {
	const mod = new binaryen.Module()
	const locals = buildLocals(context)
	const expressions = collectExpressions(mod, context)

	if (expressions.length === 0) {
		mod.dispose()
		context.emit('TWGEN001' as DiagnosticCode, 1, 1, {})
		throw new CompileError('empty program')
	}

	const body = createFunctionBody(mod, expressions)
	setupStartFunction(mod, body, locals)

	if (options.optimize) {
		mod.optimize()
	}

	const warnings = extractWarnings(context)
	return emitResult(mod, warnings)
}
