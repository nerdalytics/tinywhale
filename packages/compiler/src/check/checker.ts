/**
 * Check phase: semantic analysis between Parse and Codegen.
 *
 * Performs:
 * - Scope validation (reject invalid indentation)
 * - Reachability analysis (unreachable code warnings)
 * - Name resolution (symbol table lookup)
 * - Type checking (type annotation validation)
 * - SemIR emission (instructions for codegen)
 */

import type { CompilationContext, StringId } from '../core/context.ts'
import type { DiagnosticCode } from '../core/diagnostics.ts'
import { type NodeId, NodeKind, nodeId } from '../core/nodes.ts'
import { TokenKind } from '../core/tokens.ts'
import { InstStore, ScopeStore, SymbolStore, TypeStore } from './stores.ts'
import {
	BuiltinTypeId,
	type CheckResult,
	type InstId,
	InstKind,
	type Scope,
	type TypeId,
} from './types.ts'

/**
 * Tracks a range of unreachable statements.
 */
interface UnreachableRange {
	/** First unreachable statement node */
	firstNodeId: NodeId
	/** First line of unreachable code */
	startLine: number
	/** Last line of unreachable code */
	endLine: number
}

/**
 * Internal state during checking.
 */
interface CheckerState {
	/** Instruction store being populated */
	readonly insts: InstStore
	/** Scope store */
	readonly scopes: ScopeStore
	/** Symbol store for variable bindings */
	readonly symbols: SymbolStore
	/** Type store */
	readonly types: TypeStore
	/** Current scope */
	currentScope: Scope
	/** Tracking for grouped unreachable warnings */
	unreachableRange: UnreachableRange | null
}

/**
 * Result of checking an expression.
 */
interface ExprResult {
	typeId: TypeId
	instId: InstId
}

/**
 * Determines if a node kind is a control flow terminator.
 */
function isTerminator(kind: NodeKind): boolean {
	return kind === NodeKind.PanicStatement
}

/**
 * Checks if a node kind represents a statement.
 * Statement kinds are in range 10-99.
 */
function isStatementNode(kind: NodeKind): boolean {
	return kind >= 10 && kind < 100
}

/**
 * Checks if a node kind represents an expression.
 * Expression kinds are in range 100-149.
 */
function isExpressionNode(kind: NodeKind): boolean {
	return kind >= 100 && kind < 150
}

/**
 * Get the statement child from a line node.
 * Returns null if the line has no statement.
 */
function getStatementFromLine(
	lineId: NodeId,
	context: CompilationContext
): { id: NodeId; kind: NodeKind } | null {
	for (const [childId, child] of context.nodes.iterateChildren(lineId)) {
		if (isStatementNode(child.kind)) {
			return { id: childId, kind: child.kind }
		}
	}
	return null
}

/**
 * Get the type name from a TypeAnnotation node's token.
 */
function getTypeNameFromToken(tokenKind: TokenKind): { name: string; typeId: TypeId } | null {
	switch (tokenKind) {
		case TokenKind.I32:
			return { name: 'i32', typeId: BuiltinTypeId.I32 }
		case TokenKind.I64:
			return { name: 'i64', typeId: BuiltinTypeId.I64 }
		case TokenKind.F32:
			return { name: 'f32', typeId: BuiltinTypeId.F32 }
		case TokenKind.F64:
			return { name: 'f64', typeId: BuiltinTypeId.F64 }
		default:
			return null
	}
}

/**
 * Integer bounds for type checking literals.
 * All bounds use BigInt for consistent precision.
 */
const INT_BOUNDS = {
	i32: { max: BigInt(2147483647), min: BigInt(-2147483648) },
	i64: { max: BigInt('9223372036854775807'), min: BigInt('-9223372036854775808') },
}

/**
 * Check if a BigInt value fits in the given integer type bounds.
 */
function valueFitsInType(value: bigint, typeId: TypeId): boolean {
	if (typeId === BuiltinTypeId.I32) {
		return value >= INT_BOUNDS.i32.min && value <= INT_BOUNDS.i32.max
	}
	if (typeId === BuiltinTypeId.I64) {
		return value >= INT_BOUNDS.i64.min && value <= INT_BOUNDS.i64.max
	}
	return false
}

/**
 * Split a BigInt value into low and high 32-bit parts for codegen.
 * Uses two's complement representation for negative values.
 */
function splitBigIntTo32BitParts(value: bigint, typeId: TypeId): { low: number; high: number } {
	if (typeId === BuiltinTypeId.I32) {
		// For i32, the value fits in low 32 bits
		return { high: 0, low: Number(BigInt.asIntN(32, value)) }
	}
	const low = Number(BigInt.asIntN(32, value))
	const high = Number(BigInt.asIntN(32, value >> 32n))
	return { high, low }
}

/** Check if value is valid for f32 (doesn't overflow to infinity) */
function isValidF32(value: number): boolean {
	const f32Value = Math.fround(value)
	return Number.isFinite(f32Value) || !Number.isFinite(value)
}

/** Check if expected type is a float type */
function isFloatType(typeId: TypeId): boolean {
	return typeId === BuiltinTypeId.F32 || typeId === BuiltinTypeId.F64
}

/** Apply negation to a value */
function applyNegation(value: number, negate: boolean): number {
	return negate ? -value : value
}

/** Format display value for error messages */
function formatDisplayValue(literalText: string, negate: boolean): string {
	return negate ? `-${literalText}` : literalText
}

/** Emit a FloatConst instruction and return ExprResult */
function emitFloatConstInst(
	nodeId: NodeId,
	typeId: TypeId,
	value: number,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const floatId = context.floats.add(value)
	const instId = state.insts.add({
		arg0: floatId as number,
		arg1: 0,
		kind: InstKind.FloatConst,
		parseNodeId: nodeId,
		typeId,
	})
	return { instId, typeId }
}

/** Emit f32 overflow error */
function emitF32OverflowError(
	nodeId: NodeId,
	displayValue: string,
	context: CompilationContext
): ExprResult {
	context.emitAtNode('TWCHECK017' as DiagnosticCode, nodeId, {
		type: 'f32',
		value: displayValue,
	})
	return { instId: -1 as InstId, typeId: BuiltinTypeId.Invalid }
}

/** Emit an IntConst instruction and return ExprResult */
function emitIntConstInst(
	nodeId: NodeId,
	expectedType: TypeId,
	value: bigint,
	state: CheckerState
): ExprResult {
	const { high, low } = splitBigIntTo32BitParts(value, expectedType)
	const instId = state.insts.add({
		arg0: low,
		arg1: high,
		kind: InstKind.IntConst,
		parseNodeId: nodeId,
		typeId: expectedType,
	})
	return { instId, typeId: expectedType }
}

/** Emit integer bounds overflow error */
function emitIntBoundsError(
	nodeId: NodeId,
	typeName: string,
	displayValue: string,
	context: CompilationContext
): ExprResult {
	context.emitAtNode('TWCHECK014' as DiagnosticCode, nodeId, {
		type: typeName,
		value: displayValue,
	})
	return { instId: -1 as InstId, typeId: BuiltinTypeId.Invalid }
}

/** Parse integer literal text, handling scientific notation (e.g., 1e10) */
function parseIntegerLiteral(text: string): bigint {
	const expMatch = text.match(/^(\d+)[eE]([+-]?\d+)$/)
	if (expMatch) {
		const base = BigInt(expMatch[1] as string)
		const exp = Number(expMatch[2])
		if (exp < 0) throw new Error('Negative exponent not allowed for integers')
		return base * 10n ** BigInt(exp)
	}
	return BigInt(text)
}

/** Check an integer literal expression for integer types */
function checkIntLiteralAsInt(
	nodeId: NodeId,
	expectedType: TypeId,
	literalText: string,
	negate: boolean,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	let value = parseIntegerLiteral(literalText)
	if (negate) value = -value

	if (!valueFitsInType(value, expectedType)) {
		const typeName = state.types.typeName(expectedType)
		return emitIntBoundsError(nodeId, typeName, formatDisplayValue(literalText, negate), context)
	}
	return emitIntConstInst(nodeId, expectedType, value, state)
}

/** Check an integer literal expression. */
function checkIntLiteral(
	nodeId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext,
	negate = false
): ExprResult {
	const node = context.nodes.get(nodeId)
	const token = context.tokens.get(node.tokenId)
	const literalText = context.strings.get(token.payload as StringId)

	if (isFloatType(expectedType)) {
		const expected = state.types.typeName(expectedType)
		context.emitAtNode('TWCHECK016' as DiagnosticCode, nodeId, {
			expected,
			found: 'integer literal',
		})
		return { instId: -1 as InstId, typeId: BuiltinTypeId.Invalid }
	}
	return checkIntLiteralAsInt(nodeId, expectedType, literalText, negate, state, context)
}

/**
 * Check a variable reference expression.
 */
function checkVarRef(
	nodeId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const node = context.nodes.get(nodeId)
	const token = context.tokens.get(node.tokenId)
	const nameId = token.payload as StringId
	const name = context.strings.get(nameId)
	const symId = state.symbols.lookupByName(nameId)
	if (symId === undefined) {
		context.emitAtNode('TWCHECK013' as DiagnosticCode, nodeId, { name })
		return { instId: -1 as InstId, typeId: BuiltinTypeId.Invalid }
	}

	const symbol = state.symbols.get(symId)

	if (!state.types.areEqual(symbol.typeId, expectedType)) {
		const expected = state.types.typeName(expectedType)
		const found = state.types.typeName(symbol.typeId)
		context.emitAtNode('TWCHECK012' as DiagnosticCode, nodeId, { expected, found })
		return { instId: -1 as InstId, typeId: BuiltinTypeId.Invalid }
	}

	const instId = state.insts.add({
		arg0: symId as number,
		arg1: 0,
		kind: InstKind.VarRef,
		parseNodeId: nodeId,
		typeId: symbol.typeId,
	})

	return { instId, typeId: symbol.typeId }
}

/** Emit float type mismatch error */
function emitFloatTypeMismatchError(
	nodeId: NodeId,
	expected: string,
	context: CompilationContext
): ExprResult {
	context.emitAtNode('TWCHECK016' as DiagnosticCode, nodeId, {
		expected,
		found: 'float literal',
	})
	return { instId: -1 as InstId, typeId: BuiltinTypeId.Invalid }
}

/** Check a float literal expression. */
function checkFloatLiteral(
	nodeId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext,
	negate = false
): ExprResult {
	const node = context.nodes.get(nodeId)
	const token = context.tokens.get(node.tokenId)
	const literalText = context.strings.get(token.payload as StringId)
	const value = applyNegation(Number.parseFloat(literalText), negate)

	if (!isFloatType(expectedType)) {
		return emitFloatTypeMismatchError(nodeId, state.types.typeName(expectedType), context)
	}
	if (expectedType === BuiltinTypeId.F32 && !isValidF32(value)) {
		return emitF32OverflowError(nodeId, formatDisplayValue(literalText, negate), context)
	}
	return emitFloatConstInst(nodeId, expectedType, value, state, context)
}

/**
 * Check a unary expression (currently only unary minus).
 * In postorder, the child is at exprNodeId - 1.
 */
function checkUnaryExpr(
	exprNodeId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	// In postorder storage, the child expression is immediately before the UnaryExpr
	const childId = nodeId((exprNodeId as number) - 1)
	const child = context.nodes.get(childId)

	// Handle literal negation specially (compile-time constant folding)
	if (child.kind === NodeKind.IntLiteral) {
		return checkIntLiteral(childId, expectedType, state, context, true)
	}

	if (child.kind === NodeKind.FloatLiteral) {
		return checkFloatLiteral(childId, expectedType, state, context, true)
	}

	// Runtime negation: check child expression first
	const childResult = checkExpression(childId, expectedType, state, context)
	if (childResult.typeId === BuiltinTypeId.Invalid) {
		return childResult
	}

	// Emit Negate instruction
	const instId = state.insts.add({
		arg0: childResult.instId as number,
		arg1: 0,
		kind: InstKind.Negate,
		parseNodeId: exprNodeId,
		typeId: childResult.typeId,
	})
	return { instId, typeId: childResult.typeId }
}

/**
 * Check an expression node.
 */
function checkExpression(
	exprId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const node = context.nodes.get(exprId)

	switch (node.kind) {
		case NodeKind.IntLiteral:
			return checkIntLiteral(exprId, expectedType, state, context)
		case NodeKind.FloatLiteral:
			return checkFloatLiteral(exprId, expectedType, state, context)
		case NodeKind.UnaryExpr:
			return checkUnaryExpr(exprId, expectedType, state, context)
		case NodeKind.Identifier:
			return checkVarRef(exprId, expectedType, state, context)
		default:
			// Should be unreachable - all expression kinds should be handled
			console.assert(false, 'checkExpression: unhandled expression kind %d', node.kind)
			return { instId: -1 as InstId, typeId: BuiltinTypeId.Invalid }
	}
}

/**
 * Process a VariableBinding statement.
 * Syntax: identifier TypeAnnotation = Expression
 * In postorder: [Identifier, TypeAnnotation, Expression..., VariableBinding]
 *
 * Note: Expression may have subtreeSize > 1 (e.g., UnaryExpr has subtreeSize=2).
 * We must use subtreeSize to correctly navigate the postorder storage.
 */
function processVariableBinding(
	bindingId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	// In postorder, expression root is immediately before VariableBinding
	// Then we work backwards using subtreeSize to find TypeAnnotation and Identifier
	const exprId = nodeId((bindingId as number) - 1)
	const exprNode = context.nodes.get(exprId)
	console.assert(
		isExpressionNode(exprNode.kind),
		'VariableBinding: expected expression at offset -1, found %d',
		exprNode.kind
	)

	// TypeAnnotation is before the expression's entire subtree
	const typeAnnotationId = nodeId((exprId as number) - exprNode.subtreeSize)
	const typeAnnotationNode = context.nodes.get(typeAnnotationId)
	console.assert(
		typeAnnotationNode.kind === NodeKind.TypeAnnotation,
		'VariableBinding: expected TypeAnnotation, found %d',
		typeAnnotationNode.kind
	)

	// Identifier is before the TypeAnnotation's subtree (subtreeSize=1)
	const identId = nodeId((typeAnnotationId as number) - typeAnnotationNode.subtreeSize)
	const identNode = context.nodes.get(identId)
	console.assert(
		identNode.kind === NodeKind.Identifier,
		'VariableBinding: expected Identifier, found %d',
		identNode.kind
	)

	// 1. Get identifier name
	const identToken = context.tokens.get(identNode.tokenId)
	const nameId = identToken.payload as StringId

	// 2. Resolve declared type from TypeAnnotation
	const typeToken = context.tokens.get(typeAnnotationNode.tokenId)
	const typeInfo = getTypeNameFromToken(typeToken.kind)

	if (!typeInfo) {
		context.emitAtNode('TWCHECK010' as DiagnosticCode, typeAnnotationId, {
			found: 'unknown',
		})
		return
	}

	const declaredType = typeInfo.typeId

	// 3. Check expression with expected type
	const exprResult = checkExpression(exprId, declaredType, state, context)
	if (exprResult.typeId === BuiltinTypeId.Invalid) {
		return // Error already reported
	}

	// 4. Add symbol to table (allocates fresh local, supports shadowing)
	const symId = state.symbols.add({
		nameId,
		parseNodeId: bindingId,
		typeId: declaredType,
	})

	// 5. Emit Bind instruction
	state.insts.add({
		arg0: symId as number,
		arg1: exprResult.instId as number,
		kind: InstKind.Bind,
		parseNodeId: bindingId,
		typeId: declaredType,
	})
}

/**
 * Emit an instruction for a statement.
 */
function emitStatement(
	stmtId: NodeId,
	stmtKind: NodeKind,
	state: CheckerState,
	context: CompilationContext
): void {
	switch (stmtKind) {
		case NodeKind.PanicStatement:
			state.insts.add({
				arg0: 0,
				arg1: 0,
				kind: InstKind.Unreachable,
				parseNodeId: stmtId,
				typeId: BuiltinTypeId.None,
			})
			break
		case NodeKind.VariableBinding:
			processVariableBinding(stmtId, state, context)
			break
	}
}

/**
 * Checks if a line kind requires a scope (indented or dedented).
 */
function isIndentedOrDedentedLine(kind: NodeKind): boolean {
	return kind === NodeKind.IndentedLine || kind === NodeKind.DedentLine
}

/**
 * Emit the grouped unreachable warning if there's an active range.
 */
function flushUnreachableWarning(state: CheckerState, context: CompilationContext): void {
	const range = state.unreachableRange
	if (!range) return

	const { endLine, firstNodeId, startLine } = range

	if (startLine === endLine) {
		// Single line - use default suggestion
		context.emitAtNode('TWCHECK050' as DiagnosticCode, firstNodeId)
	} else {
		// Multiple lines - use custom suggestion with range
		const suggestion = `Lines ${startLine}-${endLine} are unreachable. You can safely remove this code, or move it before the exit point.`
		context.emitAtNodeWithSuggestion('TWCHECK050' as DiagnosticCode, firstNodeId, suggestion)
	}

	state.unreachableRange = null
}

/**
 * Get the line number for a node.
 */
function getNodeLine(nodeId: NodeId, context: CompilationContext): number {
	const node = context.nodes.get(nodeId)
	const token = context.tokens.get(node.tokenId)
	return token.line
}

/**
 * Track an unreachable statement for grouped warning.
 */
function trackUnreachable(stmtId: NodeId, state: CheckerState, context: CompilationContext): void {
	const line = getNodeLine(stmtId, context)

	if (!state.unreachableRange) {
		state.unreachableRange = {
			endLine: line,
			firstNodeId: stmtId,
			startLine: line,
		}
	} else {
		state.unreachableRange.endLine = line
	}
}

/**
 * Process the statement within a RootLine.
 */
function processRootLineStatement(
	lineId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	const stmt = getStatementFromLine(lineId, context)
	if (!stmt) return

	if (!state.currentScope.reachable) {
		trackUnreachable(stmt.id, state, context)
	}

	emitStatement(stmt.id, stmt.kind, state, context)

	if (isTerminator(stmt.kind)) {
		state.currentScope.reachable = false
	}
}

/**
 * Process a line node.
 * - RootLine: valid, process statement
 * - IndentedLine/DedentLine: error - invalid indentation
 */
function processLine(
	lineId: NodeId,
	line: { kind: NodeKind },
	state: CheckerState,
	context: CompilationContext
): void {
	if (isIndentedOrDedentedLine(line.kind)) {
		context.emitAtNode('TWCHECK001' as DiagnosticCode, lineId)
		return
	}

	processRootLineStatement(lineId, state, context)
}

/**
 * Collect line children from Program node in source order.
 * iterateChildren yields in reverse order, so we reverse to get source order.
 */
function getLineChildrenInSourceOrder(
	programId: NodeId,
	context: CompilationContext
): Array<[NodeId, { kind: NodeKind }]> {
	const lines: Array<[NodeId, { kind: NodeKind }]> = []
	for (const [lineId, line] of context.nodes.iterateChildren(programId)) {
		lines.push([lineId, line])
	}
	return lines.reverse()
}

/**
 * Perform semantic checking on a parsed program.
 *
 * Algorithm:
 * 1. Create "main" scope
 * 2. Find Program node (last in postorder)
 * 3. Iterate line children in source order
 * 4. For each line:
 *    - IndentedLine/DedentLine → error
 *    - RootLine → process statement
 *      - If unreachable, warn
 *      - Emit instruction
 *      - If terminator, mark unreachable
 */
export function check(context: CompilationContext): CheckResult {
	const insts = new InstStore()
	const scopes = new ScopeStore()
	const symbols = new SymbolStore()
	const types = new TypeStore()
	const mainScopeId = scopes.createMainScope()
	const mainScope = scopes.get(mainScopeId)

	const state: CheckerState = {
		currentScope: mainScope,
		insts,
		scopes,
		symbols,
		types,
		unreachableRange: null,
	}

	// Find Program node (last node in postorder storage)
	const nodeCount = context.nodes.count()
	if (nodeCount === 0) {
		context.insts = insts
		context.symbols = symbols
		context.types = types
		return { succeeded: true }
	}

	const programId = nodeId(nodeCount - 1)
	const program = context.nodes.get(programId)

	if (program.kind !== NodeKind.Program) {
		// No valid Program node - might be a parse error
		context.insts = insts
		context.symbols = symbols
		context.types = types
		return { succeeded: !context.hasErrors() }
	}

	// Process line children in source order
	const lines = getLineChildrenInSourceOrder(programId, context)
	for (const [lineId, line] of lines) {
		processLine(lineId, line, state, context)
	}

	flushUnreachableWarning(state, context)
	context.insts = insts
	context.symbols = symbols
	context.types = types

	return { succeeded: !context.hasErrors() }
}
