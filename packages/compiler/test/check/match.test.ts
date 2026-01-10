import assert from 'node:assert'
import { describe, it } from 'node:test'
import { check } from '../../src/check/checker.ts'
import { InstKind, instId } from '../../src/check/types.ts'
import { CompilationContext, DiagnosticSeverity } from '../../src/core/context.ts'
import { tokenize } from '../../src/lex/tokenizer.ts'
import { parse } from '../../src/parse/parser.ts'

function prepareContext(source: string): CompilationContext {
	const ctx = new CompilationContext(source)
	tokenize(ctx)
	parse(ctx)
	return ctx
}

function getErrors(ctx: CompilationContext) {
	return ctx.getDiagnostics().filter((d) => d.def.severity === DiagnosticSeverity.Error)
}

describe('check/match', () => {
	describe('basic match expression', () => {
		it('should accept match with wildcard pattern', () => {
			const source = `x: i32 = 42
result: i32 = match x
	_ -> 0
`
			const ctx = prepareContext(source)
			const result = check(ctx)

			assert.strictEqual(result.succeeded, true)
			const errors = getErrors(ctx)
			assert.strictEqual(errors.length, 0)
		})

		it('should accept match with literal patterns', () => {
			const source = `x: i32 = 1
result: i32 = match x
	0 -> 100
	1 -> 200
	_ -> 0
`
			const ctx = prepareContext(source)
			const result = check(ctx)

			assert.strictEqual(result.succeeded, true)
			const errors = getErrors(ctx)
			assert.strictEqual(errors.length, 0)
		})

		it('should accept match with negative literal patterns', () => {
			const source = `x: i32 = -1
result: i32 = match x
	-1 -> 100
	0 -> 200
	_ -> 0
`
			const ctx = prepareContext(source)
			const result = check(ctx)

			assert.strictEqual(result.succeeded, true)
			const errors = getErrors(ctx)
			assert.strictEqual(errors.length, 0)
		})
	})

	describe('instruction emission', () => {
		it('should emit Match instruction', () => {
			const source = `x: i32 = 42
result: i32 = match x
	_ -> 0
`
			const ctx = prepareContext(source)
			check(ctx)

			assert.ok(ctx.insts !== null)
			// Should have: IntConst (42), Bind (x), IntConst (0), MatchArm, Match, Bind (result)
			let hasMatch = false
			for (let i = 0; i < ctx.insts.count(); i++) {
				const inst = ctx.insts.get(instId(i))
				if (inst.kind === InstKind.Match) {
					hasMatch = true
				}
			}
			assert.ok(hasMatch, 'should have Match instruction')
		})

		it('should emit MatchArm instructions', () => {
			const source = `x: i32 = 42
result: i32 = match x
	0 -> 100
	1 -> 200
	_ -> 0
`
			const ctx = prepareContext(source)
			check(ctx)

			assert.ok(ctx.insts !== null)
			let armCount = 0
			for (let i = 0; i < ctx.insts.count(); i++) {
				const inst = ctx.insts.get(instId(i))
				if (inst.kind === InstKind.MatchArm) {
					armCount++
				}
			}
			assert.strictEqual(armCount, 3, 'should have 3 MatchArm instructions')
		})

		it('should emit Bind instruction for match result', () => {
			const source = `x: i32 = 42
result: i32 = match x
	_ -> 0
`
			const ctx = prepareContext(source)
			check(ctx)

			assert.ok(ctx.insts !== null)
			let bindCount = 0
			for (let i = 0; i < ctx.insts.count(); i++) {
				const inst = ctx.insts.get(instId(i))
				if (inst.kind === InstKind.Bind) {
					bindCount++
				}
			}
			assert.strictEqual(bindCount, 2, 'should have 2 Bind instructions (x and result)')
		})
	})

	describe('type checking', () => {
		it('should require arm bodies to match declared type', () => {
			const source = `x: i32 = 42
result: i32 = match x
	_ -> 3.14
`
			const ctx = prepareContext(source)
			const result = check(ctx)

			assert.strictEqual(result.succeeded, false)
			const errors = getErrors(ctx)
			assert.ok(errors.length > 0)
			assert.ok(errors.some((e) => e.message.includes('type mismatch')))
		})

		it('should check scrutinee type matches declared type', () => {
			const source = `x: i32 = 42
result: i64 = match x
	_ -> 0
`
			const ctx = prepareContext(source)
			const result = check(ctx)

			// Currently scrutinee is checked with expected type
			// This should fail because x is i32 but result expects i64
			assert.strictEqual(result.succeeded, false)
			const errors = getErrors(ctx)
			assert.ok(errors.length > 0)
		})
	})

	describe('symbol table', () => {
		it('should create symbol for match result', () => {
			const source = `x: i32 = 42
result: i32 = match x
	_ -> 0
`
			const ctx = prepareContext(source)
			check(ctx)

			assert.ok(ctx.symbols !== null)
			// Should have symbols for x and result
			assert.strictEqual(ctx.symbols.count(), 2)
		})

		it('should allow using match result in subsequent code', () => {
			const source = `x: i32 = 42
result: i32 = match x
	_ -> 0
y: i32 = result
`
			const ctx = prepareContext(source)
			const result = check(ctx)

			assert.strictEqual(result.succeeded, true)
			const errors = getErrors(ctx)
			assert.strictEqual(errors.length, 0)
		})
	})

	describe('multiple match expressions', () => {
		it('should handle multiple sequential match expressions', () => {
			const source = `x: i32 = 1
a: i32 = match x
	0 -> 10
	_ -> 20
b: i32 = match x
	1 -> 30
	_ -> 40
`
			const ctx = prepareContext(source)
			const result = check(ctx)

			assert.strictEqual(result.succeeded, true)
			const errors = getErrors(ctx)
			assert.strictEqual(errors.length, 0)
		})
	})

	describe('exhaustiveness checking', () => {
		it('should error on match without catch-all pattern', () => {
			const source = `x: i32 = 42
result: i32 = match x
	0 -> 100
`
			const ctx = prepareContext(source)
			const result = check(ctx)

			assert.strictEqual(result.succeeded, false)
			const errors = getErrors(ctx)
			assert.ok(errors.some((e) => e.message.includes('non-exhaustive match')))
		})

		it('should error on match with only literal patterns', () => {
			const source = `x: i32 = 42
result: i32 = match x
	0 -> 100
	1 -> 200
`
			const ctx = prepareContext(source)
			const result = check(ctx)

			assert.strictEqual(result.succeeded, false)
			const errors = getErrors(ctx)
			assert.ok(errors.some((e) => e.message.includes('non-exhaustive match')))
		})

		it('should accept match with wildcard as last arm', () => {
			const source = `x: i32 = 42
result: i32 = match x
	0 -> 100
	_ -> 0
`
			const ctx = prepareContext(source)
			const result = check(ctx)

			assert.strictEqual(result.succeeded, true)
			const errors = getErrors(ctx)
			assert.strictEqual(errors.length, 0)
		})

		it('should accept match with binding pattern as last arm', () => {
			// Note: binding patterns are recognized for exhaustiveness checking
			// but pattern variable bindings are not yet in scope for the arm body
			const source = `x: i32 = 42
result: i32 = match x
	0 -> 100
	other -> 0
`
			const ctx = prepareContext(source)
			const result = check(ctx)

			assert.strictEqual(result.succeeded, true)
			const errors = getErrors(ctx)
			assert.strictEqual(errors.length, 0)
		})

		it('should accept or-pattern containing wildcard as last arm', () => {
			const source = `x: i32 = 42
result: i32 = match x
	0 -> 100
	1 | _ -> 0
`
			const ctx = prepareContext(source)
			const result = check(ctx)

			assert.strictEqual(result.succeeded, true)
			const errors = getErrors(ctx)
			assert.strictEqual(errors.length, 0)
		})

		it('should error when wildcard is not the last arm', () => {
			const source = `x: i32 = 42
result: i32 = match x
	_ -> 0
	0 -> 100
`
			const ctx = prepareContext(source)
			const result = check(ctx)

			assert.strictEqual(result.succeeded, false)
			const errors = getErrors(ctx)
			assert.ok(errors.some((e) => e.message.includes('non-exhaustive match')))
		})
	})
})
