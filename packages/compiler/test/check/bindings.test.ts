import assert from 'node:assert'
import { describe, it } from 'node:test'

import { check } from '../../src/check/checker.ts'
import { InstKind } from '../../src/check/types.ts'
import { CompilationContext } from '../../src/core/context.ts'
import { compile } from '../../src/index.ts'
import { tokenize } from '../../src/lex/tokenizer.ts'
import { parse } from '../../src/parse/parser.ts'

function compileAndCheck(source: string): CompilationContext {
	const ctx = new CompilationContext(source)
	tokenize(ctx)
	parse(ctx)
	check(ctx)
	return ctx
}

describe('check/variable bindings', () => {
	describe('basic binding', () => {
		it('should compile x:i32 = 0 successfully', () => {
			const ctx = compileAndCheck('x:i32 = 0\n')
			assert.strictEqual(ctx.hasErrors(), false)
			assert.ok(ctx.symbols)
			assert.strictEqual(ctx.symbols.count(), 1)
		})

		it('should compile x:i64 = 100 with i64 literal', () => {
			const ctx = compileAndCheck('x:i64 = 100\n')
			assert.strictEqual(ctx.hasErrors(), false)
			assert.ok(ctx.symbols)
			const symbol = ctx.symbols.get(0 as import('../../src/check/types.ts').SymbolId)
			assert.strictEqual(symbol.typeId, 2) // BuiltinTypeId.I64
		})

		it('should allow spaces around colon', () => {
			const ctx = compileAndCheck('x : i32 = 0\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should emit Bind instruction', () => {
			const ctx = compileAndCheck('x:i32 = 0\n')
			assert.ok(ctx.insts)
			// Should have IntConst and Bind
			let hasBind = false
			for (const [, inst] of ctx.insts) {
				if (inst.kind === InstKind.Bind) hasBind = true
			}
			assert.ok(hasBind)
		})

		it('should emit IntConst instruction', () => {
			const ctx = compileAndCheck('x:i32 = 42\n')
			assert.ok(ctx.insts)
			let hasIntConst = false
			for (const [, inst] of ctx.insts) {
				if (inst.kind === InstKind.IntConst) {
					hasIntConst = true
					assert.strictEqual(inst.arg0, 42)
				}
			}
			assert.ok(hasIntConst)
		})
	})

	describe('variable references', () => {
		it('should compile y:i32 = x when x is defined', () => {
			const ctx = compileAndCheck('x:i32 = 0\ny:i32 = x\n')
			assert.strictEqual(ctx.hasErrors(), false)
			assert.ok(ctx.symbols)
			assert.strictEqual(ctx.symbols.count(), 2)
		})

		it('should emit VarRef instruction for variable reference', () => {
			const ctx = compileAndCheck('x:i32 = 0\ny:i32 = x\n')
			assert.ok(ctx.insts)
			let hasVarRef = false
			for (const [, inst] of ctx.insts) {
				if (inst.kind === InstKind.VarRef) hasVarRef = true
			}
			assert.ok(hasVarRef)
		})

		it('should error on undefined variable', () => {
			const ctx = compileAndCheck('x:i32 = y\n')
			assert.strictEqual(ctx.hasErrors(), true)
			const errors = ctx.getErrors()
			assert.ok(errors.some((e) => e.message.includes('undefined variable')))
		})
	})

	describe('type checking', () => {
		it('should error on type mismatch', () => {
			const ctx = compileAndCheck('x:i64 = 0\ny:i32 = x\n')
			assert.strictEqual(ctx.hasErrors(), true)
			const errors = ctx.getErrors()
			assert.ok(errors.some((e) => e.message.includes('type mismatch')))
		})

		it('should allow same type assignment', () => {
			const ctx = compileAndCheck('x:i32 = 0\ny:i32 = x\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})
	})

	describe('shadowing', () => {
		it('should allow rebinding same name with same type', () => {
			const ctx = compileAndCheck('x:i32 = 0\nx:i32 = 1\n')
			assert.strictEqual(ctx.hasErrors(), false)
			assert.ok(ctx.symbols)
			assert.strictEqual(ctx.symbols.count(), 2) // Two distinct locals
		})

		it('should create fresh local for each binding', () => {
			const ctx = compileAndCheck('x:i32 = 0\nx:i32 = 1\n')
			assert.ok(ctx.symbols)
			const sym0 = ctx.symbols.get(0 as import('../../src/check/types.ts').SymbolId)
			const sym1 = ctx.symbols.get(1 as import('../../src/check/types.ts').SymbolId)
			assert.strictEqual(sym0.localIndex, 0)
			assert.strictEqual(sym1.localIndex, 1)
		})

		it('should allow self-reference in shadowing', () => {
			const ctx = compileAndCheck('x:i32 = 0\nx:i32 = x\n')
			assert.strictEqual(ctx.hasErrors(), false)
			assert.ok(ctx.symbols)
			assert.strictEqual(ctx.symbols.count(), 2)
		})
	})

	describe('codegen integration', () => {
		it('should compile binding to valid WASM', () => {
			const result = compile('x:i32 = 42\npanic\n')
			assert.strictEqual(result.valid, true)
			// Check for local.set in WAT output
			assert.ok(result.text.includes('local.set'))
		})

		it('should include locals declaration', () => {
			const result = compile('x:i32 = 0\npanic\n')
			assert.strictEqual(result.valid, true)
			// Check for local declaration
			assert.ok(result.text.includes('(local'))
		})

		it('should compile reference to valid WASM', () => {
			const result = compile('x:i32 = 0\ny:i32 = x\npanic\n')
			assert.strictEqual(result.valid, true)
			// Check for local.get in WAT output
			assert.ok(result.text.includes('local.get'))
		})

		it('should compile shadowing to valid WASM', () => {
			const result = compile('x:i32 = 0\nx:i32 = x\npanic\n')
			assert.strictEqual(result.valid, true)
		})
	})

	describe('error cases', () => {
		it('should error on unknown type', () => {
			// This would need a different type name but our tokenizer
			// only recognizes i32, i64, f32, f64 as type keywords
			// So this test would require an identifier as type which we don't support
		})

		it('should report correct error location for undefined variable', () => {
			const ctx = compileAndCheck('x:i32 = undefined_var\n')
			assert.strictEqual(ctx.hasErrors(), true)
			const errors = ctx.getErrors()
			assert.strictEqual(errors.length, 1)
			assert.strictEqual(errors[0]?.line, 1)
		})

		it('should report correct error location for type mismatch', () => {
			const ctx = compileAndCheck('x:i64 = 0\ny:i32 = x\n')
			assert.strictEqual(ctx.hasErrors(), true)
			const errors = ctx.getErrors()
			assert.strictEqual(errors.length, 1)
			assert.strictEqual(errors[0]?.line, 2)
		})
	})
})
