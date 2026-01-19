import type { Grammar, PExpr, RuleInfo } from 'ohm-js'
import type { PExprVisitor } from '../types.ts'

type PExprWithChildren = PExpr & {
	terms?: PExpr[]
	factors?: PExpr[]
	expr?: PExpr
}

export function extractRules(grammar: Grammar): Map<string, RuleInfo> {
	const rules = new Map<string, RuleInfo>()
	for (const [name, info] of Object.entries(grammar.rules)) {
		rules.set(name, info)
	}
	return rules
}

export function getRuleNames(grammar: Grammar): string[] {
	return Object.keys(grammar.rules)
}

function getConstructorName(expr: PExpr): string {
	return expr.constructor.name
}

function walkChild<T>(expr: PExprWithChildren, visitor: PExprVisitor<T>): T | undefined {
	const inner = expr.expr
	return inner !== undefined ? walkPExpr(inner, visitor) : undefined
}

function handleAlt<T>(expr: PExprWithChildren, visitor: PExprVisitor<T>): T | undefined {
	const children = (expr.terms ?? []).map((child) => walkPExpr(child, visitor))
	return visitor.onAlt?.(children.filter((c): c is T => c !== undefined))
}

function handleSeq<T>(expr: PExprWithChildren, visitor: PExprVisitor<T>): T | undefined {
	const children = (expr.factors ?? []).map((child) => walkPExpr(child, visitor))
	return visitor.onSeq?.(children.filter((c): c is T => c !== undefined))
}

function handleApply<T>(expr: PExpr, visitor: PExprVisitor<T>): T | undefined {
	const apply = expr as unknown as { ruleName: string; args: PExpr[] }
	const argResults = apply.args.map((arg) => walkPExpr(arg, visitor))
	return visitor.onApp?.(
		apply.ruleName,
		argResults.filter((a): a is T => a !== undefined)
	)
}

function handleTerminal<T>(expr: PExpr, visitor: PExprVisitor<T>): T | undefined {
	const terminal = expr as unknown as { obj: string }
	return visitor.onTerminal?.(terminal.obj)
}

type Handler<T> = (expr: PExpr, visitor: PExprVisitor<T>) => T | undefined

function handleUnary<T>(
	e: PExpr,
	v: PExprVisitor<T>,
	callback: ((child: T) => T | undefined) | undefined
): T | undefined {
	const child = walkChild(e as PExprWithChildren, v)
	return callback !== undefined ? callback(child as T) : child
}

function createHandlers<T>(): Record<string, Handler<T>> {
	return {
		Alt: (e, v) => handleAlt(e as PExprWithChildren, v),
		Apply: handleApply,
		CaseInsensitiveTerminal: handleTerminal,
		Extend: (e, v) => handleAlt(e as PExprWithChildren, v),
		Lex: (e, v) => handleUnary(e, v, v.onLex),
		Lookahead: (e, v) => handleUnary(e, v, v.onLookahead),
		Not: (e, v) => handleUnary(e, v, v.onNot),
		Opt: (e, v) => handleUnary(e, v, v.onOpt),
		Param: (e, v) => v.onParam?.((e as unknown as { index: number }).index),
		Plus: (e, v) => handleUnary(e, v, v.onPlus),
		Range: (e, v) => {
			const range = e as unknown as { from: string; to: string }
			return v.onRange?.(range.from, range.to)
		},
		Seq: (e, v) => handleSeq(e as PExprWithChildren, v),
		Splice: (e, v) => handleAlt(e as PExprWithChildren, v),
		Star: (e, v) => handleUnary(e, v, v.onStar),
		Terminal: handleTerminal,
		UnicodeChar: (e, v) => v.onUnicodeChar?.((e as unknown as { category: string }).category),
	}
}

export function walkPExpr<T>(expr: PExpr, visitor: PExprVisitor<T>): T | undefined {
	const ctorName = getConstructorName(expr)
	const handlers = createHandlers<T>()
	const handler = handlers[ctorName]
	return handler !== undefined ? handler(expr, visitor) : undefined
}

export function collectRuleReferences(expr: PExpr): Set<string> {
	const refs = new Set<string>()

	const visitor: PExprVisitor<void> = {
		onApp(ruleName: string): void {
			refs.add(ruleName)
		},
	}

	walkPExpr(expr, visitor)
	return refs
}
