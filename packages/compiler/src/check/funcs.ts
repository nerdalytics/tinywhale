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
import { resolveTypeFromAnnotation } from './type-resolution.ts'
import { BuiltinTypeId, InstKind, type InstId, type SymbolId, type TypeId } from './types.ts'

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

/**
 * Extract the function name from a FuncDecl node.
 */
function extractFuncDeclName(declId: NodeId, context: CompilationContext): StringId {
	for (const [_childId, child] of context.nodes.iterateChildren(declId)) {
		if (child.kind === NodeKind.Identifier) {
			const token = context.tokens.get(child.tokenId)
			return token.payload as StringId
		}
	}
	throw new Error('FuncDecl missing identifier')
}

/**
 * Resolve the function type from a FuncDecl node.
 */
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
 * Resolve a FuncType node to a TypeId.
 */
export function resolveFuncType(
	funcTypeId: NodeId,
	state: CheckerState,
	context: CompilationContext
): TypeId {
	const paramTypes: TypeId[] = []
	let returnType: TypeId = BuiltinTypeId.None

	for (const [childId, child] of context.nodes.iterateChildren(funcTypeId)) {
		if (child.kind === NodeKind.TypeList) {
			for (const [typeId, typeNode] of context.nodes.iterateChildren(childId)) {
				const resolved = resolveTypeRef(typeId, typeNode.kind, state, context)
				if (resolved !== null) {
					paramTypes.unshift(resolved)
				}
			}
		} else if (child.kind === NodeKind.TypeAnnotation) {
			const resolved = resolveTypeFromAnnotation(childId, state, context)
			if (resolved) {
				returnType = resolved.typeId
			}
		} else {
			const resolved = resolveTypeRef(childId, child.kind, state, context)
			if (resolved !== null) {
				returnType = resolved
			}
		}
	}

	return state.types.registerFuncType(paramTypes, returnType)
}

/**
 * Resolve a type reference node to a TypeId.
 */
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

	switch (token.kind) {
		case TokenKind.I32:
			return BuiltinTypeId.I32
		case TokenKind.I64:
			return BuiltinTypeId.I64
		case TokenKind.F32:
			return BuiltinTypeId.F32
		case TokenKind.F64:
			return BuiltinTypeId.F64
		default:
			if (token.kind === TokenKind.Identifier) {
				const typeName = context.strings.get(token.payload as StringId)
				const userType = state.types.lookup(typeName)
				if (userType !== undefined) {
					return userType
				}
			}
			return null
	}
}

/**
 * Handle a function binding: double = (x: i32): i32 -> expr
 * This processes the entire binding including checking the body expression.
 */
export function handleFuncBinding(
	bindingId: NodeId,
	state: CheckerState,
	context: CompilationContext,
	checkExpr: (exprId: NodeId, expectedType: TypeId, state: CheckerState, context: CompilationContext) => { instId: InstId | null; typeId: TypeId }
): void {
	const funcs = context.funcs
	if (!funcs) return

	const { nameId, lambdaId } = extractFuncBindingParts(bindingId, context)
	const { paramNames, paramTypes, returnType, bodyExprId } = parseLambdaSignature(lambdaId, state, context)

	if (bodyExprId === null) {
		context.emitAtNode('TWCHECK010' as DiagnosticCode, bindingId, {
			found: 'lambda without body',
		})
		return
	}

	const funcTypeId = state.types.registerFuncType(paramTypes, returnType)

	let funcId = funcs.getByName(nameId)
	if (funcId === undefined) {
		funcId = funcs.declareForward(nameId, funcTypeId, bindingId)
		state.symbols.add({
			nameId,
			parseNodeId: bindingId,
			typeId: funcTypeId,
		})
	} else {
		const declaredType = funcs.get(funcId).typeId
		if (declaredType !== funcTypeId) {
			context.emitAtNode('TWCHECK010' as DiagnosticCode, bindingId, {
				found: state.types.typeName(funcTypeId),
			})
		}
	}

	state.symbols.pushScope()

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

	const bodyResult = checkExpr(bodyExprId, returnType, state, context)

	state.symbols.popScope()

	if (bodyResult.instId === null) {
		return
	}

	if (bodyResult.typeId !== returnType && bodyResult.typeId !== BuiltinTypeId.None) {
		context.emitAtNode('TWCHECK016' as DiagnosticCode, bindingId, {
			expected: state.types.typeName(returnType),
			found: state.types.typeName(bodyResult.typeId),
		})
	}

	state.insts.add({
		arg0: funcId as number,
		arg1: bodyResult.instId as number,
		kind: InstKind.FuncDef,
		parseNodeId: bindingId,
		typeId: BuiltinTypeId.None,
	})

	funcs.defineFunc(funcId, bodyResult.instId, paramSymbols)
}

/**
 * Extract name and lambda from a FuncBinding node.
 */
function extractFuncBindingParts(
	bindingId: NodeId,
	context: CompilationContext
): { nameId: StringId; lambdaId: NodeId } {
	let nameId: StringId | null = null
	let lambdaId: NodeId | null = null

	for (const [childId, child] of context.nodes.iterateChildren(bindingId)) {
		if (child.kind === NodeKind.Identifier) {
			const token = context.tokens.get(child.tokenId)
			nameId = token.payload as StringId
		} else if (child.kind === NodeKind.Lambda) {
			lambdaId = childId
		}
	}

	if (nameId === null || lambdaId === null) {
		throw new Error('FuncBinding missing identifier or lambda')
	}

	return { lambdaId, nameId }
}

/**
 * Parse lambda signature to extract parameter names, types, return type, and body expression.
 */
function parseLambdaSignature(
	lambdaId: NodeId,
	state: CheckerState,
	context: CompilationContext
): { paramNames: StringId[]; paramTypes: TypeId[]; returnType: TypeId; bodyExprId: NodeId | null } {
	const paramNames: StringId[] = []
	const paramTypes: TypeId[] = []
	let returnType: TypeId = BuiltinTypeId.I32
	let bodyExprId: NodeId | null = null

	for (const [childId, child] of context.nodes.iterateChildren(lambdaId)) {
		if (child.kind === NodeKind.ParameterList) {
			// Handle ParameterList if present (for compatibility)
			for (const [paramId, paramNode] of context.nodes.iterateChildren(childId)) {
				if (paramNode.kind === NodeKind.Parameter) {
					const { nameId, typeId } = parseParameter(paramId, state, context)
					paramNames.unshift(nameId)
					paramTypes.unshift(typeId)
				}
			}
		} else if (child.kind === NodeKind.Parameter) {
			// Handle Parameter nodes directly under Lambda (parser emits them this way)
			const { nameId, typeId } = parseParameter(childId, state, context)
			paramNames.unshift(nameId)
			paramTypes.unshift(typeId)
		} else if (child.kind === NodeKind.TypeAnnotation) {
			const resolved = resolveTypeFromAnnotation(childId, state, context)
			if (resolved) {
				returnType = resolved.typeId
			}
		} else {
			bodyExprId = childId
		}
	}

	return { bodyExprId, paramNames, paramTypes, returnType }
}

/**
 * Parse a Parameter node.
 */
function parseParameter(
	paramId: NodeId,
	state: CheckerState,
	context: CompilationContext
): { nameId: StringId; typeId: TypeId } {
	let nameId: StringId | null = null
	let typeId: TypeId = BuiltinTypeId.Invalid

	for (const [childId, child] of context.nodes.iterateChildren(paramId)) {
		if (child.kind === NodeKind.Identifier) {
			const token = context.tokens.get(child.tokenId)
			nameId = token.payload as StringId
		} else if (child.kind === NodeKind.TypeAnnotation) {
			const resolved = resolveTypeFromAnnotation(childId, state, context)
			if (resolved) {
				typeId = resolved.typeId
			}
		} else {
			const resolved = resolveTypeRef(childId, child.kind, state, context)
			if (resolved !== null) {
				typeId = resolved
			}
		}
	}

	if (nameId === null) {
		throw new Error('Parameter missing identifier')
	}

	return { nameId, typeId }
}

/**
 * Handle a function call expression.
 */
export function handleFuncCall(
	callId: NodeId,
	state: CheckerState,
	context: CompilationContext,
	checkExpr: (exprId: NodeId, state: CheckerState, context: CompilationContext) => { instId: InstId | null; typeId: TypeId }
): { instId: InstId | null; typeId: TypeId } {
	let calleeId: NodeId | null = null
	const argIds: NodeId[] = []

	// Parser emits arguments directly as children of FuncCall (no ArgumentList wrapper)
	// Children in postorder: arguments first (reverse order), then callee identifier last
	for (const [childId, child] of context.nodes.iterateChildren(callId)) {
		if (child.kind === NodeKind.Identifier) {
			calleeId = childId
		} else {
			// All non-identifier children are arguments
			argIds.push(childId)
		}
	}

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

	// Check each argument - argIds are in reverse order from postorder iteration
	const args: InstId[] = []
	for (const argId of argIds) {
		const argResult = checkExpr(argId, state, context)
		if (argResult.instId !== null) {
			args.unshift(argResult.instId)
		}
	}

	if (args.length !== funcInfo.paramTypes.length) {
		context.emitAtNode('TWCHECK010' as DiagnosticCode, callId, {
			found: `${args.length} arguments (expected ${funcInfo.paramTypes.length})`,
		})
	}

	for (let i = 0; i < Math.min(args.length, funcInfo.paramTypes.length); i++) {
		const argInstId = args[i]
		const expectedParamType = funcInfo.paramTypes[i]
		if (argInstId === undefined || expectedParamType === undefined) continue
		const argInst = state.insts.get(argInstId)
		if (argInst.typeId !== expectedParamType) {
			context.emitAtNode('TWCHECK016' as DiagnosticCode, callId, {
				expected: state.types.typeName(expectedParamType),
				found: state.types.typeName(argInst.typeId),
			})
		}
	}

	const instId = state.insts.add({
		arg0: calleeResult.instId as number,
		arg1: args.length,
		kind: InstKind.Call,
		parseNodeId: callId,
		typeId: funcInfo.returnType,
	})

	return { instId, typeId: funcInfo.returnType }
}
