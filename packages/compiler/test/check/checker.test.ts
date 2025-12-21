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

function getWarnings(ctx: CompilationContext) {
	return ctx.getDiagnostics().filter((d) => d.def.severity === DiagnosticSeverity.Warning)
}

function getErrors(ctx: CompilationContext) {
	return ctx.getDiagnostics().filter((d) => d.def.severity === DiagnosticSeverity.Error)
}

describe('check/checker', () => {
	describe('scope validation', () => {
		it('should error on indented code without scope', () => {
			const ctx = prepareContext('panic\n\tpanic\n')
			const result = check(ctx)

			assert.strictEqual(result.succeeded, false)
			const errors = getErrors(ctx)
			// Errors for: IndentedLine (line 2) and DedentLine (from EOF dedent)
			assert.strictEqual(errors.length, 2)
			assert.ok(errors[0]?.message.includes('unexpected indentation'))
		})

		it('should error on dedented code without scope', () => {
			// This creates indent then dedent without a scope-creating construct
			const ctx = prepareContext('panic\n\tpanic\npanic\n')
			const result = check(ctx)

			assert.strictEqual(result.succeeded, false)
			const errors = getErrors(ctx)
			// IndentedLine and DedentLine both produce errors
			assert.ok(errors.length >= 2)
		})

		it('should accept root-level statements', () => {
			const ctx = prepareContext('panic\n')
			const result = check(ctx)

			assert.strictEqual(result.succeeded, true)
			const errors = getErrors(ctx)
			assert.strictEqual(errors.length, 0)
		})
	})

	describe('reachability analysis', () => {
		it('should not warn for single panic', () => {
			const ctx = prepareContext('panic\n')
			const result = check(ctx)

			assert.strictEqual(result.succeeded, true)
			const warnings = getWarnings(ctx)
			assert.strictEqual(warnings.length, 0)
		})

		it('should warn for code after panic', () => {
			const ctx = prepareContext('panic\npanic\n')
			const result = check(ctx)

			assert.strictEqual(result.succeeded, true)
			const warnings = getWarnings(ctx)
			assert.strictEqual(warnings.length, 1)
			assert.ok(warnings[0]?.message.includes('unreachable'))
		})

		it('should warn for all code after panic', () => {
			const ctx = prepareContext('panic\npanic\npanic\n')
			const result = check(ctx)

			assert.strictEqual(result.succeeded, true)
			const warnings = getWarnings(ctx)
			assert.strictEqual(warnings.length, 2)
		})

		it('should report correct line for unreachable code', () => {
			const ctx = prepareContext('panic\npanic\n')
			check(ctx)

			const warnings = getWarnings(ctx)
			assert.strictEqual(warnings[0]?.line, 2)
		})

		it('should report correct line for multiple unreachable', () => {
			const ctx = prepareContext('panic\npanic\npanic\n')
			check(ctx)

			const warnings = getWarnings(ctx)
			assert.strictEqual(warnings[0]?.line, 2)
			assert.strictEqual(warnings[1]?.line, 3)
		})
	})

	describe('instruction emission', () => {
		it('should emit Unreachable instruction for panic', () => {
			const ctx = prepareContext('panic\n')
			check(ctx)

			assert.ok(ctx.insts !== null)
			assert.strictEqual(ctx.insts.count(), 1)

			const inst = ctx.insts.get(instId(0))
			assert.strictEqual(inst.kind, InstKind.Unreachable)
		})

		it('should emit instructions for all statements', () => {
			const ctx = prepareContext('panic\npanic\n')
			check(ctx)

			assert.ok(ctx.insts !== null)
			assert.strictEqual(ctx.insts.count(), 2)
		})

		it('should link instructions to parse nodes', () => {
			const ctx = prepareContext('panic\n')
			check(ctx)

			assert.ok(ctx.insts !== null)
			const inst = ctx.insts.get(instId(0))
			// parseNodeId should reference a valid node
			assert.ok(ctx.nodes.isValid(inst.parseNodeId))
		})
	})

	describe('empty and comment-only programs', () => {
		it('should handle empty program', () => {
			const ctx = prepareContext('\n')
			const result = check(ctx)

			assert.strictEqual(result.succeeded, true)
			const warnings = getWarnings(ctx)
			assert.strictEqual(warnings.length, 0)
		})

		it('should handle comment-only program', () => {
			const ctx = prepareContext('# comment\n')
			const result = check(ctx)

			assert.strictEqual(result.succeeded, true)
			const warnings = getWarnings(ctx)
			assert.strictEqual(warnings.length, 0)
		})
	})
})
