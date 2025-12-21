/**
 * Check phase: semantic analysis between Parse and Codegen.
 *
 * This module provides the public API for the Check phase,
 * which performs scope validation and reachability analysis.
 */

export { check } from './checker.ts'
export { InstStore, ScopeStore } from './stores.ts'
export {
	BuiltinTypeId,
	type CheckResult,
	type Inst,
	type InstId,
	InstKind,
	instId,
	type Scope,
	type ScopeId,
	scopeId,
	type TypeId,
	typeId,
} from './types.ts'
