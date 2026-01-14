import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CompilationContext } from '../src/core/context.ts'
import { NodeKind } from '../src/core/nodes.ts'
import { TokenKind } from '../src/core/tokens.ts'
import { tokenize } from '../src/lex/tokenizer.ts'
import { matchOnly, parse } from '../src/parse/parser.ts'

describe('record types tokenization', () => {
	it('tokenizes type keyword', () => {
		const ctx = new CompilationContext('type Point')
		tokenize(ctx)
		const tokens = [...ctx.tokens]
		const typeToken = tokens.find(([, t]) => t.kind === TokenKind.Type)
		assert.ok(typeToken, 'should have Type token')
	})
})

describe('record types node kinds', () => {
	it('has TypeDecl node kind', () => {
		assert.ok(NodeKind.TypeDecl !== undefined)
	})
	it('has FieldDecl node kind', () => {
		assert.ok(NodeKind.FieldDecl !== undefined)
	})
	it('has RecordLiteral node kind', () => {
		assert.ok(NodeKind.RecordLiteral !== undefined)
	})
	it('has FieldInit node kind', () => {
		assert.ok(NodeKind.FieldInit !== undefined)
	})
	it('has FieldAccess node kind', () => {
		assert.ok(NodeKind.FieldAccess !== undefined)
	})
})

describe('record types parsing', () => {
	it('parses type declaration', () => {
		const source = `type Point
    x: i32
    y: i32
panic`
		const ctx = new CompilationContext(source)
		tokenize(ctx)
		const result = matchOnly(ctx)
		assert.ok(result, 'should match type declaration')
	})
})

describe('record literal parsing', () => {
	it('parses record instantiation', () => {
		const source = `type Point
    x: i32
    y: i32
p: Point =
    x: 5
    y: 10
panic`
		const ctx = new CompilationContext(source)
		tokenize(ctx)
		const result = matchOnly(ctx)
		assert.ok(result, 'should match record instantiation')
	})
})

describe('field access parsing', () => {
	it('parses dot notation', () => {
		const source = `x:i32 = p.x
panic`
		const ctx = new CompilationContext(source)
		tokenize(ctx)
		const result = matchOnly(ctx)
		assert.ok(result, 'should match field access')
	})

	it('parses nested dot notation', () => {
		const source = `x:i32 = person.home.zip
panic`
		const ctx = new CompilationContext(source)
		tokenize(ctx)
		const result = matchOnly(ctx)
		assert.ok(result, 'should match nested field access')
	})
})

describe('parser semantic actions', () => {
	it('creates TypeDecl node', () => {
		// Use simple source without field declarations (FieldDecl semantic action comes in a later task)
		const source = `type Point
panic`
		const ctx = new CompilationContext(source)
		tokenize(ctx)
		parse(ctx)

		const nodes = [...ctx.nodes]
		const typeDecl = nodes.find(([, n]) => n.kind === NodeKind.TypeDecl)
		assert.ok(typeDecl, 'should create TypeDecl node')
	})

	it('creates FieldDecl nodes', () => {
		const source = `type Point
    x: i32
    y: i32
panic`
		const ctx = new CompilationContext(source)
		tokenize(ctx)
		parse(ctx)

		const nodes = [...ctx.nodes]
		const fieldDecls = nodes.filter(([, n]) => n.kind === NodeKind.FieldDecl)
		assert.equal(fieldDecls.length, 2, 'should create 2 FieldDecl nodes')
	})

	it('creates FieldInit nodes', () => {
		const source = `p: Point =
    x: 5
    y: 10
panic`
		const ctx = new CompilationContext(source)
		tokenize(ctx)
		parse(ctx)

		const nodes = [...ctx.nodes]
		const fieldInits = nodes.filter(([, n]) => n.kind === NodeKind.FieldInit)
		assert.equal(fieldInits.length, 2, 'should create 2 FieldInit nodes')
	})

	it('creates FieldAccess node', () => {
		const source = `x:i32 = p.x
panic`
		const ctx = new CompilationContext(source)
		tokenize(ctx)
		parse(ctx)

		const nodes = [...ctx.nodes]
		const fieldAccess = nodes.find(([, n]) => n.kind === NodeKind.FieldAccess)
		assert.ok(fieldAccess, 'should create FieldAccess node')
	})
})
