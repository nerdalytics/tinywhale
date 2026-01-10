import binaryen from 'binaryen'

import {
	BuiltinTypeId,
	type Inst,
	type InstId,
	InstKind,
	instId,
	type TypeId,
} from '../check/types.ts'
import {
	type CompilationContext,
	DiagnosticSeverity,
	type FloatId,
	type StringId,
} from '../core/context.ts'
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
	formattedMessage: string
}

export interface CompileResult {
	binary: Uint8Array
	text: string
	valid: boolean
	warnings: CompileWarning[]
}

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

function emitNegate(
	mod: binaryen.Module,
	inst: Inst,
	valueMap: Map<number, binaryen.ExpressionRef>,
	context: CompilationContext
): binaryen.ExpressionRef | null {
	const operand = valueMap.get(inst.arg0)
	if (operand === undefined) return null

	const binaryenType = toBinaryenType(inst.typeId, context)

	switch (binaryenType) {
		case binaryen.i32:
			return mod.i32.sub(mod.i32.const(0), operand)
		case binaryen.i64:
			return mod.i64.sub(mod.i64.const(0, 0), operand)
		case binaryen.f32:
			return mod.f32.neg(operand)
		case binaryen.f64:
			return mod.f64.neg(operand)
		default:
			return null
	}
}

/**
 * Extract integer literal value from a LiteralPattern node.
 * For `-N` patterns, tokenId points to Minus, and IntLiteral is at tokenId+1.
 * For `N` patterns, tokenId points directly to IntLiteral.
 */
function extractLiteralValue(
	patternNodeId: NodeId,
	context: CompilationContext
): { value: bigint; isNegated: boolean } | null {
	const patternNode = context.nodes.get(patternNodeId)
	if (patternNode.kind !== NodeKind.LiteralPattern) return null

	const firstToken = context.tokens.get(patternNode.tokenId)

	// Check if pattern starts with Minus (kind=5)
	if (firstToken.kind === 5) {
		// Negated literal: tokenId+1 is the IntLiteral
		const literalTokenId = (patternNode.tokenId as number) + 1
		const literalToken = context.tokens.get(literalTokenId as import('../core/tokens.ts').TokenId)
		const text = context.strings.get(literalToken.payload as StringId)
		return { isNegated: true, value: BigInt(text) }
	}

	// Positive literal: tokenId is the IntLiteral
	const text = context.strings.get(firstToken.payload as StringId)
	return { isNegated: false, value: BigInt(text) }
}

/**
 * Emit a comparison expression: scrutinee == literal
 */
function emitLiteralComparison(
	mod: binaryen.Module,
	scrutineeExpr: binaryen.ExpressionRef,
	literalValue: bigint,
	isNegated: boolean,
	typeId: TypeId,
	context: CompilationContext
): binaryen.ExpressionRef {
	const value = isNegated ? -literalValue : literalValue
	const binaryenType = toBinaryenType(typeId, context)

	if (binaryenType === binaryen.i64) {
		const low = Number(BigInt.asIntN(32, value))
		const high = Number(BigInt.asIntN(32, value >> 32n))
		return mod.i64.eq(scrutineeExpr, mod.i64.const(low, high))
	}

	return mod.i32.eq(scrutineeExpr, mod.i32.const(Number(value)))
}

function isPatternKind(kind: NodeKind): boolean {
	return kind >= 200 && kind < 250
}

function emitLiteralPatternComparison(
	mod: binaryen.Module,
	scrutineeExpr: binaryen.ExpressionRef,
	patternNodeId: NodeId,
	typeId: TypeId,
	context: CompilationContext
): binaryen.ExpressionRef | null {
	const literal = extractLiteralValue(patternNodeId, context)
	if (!literal) return null
	return emitLiteralComparison(
		mod,
		scrutineeExpr,
		literal.value,
		literal.isNegated,
		typeId,
		context
	)
}

function collectPatternChildren(patternNodeId: NodeId, context: CompilationContext): NodeId[] {
	const children: NodeId[] = []
	for (const [childId, child] of context.nodes.iterateChildren(patternNodeId)) {
		if (isPatternKind(child.kind)) children.push(childId)
	}
	return children
}

function hasCatchAllComparison(comparisons: Array<binaryen.ExpressionRef | null>): boolean {
	return comparisons.some((cmp) => cmp === null)
}

function orCombine(
	mod: binaryen.Module,
	comparisons: binaryen.ExpressionRef[]
): binaryen.ExpressionRef | null {
	if (comparisons.length === 0) return null
	return comparisons.reduce((acc, cmp) => mod.i32.or(acc, cmp))
}

function combineComparisonsWithOr(
	mod: binaryen.Module,
	comparisons: Array<binaryen.ExpressionRef | null>
): binaryen.ExpressionRef | null {
	if (hasCatchAllComparison(comparisons)) return null
	return orCombine(mod, comparisons as binaryen.ExpressionRef[])
}

/**
 * Emit comparison for an or-pattern (p1 | p2 | ...).
 * Returns null if any child is a catch-all.
 */
function emitOrPatternComparison(
	mod: binaryen.Module,
	scrutineeExpr: binaryen.ExpressionRef,
	patternNodeId: NodeId,
	typeId: TypeId,
	context: CompilationContext
): binaryen.ExpressionRef | null {
	const children = collectPatternChildren(patternNodeId, context)
	const comparisons = children.map((id) =>
		emitPatternComparison(mod, scrutineeExpr, id, typeId, context)
	)
	return combineComparisonsWithOr(mod, comparisons)
}

/**
 * Emit pattern comparison for a single pattern.
 * Returns null if the pattern is a catch-all (wildcard/binding).
 */
function emitPatternComparison(
	mod: binaryen.Module,
	scrutineeExpr: binaryen.ExpressionRef,
	patternNodeId: NodeId,
	typeId: TypeId,
	context: CompilationContext
): binaryen.ExpressionRef | null {
	const patternNode = context.nodes.get(patternNodeId)

	switch (patternNode.kind) {
		case NodeKind.WildcardPattern:
		case NodeKind.BindingPattern:
			return null
		case NodeKind.LiteralPattern:
			return emitLiteralPatternComparison(mod, scrutineeExpr, patternNodeId, typeId, context)
		case NodeKind.OrPattern:
			return emitOrPatternComparison(mod, scrutineeExpr, patternNodeId, typeId, context)
		default:
			return null
	}
}

interface MatchArm {
	patternNodeId: NodeId
	bodyInstId: InstId
}

/**
 * Collect match arm instructions that precede the Match instruction.
 */
function collectMatchArms(
	currentInstId: number,
	armCount: number,
	context: CompilationContext
): MatchArm[] {
	const arms: MatchArm[] = []
	for (let i = armCount; i >= 1; i--) {
		const armInstId = instId(currentInstId - i)
		const armInst = context.insts?.get(armInstId)
		if (armInst?.kind === InstKind.MatchArm) {
			arms.push({ bodyInstId: armInst.arg1 as InstId, patternNodeId: armInst.arg0 as NodeId })
		}
	}
	return arms
}

function buildArmResult(
	mod: binaryen.Module,
	comparison: binaryen.ExpressionRef | null,
	bodyExpr: binaryen.ExpressionRef,
	currentResult: binaryen.ExpressionRef | null
): binaryen.ExpressionRef {
	if (comparison === null) return bodyExpr
	if (currentResult === null) return mod.if(comparison, bodyExpr, mod.unreachable())
	return mod.if(comparison, bodyExpr, currentResult)
}

/** Process a single arm and return updated result, or null if arm should be skipped */
function processMatchArm(
	mod: binaryen.Module,
	arm: MatchArm,
	scrutineeExpr: binaryen.ExpressionRef,
	typeId: TypeId,
	valueMap: Map<number, binaryen.ExpressionRef>,
	currentResult: binaryen.ExpressionRef | null,
	context: CompilationContext
): binaryen.ExpressionRef | null {
	const bodyExpr = valueMap.get(arm.bodyInstId as number)
	if (bodyExpr === undefined) return currentResult
	const comparison = emitPatternComparison(mod, scrutineeExpr, arm.patternNodeId, typeId, context)
	return buildArmResult(mod, comparison, bodyExpr, currentResult)
}

function buildMatchChain(
	mod: binaryen.Module,
	scrutineeExpr: binaryen.ExpressionRef,
	arms: MatchArm[],
	typeId: TypeId,
	valueMap: Map<number, binaryen.ExpressionRef>,
	context: CompilationContext
): binaryen.ExpressionRef | null {
	let result: binaryen.ExpressionRef | null = null
	for (let i = arms.length - 1; i >= 0; i--) {
		const arm = arms[i]
		if (arm) result = processMatchArm(mod, arm, scrutineeExpr, typeId, valueMap, result, context)
	}
	return result
}

/**
 * Emit a match expression by building cascading if/else.
 */
function emitMatch(
	mod: binaryen.Module,
	inst: Inst,
	currentInstId: number,
	valueMap: Map<number, binaryen.ExpressionRef>,
	context: CompilationContext
): binaryen.ExpressionRef | null {
	const scrutineeExpr = valueMap.get(inst.arg0)
	if (scrutineeExpr === undefined) return null

	const arms = collectMatchArms(currentInstId, inst.arg1, context)
	if (arms.length === 0) return null

	return buildMatchChain(mod, scrutineeExpr, arms, inst.typeId, valueMap, context)
}

/**
 * Emit an instruction and return its expression (if it produces a value).
 */
function emitInstruction(
	mod: binaryen.Module,
	inst: Inst,
	instId: number,
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
		case InstKind.Negate:
			return emitNegate(mod, inst, valueMap, context)
		case InstKind.Match:
			return emitMatch(mod, inst, instId, valueMap, context)
		case InstKind.MatchArm:
			// MatchArm is handled by emitMatch - skip here
			return null
		default:
			return null
	}
}

function isValueProducer(kind: import('../check/types.ts').InstKind): boolean {
	return (
		kind === InstKind.IntConst ||
		kind === InstKind.FloatConst ||
		kind === InstKind.VarRef ||
		kind === InstKind.Negate ||
		kind === InstKind.Match
	)
}

function isStatement(kind: import('../check/types.ts').InstKind): boolean {
	return kind === InstKind.Unreachable || kind === InstKind.Bind
}

function processInstruction(
	currentInstId: number,
	inst: Inst,
	mod: binaryen.Module,
	valueMap: Map<number, binaryen.ExpressionRef>,
	expressions: binaryen.ExpressionRef[],
	context: CompilationContext
): void {
	const expr = emitInstruction(mod, inst, currentInstId, valueMap, context)
	if (expr === null) return

	if (isValueProducer(inst.kind)) {
		valueMap.set(currentInstId, expr)
	}
	if (isStatement(inst.kind)) {
		expressions.push(expr)
	}
}

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
