import binaryen from 'binaryen'

import {
	BuiltinTypeId,
	getBinaryOpLeftId,
	getBinaryOpRightId,
	getBindInitId,
	getBindSymbolId,
	getBitwiseNotOperandId,
	getFloatConstId,
	getIntConstHigh,
	getIntConstLow,
	getLogicalAndLeftId,
	getLogicalAndRightId,
	getLogicalOrLeftId,
	getLogicalOrRightId,
	getMatchArmBodyId,
	getMatchArmCount,
	getMatchArmPatternNodeId,
	getMatchScrutineeId,
	getNegateOperandId,
	getVarRefSymbolId,
	type Inst,
	type InstId,
	InstKind,
	instId,
	type TypeId,
} from '../check/types.ts'
import { type CompilationContext, DiagnosticSeverity, type StringId } from '../core/context.ts'
import type { DiagnosticCode } from '../core/diagnostics.ts'
import { type NodeId, NodeKind } from '../core/nodes.ts'
import { nextTokenId, TokenKind } from '../core/tokens.ts'

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
		return mod.i64.const(getIntConstLow(inst), getIntConstHigh(inst))
	}
	return mod.i32.const(getIntConstLow(inst))
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
	const floatId = getFloatConstId(inst)
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
	const symId = getVarRefSymbolId(inst)
	const symbol = context.symbols?.get(symId)
	if (!symbol) return null
	const binaryenType = toBinaryenType(symbol.typeId, context)
	return mod.local.get(symbol.localIndex, binaryenType)
}

function emitBind(
	mod: binaryen.Module,
	inst: Inst,
	valueMap: Map<InstId, binaryen.ExpressionRef>,
	context: CompilationContext
): binaryen.ExpressionRef | null {
	const symId = getBindSymbolId(inst)
	const initInstId = getBindInitId(inst)
	const symbol = context.symbols?.get(symId)
	if (!symbol) return null

	const initExpr = valueMap.get(initInstId)
	if (initExpr === undefined) return null

	return mod.local.set(symbol.localIndex, initExpr)
}

function emitNegate(
	mod: binaryen.Module,
	inst: Inst,
	valueMap: Map<InstId, binaryen.ExpressionRef>,
	context: CompilationContext
): binaryen.ExpressionRef | null {
	const operandId = getNegateOperandId(inst)
	const operand = valueMap.get(operandId)
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

function emitBitwiseNot(
	mod: binaryen.Module,
	inst: Inst,
	valueMap: Map<InstId, binaryen.ExpressionRef>,
	context: CompilationContext
): binaryen.ExpressionRef | null {
	const operandId = getBitwiseNotOperandId(inst)
	const operand = valueMap.get(operandId)
	if (operand === undefined) return null

	const binaryenType = toBinaryenType(inst.typeId, context)

	switch (binaryenType) {
		case binaryen.i32:
			return mod.i32.xor(operand, mod.i32.const(-1))
		case binaryen.i64:
			return mod.i64.xor(operand, mod.i64.const(-1, -1))
		default:
			return null
	}
}

/**
 * Emit Euclidean modulo: ((a % b) + abs(b)) % abs(b)
 * This handles negative divisors correctly.
 */
function emitEuclideanMod(
	mod: binaryen.Module,
	left: binaryen.ExpressionRef,
	right: binaryen.ExpressionRef,
	binaryenType: binaryen.Type
): binaryen.ExpressionRef | null {
	if (binaryenType === binaryen.i32) {
		// abs(b) for i32: ((b >> 31) ^ b) - (b >> 31)
		// But simpler: use select based on sign
		// Actually, for WASM we can use: if b < 0 then -b else b
		const absB = mod.select(
			mod.i32.lt_s(right, mod.i32.const(0)),
			mod.i32.sub(mod.i32.const(0), right),
			right
		)
		// ((a % b) + abs(b)) % abs(b)
		const remainder = mod.i32.rem_s(left, right)
		const adjusted = mod.i32.add(remainder, absB)
		return mod.i32.rem_s(adjusted, absB)
	}
	if (binaryenType === binaryen.i64) {
		const absB = mod.select(
			mod.i64.lt_s(right, mod.i64.const(0, 0)),
			mod.i64.sub(mod.i64.const(0, 0), right),
			right
		)
		const remainder = mod.i64.rem_s(left, right)
		const adjusted = mod.i64.add(remainder, absB)
		return mod.i64.rem_s(adjusted, absB)
	}
	return null
}

type BinaryEmitter = (
	left: binaryen.ExpressionRef,
	right: binaryen.ExpressionRef
) => binaryen.ExpressionRef

type TypeOps = {
	i32: (l: binaryen.ExpressionRef, r: binaryen.ExpressionRef) => binaryen.ExpressionRef
	i64: (l: binaryen.ExpressionRef, r: binaryen.ExpressionRef) => binaryen.ExpressionRef
	f32?: (l: binaryen.ExpressionRef, r: binaryen.ExpressionRef) => binaryen.ExpressionRef
	f64?: (l: binaryen.ExpressionRef, r: binaryen.ExpressionRef) => binaryen.ExpressionRef
}

function createArithmeticOps(mod: binaryen.Module): Map<TokenKind, TypeOps> {
	return new Map([
		[TokenKind.Plus, { f32: mod.f32.add, f64: mod.f64.add, i32: mod.i32.add, i64: mod.i64.add }],
		[TokenKind.Minus, { f32: mod.f32.sub, f64: mod.f64.sub, i32: mod.i32.sub, i64: mod.i64.sub }],
		[TokenKind.Star, { f32: mod.f32.mul, f64: mod.f64.mul, i32: mod.i32.mul, i64: mod.i64.mul }],
		[
			TokenKind.Slash,
			{ f32: mod.f32.div, f64: mod.f64.div, i32: mod.i32.div_s, i64: mod.i64.div_s },
		],
		[TokenKind.Percent, { i32: mod.i32.rem_s, i64: mod.i64.rem_s }],
	])
}

function createBitwiseOps(mod: binaryen.Module): Map<TokenKind, TypeOps> {
	return new Map([
		[TokenKind.Ampersand, { i32: mod.i32.and, i64: mod.i64.and }],
		[TokenKind.Pipe, { i32: mod.i32.or, i64: mod.i64.or }],
		[TokenKind.Caret, { i32: mod.i32.xor, i64: mod.i64.xor }],
		[TokenKind.LessLess, { i32: mod.i32.shl, i64: mod.i64.shl }],
		[TokenKind.GreaterGreater, { i32: mod.i32.shr_s, i64: mod.i64.shr_s }],
		[TokenKind.GreaterGreaterGreater, { i32: mod.i32.shr_u, i64: mod.i64.shr_u }],
	])
}

function createComparisonOps(mod: binaryen.Module): Map<TokenKind, TypeOps> {
	return new Map([
		[
			TokenKind.LessThan,
			{ f32: mod.f32.lt, f64: mod.f64.lt, i32: mod.i32.lt_s, i64: mod.i64.lt_s },
		],
		[
			TokenKind.LessEqual,
			{ f32: mod.f32.le, f64: mod.f64.le, i32: mod.i32.le_s, i64: mod.i64.le_s },
		],
		[
			TokenKind.GreaterThan,
			{ f32: mod.f32.gt, f64: mod.f64.gt, i32: mod.i32.gt_s, i64: mod.i64.gt_s },
		],
		[
			TokenKind.GreaterEqual,
			{ f32: mod.f32.ge, f64: mod.f64.ge, i32: mod.i32.ge_s, i64: mod.i64.ge_s },
		],
		[TokenKind.EqualEqual, { f32: mod.f32.eq, f64: mod.f64.eq, i32: mod.i32.eq, i64: mod.i64.eq }],
		[TokenKind.BangEqual, { f32: mod.f32.ne, f64: mod.f64.ne, i32: mod.i32.ne, i64: mod.i64.ne }],
	])
}

type TypeKey = 'i32' | 'i64' | 'f32' | 'f64'

const BINARYEN_TYPE_KEYS: Map<number, TypeKey> = new Map([
	[binaryen.i32, 'i32'],
	[binaryen.i64, 'i64'],
	[binaryen.f32, 'f32'],
	[binaryen.f64, 'f64'],
])

function getEmitterFromTypeOps(
	typeOps: TypeOps,
	binaryenType: binaryen.Type
): BinaryEmitter | null {
	const key = BINARYEN_TYPE_KEYS.get(binaryenType)
	if (!key) return null
	return typeOps[key] ?? null
}

function lookupEmitter(
	ops: Map<TokenKind, TypeOps>,
	opKind: TokenKind,
	binaryenType: binaryen.Type
): BinaryEmitter | null {
	const typeOps = ops.get(opKind)
	return typeOps ? getEmitterFromTypeOps(typeOps, binaryenType) : null
}

function findBinaryEmitter(
	mod: binaryen.Module,
	opKind: TokenKind,
	binaryenType: binaryen.Type,
	operandType: binaryen.Type
): BinaryEmitter | null {
	return (
		lookupEmitter(createArithmeticOps(mod), opKind, binaryenType) ??
		lookupEmitter(createBitwiseOps(mod), opKind, binaryenType) ??
		lookupEmitter(createComparisonOps(mod), opKind, operandType)
	)
}

interface BinaryOpValues {
	left: binaryen.ExpressionRef
	right: binaryen.ExpressionRef
	leftId: InstId
}

function getBinaryOpValues(
	inst: Inst,
	valueMap: Map<InstId, binaryen.ExpressionRef>
): BinaryOpValues | null {
	const leftId = getBinaryOpLeftId(inst)
	const rightId = getBinaryOpRightId(inst)
	const left = valueMap.get(leftId)
	const right = valueMap.get(rightId)
	if (left === undefined || right === undefined) return null
	return { left, leftId, right }
}

function emitBinaryOp(
	mod: binaryen.Module,
	inst: Inst,
	valueMap: Map<InstId, binaryen.ExpressionRef>,
	context: CompilationContext
): binaryen.ExpressionRef | null {
	const values = getBinaryOpValues(inst, valueMap)
	if (!values) return null

	const parseNode = context.nodes.get(inst.parseNodeId)
	const opKind = context.tokens.get(parseNode.tokenId).kind
	const binaryenType = toBinaryenType(inst.typeId, context)

	if (opKind === TokenKind.PercentPercent) {
		return emitEuclideanMod(mod, values.left, values.right, binaryenType)
	}

	const leftInst = context.insts?.get(values.leftId)
	const operandType = leftInst ? toBinaryenType(leftInst.typeId, context) : binaryenType
	const emitter = findBinaryEmitter(mod, opKind, binaryenType, operandType)
	return emitter ? emitter(values.left, values.right) : null
}

/**
 * Emit short-circuit logical AND: if (left) { right } else { 0 }
 */
function emitLogicalAnd(
	mod: binaryen.Module,
	inst: Inst,
	valueMap: Map<InstId, binaryen.ExpressionRef>
): binaryen.ExpressionRef | null {
	const leftId = getLogicalAndLeftId(inst)
	const rightId = getLogicalAndRightId(inst)
	const left = valueMap.get(leftId)
	const right = valueMap.get(rightId)
	if (left === undefined || right === undefined) return null

	// Short-circuit: if left is 0, return 0; otherwise return right
	return mod.if(left, right, mod.i32.const(0))
}

/**
 * Emit short-circuit logical OR: if (left) { 1 } else { right }
 */
function emitLogicalOr(
	mod: binaryen.Module,
	inst: Inst,
	valueMap: Map<InstId, binaryen.ExpressionRef>
): binaryen.ExpressionRef | null {
	const leftId = getLogicalOrLeftId(inst)
	const rightId = getLogicalOrRightId(inst)
	const left = valueMap.get(leftId)
	const right = valueMap.get(rightId)
	if (left === undefined || right === undefined) return null

	// Short-circuit: if left is non-zero, return 1; otherwise return right
	return mod.if(left, mod.i32.const(1), right)
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
		const literalTokenId = nextTokenId(patternNode.tokenId)
		const literalToken = context.tokens.get(literalTokenId)
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
	currentInstId: InstId,
	armCount: number,
	context: CompilationContext
): MatchArm[] {
	const arms: MatchArm[] = []
	for (let i = armCount; i >= 1; i--) {
		const armInstId = instId((currentInstId as number) - i)
		const armInst = context.insts?.get(armInstId)
		if (armInst?.kind === InstKind.MatchArm) {
			arms.push({
				bodyInstId: getMatchArmBodyId(armInst),
				patternNodeId: getMatchArmPatternNodeId(armInst),
			})
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
	valueMap: Map<InstId, binaryen.ExpressionRef>,
	currentResult: binaryen.ExpressionRef | null,
	context: CompilationContext
): binaryen.ExpressionRef | null {
	const bodyExpr = valueMap.get(arm.bodyInstId)
	if (bodyExpr === undefined) return currentResult
	const comparison = emitPatternComparison(mod, scrutineeExpr, arm.patternNodeId, typeId, context)
	return buildArmResult(mod, comparison, bodyExpr, currentResult)
}

function buildMatchChain(
	mod: binaryen.Module,
	scrutineeExpr: binaryen.ExpressionRef,
	arms: MatchArm[],
	typeId: TypeId,
	valueMap: Map<InstId, binaryen.ExpressionRef>,
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
	currentInstId: InstId,
	valueMap: Map<InstId, binaryen.ExpressionRef>,
	context: CompilationContext
): binaryen.ExpressionRef | null {
	const scrutineeId = getMatchScrutineeId(inst)
	const scrutineeExpr = valueMap.get(scrutineeId)
	if (scrutineeExpr === undefined) return null

	const armCount = getMatchArmCount(inst)
	const arms = collectMatchArms(currentInstId, armCount, context)
	if (arms.length === 0) return null

	return buildMatchChain(mod, scrutineeExpr, arms, inst.typeId, valueMap, context)
}

/**
 * Emit an instruction and return its expression (if it produces a value).
 */
function emitInstruction(
	mod: binaryen.Module,
	inst: Inst,
	currentInstId: InstId,
	valueMap: Map<InstId, binaryen.ExpressionRef>,
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
		case InstKind.BitwiseNot:
			return emitBitwiseNot(mod, inst, valueMap, context)
		case InstKind.BinaryOp:
			return emitBinaryOp(mod, inst, valueMap, context)
		case InstKind.LogicalAnd:
			return emitLogicalAnd(mod, inst, valueMap)
		case InstKind.LogicalOr:
			return emitLogicalOr(mod, inst, valueMap)
		case InstKind.Match:
			return emitMatch(mod, inst, currentInstId, valueMap, context)
		case InstKind.MatchArm:
			// MatchArm is handled by emitMatch - skip here
			return null
		case InstKind.FieldAccess:
			// Field access on flattened records is resolved to VarRef by the checker.
			// This case handles non-flattened field access (e.g., nested records or
			// future heap-allocated records). Currently returns null since all record
			// fields are flattened to locals.
			return null
		default:
			return null
	}
}

function isValueProducer(kind: InstKind): boolean {
	return (
		kind === InstKind.IntConst ||
		kind === InstKind.FloatConst ||
		kind === InstKind.VarRef ||
		kind === InstKind.Negate ||
		kind === InstKind.BitwiseNot ||
		kind === InstKind.BinaryOp ||
		kind === InstKind.LogicalAnd ||
		kind === InstKind.LogicalOr ||
		kind === InstKind.Match
	)
}

function isStatement(kind: InstKind): boolean {
	return kind === InstKind.Unreachable || kind === InstKind.Bind
}

function processInstruction(
	currentInstId: InstId,
	inst: Inst,
	mod: binaryen.Module,
	valueMap: Map<InstId, binaryen.ExpressionRef>,
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
	const valueMap = new Map<InstId, binaryen.ExpressionRef>()

	if (!context.insts) return expressions

	for (const [currentInstId, inst] of context.insts) {
		processInstruction(currentInstId, inst, mod, valueMap, expressions, context)
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
