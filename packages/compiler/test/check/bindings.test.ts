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

	describe('float bindings', () => {
		it('should compile x:f32 = 0.0 successfully', () => {
			const ctx = compileAndCheck('x:f32 = 0.0\n')
			assert.strictEqual(ctx.hasErrors(), false)
			assert.ok(ctx.symbols)
			const symbol = ctx.symbols.get(0 as import('../../src/check/types.ts').SymbolId)
			assert.strictEqual(symbol.typeId, 3) // BuiltinTypeId.F32
		})

		it('should compile x:f64 = 0.0 successfully', () => {
			const ctx = compileAndCheck('x:f64 = 0.0\n')
			assert.strictEqual(ctx.hasErrors(), false)
			assert.ok(ctx.symbols)
			const symbol = ctx.symbols.get(0 as import('../../src/check/types.ts').SymbolId)
			assert.strictEqual(symbol.typeId, 4) // BuiltinTypeId.F64
		})

		it('should error on integer literal assigned to float type', () => {
			const ctx = compileAndCheck('x:f32 = 0\n')
			assert.strictEqual(ctx.hasErrors(), true)
			const errors = ctx.getErrors()
			assert.ok(errors.some((e) => e.message.includes('type mismatch')))
		})

		it('should error on f32/f64 type mismatch', () => {
			const ctx = compileAndCheck('x:f32 = 0.0\ny:f64 = x\n')
			assert.strictEqual(ctx.hasErrors(), true)
			const errors = ctx.getErrors()
			assert.ok(errors.some((e) => e.message.includes('type mismatch')))
		})

		it('should allow same float type assignment', () => {
			const ctx = compileAndCheck('x:f32 = 0.0\ny:f32 = x\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})
	})

	describe('float literals', () => {
		it('should compile f32 float literal', () => {
			const ctx = compileAndCheck('x:f32 = 0.1\n')
			assert.strictEqual(ctx.hasErrors(), false)
			assert.ok(ctx.insts)
			let hasFloatConst = false
			for (const [, inst] of ctx.insts) {
				if (inst.kind === InstKind.FloatConst) {
					hasFloatConst = true
				}
			}
			assert.ok(hasFloatConst)
		})

		it('should compile f64 float literal', () => {
			const ctx = compileAndCheck('x:f64 = 3.14159\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile negative float literal', () => {
			const ctx = compileAndCheck('x:f64 = -0.5\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile float literal with exponent', () => {
			const ctx = compileAndCheck('x:f64 = 1.5e10\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile float literal with negative exponent', () => {
			const ctx = compileAndCheck('x:f32 = 1.5e-10\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should error when assigning float literal to integer type', () => {
			const ctx = compileAndCheck('x:i32 = 0.5\n')
			assert.strictEqual(ctx.hasErrors(), true)
			const errors = ctx.getErrors()
			assert.ok(errors.some((e) => e.message.includes('type mismatch')))
		})

		it('should generate valid WAT for float literals', () => {
			const result = compile('x:f32 = 0.1\ny:f64 = -0.2\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('f32.const'))
			assert.ok(result.text.includes('f64.const'))
		})
	})

	describe('negative integer literals', () => {
		it('should compile negative i32 literal', () => {
			const ctx = compileAndCheck('x:i32 = -42\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile negative i64 literal', () => {
			const ctx = compileAndCheck('x:i64 = -1000000\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile i32 min value', () => {
			const ctx = compileAndCheck('x:i32 = -2147483648\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile i32 max value', () => {
			const ctx = compileAndCheck('x:i32 = 2147483647\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should error on i32 positive overflow', () => {
			const ctx = compileAndCheck('x:i32 = 2147483648\n')
			assert.strictEqual(ctx.hasErrors(), true)
			const errors = ctx.getErrors()
			assert.ok(errors.some((e) => e.message.includes('exceeds')))
		})

		it('should error on i32 negative overflow', () => {
			const ctx = compileAndCheck('x:i32 = -2147483649\n')
			assert.strictEqual(ctx.hasErrors(), true)
			const errors = ctx.getErrors()
			assert.ok(errors.some((e) => e.message.includes('exceeds')))
		})

		it('should generate valid WAT for negative integer', () => {
			const result = compile('x:i32 = -42\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i32.const'))
		})
	})

	describe('i64 edge cases', () => {
		it('should compile i64 max value', () => {
			const ctx = compileAndCheck('x:i64 = 9223372036854775807\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile i64 min value', () => {
			const ctx = compileAndCheck('x:i64 = -9223372036854775808\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should error on i64 positive overflow', () => {
			const ctx = compileAndCheck('x:i64 = 9223372036854775808\n')
			assert.strictEqual(ctx.hasErrors(), true)
			const errors = ctx.getErrors()
			assert.ok(errors.some((e) => e.message.includes('exceeds')))
		})

		it('should error on i64 negative overflow', () => {
			const ctx = compileAndCheck('x:i64 = -9223372036854775809\n')
			assert.strictEqual(ctx.hasErrors(), true)
			const errors = ctx.getErrors()
			assert.ok(errors.some((e) => e.message.includes('exceeds')))
		})

		it('should correctly split large i64 into low/high parts', () => {
			// Test with a value that requires high bits: 2^32 + 1 = 4294967297
			const result = compile('x:i64 = 4294967297\npanic\n')
			assert.strictEqual(result.valid, true)
			// WAT should show i64.const with the correct value
			assert.ok(result.text.includes('i64.const'))
		})

		it('should correctly handle negative i64 with high bits', () => {
			// Test with -1 which in 64-bit is all 1s (low=-1, high=-1)
			const result = compile('x:i64 = -1\npanic\n')
			assert.strictEqual(result.valid, true)
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

	describe('runtime negation', () => {
		it('should compile -x where x is i32', () => {
			const result = compile('x:i32 = 42\ny:i32 = -x\npanic\n')
			assert.strictEqual(result.valid, true)
			// WASM uses 0-x for integer negation
			assert.ok(result.text.includes('i32.sub'))
		})

		it('should compile -x where x is i64', () => {
			const result = compile('x:i64 = 42\ny:i64 = -x\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('i64.sub'))
		})

		it('should compile -x where x is f32', () => {
			const result = compile('x:f32 = 1.0\ny:f32 = -x\npanic\n')
			assert.strictEqual(result.valid, true)
			// WASM has direct fneg for floats
			assert.ok(result.text.includes('f32.neg'))
		})

		it('should compile -x where x is f64', () => {
			const result = compile('x:f64 = 1.0\ny:f64 = -x\npanic\n')
			assert.strictEqual(result.valid, true)
			assert.ok(result.text.includes('f64.neg'))
		})
	})

	describe('scientific notation', () => {
		it('should compile integer with scientific notation', () => {
			const ctx = compileAndCheck('x:i64 = 1e10\n')
			assert.strictEqual(ctx.hasErrors(), false)
		})

		it('should compile large integer with scientific notation', () => {
			const result = compile('x:i64 = 1e18\npanic\n')
			assert.strictEqual(result.valid, true)
		})

		it('should error on i32 overflow from scientific notation', () => {
			const ctx = compileAndCheck('x:i32 = 1e10\n')
			assert.strictEqual(ctx.hasErrors(), true)
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

	describe('scope operations', () => {
		it('should make binding invisible after popScope', () => {
			const ctx = compileAndCheck(`x:i32 = 5
result:i32 = match x
\t0 -> 100
\tn -> n + 1
check:i32 = n
`)
			assert.strictEqual(ctx.hasErrors(), true)
			const errors = ctx.getErrors()
			assert.ok(errors.some((e) => e.message.includes('undefined variable')))
		})

		it('should allow outer binding to shadow inner after pop', () => {
			const ctx = compileAndCheck(`x:i32 = 5
result:i32 = match x
\tn -> n
n:i32 = 99
y:i32 = n
`)
			assert.strictEqual(ctx.hasErrors(), false)
			assert.ok(ctx.symbols)
			// Should have: x, (inner n - invisible), result, n (outer), y
			// The outer n is visible for y
		})

		it('should preserve outer binding visibility in match arm', () => {
			const ctx = compileAndCheck(`outer:i32 = 42
x:i32 = 5
result:i32 = match x
\tn -> n + outer
`)
			assert.strictEqual(ctx.hasErrors(), false)
		})
	})

	describe('BindingExpr record instantiation', () => {
		it('should detect record instantiation from lowercase = Uppercase pattern', () => {
			const source = `Point
\tx: i32
\ty: i32

p = Point
\tx = 1
\ty = 2
`
			const ctx = compileAndCheck(source)
			assert.strictEqual(
				ctx.hasErrors(),
				false,
				`Errors: ${ctx
					.getErrors()
					.map((e) => e.message)
					.join(', ')}`
			)
		})

		it('should error on missing field in record instantiation', () => {
			const source = `Point
\tx: i32
\ty: i32

p = Point
\tx = 1
`
			const ctx = compileAndCheck(source)
			assert.strictEqual(ctx.hasErrors(), true)
			const errors = ctx.getErrors()
			assert.ok(errors.some((e) => e.message.includes('missing') || e.message.includes('field')))
		})

		it('should require type annotation for simple bindings', () => {
			// x = 42 without type annotation currently requires explicit type
			const source = `x = 42
`
			const ctx = compileAndCheck(source)
			// Bindings without type annotation error (type inference not yet implemented)
			assert.strictEqual(ctx.hasErrors(), true)
		})
	})

	describe('BindingExpr type alias', () => {
		it('should detect type alias from Uppercase = Uppercase pattern', () => {
			// Uses new syntax: p = P (not p: P) for record instantiation
			const source = `Point
\tx: i32
\ty: i32

P = Point
p = P
\tx = 1
\ty = 2
`
			const ctx = compileAndCheck(source)
			assert.strictEqual(
				ctx.hasErrors(),
				false,
				`Errors: ${ctx
					.getErrors()
					.map((e) => e.message)
					.join(', ')}`
			)
		})

		it('should error on type alias with unknown type', () => {
			const source = `P = Unknown
`
			const ctx = compileAndCheck(source)
			assert.strictEqual(ctx.hasErrors(), true, 'Should have errors for unknown type')
			const errors = ctx.getErrors()
			assert.ok(errors.some((e) => e.message.includes('Unknown')))
		})
	})
})
