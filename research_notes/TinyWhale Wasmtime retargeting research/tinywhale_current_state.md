# TinyWhale current state (repo analysis, 2026-11-14)

Source: direct inspection of the checkout at /home/user/tinywhale (shallow clone, HEAD a88033e, 2026-09-13). These are facts about the project being retargeted, not web research. Cite them as file paths.

## History
- Last language-feature commit touching `packages/compiler/src`: 2026-01-24 (#57). Later commits are dependency/CI maintenance (#73 on 2026-04-20, #89 on 2026-07-24, #99 on 2026-09-13). Source: `git log -- packages/compiler/src`.
- Dependencies pinned in package.json files: binaryen 131.0.0, ohm-js 17.5.0, typescript 7.0.2, @biomejs/biome 2.5.5, fast-check 4.9.0, @adonisjs/ace 14.1.0, Node 26.5.0, pnpm 11.16.0. npm latest on 2026-11-14 (`npm view`): binaryen 132.0.0, biome 2.6.7, fast-check 4.10.2, ace 14.1.1; typescript/ohm-js/@ohm-js/cli current.

## Structure
- pnpm monorepo, tasks via mise (`mise.toml`). Packages: compiler, cli-compiler, diagnostics, grammar-test, cli-grammar-test, lsp, cli-lsp.
- Pipeline (`docs/architecture.md`): Source -> tokenize -> TokenStore -> parse (Ohm grammar `packages/compiler/src/parse/tinywhale.ohm`, 235 lines) -> NodeStore -> check -> SemIR/InstStore -> emit -> Wasm. Carbon-style data-oriented design (dense arrays, branded integer IDs, postorder nodes).
- Compiler src + tests total about 20,900 lines; codegen is one file, `packages/compiler/src/codegen/index.ts` (1,125 lines).

## Language today (`docs/language.md`)
- Primitives i32, i64, f32, f64; type bounds (`i32<min=0, max=125>`), list size bounds (`i32[]<size=3>`).
- Records (nominal, nested), record instantiation, field access; type aliases; lists with index access.
- Functions: named bindings, function type aliases, forward declarations, direct calls, multi-line bodies. No higher-order functions, closures, tuples, or externs yet.
- Operators: arithmetic incl. euclidean modulo, comparison (chained), logical short-circuit, bitwise. `match` with literal and or-patterns. `panic`.
- No string type, no I/O, no imports, no modules. (`grep` for "string" in the Ohm grammar finds nothing.)
- Indentation-sensitive syntax.

## Codegen today (`packages/compiler/src/codegen/index.ts`)
- Uses binaryen.js only for numeric ops, locals, `if`, `select`, `unreachable`, `addFunction`, `addFunctionExport`, `setStart`, `validate`, `optimize`, `emitBinary`, `emitText`. No memory, no GC types, no tables, no imports, no data segments, no feature flags set.
- Records and lists are flattened into Wasm locals (comment at lines ~966-969: "Field access on flattened records is resolved to VarRef by the checker").
- Output: a bare core module whose top-level code is a `_start` function that is both exported and set as the Wasm start function (lines 1065-1067). Not a component.

## Tests and fixtures
- Tests run with `node --test`. They check `mod.validate()` (`result.valid`) and WAT text; no test instantiates or executes a module (no `WebAssembly.instantiate` anywhere in packages). So Node is not actually used as a runtime today, and no observable-behaviour tests exist.
- Fixtures: 31 `.tw` files under `examples/` (basics 4, control-flow 5, errors 8, functions 2, operators 5, records 4, types 3); table-driven `test/grammar-specs.test.ts` (632 lines) and `test/semantic-specs.test.ts` (391 lines; expectations 'valid' | 'check-error' | 'parse-error'); property-based tests with fast-check.

## Roadmap statements relevant to the research (`docs/2026-01-19-functions-roadmap.md`, updated 2026-07-24)
- Next milestone was non-capturing first-class functions via a function table and `call_indirect`.
- "Extern bindings: add host imports" is listed as Later.
- "Runtime values: choose a shared representation for aggregates and closure environments" is marked "Design required". The decision "must cover records, lists, tuples, closure environments, and the host ABI together". Candidates named: linear-memory values with explicit layouts and handles; WebAssembly GC reference types; a constrained local and multi-value representation.

## The author's restart plan (the question the report must inform)
1. Adopt Wasmtime as the runtime target (Node dropped as runtime only; compiler toolchain stays on Node/TypeScript).
2. Modernize dependencies including Binaryen.
3. Adopt WASI 0.3 and use its native features (async, stream, future).
4. Deep research: Wasmtime capabilities (author believes GC on by default since Wasmtime 47; WASI 0.3 support).
5. Revisit mixing WasmGC + linear memory, strings via GC arrays.
6. Rebuild: keep and extend fixtures, new parser/compiler from scratch.
