/**
 * Pattern matching processing for the Check phase.
 *
 * This module handles:
 * - Match arm detection and processing
 * - Pattern validation (literal, or, wildcard, binding)
 * - Catch-all pattern detection
 * - Match exhaustiveness checking
 * - Match finalization and binding creation
 */

import type { CompilationContext, StringId } from '../core/context.ts'
import type { DiagnosticCode } from '../core/diagnostics.ts'
import { type NodeId, NodeKind, offsetNodeId, prevNodeId } from '../core/nodes.ts'
import { checkExpression } from './expressions.ts'
import type { CheckerState, MatchContext } from './state.ts'
import { getTypeNameFromToken } from './type-resolution.ts'
import { BuiltinTypeId, type InstId, InstKind, type TypeId } from './types.ts'
import { isExpressionNode, isIntegerType, isPatternNode, isValidExprResult } from './utils.ts'

// ============================================================================
// Match Arm Detection
// ============================================================================

/**
 * Find a MatchArm node within a line.
 */
export function getMatchArmFromLine(
	lineId: NodeId,
	context: CompilationContext
): { id: NodeId; kind: NodeKind } | null {
	for (const [childId, child] of context.nodes.iterateChildren(lineId)) {
		if (child.kind === NodeKind.MatchArm) {
			return { id: childId, kind: child.kind }
		}
	}
	return null
}

// ============================================================================
// Pattern Validation
// ============================================================================

/**
 * Validate a literal pattern against the scrutinee type.
 */
function validateLiteralPattern(
	patternId: NodeId,
	scrutineeType: TypeId,
	state: CheckerState,
	context: CompilationContext
): void {
	if (!isIntegerType(scrutineeType)) {
		context.emitAtNode('TWCHECK018' as DiagnosticCode, patternId, {
			patternType: 'integer literal',
			scrutineeType: state.types.typeName(scrutineeType),
		})
	}
}

/**
 * Check all children of an or-pattern.
 */
function checkOrPatternChildren(
	patternId: NodeId,
	scrutineeType: TypeId,
	state: CheckerState,
	context: CompilationContext
): void {
	for (const [childId, child] of context.nodes.iterateChildren(patternId)) {
		if (isPatternNode(child.kind)) {
			checkPattern(childId, scrutineeType, state, context)
		}
	}
}

/**
 * Create a symbol for a binding pattern variable.
 * The pattern variable is bound to the scrutinee value.
 */
function createPatternBindingSymbol(
	patternId: NodeId,
	scrutineeType: TypeId,
	state: CheckerState,
	context: CompilationContext
): void {
	const patternNode = context.nodes.get(patternId)
	const token = context.tokens.get(patternNode.tokenId)
	const nameId = token.payload as StringId

	// Create symbol for pattern variable
	const symId = state.symbols.add({
		nameId,
		parseNodeId: patternId,
		typeId: scrutineeType,
	})

	// Emit PatternBind instruction if we have a valid scrutinee
	const scrutineeInstId = state.matchContext?.scrutinee.instId
	if (scrutineeInstId !== null && scrutineeInstId !== undefined) {
		state.insts.add({
			arg0: symId as number,
			arg1: scrutineeInstId as number,
			kind: InstKind.PatternBind,
			parseNodeId: patternId,
			typeId: scrutineeType,
		})
	}
}

/**
 * Check a pattern against the scrutinee type.
 */
export function checkPattern(
	patternId: NodeId,
	scrutineeType: TypeId,
	state: CheckerState,
	context: CompilationContext
): NodeId {
	const patternNode = context.nodes.get(patternId)

	switch (patternNode.kind) {
		case NodeKind.LiteralPattern:
			validateLiteralPattern(patternId, scrutineeType, state, context)
			break
		case NodeKind.OrPattern:
			checkOrPatternChildren(patternId, scrutineeType, state, context)
			break
		case NodeKind.BindingPattern:
			createPatternBindingSymbol(patternId, scrutineeType, state, context)
			break
	}

	return patternId
}

// ============================================================================
// Match Arm Processing
// ============================================================================

/**
 * Process a MatchArm node.
 * In postorder: [Pattern..., Expression..., MatchArm]
 */
export function processMatchArm(
	armId: NodeId,
	state: CheckerState,
	context: CompilationContext
): void {
	if (!state.matchContext) {
		context.emitAtNode('TWCHECK019' as DiagnosticCode, armId)
		return
	}

	// In postorder, children are before parent. We need to find the pattern and expression.
	// The expression is the last child (closest to MatchArm).
	// Pattern(s) come before the expression.
	const exprId = prevNodeId(armId)
	const exprNode = context.nodes.get(exprId)

	if (!isExpressionNode(exprNode.kind)) {
		return
	}

	// Pattern is before the expression's subtree
	const patternId = offsetNodeId(exprId, -exprNode.subtreeSize)
	const patternNode = context.nodes.get(patternId)

	if (!isPatternNode(patternNode.kind)) {
		return
	}

	// Push scope for this arm's bindings
	state.symbols.pushScope()

	checkPattern(patternId, state.matchContext.scrutinee.typeId, state, context)

	const bodyResult = checkExpression(exprId, state.matchContext.expectedType, state, context)

	// Pop scope - arm bindings no longer visible
	state.symbols.popScope()

	if (isValidExprResult(bodyResult)) {
		state.matchContext.arms.push({
			bodyInstId: bodyResult.instId,
			patternNodeId: patternId,
		})
	}
}

// ============================================================================
// Catch-All Detection
// ============================================================================

/**
 * Check if a pattern kind is a simple catch-all (wildcard or binding).
 */
function isSimpleCatchAll(kind: NodeKind): boolean {
	return kind === NodeKind.WildcardPattern || kind === NodeKind.BindingPattern
}

/**
 * Check if an or-pattern contains a catch-all pattern.
 */
function orPatternContainsCatchAll(patternId: NodeId, context: CompilationContext): boolean {
	for (const [childId, child] of context.nodes.iterateChildren(patternId)) {
		if (isPatternNode(child.kind) && isCatchAllPattern(childId, context)) {
			return true
		}
	}
	return false
}

/**
 * Check if a pattern is a catch-all (wildcard or binding).
 * For OrPattern, recursively checks if any child is a catch-all.
 */
function isCatchAllPattern(patternId: NodeId, context: CompilationContext): boolean {
	const pattern = context.nodes.get(patternId)

	if (isSimpleCatchAll(pattern.kind)) return true
	if (pattern.kind === NodeKind.OrPattern) return orPatternContainsCatchAll(patternId, context)
	return false
}

// ============================================================================
// Match Exhaustiveness
// ============================================================================

/**
 * Check if a match is exhaustive (has a catch-all in the last arm).
 */
function checkMatchExhaustiveness(
	arms: MatchContext['arms'],
	matchNodeId: NodeId,
	context: CompilationContext
): void {
	const lastArm = arms[arms.length - 1]
	if (!lastArm || !isCatchAllPattern(lastArm.patternNodeId, context)) {
		context.emitAtNode('TWCHECK020' as DiagnosticCode, matchNodeId)
	}
}

// ============================================================================
// Match Finalization
// ============================================================================

/**
 * Emit instructions for all match arms.
 */
function emitMatchArmInsts(
	arms: MatchContext['arms'],
	matchNodeId: NodeId,
	expectedType: TypeId,
	state: CheckerState
): void {
	for (const arm of arms) {
		state.insts.add({
			arg0: arm.patternNodeId as number,
			arg1: arm.bodyInstId as number,
			kind: InstKind.MatchArm,
			parseNodeId: matchNodeId,
			typeId: expectedType,
		})
	}
}

/**
 * Create a binding for the match result.
 */
function createMatchBinding(
	matchCtx: MatchContext,
	matchInstId: InstId,
	state: CheckerState
): void {
	const symId = state.symbols.add({
		nameId: matchCtx.bindingNameId,
		parseNodeId: matchCtx.bindingNodeId,
		typeId: matchCtx.expectedType,
	})
	state.insts.add({
		arg0: symId as number,
		arg1: matchInstId as number,
		kind: InstKind.Bind,
		parseNodeId: matchCtx.bindingNodeId,
		typeId: matchCtx.expectedType,
	})
}

/**
 * Finalize a match expression, emitting all instructions.
 */
export function finalizeMatch(state: CheckerState, context: CompilationContext): void {
	if (!state.matchContext) return

	const { arms, expectedType, matchNodeId, scrutinee } = state.matchContext

	checkMatchExhaustiveness(arms, matchNodeId, context)

	// scrutinee.instId null check (matchContext only set after valid typeId check)
	if (scrutinee.instId === null) return

	emitMatchArmInsts(arms, matchNodeId, expectedType, state)

	const matchInstId = state.insts.add({
		arg0: scrutinee.instId as number,
		arg1: arms.length,
		kind: InstKind.Match,
		parseNodeId: matchNodeId,
		typeId: expectedType,
	})

	createMatchBinding(state.matchContext, matchInstId, state)
	state.matchContext = null
}

// ============================================================================
// Match Binding
// ============================================================================

interface MatchBindingNodes {
	identId: NodeId
	typeAnnotationId: NodeId
	scrutineeId: NodeId
	bindingNameId: StringId
	expectedType: TypeId
}

/**
 * Extract raw positional nodes from match binding.
 * Returns null if structure is invalid.
 */
function extractMatchBindingPositionalNodes(
	bindingId: NodeId,
	context: CompilationContext
): {
	matchExprNode: ReturnType<typeof context.nodes.get>
	scrutineeId: NodeId
	typeAnnotationId: NodeId
	identId: NodeId
} | null {
	const matchExprId = prevNodeId(bindingId)
	const matchExprNode = context.nodes.get(matchExprId)
	if (matchExprNode.kind !== NodeKind.MatchExpr) return null

	const scrutineeId = prevNodeId(matchExprId)
	if (!isExpressionNode(context.nodes.get(scrutineeId).kind)) return null

	const typeAnnotationId = offsetNodeId(matchExprId, -matchExprNode.subtreeSize)
	if (context.nodes.get(typeAnnotationId).kind !== NodeKind.TypeAnnotation) return null

	const identId = offsetNodeId(typeAnnotationId, -context.nodes.get(typeAnnotationId).subtreeSize)
	if (context.nodes.get(identId).kind !== NodeKind.Identifier) return null

	return { identId, matchExprNode, scrutineeId, typeAnnotationId }
}

/**
 * Extract match binding nodes with type resolution.
 */
function extractMatchBindingNodes(
	bindingId: NodeId,
	context: CompilationContext
): MatchBindingNodes | null {
	const positional = extractMatchBindingPositionalNodes(bindingId, context)
	if (!positional) return null

	const { identId, scrutineeId, typeAnnotationId } = positional
	const bindingNameId = context.tokens.get(context.nodes.get(identId).tokenId).payload as StringId
	const typeToken = context.tokens.get(context.nodes.get(typeAnnotationId).tokenId)
	const typeInfo = getTypeNameFromToken(typeToken.kind)

	if (!typeInfo) {
		context.emitAtNode('TWCHECK010' as DiagnosticCode, typeAnnotationId, { found: 'unknown' })
		return null
	}

	return { bindingNameId, expectedType: typeInfo.typeId, identId, scrutineeId, typeAnnotationId }
}

/**
 * Start processing a match binding.
 * If the binding is not a match expression, falls back to the provided handler.
 */
export function startMatchBinding(
	bindingId: NodeId,
	state: CheckerState,
	context: CompilationContext,
	fallbackHandler: (bindingId: NodeId, state: CheckerState, context: CompilationContext) => void
): void {
	const nodes = extractMatchBindingNodes(bindingId, context)
	if (!nodes) {
		fallbackHandler(bindingId, state, context)
		return
	}

	const scrutineeResult = checkExpression(nodes.scrutineeId, nodes.expectedType, state, context)
	if (scrutineeResult.typeId === BuiltinTypeId.Invalid) return

	state.matchContext = {
		arms: [],
		bindingNameId: nodes.bindingNameId,
		bindingNodeId: bindingId,
		expectedType: nodes.expectedType,
		matchNodeId: bindingId,
		scrutinee: scrutineeResult,
		scrutineeNodeId: nodes.scrutineeId,
	}
}

/**
 * Find scrutinee expression in a MatchExpr node.
 */
function findScrutineeInMatchExpr(matchExprId: NodeId, context: CompilationContext): NodeId | null {
	for (const [childId, child] of context.nodes.iterateChildren(matchExprId)) {
		if (isExpressionNode(child.kind)) return childId
	}
	return null
}

/**
 * Start processing a match expression from a BindingExpr context.
 * Pattern: name: Type = match scrutinee
 *
 * This handles BindingExpr where the RHS is a MatchExpr.
 */
export function startMatchFromBindingExpr(
	bindingId: NodeId,
	matchExprId: NodeId,
	bindingNameId: StringId,
	expectedType: TypeId,
	state: CheckerState,
	context: CompilationContext
): void {
	const scrutineeId = findScrutineeInMatchExpr(matchExprId, context)
	if (scrutineeId === null) {
		context.emitAtNode('TWCHECK010' as DiagnosticCode, matchExprId, {
			found: 'match without scrutinee',
		})
		return
	}

	const scrutineeResult = checkExpression(scrutineeId, expectedType, state, context)
	if (scrutineeResult.typeId === BuiltinTypeId.Invalid) return

	state.matchContext = {
		arms: [],
		bindingNameId,
		bindingNodeId: bindingId,
		expectedType,
		matchNodeId: bindingId,
		scrutinee: scrutineeResult,
		scrutineeNodeId: scrutineeId,
	}
}
