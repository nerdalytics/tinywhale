import assert from 'node:assert'
import { describe, it } from 'node:test'
import { CompileError } from '@tinywhale/compiler'
import {
	formatCompileError,
	formatReadError,
	getErrorMessage,
	getOutputContent,
	isNodeError,
	isValidTarget,
	resolveOutputFilename,
	resolveOutputPath,
} from '../src/utils.ts'

describe('isNodeError', () => {
	it('should return true for Error with code property', () => {
		const error = new Error('test') as NodeJS.ErrnoException
		error.code = 'ENOENT'
		assert.strictEqual(isNodeError(error), true)
	})

	it('should return false for plain Error', () => {
		const error = new Error('test')
		assert.strictEqual(isNodeError(error), false)
	})

	it('should return false for non-Error', () => {
		assert.strictEqual(isNodeError('string'), false)
		assert.strictEqual(isNodeError(null), false)
		assert.strictEqual(isNodeError(undefined), false)
		assert.strictEqual(isNodeError(42), false)
	})
})

describe('getErrorMessage', () => {
	it('should extract message from Error', () => {
		const error = new Error('test message')
		assert.strictEqual(getErrorMessage(error), 'test message')
	})

	it('should convert non-Error to string', () => {
		assert.strictEqual(getErrorMessage('string error'), 'string error')
		assert.strictEqual(getErrorMessage(42), '42')
		assert.strictEqual(getErrorMessage(null), 'null')
	})
})

describe('formatReadError', () => {
	it('should format ENOENT as "File not found"', () => {
		const error = new Error('no such file') as NodeJS.ErrnoException
		error.code = 'ENOENT'
		const result = formatReadError('/path/to/file.tw', error)
		assert.strictEqual(result, 'File not found: /path/to/file.tw')
	})

	it('should format other errors with generic message', () => {
		const error = new Error('permission denied') as NodeJS.ErrnoException
		error.code = 'EACCES'
		const result = formatReadError('/path/to/file.tw', error)
		assert.strictEqual(result, 'Cannot read file: permission denied')
	})

	it('should handle plain Error', () => {
		const error = new Error('unknown error')
		const result = formatReadError('/path/to/file.tw', error)
		assert.strictEqual(result, 'Cannot read file: unknown error')
	})
})

describe('formatCompileError', () => {
	it('should return CompileError message directly', () => {
		const error = new CompileError('Empty program')
		const result = formatCompileError(error)
		assert.strictEqual(result, 'Empty program')
	})

	it('should wrap other errors with "Compilation failed"', () => {
		const error = new Error('something went wrong')
		const result = formatCompileError(error)
		assert.strictEqual(result, 'Compilation failed: something went wrong')
	})

	it('should handle non-Error values', () => {
		const result = formatCompileError('string error')
		assert.strictEqual(result, 'Compilation failed: string error')
	})
})

describe('isValidTarget', () => {
	it('should return true for "wasm"', () => {
		assert.strictEqual(isValidTarget('wasm'), true)
	})

	it('should return true for "wat"', () => {
		assert.strictEqual(isValidTarget('wat'), true)
	})

	it('should return false for other strings', () => {
		assert.strictEqual(isValidTarget('txt'), false)
		assert.strictEqual(isValidTarget('bin'), false)
		assert.strictEqual(isValidTarget(''), false)
		assert.strictEqual(isValidTarget('WASM'), false)
	})
})

describe('resolveOutputFilename', () => {
	it('should derive filename from input basename', () => {
		assert.strictEqual(resolveOutputFilename('main.tw', 'wasm'), 'main.wasm')
	})

	it('should strip .tw extension', () => {
		assert.strictEqual(resolveOutputFilename('program.tw', 'wat'), 'program.wat')
	})

	it('should add .wasm for wasm target', () => {
		assert.strictEqual(resolveOutputFilename('test.tw', 'wasm'), 'test.wasm')
	})

	it('should add .wat for wat target', () => {
		assert.strictEqual(resolveOutputFilename('test.tw', 'wat'), 'test.wat')
	})

	it('should handle paths with directories', () => {
		assert.strictEqual(resolveOutputFilename('src/lib/main.tw', 'wasm'), 'main.wasm')
		assert.strictEqual(resolveOutputFilename('/absolute/path/file.tw', 'wat'), 'file.wat')
	})
})

describe('resolveOutputPath', () => {
	it('should use current directory when output is undefined', () => {
		assert.strictEqual(resolveOutputPath('main.tw', undefined, 'wasm'), 'main.wasm')
	})

	it('should join output directory with filename', () => {
		assert.strictEqual(resolveOutputPath('main.tw', 'dist', 'wasm'), 'dist/main.wasm')
	})

	it('should handle nested output directories', () => {
		assert.strictEqual(resolveOutputPath('main.tw', 'build/output', 'wat'), 'build/output/main.wat')
	})

	it('should extract basename from input path', () => {
		assert.strictEqual(resolveOutputPath('src/main.tw', 'dist', 'wasm'), 'dist/main.wasm')
	})
})

describe('getOutputContent', () => {
	const mockResult = {
		binary: new Uint8Array([0, 1, 2, 3]),
		text: '(module)',
		valid: true,
	}

	it('should return binary for wasm target', () => {
		const result = getOutputContent(mockResult, 'wasm')
		assert.strictEqual(result, mockResult.binary)
	})

	it('should return text for wat target', () => {
		const result = getOutputContent(mockResult, 'wat')
		assert.strictEqual(result, mockResult.text)
	})
})
