import assert from 'node:assert'
import { describe, it } from 'node:test'
import { CompilationContext, DiagnosticSeverity } from '../../src/core/context.ts'
import type { DiagnosticCode } from '../../src/core/diagnostics.ts'
import { NodeKind } from '../../src/core/nodes.ts'
import { TokenKind } from '../../src/core/tokens.ts'

describe('core/context', () => {
	describe('DiagnosticSeverity', () => {
		it('should have correct values', () => {
			assert.strictEqual(DiagnosticSeverity.Error, 0)
			assert.strictEqual(DiagnosticSeverity.Warning, 1)
			assert.strictEqual(DiagnosticSeverity.Note, 2)
		})
	})

	describe('CompilationContext', () => {
		it('should store source and filename', () => {
			const ctx = new CompilationContext('panic', 'test.tw')
			assert.strictEqual(ctx.source, 'panic')
			assert.strictEqual(ctx.filename, 'test.tw')
		})

		it('should use default filename if not provided', () => {
			const ctx = new CompilationContext('panic')
			assert.strictEqual(ctx.filename, '<input>')
		})

		it('should initialize empty stores', () => {
			const ctx = new CompilationContext('panic')
			assert.strictEqual(ctx.tokens.count(), 0)
			assert.strictEqual(ctx.nodes.count(), 0)
		})

		it('should start with no errors', () => {
			const ctx = new CompilationContext('panic')
			assert.strictEqual(ctx.hasErrors(), false)
			assert.strictEqual(ctx.getErrorCount(), 0)
			assert.deepStrictEqual(ctx.getDiagnostics(), [])
		})

		describe('emit', () => {
			it('should add error diagnostic', () => {
				const ctx = new CompilationContext('panic')
				ctx.emit('TWLEX001' as DiagnosticCode, 1, 5)

				assert.strictEqual(ctx.hasErrors(), true)
				assert.strictEqual(ctx.getErrorCount(), 1)

				const diags = ctx.getDiagnostics()
				assert.strictEqual(diags.length, 1)
				assert.strictEqual(diags[0]!.def.severity, DiagnosticSeverity.Error)
				assert.strictEqual(diags[0]!.line, 1)
				assert.strictEqual(diags[0]!.column, 5)
			})

			it('should accumulate multiple errors', () => {
				const ctx = new CompilationContext('panic\npanic')
				ctx.emit('TWLEX001' as DiagnosticCode, 1, 1)
				ctx.emit('TWLEX001' as DiagnosticCode, 2, 1)

				assert.strictEqual(ctx.getErrorCount(), 2)
				assert.strictEqual(ctx.getDiagnostics().length, 2)
			})

			it('should add warning diagnostic', () => {
				const ctx = new CompilationContext('panic')
				ctx.emit('TWCHECK050' as DiagnosticCode, 1, 1)

				assert.strictEqual(ctx.hasErrors(), false)
				assert.strictEqual(ctx.getErrorCount(), 0)

				const diags = ctx.getDiagnostics()
				assert.strictEqual(diags.length, 1)
				assert.strictEqual(diags[0]!.def.severity, DiagnosticSeverity.Warning)
			})
		})

		describe('emitAtToken', () => {
			it('should add error at token location', () => {
				const ctx = new CompilationContext('  panic')
				const tokenId = ctx.tokens.add({
					column: 3,
					kind: TokenKind.Panic,
					line: 1,
					payload: 0,
				})

				ctx.emitAtToken('TWLEX001' as DiagnosticCode, tokenId)

				const diags = ctx.getDiagnostics()
				assert.strictEqual(diags.length, 1)
				assert.strictEqual(diags[0]!.line, 1)
				assert.strictEqual(diags[0]!.column, 3)
				assert.strictEqual(diags[0]!.tokenId, tokenId)
			})
		})

		describe('emitAtNode', () => {
			it('should add error at node location', () => {
				const ctx = new CompilationContext('panic')

				const tokenId = ctx.tokens.add({
					column: 1,
					kind: TokenKind.Panic,
					line: 1,
					payload: 0,
				})

				const nodeId = ctx.nodes.add({
					kind: NodeKind.PanicExpr,
					subtreeSize: 1,
					tokenId,
				})

				ctx.emitAtNode('TWCHECK001' as DiagnosticCode, nodeId)

				const diags = ctx.getDiagnostics()
				assert.strictEqual(diags.length, 1)
				assert.strictEqual(diags[0]!.line, 1)
				assert.strictEqual(diags[0]!.column, 1)
				assert.strictEqual(diags[0]!.nodeId, nodeId)
				assert.strictEqual(diags[0]!.tokenId, tokenId)
			})
		})

		describe('getErrors', () => {
			it('should return only errors', () => {
				const ctx = new CompilationContext('panic')
				ctx.emit('TWLEX001' as DiagnosticCode, 1, 1)
				ctx.emit('TWCHECK050' as DiagnosticCode, 1, 5)
				ctx.emit('TWLEX002' as DiagnosticCode, 2, 1)

				const errors = ctx.getErrors()
				assert.strictEqual(errors.length, 2)
				assert.strictEqual(errors[0]!.def.code, 'TWLEX001')
				assert.strictEqual(errors[1]!.def.code, 'TWLEX002')
			})
		})

		describe('getSourceLine', () => {
			it('should return correct line', () => {
				const ctx = new CompilationContext('line1\nline2\nline3')
				assert.strictEqual(ctx.getSourceLine(1), 'line1')
				assert.strictEqual(ctx.getSourceLine(2), 'line2')
				assert.strictEqual(ctx.getSourceLine(3), 'line3')
			})

			it('should return undefined for out of bounds', () => {
				const ctx = new CompilationContext('line1\nline2')
				assert.strictEqual(ctx.getSourceLine(0), undefined)
				assert.strictEqual(ctx.getSourceLine(3), undefined)
			})
		})

		describe('formatDiagnostic', () => {
			it('should format error with source context', () => {
				const ctx = new CompilationContext('panic')
				ctx.emit('TWLEX001' as DiagnosticCode, 1, 1)

				const formatted = ctx.formatDiagnostic(ctx.getDiagnostics()[0]!)

				assert.ok(formatted.includes('<input>:1:1'))
				assert.ok(formatted.includes('error'))
				assert.ok(formatted.includes('[TWLEX001]'))
				assert.ok(formatted.includes('panic'))
				assert.ok(formatted.includes('^'))
			})

			it('should format warning correctly', () => {
				const ctx = new CompilationContext('panic', 'test.tw')
				ctx.emit('TWCHECK050' as DiagnosticCode, 1, 3)

				const formatted = ctx.formatDiagnostic(ctx.getDiagnostics()[0]!)

				assert.ok(formatted.includes('test.tw:1:3'))
				assert.ok(formatted.includes('warning'))
				assert.ok(formatted.includes('[TWCHECK050]'))
			})

			it('should handle missing source line', () => {
				const ctx = new CompilationContext('')
				ctx.emit('TWLEX001' as DiagnosticCode, 5, 1)

				const formatted = ctx.formatDiagnostic(ctx.getDiagnostics()[0]!)

				assert.ok(formatted.includes('<input>:5:1'))
				assert.ok(formatted.includes('error'))
				assert.ok(!formatted.includes('^'))
			})
		})

		describe('formatAllDiagnostics', () => {
			it('should format multiple diagnostics', () => {
				const ctx = new CompilationContext('line1\nline2')
				ctx.emit('TWLEX001' as DiagnosticCode, 1, 1)
				ctx.emit('TWLEX002' as DiagnosticCode, 2, 1)

				const formatted = ctx.formatAllDiagnostics()

				assert.ok(formatted.includes('[TWLEX001]'))
				assert.ok(formatted.includes('[TWLEX002]'))
				assert.ok(formatted.includes('line1'))
				assert.ok(formatted.includes('line2'))
			})
		})
	})
})
