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
 */
const INT_BOUNDS = {
	i32: { max: 2147483647, min: -2147483648 },
	i64: { max: BigInt('9223372036854775807'), min: BigInt('-9223372036854775808') },
}

/**
 * Check if a value fits in the given type bounds.
 */
function valueFitsInType(value: number, typeId: TypeId): boolean {
	if (typeId === BuiltinTypeId.I32) {
		return value >= INT_BOUNDS.i32.min && value <= INT_BOUNDS.i32.max
	}
	if (typeId === BuiltinTypeId.I64) {
		// For now, JavaScript number precision limits i64 checking
		// Values beyond safe integer range would need BigInt parsing
		return true // Simplified: assume fits for now
	}
	// Floats: any number is valid
	return true
}

/**
 * Check an integer literal expression.
 * The literal takes the expected type from the binding context.
 */
function checkIntLiteral(
	nodeId: NodeId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): ExprResult {
	const node = context.nodes.get(nodeId)
	const token = context.tokens.get(node.tokenId)
	const value = token.payload // IntLiteral payload is the parsed value

	// Check bounds
	if (!valueFitsInType(value, expectedType)) {
		const typeName = state.types.typeName(expectedType)
		context.emitAtNode('TWCHECK014' as DiagnosticCode, nodeId, {
			type: typeName,
			value: String(value),
		})
		return { instId: -1 as InstId, typeId: BuiltinTypeId.Invalid }
	}

	// Emit IntConst instruction with the expected type
	const instId = state.insts.add({
		arg0: value, // low 32 bits
		arg1: 0, // high 32 bits (for i64 - simplified)
		kind: InstKind.IntConst,
		parseNodeId: nodeId,
		typeId: expectedType,
	})

	return { instId, typeId: expectedType }
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

	// Look up in symbol table
	const symId = state.symbols.lookupByName(nameId)
	if (symId === undefined) {
		context.emitAtNode('TWCHECK013' as DiagnosticCode, nodeId, { name })
		return { instId: -1 as InstId, typeId: BuiltinTypeId.Invalid }
	}

	const symbol = state.symbols.get(symId)

	// Type check: symbol's type must match expected type
	if (!state.types.areEqual(symbol.typeId, expectedType)) {
		const expected = state.types.typeName(expectedType)
		const found = state.types.typeName(symbol.typeId)
		context.emitAtNode('TWCHECK012' as DiagnosticCode, nodeId, { expected, found })
		return { instId: -1 as InstId, typeId: BuiltinTypeId.Invalid }
	}

	// Emit VarRef instruction
	const instId = state.insts.add({
		arg0: symId as number,
		arg1: 0,
		kind: InstKind.VarRef,
		parseNodeId: nodeId,
		typeId: symbol.typeId,
	})

	return { instId, typeId: symbol.typeId }
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
		case NodeKind.Identifier:
			return checkVarRef(exprId, expectedType, state, context)
		default:
			// Unknown expression kind
			return { instId: -1 as InstId, typeId: BuiltinTypeId.Invalid }
	}
}

/**
 * Process a VariableBinding statement.
 * Syntax: identifier TypeAnnotation = Expression
 * In postorder: [Identifier, TypeAnnotation, Expression, VariableBinding]
 */
function processVariableBinding(
	bindingId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	// In postorder, children are at [bindingId-3, bindingId-2, bindingId-1]
	// Contract: VariableBinding = Identifier TypeAnnotation "=" Expression
	const identId = nodeId((bindingId as number) - 3)
	const typeAnnotationId = nodeId((bindingId as number) - 2)
	const exprId = nodeId((bindingId as number) - 1)

	// 1. Get identifier name
	const identNode = context.nodes.get(identId)
	console.assert(
		identNode.kind === NodeKind.Identifier,
		'VariableBinding: expected Identifier at offset -3, found %d',
		identNode.kind
	)
	const identToken = context.tokens.get(identNode.tokenId)
	const nameId = identToken.payload as StringId

	// 2. Resolve declared type from TypeAnnotation
	const typeAnnotationNode = context.nodes.get(typeAnnotationId)
	console.assert(
		typeAnnotationNode.kind === NodeKind.TypeAnnotation,
		'VariableBinding: expected TypeAnnotation at offset -2, found %d',
		typeAnnotationNode.kind
	)
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
	const exprNode = context.nodes.get(exprId)
	console.assert(
		isExpressionNode(exprNode.kind),
		'VariableBinding: expected expression at offset -1, found %d',
		exprNode.kind
	)
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
		context.emitAtNode('TWCHECK050' as DiagnosticCode, stmt.id)
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

	// Create main scope
	const mainScopeId = scopes.createMainScope()
	const mainScope = scopes.get(mainScopeId)

	const state: CheckerState = {
		currentScope: mainScope,
		insts,
		scopes,
		symbols,
		types,
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

	// Attach stores to context
	context.insts = insts
	context.symbols = symbols
	context.types = types

	return { succeeded: !context.hasErrors() }
}
