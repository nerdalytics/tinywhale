/**
 * Utility functions for the checker phase.
 *
 * This module contains:
 * - Type guards for expression results
 * - Node classification functions (statement, expression, pattern)
 * - Numeric utilities (bounds checking, BigInt splitting)
 * - Operator classification functions
 */

import { NodeKind } from '../core/nodes.ts'
import { TokenKind } from '../core/tokens.ts'
import type { ExprResult } from './state.ts'
import { BuiltinTypeId, type InstId, type TypeId } from './types.ts'

/**
 * Type guard to check if an expression result is valid.
 */
export function isValidExprResult(result: ExprResult): result is { typeId: TypeId; instId: InstId } {
	return result.typeId !== BuiltinTypeId.Invalid && result.instId !== null
}

/**
 * Checks if a node kind is a terminator (e.g., panic).
 */
export function isTerminator(kind: NodeKind): boolean {
	return kind === NodeKind.PanicStatement
}

/**
 * Checks if a node kind represents a statement.
 * Statement kinds are in range 10-99.
 */
export function isStatementNode(kind: NodeKind): boolean {
	return kind >= 10 && kind < 100
}

/**
 * Checks if a node kind represents an expression.
 * Expression kinds are in range 100-149.
 */
export function isExpressionNode(kind: NodeKind): boolean {
	return kind >= 100 && kind < 150
}

/**
 * Checks if a node kind represents a pattern.
 * Pattern kinds are in range 200-249.
 */
export function isPatternNode(kind: NodeKind): boolean {
	return kind >= 200 && kind < 250
}

/**
 * Integer bounds for i32 and i64 types.
 */
export const INT_BOUNDS = {
	i32: { max: BigInt(2147483647), min: BigInt(-2147483648) },
	i64: { max: BigInt('9223372036854775807'), min: BigInt('-9223372036854775808') },
}

/**
 * Checks if a value fits within the base type bounds.
 */
export function fitsInBaseBounds(value: bigint, baseTypeId: TypeId): boolean {
	if (baseTypeId === BuiltinTypeId.I32) {
		return value >= INT_BOUNDS.i32.min && value <= INT_BOUNDS.i32.max
	}
	if (baseTypeId === BuiltinTypeId.I64) {
		return value >= INT_BOUNDS.i64.min && value <= INT_BOUNDS.i64.max
	}
	return false
}

/**
 * Checks if a value fits within the given constraints.
 */
export function fitsInConstraints(value: bigint, constraints: { min?: bigint; max?: bigint }): boolean {
	if (constraints.min !== undefined && value < constraints.min) return false
	if (constraints.max !== undefined && value > constraints.max) return false
	return true
}

/**
 * Split a BigInt value into low and high 32-bit parts for codegen.
 * Uses two's complement representation for negative values.
 */
export function splitBigIntTo32BitParts(value: bigint, typeId: TypeId): { low: number; high: number } {
	if (typeId === BuiltinTypeId.I32) {
		return { high: 0, low: Number(BigInt.asIntN(32, value)) }
	}
	const low = Number(BigInt.asIntN(32, value))
	const high = Number(BigInt.asIntN(32, value >> 32n))
	return { high, low }
}

/**
 * Checks if a value is representable as f32.
 */
export function isValidF32(value: number): boolean {
	const f32Value = Math.fround(value)
	return Number.isFinite(f32Value) || !Number.isFinite(value)
}

/**
 * Checks if a type is a floating-point type (f32 or f64).
 */
export function isFloatType(typeId: TypeId): boolean {
	return typeId === BuiltinTypeId.F32 || typeId === BuiltinTypeId.F64
}

/**
 * Checks if a type is an integer type (i32 or i64).
 */
export function isIntegerType(typeId: TypeId): boolean {
	return typeId === BuiltinTypeId.I32 || typeId === BuiltinTypeId.I64
}

/**
 * Checks if an operator is integer-only (bitwise, modulo, shifts).
 */
export function isIntegerOnlyOperator(tokenKind: TokenKind): boolean {
	switch (tokenKind) {
		case TokenKind.Percent:
		case TokenKind.PercentPercent:
		case TokenKind.Ampersand:
		case TokenKind.Pipe:
		case TokenKind.Caret:
		case TokenKind.Tilde:
		case TokenKind.LessLess:
		case TokenKind.GreaterGreater:
		case TokenKind.GreaterGreaterGreater:
			return true
		default:
			return false
	}
}

/**
 * Checks if an operator is a comparison operator.
 */
export function isComparisonOperator(tokenKind: TokenKind): boolean {
	switch (tokenKind) {
		case TokenKind.LessThan:
		case TokenKind.LessEqual:
		case TokenKind.GreaterThan:
		case TokenKind.GreaterEqual:
		case TokenKind.EqualEqual:
		case TokenKind.BangEqual:
			return true
		default:
			return false
	}
}

/**
 * Checks if an operator is a logical operator (&& or ||).
 */
export function isLogicalOperator(kind: TokenKind): boolean {
	return kind === TokenKind.AmpersandAmpersand || kind === TokenKind.PipePipe
}

/**
 * Gets the string representation of an operator token.
 */
export function getOperatorName(tokenKind: TokenKind): string {
	switch (tokenKind) {
		case TokenKind.Plus:
			return '+'
		case TokenKind.Minus:
			return '-'
		case TokenKind.Star:
			return '*'
		case TokenKind.Slash:
			return '/'
		case TokenKind.Percent:
			return '%'
		case TokenKind.PercentPercent:
			return '%%'
		case TokenKind.Ampersand:
			return '&'
		case TokenKind.Pipe:
			return '|'
		case TokenKind.Caret:
			return '^'
		case TokenKind.Tilde:
			return '~'
		case TokenKind.LessLess:
			return '<<'
		case TokenKind.GreaterGreater:
			return '>>'
		case TokenKind.GreaterGreaterGreater:
			return '>>>'
		case TokenKind.LessThan:
			return '<'
		case TokenKind.LessEqual:
			return '<='
		case TokenKind.GreaterThan:
			return '>'
		case TokenKind.GreaterEqual:
			return '>='
		case TokenKind.EqualEqual:
			return '=='
		case TokenKind.BangEqual:
			return '!='
		case TokenKind.AmpersandAmpersand:
			return '&&'
		case TokenKind.PipePipe:
			return '||'
		default:
			return '?'
	}
}
