import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check } from '../src/check/checker.ts'
import { TypeStore } from '../src/check/stores.ts'
import { BuiltinTypeId } from '../src/check/types.ts'
import { CompilationContext } from '../src/core/context.ts'
import { NodeKind } from '../src/core/nodes.ts'
import { TokenKind } from '../src/core/tokens.ts'
import { tokenize } from '../src/lex/tokenizer.ts'
import { matchOnly, parse } from '../src/parse/parser.ts'

describe('TypeStore record types', () => {
	it('registers record type with fields', () => {
		const types = new TypeStore()
		const fields = [
			{ index: 0, name: 'x', typeId: BuiltinTypeId.I32 },
			{ index: 1, name: 'y', typeId: BuiltinTypeId.I32 },
		]
		const pointId = types.registerRecordType('Point', fields, null)

		assert.ok(types.isRecordType(pointId))
		assert.equal(types.getFields(pointId).length, 2)
	})

	it('looks up field by name', () => {
		const types = new TypeStore()
		const fields = [{ index: 0, name: 'x', typeId: BuiltinTypeId.I32 }]
		const pointId = types.registerRecordType('Point', fields, null)

		const field = types.getField(pointId, 'x')
		assert.ok(field)
		assert.equal(field.typeId, BuiltinTypeId.I32)
	})

	it('returns undefined for non-existent field', () => {
		const types = new TypeStore()
		const fields = [{ index: 0, name: 'x', typeId: BuiltinTypeId.I32 }]
		const pointId = types.registerRecordType('Point', fields, null)

		const field = types.getField(pointId, 'nonexistent')
		assert.equal(field, undefined)
	})

	it('returns false for isRecordType on non-record types', () => {
		const types = new TypeStore()
		assert.equal(types.isRecordType(BuiltinTypeId.I32), false)
	})

	it('returns empty array for getFields on non-record types', () => {
		const types = new TypeStore()
		assert.deepEqual(types.getFields(BuiltinTypeId.I32), [])
	})

	it('can look up record type by name', () => {
		const types = new TypeStore()
		const fields = [{ index: 0, name: 'x', typeId: BuiltinTypeId.I32 }]
		types.registerRecordType('Point', fields, null)

		const lookedUp = types.lookup('Point')
		assert.ok(lookedUp !== undefined)
		assert.ok(types.isRecordType(lookedUp))
	})
})

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

describe('checker type declarations', () => {
	it('registers type in TypeStore', () => {
		const source = `type Point
    x: i32
    y: i32
panic`
		const ctx = new CompilationContext(source)
		tokenize(ctx)
		parse(ctx)
		check(ctx)

		const pointId = ctx.types?.lookup('Point')
		assert.ok(pointId !== undefined, 'Point type should be registered')
		assert.ok(ctx.types?.isRecordType(pointId))
	})

	it('reports error for duplicate field names', () => {
		const source = `type Point
    x: i32
    x: i32
panic`
		const ctx = new CompilationContext(source)
		tokenize(ctx)
		parse(ctx)
		check(ctx)

		assert.ok(ctx.hasErrors(), 'should report duplicate field error')
	})

	it('registers fields with correct types', () => {
		const source = `type Point
    x: i32
    y: i64
panic`
		const ctx = new CompilationContext(source)
		tokenize(ctx)
		parse(ctx)
		check(ctx)

		const pointId = ctx.types?.lookup('Point')
		assert.ok(pointId !== undefined)
		const fields = ctx.types?.getFields(pointId)
		assert.equal(fields?.length, 2)
		assert.equal(fields?.[0]?.name, 'x')
		assert.equal(fields?.[0]?.typeId, BuiltinTypeId.I32)
		assert.equal(fields?.[1]?.name, 'y')
		assert.equal(fields?.[1]?.typeId, BuiltinTypeId.I64)
	})

	it('handles type with no fields', () => {
		const source = `type Empty
panic`
		const ctx = new CompilationContext(source)
		tokenize(ctx)
		parse(ctx)
		check(ctx)

		const emptyId = ctx.types?.lookup('Empty')
		assert.ok(emptyId !== undefined, 'Empty type should be registered')
		assert.ok(ctx.types?.isRecordType(emptyId))
		assert.equal(ctx.types?.getFields(emptyId).length, 0)
	})
})

function createContext(source: string): CompilationContext {
	return new CompilationContext(source)
}

describe('checker record instantiation', () => {
	it('validates all fields provided', () => {
		const source = `type Point
    x: i32
    y: i32
p: Point =
    x: 5
    y: 10
panic`
		const ctx = createContext(source)
		tokenize(ctx)
		parse(ctx)
		const result = check(ctx)

		assert.ok(result.succeeded, 'should succeed with all fields')
	})

	it('reports error for missing field', () => {
		const source = `type Point
    x: i32
    y: i32
p: Point =
    x: 5
panic`
		const ctx = createContext(source)
		tokenize(ctx)
		parse(ctx)
		check(ctx)

		assert.ok(ctx.hasErrors(), 'should report missing field error')
	})

	it('reports error for unknown field', () => {
		const source = `type Point
    x: i32
    y: i32
p: Point =
    x: 5
    y: 10
    z: 15
panic`
		const ctx = createContext(source)
		tokenize(ctx)
		parse(ctx)
		check(ctx)

		assert.ok(ctx.hasErrors(), 'should report unknown field error')
	})

	it('reports error for duplicate field in initializer', () => {
		const source = `type Point
    x: i32
    y: i32
p: Point =
    x: 5
    x: 10
panic`
		const ctx = createContext(source)
		tokenize(ctx)
		parse(ctx)
		check(ctx)

		assert.ok(ctx.hasErrors(), 'should report duplicate field error')
	})

	it('allows record instantiation without type declaration (error expected)', () => {
		const source = `p: UnknownType =
    x: 5
panic`
		const ctx = createContext(source)
		tokenize(ctx)
		parse(ctx)
		check(ctx)

		assert.ok(ctx.hasErrors(), 'should report unknown type error')
	})
})
