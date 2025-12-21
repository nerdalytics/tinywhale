import assert from 'node:assert'
import { describe, it } from 'node:test'
import { CompilationContext, DiagnosticSeverity } from '../../src/core/context.ts'
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

		describe('addError', () => {
			it('should add error diagnostic', () => {
				const ctx = new CompilationContext('panic')
				ctx.addError(1, 5, 'unexpected token')

				assert.strictEqual(ctx.hasErrors(), true)
				assert.strictEqual(ctx.getErrorCount(), 1)

				const diags = ctx.getDiagnostics()
				assert.strictEqual(diags.length, 1)
				assert.strictEqual(diags[0]!.def.severity, DiagnosticSeverity.Error)
				assert.strictEqual(diags[0]!.message, 'unexpected token')
				assert.strictEqual(diags[0]!.line, 1)
				assert.strictEqual(diags[0]!.column, 5)
			})

			it('should accumulate multiple errors', () => {
				const ctx = new CompilationContext('panic\npanic')
				ctx.addError(1, 1, 'first error')
				ctx.addError(2, 1, 'second error')

				assert.strictEqual(ctx.getErrorCount(), 2)
				assert.strictEqual(ctx.getDiagnostics().length, 2)
			})
		})

		describe('addWarning', () => {
			it('should add warning diagnostic', () => {
				const ctx = new CompilationContext('panic')
				ctx.addWarning(1, 1, 'unused variable')

				assert.strictEqual(ctx.hasErrors(), false)
				assert.strictEqual(ctx.getErrorCount(), 0)

				const diags = ctx.getDiagnostics()
				assert.strictEqual(diags.length, 1)
				assert.strictEqual(diags[0]!.def.severity, DiagnosticSeverity.Warning)
			})
		})

		describe('errorAtToken', () => {
			it('should add error at token location', () => {
				const ctx = new CompilationContext('  panic')
				const tokenId = ctx.tokens.add({
					column: 3,
					kind: TokenKind.Panic,
					line: 1,
					payload: 0,
				})

				ctx.errorAtToken(tokenId, 'invalid statement')

				const diags = ctx.getDiagnostics()
				assert.strictEqual(diags.length, 1)
				assert.strictEqual(diags[0]!.line, 1)
				assert.strictEqual(diags[0]!.column, 3)
				assert.strictEqual(diags[0]!.tokenId, tokenId)
			})
		})

		describe('errorAtNode', () => {
			it('should add error at node location', () => {
				const ctx = new CompilationContext('panic')

				const tokenId = ctx.tokens.add({
					column: 1,
					kind: TokenKind.Panic,
					line: 1,
					payload: 0,
				})

				const nodeId = ctx.nodes.add({
					kind: NodeKind.PanicStatement,
					subtreeSize: 1,
					tokenId,
				})

				ctx.errorAtNode(nodeId, 'semantic error')

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
				ctx.addError(1, 1, 'error 1')
				ctx.addWarning(1, 5, 'warning 1')
				ctx.addError(2, 1, 'error 2')

				const errors = ctx.getErrors()
				assert.strictEqual(errors.length, 2)
				assert.strictEqual(errors[0]!.message, 'error 1')
				assert.strictEqual(errors[1]!.message, 'error 2')
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
				ctx.addError(1, 1, 'unexpected keyword')

				const formatted = ctx.formatDiagnostic(ctx.getDiagnostics()[0]!)

				assert.ok(formatted.includes('<input>:1:1'))
				assert.ok(formatted.includes('error'))
				assert.ok(formatted.includes('unexpected keyword'))
				assert.ok(formatted.includes('panic'))
				assert.ok(formatted.includes('^'))
			})

			it('should format warning correctly', () => {
				const ctx = new CompilationContext('panic', 'test.tw')
				ctx.addWarning(1, 3, 'unused')

				const formatted = ctx.formatDiagnostic(ctx.getDiagnostics()[0]!)

				assert.ok(formatted.includes('test.tw:1:3'))
				assert.ok(formatted.includes('warning'))
				assert.ok(formatted.includes('unused'))
			})

			it('should handle missing source line', () => {
				const ctx = new CompilationContext('')
				ctx.addError(5, 1, 'error')

				const formatted = ctx.formatDiagnostic(ctx.getDiagnostics()[0]!)

				assert.ok(formatted.includes('<input>:5:1'))
				assert.ok(formatted.includes('error'))
				assert.ok(!formatted.includes('^'))
			})
		})

		describe('formatAllDiagnostics', () => {
			it('should format multiple diagnostics', () => {
				const ctx = new CompilationContext('line1\nline2')
				ctx.addError(1, 1, 'first error')
				ctx.addError(2, 1, 'second error')

				const formatted = ctx.formatAllDiagnostics()

				assert.ok(formatted.includes('first error'))
				assert.ok(formatted.includes('second error'))
				assert.ok(formatted.includes('line1'))
				assert.ok(formatted.includes('line2'))
			})
		})
	})
})
