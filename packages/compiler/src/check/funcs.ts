/**
 * Function checking for the Check phase.
 *
 * This module handles:
 * - Forward declarations (FuncDecl)
 * - Function bindings (FuncBinding with Lambda)
 * - Function calls (FuncCall)
 */

import type { CompilationContext, StringId } from '../core/context.ts'
import type { DiagnosticCode } from '../core/diagnostics.ts'
import { type NodeId, NodeKind } from '../core/nodes.ts'
import { TokenKind } from '../core/tokens.ts'
import type { CheckerState } from './state.ts'
import type { FuncId, FuncStore } from './stores.ts'
import { resolveTypeFromAnnotation } from './type-resolution.ts'
import {
	BuiltinTypeId,
	type InstId,
	InstKind,
	instId,
	type SymbolId,
	type TypeId,
} from './types.ts'

// ============================================================================
// Type Resolution Helpers
// ============================================================================

const PRIMITIVE_TYPE_MAP: ReadonlyMap<TokenKind, TypeId> = new Map([
	[TokenKind.I32, BuiltinTypeId.I32],
	[TokenKind.I64, BuiltinTypeId.I64],
	[TokenKind.F32, BuiltinTypeId.F32],
	[TokenKind.F64, BuiltinTypeId.F64],
])

function resolvePrimitiveType(tokenKind: TokenKind): TypeId | null {
	return PRIMITIVE_TYPE_MAP.get(tokenKind) ?? null
}

function resolveUserType(
	tokenKind: TokenKind,
	payload: StringId,
	state: CheckerState,
	context: CompilationContext
): TypeId | null {
	if (tokenKind !== TokenKind.Identifier) return null
	const typeName = context.strings.get(payload)
	return state.types.lookup(typeName) ?? null
}

function resolveTypeRef(
	nodeId: NodeId,
	kind: NodeKind,
	state: CheckerState,
	context: CompilationContext
): TypeId | null {
	if (kind === NodeKind.TypeAnnotation) {
		const resolved = resolveTypeFromAnnotation(nodeId, state, context)
		return resolved?.typeId ?? null
	}

	const node = context.nodes.get(nodeId)
	const token = context.tokens.get(node.tokenId)

	return (
		resolvePrimitiveType(token.kind) ??
		resolveUserType(token.kind, token.payload as StringId, state, context)
	)
}

// ============================================================================
// TypeList Resolution
// ============================================================================

function collectTypeListParams(
	typeListId: NodeId,
	state: CheckerState,
	context: CompilationContext
): TypeId[] {
	const paramTypes: TypeId[] = []
	for (const [typeId, typeNode] of context.nodes.iterateChildren(typeListId)) {
		const resolved = resolveTypeRef(typeId, typeNode.kind, state, context)
		if (resolved !== null) {
			paramTypes.unshift(resolved)
		}
	}
	return paramTypes
}

function resolveReturnTypeFromChild(
	childId: NodeId,
	childKind: NodeKind,
	state: CheckerState,
	context: CompilationContext
): TypeId | null {
	if (childKind === NodeKind.TypeAnnotation) {
		const resolved = resolveTypeFromAnnotation(childId, state, context)
		return resolved?.typeId ?? null
	}
	return resolveTypeRef(childId, childKind, state, context)
}

function extractFuncTypeParams(
	funcTypeId: NodeId,
	state: CheckerState,
	context: CompilationContext
): TypeId[] {
	for (const [childId, child] of context.nodes.iterateChildren(funcTypeId)) {
		if (child.kind === NodeKind.TypeList) {
			return collectTypeListParams(childId, state, context)
		}
	}
	return []
}

function tryExtractReturnType(
	childId: NodeId,
	childKind: NodeKind,
	state: CheckerState,
	context: CompilationContext
): TypeId | null {
	if (childKind === NodeKind.TypeList) return null
	return resolveReturnTypeFromChild(childId, childKind, state, context)
}

function extractFuncTypeReturn(
	funcTypeId: NodeId,
	state: CheckerState,
	context: CompilationContext
): TypeId {
	for (const [childId, child] of context.nodes.iterateChildren(funcTypeId)) {
		const resolved = tryExtractReturnType(childId, child.kind, state, context)
		if (resolved !== null) return resolved
	}
	return BuiltinTypeId.None
}

/**
 * Resolve a FuncType node to a TypeId.
 */
export function resolveFuncType(
	funcTypeId: NodeId,
	state: CheckerState,
	context: CompilationContext
): TypeId {
	const paramTypes = extractFuncTypeParams(funcTypeId, state, context)
	const returnType = extractFuncTypeReturn(funcTypeId, state, context)
	return state.types.registerFuncType(paramTypes, returnType)
}

// ============================================================================
// FuncDecl Handling
// ============================================================================

function extractFuncDeclName(declId: NodeId, context: CompilationContext): StringId {
	for (const [_childId, child] of context.nodes.iterateChildren(declId)) {
		if (child.kind === NodeKind.Identifier) {
			const token = context.tokens.get(child.tokenId)
			return token.payload as StringId
		}
	}
	throw new Error('FuncDecl missing identifier')
}

function resolveFuncTypeFromDecl(
	declId: NodeId,
	state: CheckerState,
	context: CompilationContext
): TypeId {
	for (const [childId, child] of context.nodes.iterateChildren(declId)) {
		if (child.kind === NodeKind.FuncType) {
			return resolveFuncType(childId, state, context)
		}
	}
	return BuiltinTypeId.Invalid
}

/**
 * Handle a function forward declaration: factorial: (i32) -> i32
 */
export function handleFuncDecl(
	declId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	const funcs = context.funcs
	if (!funcs) return

	const nameId = extractFuncDeclName(declId, context)
	const funcTypeId = resolveFuncTypeFromDecl(declId, state, context)

	if (funcTypeId === BuiltinTypeId.Invalid) return

	const funcId = funcs.declareForward(nameId, funcTypeId, declId)

	state.symbols.add({
		nameId,
		parseNodeId: declId,
		typeId: funcTypeId,
	})

	state.insts.add({
		arg0: funcId as number,
		arg1: 0,
		kind: InstKind.FuncDecl,
		parseNodeId: declId,
		typeId: BuiltinTypeId.None,
	})
}

// ============================================================================
// Parameter Parsing
// ============================================================================

function extractIdentifierPayload(childId: NodeId, context: CompilationContext): StringId | null {
	const child = context.nodes.get(childId)
	if (child.kind !== NodeKind.Identifier) return null
	const token = context.tokens.get(child.tokenId)
	return token.payload as StringId
}

function resolveParameterType(
	childId: NodeId,
	childKind: NodeKind,
	state: CheckerState,
	context: CompilationContext
): TypeId | null {
	if (childKind === NodeKind.TypeAnnotation) {
		const resolved = resolveTypeFromAnnotation(childId, state, context)
		return resolved?.typeId ?? null
	}
	return resolveTypeRef(childId, childKind, state, context)
}

function findParameterName(paramId: NodeId, context: CompilationContext): StringId | null {
	for (const [childId] of context.nodes.iterateChildren(paramId)) {
		const payload = extractIdentifierPayload(childId, context)
		if (payload !== null) return payload
	}
	return null
}

function findParameterType(
	paramId: NodeId,
	state: CheckerState,
	context: CompilationContext
): TypeId {
	for (const [childId, child] of context.nodes.iterateChildren(paramId)) {
		const resolved = resolveParameterType(childId, child.kind, state, context)
		if (resolved !== null) return resolved
	}
	return BuiltinTypeId.Invalid
}

function parseParameter(
	paramId: NodeId,
	state: CheckerState,
	context: CompilationContext
): { nameId: StringId; typeId: TypeId } {
	const nameId = findParameterName(paramId, context)
	if (nameId === null) throw new Error('Parameter missing identifier')
	const typeId = findParameterType(paramId, state, context)
	return { nameId, typeId }
}

// ============================================================================
// Lambda Signature Parsing
// ============================================================================

interface LambdaSignature {
	paramNames: StringId[]
	paramTypes: TypeId[]
	returnType: TypeId
	bodyExprId: NodeId | null
}

function processParameterListChild(
	childId: NodeId,
	state: CheckerState,
	context: CompilationContext,
	paramNames: StringId[],
	paramTypes: TypeId[]
): void {
	for (const [paramId, paramNode] of context.nodes.iterateChildren(childId)) {
		if (paramNode.kind === NodeKind.Parameter) {
			const { nameId, typeId } = parseParameter(paramId, state, context)
			paramNames.unshift(nameId)
			paramTypes.unshift(typeId)
		}
	}
}

function processDirectParameter(
	childId: NodeId,
	state: CheckerState,
	context: CompilationContext,
	paramNames: StringId[],
	paramTypes: TypeId[]
): void {
	const { nameId, typeId } = parseParameter(childId, state, context)
	paramNames.unshift(nameId)
	paramTypes.unshift(typeId)
}

function processLambdaParamChild(
	childId: NodeId,
	childKind: NodeKind,
	state: CheckerState,
	context: CompilationContext,
	paramNames: StringId[],
	paramTypes: TypeId[]
): void {
	if (childKind === NodeKind.ParameterList) {
		processParameterListChild(childId, state, context, paramNames, paramTypes)
	} else if (childKind === NodeKind.Parameter) {
		processDirectParameter(childId, state, context, paramNames, paramTypes)
	}
}

function extractLambdaParams(
	lambdaId: NodeId,
	state: CheckerState,
	context: CompilationContext
): { paramNames: StringId[]; paramTypes: TypeId[] } {
	const paramNames: StringId[] = []
	const paramTypes: TypeId[] = []
	for (const [childId, child] of context.nodes.iterateChildren(lambdaId)) {
		processLambdaParamChild(childId, child.kind, state, context, paramNames, paramTypes)
	}
	return { paramNames, paramTypes }
}

function tryExtractLambdaReturnType(
	childId: NodeId,
	childKind: NodeKind,
	state: CheckerState,
	context: CompilationContext
): TypeId | null {
	if (childKind !== NodeKind.TypeAnnotation) return null
	const resolved = resolveTypeFromAnnotation(childId, state, context)
	return resolved ? resolved.typeId : null
}

function extractLambdaReturnType(
	lambdaId: NodeId,
	state: CheckerState,
	context: CompilationContext
): TypeId {
	for (const [childId, child] of context.nodes.iterateChildren(lambdaId)) {
		const typeId = tryExtractLambdaReturnType(childId, child.kind, state, context)
		if (typeId !== null) return typeId
	}
	return BuiltinTypeId.I32
}

function isLambdaMetadataKind(kind: NodeKind): boolean {
	return (
		kind === NodeKind.ParameterList ||
		kind === NodeKind.Parameter ||
		kind === NodeKind.TypeAnnotation
	)
}

function extractLambdaBody(lambdaId: NodeId, context: CompilationContext): NodeId | null {
	for (const [childId, child] of context.nodes.iterateChildren(lambdaId)) {
		if (!isLambdaMetadataKind(child.kind)) return childId
	}
	return null
}

function parseLambdaSignature(
	lambdaId: NodeId,
	state: CheckerState,
	context: CompilationContext
): LambdaSignature {
	const { paramNames, paramTypes } = extractLambdaParams(lambdaId, state, context)
	const returnType = extractLambdaReturnType(lambdaId, state, context)
	const bodyExprId = extractLambdaBody(lambdaId, context)
	return { bodyExprId, paramNames, paramTypes, returnType }
}

// ============================================================================
// Lambda Binding Handling
// ============================================================================

function registerParamSymbols(
	paramNames: StringId[],
	paramTypes: TypeId[],
	bindingId: NodeId,
	state: CheckerState
): SymbolId[] {
	const paramSymbols: SymbolId[] = []
	for (let i = 0; i < paramNames.length; i++) {
		const paramNameId = paramNames[i]
		const paramTypeId = paramTypes[i]
		if (paramNameId === undefined || paramTypeId === undefined) continue
		const symId = state.symbols.add({
			nameId: paramNameId,
			parseNodeId: bindingId,
			typeId: paramTypeId,
		})
		paramSymbols.push(symId)
	}
	return paramSymbols
}

function emitTypeMismatchIfNeeded(
	bodyTypeId: TypeId,
	returnType: TypeId,
	bindingId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	if (bodyTypeId !== returnType && bodyTypeId !== BuiltinTypeId.None) {
		context.emitAtNode('TWCHECK016' as DiagnosticCode, bindingId, {
			expected: state.types.typeName(returnType),
			found: state.types.typeName(bodyTypeId),
		})
	}
}

function ensureFuncDeclared(
	nameId: StringId,
	funcTypeId: TypeId,
	bindingId: NodeId,
	funcs: FuncStore,
	state: CheckerState
): FuncId {
	const existing = funcs.getByName(nameId)
	if (existing !== undefined) return existing
	const funcId = funcs.declareForward(nameId, funcTypeId, bindingId)
	state.symbols.add({ nameId, parseNodeId: bindingId, typeId: funcTypeId })
	return funcId
}

function checkFuncTypeConsistency(
	funcId: FuncId,
	expectedTypeId: TypeId,
	bindingId: NodeId,
	funcs: FuncStore,
	state: CheckerState,
	context: CompilationContext
): void {
	const existingType = funcs.get(funcId).typeId
	if (existingType === expectedTypeId) return
	context.emitAtNode('TWCHECK010' as DiagnosticCode, bindingId, {
		found: state.types.typeName(expectedTypeId),
	})
}

/**
 * Handle a Lambda expression in a BindingExpr context.
 * Pattern: name = (params): ReturnType -> body
 *
 * This is called from handleBindingExpr when the RHS is a Lambda node.
 */
export function handleLambdaBinding(
	bindingId: NodeId,
	lambdaId: NodeId,
	nameId: StringId,
	state: CheckerState,
	context: CompilationContext,
	checkExpr: (
		exprId: NodeId,
		expectedType: TypeId,
		state: CheckerState,
		context: CompilationContext
	) => { instId: InstId | null; typeId: TypeId }
): void {
	const funcs = context.funcs
	if (!funcs) return

	const { paramNames, paramTypes, returnType, bodyExprId } = parseLambdaSignature(
		lambdaId,
		state,
		context
	)

	if (bodyExprId === null) {
		context.emitAtNode('TWCHECK010' as DiagnosticCode, bindingId, { found: 'lambda without body' })
		return
	}

	const funcTypeId = state.types.registerFuncType(paramTypes, returnType)
	const funcId = ensureFuncDeclared(nameId, funcTypeId, bindingId, funcs, state)
	checkFuncTypeConsistency(funcId, funcTypeId, bindingId, funcs, state, context)

	state.symbols.pushScope()
	const paramSymbols = registerParamSymbols(paramNames, paramTypes, bindingId, state)

	const startInstCount = state.insts.count()
	const bodyResult = checkExpr(bodyExprId, returnType, state, context)
	const endInstCount = state.insts.count()

	state.symbols.popScope()

	if (bodyResult.instId === null) return

	const bodyInstIds: InstId[] = []
	for (let i = startInstCount; i < endInstCount; i++) {
		bodyInstIds.push(instId(i))
	}

	emitTypeMismatchIfNeeded(bodyResult.typeId, returnType, bindingId, state, context)

	state.insts.add({
		arg0: funcId as number,
		arg1: bodyResult.instId as number,
		kind: InstKind.FuncDef,
		parseNodeId: bindingId,
		typeId: BuiltinTypeId.None,
	})

	funcs.defineFunc(funcId, bodyResult.instId, bodyInstIds, paramSymbols)
}

// ============================================================================
// FuncCall Handling
// ============================================================================

function collectCallChildren(
	callId: NodeId,
	context: CompilationContext
): { calleeId: NodeId | null; argIds: NodeId[] } {
	const children: NodeId[] = []

	for (const [childId] of context.nodes.iterateChildren(callId)) {
		children.push(childId)
	}

	// Children are in reverse postorder. The callee was emitted first,
	// so it's the LAST item in the iteration. Arguments follow in reverse order.
	if (children.length === 0) {
		return { argIds: [], calleeId: null }
	}

	const calleeId = children[children.length - 1] ?? null
	const argIds = children.slice(0, -1)

	return { argIds, calleeId }
}

function checkCallArguments(
	argIds: NodeId[],
	state: CheckerState,
	context: CompilationContext,
	checkExpr: (
		exprId: NodeId,
		state: CheckerState,
		context: CompilationContext
	) => { instId: InstId | null; typeId: TypeId }
): InstId[] {
	const args: InstId[] = []
	for (const argId of argIds) {
		const argResult = checkExpr(argId, state, context)
		if (argResult.instId !== null) {
			args.unshift(argResult.instId)
		}
	}
	return args
}

function emitArgCountError(
	argsLen: number,
	expectedLen: number,
	callId: NodeId,
	context: CompilationContext
): void {
	context.emitAtNode('TWCHECK010' as DiagnosticCode, callId, {
		found: `${argsLen} arguments (expected ${expectedLen})`,
	})
}

function validateSingleArgType(
	argInstId: InstId,
	expectedType: TypeId,
	callId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	const argInst = state.insts.get(argInstId)
	if (argInst.typeId === expectedType) return
	context.emitAtNode('TWCHECK016' as DiagnosticCode, callId, {
		expected: state.types.typeName(expectedType),
		found: state.types.typeName(argInst.typeId),
	})
}

function validateArgTypes(
	args: InstId[],
	paramTypes: readonly TypeId[],
	callId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	const checkCount = Math.min(args.length, paramTypes.length)
	for (let i = 0; i < checkCount; i++) {
		const argInstId = args[i]
		const expectedType = paramTypes[i]
		if (argInstId === undefined || expectedType === undefined) continue
		validateSingleArgType(argInstId, expectedType, callId, state, context)
	}
}

/**
 * Handle a function call expression.
 */
export function handleFuncCall(
	callId: NodeId,
	state: CheckerState,
	context: CompilationContext,
	checkExpr: (
		exprId: NodeId,
		state: CheckerState,
		context: CompilationContext
	) => { instId: InstId | null; typeId: TypeId }
): { instId: InstId | null; typeId: TypeId } {
	const { argIds, calleeId } = collectCallChildren(callId, context)

	if (calleeId === null) {
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	const calleeResult = checkExpr(calleeId, state, context)
	if (calleeResult.instId === null) {
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	const funcInfo = state.types.getFuncInfo(calleeResult.typeId)
	if (!funcInfo) {
		context.emitAtNode('TWCHECK016' as DiagnosticCode, callId, {
			expected: 'function',
			found: state.types.typeName(calleeResult.typeId),
		})
		return { instId: null, typeId: BuiltinTypeId.Invalid }
	}

	const args = checkCallArguments(argIds, state, context, checkExpr)

	if (args.length !== funcInfo.paramTypes.length) {
		emitArgCountError(args.length, funcInfo.paramTypes.length, callId, context)
	}

	validateArgTypes(args, funcInfo.paramTypes, callId, state, context)

	const instId = state.insts.add({
		arg0: calleeResult.instId as number,
		arg1: args.length,
		kind: InstKind.Call,
		parseNodeId: callId,
		typeId: funcInfo.returnType,
	})

	return { instId, typeId: funcInfo.returnType }
}
