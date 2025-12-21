/**
 * Dense array stores for SemIR data structures.
 * Carbon-style data-oriented design.
 */

import { type Inst, type InstId, instId, type Scope, type ScopeId, scopeId } from './types.ts'

/**
 * Dense array storage for semantic instructions.
 * Append-only during the check phase.
 */
export class InstStore {
	private readonly insts: Inst[] = []

	add(inst: Inst): InstId {
		const id = this.insts.length as InstId
		this.insts.push(inst)
		return id
	}

	get(id: InstId): Inst {
		const inst = this.insts[id]
		if (inst === undefined) {
			throw new Error(`Invalid InstId: ${id}`)
		}
		return inst
	}

	count(): number {
		return this.insts.length
	}

	isValid(id: InstId): boolean {
		return id >= 0 && id < this.insts.length
	}

	*[Symbol.iterator](): Generator<[InstId, Inst]> {
		for (let i = 0; i < this.insts.length; i++) {
			const inst = this.insts[i]
			if (inst !== undefined) yield [instId(i), inst]
		}
	}
}

/**
 * Storage for scopes.
 * Currently minimal - only tracks main scope.
 * Future: will track function scopes, nested scopes, etc.
 */
export class ScopeStore {
	private readonly scopes: Scope[] = []

	add(scope: Scope): ScopeId {
		const id = this.scopes.length as ScopeId
		this.scopes.push(scope)
		return id
	}

	get(id: ScopeId): Scope {
		const scope = this.scopes[id]
		if (scope === undefined) {
			throw new Error(`Invalid ScopeId: ${id}`)
		}
		return scope
	}

	count(): number {
		return this.scopes.length
	}

	createMainScope(): ScopeId {
		return this.add({
			id: scopeId(0),
			parentId: null,
			reachable: true,
		})
	}

	*[Symbol.iterator](): Generator<[ScopeId, Scope]> {
		for (let i = 0; i < this.scopes.length; i++) {
			const scope = this.scopes[i]
			if (scope !== undefined) yield [scopeId(i), scope]
		}
	}
}
