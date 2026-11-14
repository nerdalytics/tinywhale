# Compiler toolchain and testing for a TypeScript-hosted compiler emitting WasmGC + WASI 0.3 components run in Wasmtime (state on 2026-11-14)

Method note. Everything below was checked on 2026-11-14 against primary sources: the npm registry JSON, git tags (`git ls-remote`, tag creation dates), and files read from the upstream repositories at named tags or branches. "Verified in source" means I read or grepped the file at the cited URL. GitHub's web UI and REST API were not reachable from the research environment, so **issue trackers and GitHub Release pages were not consulted**; anything that would need them is listed under Gaps. Nothing was executed: no Wasmtime, wasm-tools or jco binary was run, so behaviours are as documented or as written in source, not as observed.

Version snapshot (all dated 2026-11-14):

| Tool | Latest version | Date | Source |
|---|---|---|---|
| binaryen (npm) | 132.0.0 (`latest`); `nightly` tag = 132.0.0-nightly.20260918 | 2026-08-13; 2026-09-18 | [npm registry](https://registry.npmjs.org/binaryen) |
| Binaryen (GitHub tag) | version_133 | 2026-09-21 | [tags](https://github.com/WebAssembly/binaryen/tags) |
| Wasmtime | 50.0.1 (50.0.0 on 2026-10-20); v51.0.0-rc.1 tagged, 51.0.0 "Unreleased" | 2026-10-29 | [release-50 notes](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/RELEASES.md), [release-51 notes](https://github.com/bytecodealliance/wasmtime/blob/release-51.0.0/RELEASES.md) |
| wasm-tools CLI | 1.263.0 (crates 0.263.0) | 2026-10-30 | [Cargo.toml](https://github.com/bytecodealliance/wasm-tools/blob/main/Cargo.toml), [tags](https://github.com/bytecodealliance/wasm-tools/tags) |
| wit-bindgen | 0.63.0 | 2026-10-14 | [Cargo.toml](https://github.com/bytecodealliance/wit-bindgen/blob/main/Cargo.toml) |
| wkg (wasm-pkg-tools) | 0.16.2 | 2026-11-13 | [Cargo.toml](https://github.com/bytecodealliance/wasm-pkg-tools/blob/main/Cargo.toml) |
| WASI | v0.3.2 (v0.3.0 on 2026-06-11, v0.3.1 on 2026-08-11) | 2026-10-13 | [tags](https://github.com/WebAssembly/WASI/tags) |
| @bytecodealliance/jco | 1.42.0 | 2026-11-13 | [npm registry](https://registry.npmjs.org/@bytecodealliance/jco) |
| @bytecodealliance/jco-transpile | 0.24.0 | 2026-11-13 | [npm registry](https://registry.npmjs.org/@bytecodealliance/jco-transpile) |
| @bytecodealliance/preview3-shim | 0.14.1 | 2026-11-13 | [npm registry](https://registry.npmjs.org/@bytecodealliance/preview3-shim) |
| @bytecodealliance/preview2-shim | 0.31.1 | 2026-11-12 | [npm registry](https://registry.npmjs.org/@bytecodealliance/preview2-shim) |
| @bytecodealliance/componentize-js | 0.23.0 | 2026-09-21 | [npm registry](https://registry.npmjs.org/@bytecodealliance/componentize-js) |
| bytecodealliance/actions | v1.1.3 (floating `v1`) | not checked | [tags](https://github.com/bytecodealliance/actions/tags) |
| wac | v0.12.0 | not checked | [tags](https://github.com/bytecodealliance/wac/tags) |

## Binaryen: changes v123 to v132, binaryen.js WasmGC completeness, Component Model support, GC passes

### Takeaway
binaryen.js 132.0.0 covers the WasmGC MVP well enough to build a backend (TypeBuilder with rec groups and subtyping, struct/array ops including `array.new_data`, `ref.cast`/`ref.test`, `br_on_cast`, `call_ref`), and every registered optimisation pass including the GC ones is reachable by name. The gaps that matter are: no builder for the new exception instructions until v133, no stack-switching or custom-descriptor builders at all, no JS way to give a function a TypeBuilder-defined type, and no Component Model support of any kind.

### Cited Findings

Release timeline and npm state
- Tag dates: version_123 2025-03-25, version_124 2025-09-02, version_125 2025-11-19, version_126 2026-02-13, version_127 2026-03-10, version_128 2026-03-13, version_129 2026-04-01, version_130 2026-06-01, version_131 2026-07-15, version_132 2026-08-12, version_133 2026-09-21. So "about a year ago" is v125, not v123. — [Binaryen tags](https://github.com/WebAssembly/binaryen/tags)
- npm `binaryen` `latest` is 132.0.0 (published 2026-08-13). There is no 133.x on npm although version_133 was tagged on 2026-09-21, and the `nightly` dist-tag has not moved since 132.0.0-nightly.20260918. — [npm registry](https://registry.npmjs.org/binaryen)
- AssemblyScript 0.28.20 (2026-07-22) pins `binaryen` 131.0.0-nightly.20260721; jco 1.42.0 and jco-transpile 0.24.0 depend on `binaryen` ^132.0.0. — [assemblyscript on npm](https://registry.npmjs.org/assemblyscript), [jco on npm](https://registry.npmjs.org/@bytecodealliance/jco)

Changelog items v123 to v132 that matter here — all from [CHANGELOG.md](https://github.com/WebAssembly/binaryen/blob/main/CHANGELOG.md)
- v123: "exact" references from the custom descriptors proposal are supported and emitted when the feature is on. Using `-all` therefore makes GC binaries use a feature "which most VMs do not yet support"; the changelog's advice is to enable only wanted features or pass `--disable-custom-descriptors`.
- v124: Custom Descriptors support, Stack Switching support, Compilation Hints and Branch Hinting support added. New `TypeRefiningGUFA` pass. New `--string-lifting` pass (pairs with `--string-lowering`). More source-map fields (`sourcesContent`, `file`, `sourceRoot`). C/JS APIs can read a module's start function.
- v125: `ReorderTypes` pass added. **API behaviour change:** C and JS APIs now assume `RefFunc`s are created after imported functions, because imported function types can vary under Custom Descriptors.
- v126: JS API throws exceptions on parse errors instead of killing the process. C API gains separate `CallRef` and `ReturnCallRef` functions. **Breaking:** atomic ops take a memory-order parameter; `setAtomic` removed in favour of `setMemoryOrder` (optional in JS).
- v127: Custom Page Sizes implemented. **Breaking JS change:** binaryen.js is now built with `WASM_BIGINT`; `i64.const`, `setValueI64` and similar take one value (bigint or number) instead of a hi/low pair, and passing two values asserts. The Emscripten build no longer targets pure JS via wasm2js by default.
- v129: `BinaryenAddTable` takes an init expression (breaking in C, optional in JS). Data-segment lookups now use a `BinaryenDataSegmentRef`. Multibyte array load/store instructions added. Codebase moved to C++20.
- v130: Wide Arithmetic support. **Breaking renames:** `module.getNumMemorySegments` to `getNumDataSegments`, `module.getMemorySegmentInfo` to `getDataSegmentInfo`; relaxed-SIMD ops gained a `Relaxed` prefix.
- v131: **Breaking JS change:** `parseTextWithFeatures` replaced by an optional `features` argument to `parseText`. `BinaryenAtomicFence` takes a memory order (C API break). ConstraintAnalysis pass added.
- v132: **Breaking JS change:** `readBinaryWithFeatures` replaced by an optional `features` argument to `readBinary`. JS API gains `BinaryenStringConst`. relaxed-atomics feature flag; compact imports emitted opportunistically.
- v133 (GitHub only, not on npm): JS API exposes `try_table`, `throw_ref` and heap types `exn`/`noexn`. **Breaking JS change:** "Organize types into enums". `--constraint-analysis` runs automatically at `-O3`/`-Os` and above.
- Unreleased trunk: **Breaking JS change:** four-argument `struct.get()`/`array.get()` (with `isSigned`) removed; use `get_s`/`get_u` for packed fields. Label names are read and written in the name section. New `--constant-arrays-to-data` and `--relax-nullability` passes.

binaryen.js 132 GC surface — verified in [binaryen.js-post.js at version_132](https://github.com/WebAssembly/binaryen/blob/version_132/src/js/binaryen.js-post.js)
- `binaryen.TypeBuilder(size)` exposes `grow`, `getSize`, `setSignatureType`, `setStructType` (fields as `{type, packedType, mutable}`), `setArrayType`, `getTempHeapType`, `getTempTupleType`, `getTempRefType`, `setSubType`, `setOpen`, `createRecGroup(index, length)` and `buildAndDispose()` (throws `TypeError` on failure). `binaryen.getTypeFromHeapType(heapType, nullable)` and `binaryen.getHeapType(type)` convert between the two.
- TypeBuilder is absent from the JS API at version_123 and present from version_124 onward (grep count 0 vs 17). — [version_123 source](https://github.com/WebAssembly/binaryen/blob/version_123/src/js/binaryen.js-post.js), [version_124 source](https://github.com/WebAssembly/binaryen/blob/version_124/src/js/binaryen.js-post.js)
- Expression builders present on a module at 132: `struct.new/new_default/get/set`; `array.new/new_default/new_fixed/new_data/new_elem/get/set/len/fill/copy/init_data/init_elem`; `ref.null/is_null/as_non_null/func/i31/eq/test/cast`; `i31.get_s/get_u`; `call_ref`, `return_call_ref`; `br_on_null`, `br_on_non_null`, `br_on_cast`, `br_on_cast_fail`; `any` and `extern` namespaces; a `string` namespace; legacy `try`/`throw`/`rethrow`.
- `module.call_ref` is absent from the JS API at version_124 and version_125 and present from version_126. — [version_125 source](https://github.com/WebAssembly/binaryen/blob/version_125/src/js/binaryen.js-post.js), [version_126 source](https://github.com/WebAssembly/binaryen/blob/version_126/src/js/binaryen.js-post.js)
- Basic value types exposed as constants at 132: `none, i32, i64, f32, f64, v128, funcref, externref, anyref, eqref, i31ref, structref, arrayref, stringref, nullref, nullexternref, nullfuncref, unreachable, auto`; packed types `notPacked, i8, i16`. Naming helpers `module.setTypeName(heapType, name)` and `module.setFieldName(heapType, index, name)` exist.

Documented or source-verified gaps
- No JS builder for `try_table` / `throw_ref` at 132; they appear in the JS API at version_133. — [132 source](https://github.com/WebAssembly/binaryen/blob/version_132/src/js/binaryen.js-post.js), [133 source](https://github.com/WebAssembly/binaryen/blob/version_133/src/js/binaryen.js-post.js)
- The 132 C header contains no `TryTable`, `ThrowRef`, `ContNew`/`Resume`/`Suspend`, descriptor or exact-type functions; the only stack-switching symbol is the feature flag `BinaryenFeatureStackSwitching`. So stack switching and custom descriptors exist in the IR (v124) but have no builder API in C or JS at 132. — [binaryen-c.h at version_132](https://github.com/WebAssembly/binaryen/blob/version_132/src/binaryen-c.h)
- C API has `BinaryenAddFunctionWithHeapType` and `BinaryenFunctionSetType`; neither is referenced by the JS API at 132, 133 or main. JS `module.addFunction(name, params, results, varTypes, body)` only calls `_BinaryenAddFunction`. — [binaryen-c.h](https://github.com/WebAssembly/binaryen/blob/version_132/src/binaryen-c.h), [JS source on main](https://github.com/WebAssembly/binaryen/blob/main/src/js/binaryen.js-post.js)
- Basic heap-type constants (`func, extern, any, eq, i31, struct, array, string, none, noextern, nofunc, exn, noexn`) are not exposed as a JS object at 132; `binaryen.HeapType` arrives in version_133. — [133 source](https://github.com/WebAssembly/binaryen/blob/version_133/src/js/binaryen.js-post.js)
- The wiki page for the JS API contains no TypeBuilder or struct/array documentation (grep for those terms finds only unrelated lines), so the source file is the only reference for the GC API. — [binaryen.js API wiki](https://github.com/WebAssembly/binaryen/wiki/binaryen.js-API)

Component Model
- Binaryen's README describes it as a compiler and toolchain library for WebAssembly modules; the word "component" appears only in the sense "toolchains using Binaryen as a component". It has no statement of Component Model support. — [README](https://github.com/WebAssembly/binaryen/blob/main/README.md)
- `jco opt` optimises a component by extracting each inner core module (via `metadataShow` ranges), running wasm-opt on the module bytes, and splicing results back with re-encoded LEB sizes. Default args are `-Oz --low-memory-unused --enable-bulk-memory --strip-debug`. — [jco opt.ts](https://github.com/bytecodealliance/jco/blob/main/packages/jco/src/cmd/opt.ts)

GC-relevant passes and their exposure
- Passes registered by name in 132 include `gufa`, `gufa-cast-all`, `gufa-optimizing`, `type-refining`, `type-refining-gufa`, `type-ssa`, `type-merging`, `type-finalizing`, `type-unfinalizing`, `abstract-type-refining`, `cfp`, `cfp-reftest`, `gto`, `gsi`, `heap2local`, `heap-store-optimization`, `optimize-casts`, `local-subtyping`, `signature-pruning`, `signature-refining`, `unsubtyping`, `remove-unused-types`, `reorder-types`, `minimize-rec-groups`, `monomorphize`, `string-lifting`, `string-lowering`, `translate-to-exnref`, `strip-debug`, `strip-dwarf`. — [pass.cpp at version_132](https://github.com/WebAssembly/binaryen/blob/version_132/src/passes/pass.cpp)
- binaryen.js exposes `module.runPasses(passes: string[])` (forwards names to `BinaryenModuleRunPasses`), `module.optimize()`, and global setters `setOptimizeLevel`, `setShrinkLevel`, `setClosedWorld`, `setTrapsNeverHappen`, `setDebugInfo`, `setPassArgument`, `setGenerateStackIR`, `setOptimizeStackIR`. — [132 JS source](https://github.com/WebAssembly/binaryen/blob/version_132/src/js/binaryen.js-post.js)
- Upstream guidance for GC languages: run the pipeline more than once (`-O3 -O3`; J2Wasm uses about 6 rounds). GUFA is not run by default, "requires `--closed-world`", and is typically sandwiched as `-O3 --gufa -O3`. Suggested type flow is `--type-ssa -O3 -O3 --type-merging -O3`. `--type-finalizing` should be run manually at the very end. `--reorder-types` (single module) or `--minimize-rec-groups` (split modules) as the last type pass. — [GC Optimization Guidebook](https://github.com/WebAssembly/binaryen/wiki/GC-Optimization-Guidebook)
- Closed world: by default any type that escapes may be inspected from outside. With `--closed-world` "several more important passes" run. References may still escape, but a specific GC type on the boundary is treated as public and not modified, so "it is best to only use basic types on the boundary". — [GC Optimization Guidebook](https://github.com/WebAssembly/binaryen/wiki/GC-Optimization-Guidebook)

### Inferences
- Because `runPasses` takes names from the same registry as `wasm-opt`, every GC pass above should be usable from binaryen.js after `binaryen.setClosedWorld(true)`. I did not run it.
- A component's lifted exports and lowered imports use only core numeric types (see the componentization section), so the boundary of a TinyWhale core module naturally satisfies the "basic types on the boundary" rule for closed-world optimisation.
- For a module built through binaryen.js 132, exceptions can only be constructed with the legacy `try`/`catch` builders; `translate-to-exnref` is registered and is the likely bridge to the standard exception proposal that Wasmtime enables by default. Untested.
- Staying on npm 132.0.0 avoids two announced JS breaks (type enums in v133; four-argument `struct.get` removal on trunk). Upgrading later will need code changes in every type reference and packed-field read.
- The missing `addFunctionWithHeapType` in JS means function types are created structurally from params/results. Whether that blocks declaring function subtypes or putting function types in a rec group with structs (needed for typed closures and vtables with `call_ref`) could not be confirmed without running code.

### Gaps
- Why npm publishing of `binaryen` stopped after 2026-09-18 and whether 133.0.0 will be published: no source found (issue trackers unreachable).
- Whether Binaryen fails cleanly or misparses when handed a component binary: not tested and no documentation found. Binaryen's lack of component support is inferred from the README's silence plus jco's extract-and-splice design, not from an explicit upstream statement.
- Open issues about binaryen.js GC API gaps could not be read.
- Whether the JS TypeBuilder can express shared types, descriptors or exact references: the 132 JS wrapper has no such methods; I did not enumerate the C-side `TypeBuilder*` functions one by one.

## Alternatives to Binaryen for a TypeScript compiler backend

### Takeaway
There are four workable routes: keep binaryen.js; write your own binary encoder; emit WAT and assemble with `wasm-tools parse` (also available in-process through jco); or use an npm encoder library. No npm package exposes Rust's `wasm-encoder` directly, and only the WAT-plus-wasm-tools route gives access to every proposal Wasmtime supports without waiting on a JS API.

### Cited Findings
- jco re-exports wasm-tools functions as a JS library: `parse` (WAT text to binary), `print` (binary to WAT), `componentNew`, `componentEmbed`, `componentWit`, `metadataAdd`, `metadataShow`. They come from a Rust crate compiled to a component that links `wasm-encoder`, `wasmparser`, `wasmprinter`, `wat`, `wit-component` and `wit-parser`. — [jco api.ts](https://github.com/bytecodealliance/jco/blob/main/packages/jco/src/api.ts), [wasm-tools-component Cargo.toml](https://github.com/bytecodealliance/jco/blob/main/crates/wasm-tools-component/Cargo.toml), [its WIT interface](https://github.com/bytecodealliance/jco/blob/main/crates/wasm-tools-component/wit/wasm-tools.wit)
- jco's workspace pins those crates at 0.262.0 (one minor behind wasm-tools 1.263.0) with the comment that the toolchain "must match wit-bindgen-core 0.63". — [jco Cargo.toml](https://github.com/bytecodealliance/jco/blob/main/Cargo.toml)
- No npm package named `wasm-encoder`, `@bytecodealliance/wasm-tools`, `@bytecodealliance/wit-parser` or `@bytecodealliance/wasm-wave` exists (registry returns "Not found"). The unscoped `wasm-tools` package (0.2.1, 2022-08-02) is an unrelated project built on `wabt`. — [registry: @bytecodealliance/wasm-tools](https://registry.npmjs.org/@bytecodealliance/wasm-tools), [registry: wasm-tools](https://registry.npmjs.org/wasm-tools)
- `wasmati` 1.0.0 (2026-10-07, zksecurity): its README claims support for "all of Wasm 3.0 plus proposals at phase 4 or 5" with an API that mirrors opcodes, and says the official Wasm 3.0 spec test suite runs through it in CI. — [wasmati on npm](https://registry.npmjs.org/wasmati)
- `@wasmgroundup/emit` 2.1.2 (2026-03-19): "A library for creating binary-encoded WebAssembly modules", zero dependencies. Its README does not mention GC. — [registry](https://registry.npmjs.org/@wasmgroundup/emit)
- `wabt` (wabt.js) 1.0.39 was published 2025-11-05 and its nightly tag stops at 2025-12-03. `@webassemblyjs/wasm-gen` 1.14.1 dates from 2024-11-06. — [wabt on npm](https://registry.npmjs.org/wabt), [@webassemblyjs/wasm-gen on npm](https://registry.npmjs.org/@webassemblyjs/wasm-gen)
- The npm package `wasm-opt` 2.0.1 (2026-10-17) describes itself as "Native wasm-opt from Binaryen, delivered as a platform package", so the native optimiser can be used without binaryen.js. — [wasm-opt on npm](https://registry.npmjs.org/wasm-opt)
- What comparable toolchains do, per Binaryen's README: AssemblyScript, Grain and Asterius use Binaryen **as a library**; Kotlin/Wasm, Dart, J2Wasm, wasm_of_ocaml, Emscripten and wasm-pack use it **as a component**, "typically running `wasm-opt`" over output their own backend produced. — [Binaryen README](https://github.com/WebAssembly/binaryen/blob/main/README.md)
- MoonBit's component workflow in wit-bindgen builds with `moon build --target wasm` and then runs `wasm-tools component embed` and `component new` on the result. — [wit-bindgen README](https://github.com/bytecodealliance/wit-bindgen/blob/main/README.md)
- `wasm-tools` validation in `wit-component` uses `WasmFeatures::all()`, and wasm-tools lists `gc` among implemented proposals. — [wit-component validation.rs](https://github.com/bytecodealliance/wasm-tools/blob/main/crates/wit-component/src/validation.rs), [wasm-tools README](https://github.com/bytecodealliance/wasm-tools/blob/main/README.md)

### Inferences
- Trade-offs, combining the findings above:
  - **binaryen.js**: gives validation, an optimiser tuned for GC code and source-map emission in-process. Costs: API lags the IR (exceptions, stack switching, descriptors), recurring breaking renames, and npm releases currently trail GitHub.
  - **Hand-written encoder**: full control and no dependency; the GC type section (rec groups, subtypes) and name section must be written and kept correct by hand, and there is no optimiser unless `wasm-opt` is run afterwards on the core module.
  - **WAT text + `wasm-tools parse`** (CLI or jco's `parse`): easiest to debug and snapshot-test, tracks new proposals as soon as wasm-tools does, and is the same text format `wasmtime wast` consumes. Costs a text round trip and string-building discipline.
  - **npm encoder (wasmati)**: typed JS API with current proposals, but a single-vendor 1.0 released five weeks ago and no optimiser.
- The split used by the largest WasmGC toolchains (own emitter, Binaryen only as `wasm-opt`) is available to TinyWhale either through the `wasm-opt` npm package or by loading the emitted binary into binaryen.js with `readBinary` and calling `runPasses`.

### Gaps
- wasmati's GC API quality and Component Model relevance were not evaluated beyond its README claims.
- Backends of Hoot, Virgil, Zena or other small WasmGC languages were not researched; no primary source consulted.
- Whether MoonBit's `wasm-gc` target can be componentized was not checked; the README only documents the linear-memory `wasm` target.
- No npm build of `wasm-encoder` as a standalone library was found; whether one exists under another name is unknown.

## Componentization from Node: embed + new, jco APIs, WASI 0.3 / async and GC support, WIT parsing, wit-bindgen

### Takeaway
A core module becomes a component with `wasm-tools component embed <wit> core.wasm` followed by `wasm-tools component new`. Both steps are callable in-process from Node as `componentEmbed` and `componentNew` in `@bytecodealliance/jco` 1.42.0. The encoder accepts GC core modules and async-lifted exports, but the canonical ABI still passes strings and lists through linear memory and `cabi_realloc`, so a WasmGC program needs a linear memory for its boundary.

### Cited Findings

CLI and conventions
- `wasm-tools component new` creates a component from a core wasm binary that has component-type metadata embedded; `component embed` adds that metadata as a custom section and "is primarily intended for one-off testing or for developers working with text format wasm". — [wasm-tools component.rs](https://github.com/bytecodealliance/wasm-tools/blob/main/src/bin/wasm-tools/component.rs)
- `component embed` options: `--world`, `--encoding utf8|utf16|compact-utf16`, `--dummy` / `--dummy-names <scheme>` (generates a placeholder core module with the right imports and exports), `--async-callback` and `--async-stackful` (both only with `--dummy-names legacy`). — [component.rs](https://github.com/bytecodealliance/wasm-tools/blob/main/src/bin/wasm-tools/component.rs)
- `component new` options: `--adapt [NAME=]MODULE`, `--validate=true|false`, `--realloc-via-memory-grow`, `--merge-imports-based-on-semver`, `--reject-legacy-names`, `--import-name OLD=NEW`, a flag for debug names, a flag to use `return_call_ref` in shims (requires tail-call and function-references), `-t` for text output. — [component.rs](https://github.com/bytecodealliance/wasm-tools/blob/main/src/bin/wasm-tools/component.rs)
- `wit-component` validates the input core module with `Validator::new_with_features(WasmFeatures::all())`. — [validation.rs](https://github.com/bytecodealliance/wasm-tools/blob/main/crates/wit-component/src/validation.rs)
- Async in `wit-component`: export names prefixed `[async-lift]` select the async ABI, `[callback][async-lift]` names the callback, imports prefixed `[async-lower]` are async-lowered, and "every async-with-callback-lifted export must have a callback". These prefixes belong to the "legacy" name mangling; the newer `cm32p2` scheme "requires a 32-bit linear memory", and the embed help says the standard scheme "does not yet support async-related features". — [validation.rs](https://github.com/bytecodealliance/wasm-tools/blob/main/crates/wit-component/src/validation.rs), [component.rs](https://github.com/bytecodealliance/wasm-tools/blob/main/src/bin/wasm-tools/component.rs)
- The encoder adds `realloc` when a signature needs it and fails with "module does not export a function named `cabi_realloc`" otherwise. — [encoding.rs](https://github.com/bytecodealliance/wasm-tools/blob/main/crates/wit-component/src/encoding.rs)
- Component Model explainer: lifted functions use core types such as `i32` pointers and lengths, and "In the future, a new ABI option will likely be added for wasm-gc to replace these integer offsets with typed GC references" (links issue 525). — [Explainer.md](https://github.com/WebAssembly/component-model/blob/main/design/mvp/Explainer.md)
- Feature gates in wasmparser (main): `cm_async` default **true**; `cm_async_stackful` default **false**; `cm_more_async_builtins`, `cm_threading`, `cm_error_context`, `cm_fixed_length_lists` default false; `cm_gc` ("Support for Wasm GC in the component model proposal", emoji 🛸) default **false**; core `gc` default true. — [wasmparser features.rs](https://github.com/bytecodealliance/wasm-tools/blob/main/crates/wasmparser/src/features.rs)
- Wasmtime 50 lists component-model async (🔀) as on by default and "stackful async" (🚟) and "more async options" (🚝) as off by default. — [stability-wasm-proposals.md](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/stability-wasm-proposals.md)

jco as the Node entry point
- `@bytecodealliance/jco` exports `componentNew`, `componentEmbed`, `componentWit`, `parse`, `print`, `metadataAdd`, `metadataShow`, `transpile`, `types`, `opt`, plus `preview1AdapterCommandPath()` / `preview1AdapterReactorPath()`. — [api.ts](https://github.com/bytecodealliance/jco/blob/main/packages/jco/src/api.ts)
- Signatures (from the WIT the JS bindings are generated from): `component-new(binary, adapters: option<list<tuple<string, bytes>>>)`; `component-embed({binary?, wit-source?, wit-path?, string-encoding?, dummy?, world?, metadata?, features?})`, with the note "Only a singular WIT document without use resolutions is supported" for inline source; `component-wit(binary) -> string`; `component-wit-metadata-for-world(wit, world?)` returns import and export interface lists. — [wasm-tools.wit](https://github.com/bytecodealliance/jco/blob/main/crates/wasm-tools-component/wit/wasm-tools.wit)
- jco's `componentNew` calls `ComponentEncoder::default().validate(true)`. — [wasm-tools-component lib.rs](https://github.com/bytecodealliance/jco/blob/main/crates/wasm-tools-component/src/lib.rs)
- CLI equivalents: `jco new`, `jco embed`, `jco wit`, `jco parse`, `jco print`, `jco tool core-to-component`. — [jco.ts](https://github.com/bytecodealliance/jco/blob/main/packages/jco/src/jco.ts)
- jco 1.42.0 dependencies include `typescript` 7.0.2, `binaryen` ^132.0.0, `rolldown`, `componentize-qjs` ^0.5.0 and `@bytecodealliance/componentize-js` ^0.23.0. — [npm registry](https://registry.npmjs.org/@bytecodealliance/jco)
- `@bytecodealliance/componentize-js` is described as "ESM -> WebAssembly Component creator, via a SpiderMonkey JS engine embedding". It builds components *from JavaScript source*; it is not a core-module-to-component tool. — [npm registry](https://registry.npmjs.org/@bytecodealliance/componentize-js)

WIT from JS
- `wasm-tools component wit ./wit --json` converts a WIT document to JSON; `component wit ./wit --wasm` produces the binary WIT package. — [wasm-tools README](https://github.com/bytecodealliance/wasm-tools/blob/main/README.md)
- In jco, WIT handling is the `wit-parser` crate inside the bundled component; the JS-visible surface is `componentWit`, `componentEmbed` and the world-metadata function above. — [wasm-tools-component Cargo.toml](https://github.com/bytecodealliance/jco/blob/main/crates/wasm-tools-component/Cargo.toml)

wit-bindgen as a reference
- wit-bindgen 0.63.0 "is currently focused on guest programs"; in-repo languages are Rust, C, C++, C# and Go, and the crates directory also holds `moonbit`, `d` and `markdown` generators. — [README](https://github.com/bytecodealliance/wit-bindgen/blob/main/README.md), [crates directory](https://github.com/bytecodealliance/wit-bindgen/tree/main/crates)
- Async support by generator, measured as occurrences of "async" in each generator's `lib.rs` on main: moonbit 143, cpp 115, c 72, go 30, csharp 0. — [crates/moonbit](https://github.com/bytecodealliance/wit-bindgen/blob/main/crates/moonbit/src/lib.rs), [crates/c](https://github.com/bytecodealliance/wit-bindgen/blob/main/crates/c/src/lib.rs), [crates/csharp](https://github.com/bytecodealliance/wit-bindgen/blob/main/crates/csharp/src/lib.rs)
- Go: generated code defines `StreamReader`/`StreamWriter` and `FutureReader`/`FutureWriter`, and "async support currently requires a patched version of" Go. — [crates/go/README.md](https://github.com/bytecodealliance/wit-bindgen/blob/main/crates/go/README.md)
- MoonBit generator "emits inline wasm helpers for strings, bytes, and arrays", and its flags mention types with future or stream fields. — [README](https://github.com/bytecodealliance/wit-bindgen/blob/main/README.md)

### Inferences
- A TinyWhale component should lift async exports with the **callback** ABI (`[async-lift]` + `[callback][async-lift]`), because the stackful variant is off by default in both wasmparser and Wasmtime 50.
- The minimum boundary runtime for a GC-based language is: one exported linear memory, a `cabi_realloc` export, and copy code between GC arrays and that memory for strings and lists. Scalars cross the boundary without it.
- jco's bundled wasm-tools is one minor behind the CLI. If a WASI 0.3.2 WIT feature or async naming detail differs between 0.262 and 0.263, the CLI installed by mise is the safer reference; using both in one pipeline risks drift.
- The C generator is the smallest complete reference for canonical-ABI lifting and lowering with async; the MoonBit generator is the closest in spirit (a non-LLVM language) but targets linear memory, not GC.

### Gaps
- The `cm_gc` (🛸) gate exists in wasmparser and as a Wasmtime flag (`-W component-model-gc`), but the explainer text I fetched does not contain that emoji and Wasmtime's 50.0 stability table does not list it. **Conflict noted; what the gate actually enables today is unverified.**
- Whether jco's `componentEmbed` accepts a WIT directory with `deps/` (needed for `wasi:cli@0.3.x`) was not tested; the `wit-path` option exists but the inline-source path is documented as single-document only.
- `wit-dylib`, `wac` (v0.12.0) and `wasm-tools component link` were not evaluated.
- Whether `wit-component` output for an async world validates in Wasmtime 50 without extra flags was not run.

## Fetching WASI 0.3 WIT definitions: wkg, registry, pinning

### Takeaway
`wkg` 0.16.2 fetches WIT packages from OCI registries. WASI packages are published to `ghcr.io/webassembly/wasi/<proposal>:<version>`, resolved by default through `wasi.dev`, and pinned through `wkg.lock` or an OCI digest. WASI 0.3 is released: v0.3.0 (2026-06-11), v0.3.1, and v0.3.2 (2026-10-13).

### Cited Findings
- WASI's README: "WASI 0.3 (Preview 3) is the current preview", replacing explicit streams and polling with the component model's native `async`, `future` and `stream`. — [WASI README](https://github.com/WebAssembly/WASI/blob/main/README.md)
- Tags: v0.3.0 2026-06-11, v0.3.1 2026-08-11, v0.3.2 2026-10-13; release candidates v0.3.0-rc-2026-01-06, -02-09, -03-15 preceded them. — [WASI tags](https://github.com/WebAssembly/WASI/tags)
- WIT sources live in the WASI monorepo under `proposals/{cli,clocks,filesystem,http,random,sockets}/wit`. On main, `proposals/cli/wit/command.wit` declares `package wasi:cli@0.3.2;` and `world command { include imports; export run; }` with `@since(version = 0.3.0)`. — [command.wit](https://github.com/WebAssembly/WASI/blob/main/proposals/cli/wit/command.wit)
- Publication target is `ghcr.io/webassembly/wasi/<proposal>:<version>` (for example `.../wasi/random:<version>`). — [publish workflow](https://github.com/WebAssembly/WASI/blob/main/.github/workflows/publish.yml)
- wkg commands: `wkg get wasi:http@0.2.1`; `wkg oci pull ghcr.io/webassembly/wasi/http:0.2.1` or by `@sha256:` digest "to pin an exact immutable artifact"; `wkg fetch` (uses `wkg.toml` / `wkg.lock`); `wkg update` (updates pins in `wkg.lock`); `wkg build` (WIT package to component). `--config` and `--cache` attach per subcommand. — [wasm-pkg-tools README](https://github.com/bytecodealliance/wasm-pkg-tools/blob/main/README.md)
- With no configuration, namespace `wasi` maps to registry `wasi.dev` and `ba` to `bytecodealliance.org`, resolved through `https://wasi.dev/.well-known/wasm-pkg/registry.json`. — [configuration.md](https://github.com/bytecodealliance/wasm-pkg-tools/blob/main/docs/configuration.md)
- `wkg.toml` is optional; `[overrides]` redirects a package to a local path. — [manifest.md](https://github.com/bytecodealliance/wasm-pkg-tools/blob/main/docs/manifest.md)
- Install: the README says installation "is manual" (release binary, `cargo install wkg`, or `cargo binstall wkg`). — [README](https://github.com/bytecodealliance/wasm-pkg-tools/blob/main/README.md)
- Wasmtime 46.0.0 (2026-06-22) "supports WASI 0.3.0 by default"; Wasmtime 43 supported the snapshot `0.3.0-rc-2026-03-15`; Wasmtime 40 warned that pre-change WASIp3 binaries "are no longer valid" and need recompilation. — [release-46 notes](https://github.com/bytecodealliance/wasmtime/blob/release-46.0.0/RELEASES.md), [release-43 notes](https://github.com/bytecodealliance/wasmtime/blob/release-43.0.0/RELEASES.md), [release-40 notes](https://github.com/bytecodealliance/wasmtime/blob/release-40.0.0/RELEASES.md)
- jco's docs state that 0.3 point releases "are not expected to introduce breaking changes" and that jco maps every supported 0.3.x interface version to its current shim. — [preview3-shim docs](https://github.com/bytecodealliance/jco/blob/main/docs/src/wasi/preview3-shim.md)

### Inferences
- Simplest reproducible setup: commit a `wkg.lock` (or vendor the fetched `wit/deps`) and pin `wkg` itself through mise. Vendoring also removes network access from the test path.
- Targeting `wasi:cli@0.3.0` rather than 0.3.2 maximises compatibility with Wasmtime 46 to 50, since release notes only state 0.3.0 support explicitly.

### Gaps
- `wa.dev` (named in the brief) does not appear in wkg's documentation; its current status is unverified.
- Which 0.3.x versions Wasmtime 50 accepts (0.3.1, 0.3.2) is not stated in the release notes I read.
- I did not pull from ghcr.io to confirm that `0.3.0`/`0.3.1`/`0.3.2` tags exist for every proposal.

## Running Wasmtime from a Node-based test suite

### Takeaway
There is no maintained Node binding for Wasmtime, so the test suite must spawn the `wasmtime` CLI. Wasmtime 50.0.1 runs WASI 0.3 + GC components with default settings, `--invoke` accepts WAVE-encoded calls and prints WAVE results to stdout, and `wasmtime wast` runs component-aware script files in a single process, which is the documented way to avoid per-test process cost.

### Cited Findings

Defaults relevant to TinyWhale
- Wasmtime 46.0.0 (2026-06-22): WASI 0.3.0 supported by default and the `component-model-async` wasm feature enabled by default; default collector switched from deferred reference counting to the **copying collector**, which can collect cycles. — [release-46 notes](https://github.com/bytecodealliance/wasmtime/blob/release-46.0.0/RELEASES.md)
- Wasmtime 47.0.0 (2026-07-20): WebAssembly GC proposal and exception-handling proposal enabled by default; `--invoke` with components "now supports fully qualified WIT interface names". — [release-47 notes](https://github.com/bytecodealliance/wasmtime/blob/release-47.0.0/RELEASES.md)
- Wasmtime 50.0.0 (2026-10-20): Winch no longer enables GC types, exceptions or tail calls by default; component-model-async updated to the latest spec (`cancellable` immediate removed, `subtask.cancel` refined); CLI no longer enables WASIp0 by default. — [release-50 notes](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/RELEASES.md)
- `gc`, `function-references`, `exception-handling` and `component-model` are Tier 1 in Wasmtime 50; `stack-switching` is Tier 3, work in progress, x86_64 Linux only. GC is supported by Cranelift on all listed architectures and by Pulley, not by Winch. — [stability-wasm-proposals.md](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/stability-wasm-proposals.md), [stability-tiers.md](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/stability-tiers.md)
- Security releases on 2026-10-29 (50.0.1, 49.0.5, 48.0.8) fixed GC heap corruption bugs, including missing rooting of GC values across `try_call` and mis-typed tag imports. — [release-49 notes](https://github.com/bytecodealliance/wasmtime/blob/release-49.0.0/RELEASES.md)

Installing a pinned version
- mise registry has `wasmtime` (backends `aqua:bytecodealliance/wasmtime`, `asdf:tachyonicbytes/asdf-wasmtime`; bins `wasmtime`, `wasmtime-min`) and `wasm-tools` (backends `aqua:bytecodealliance/wasm-tools`, `cargo:wasm-tools`). — [mise registry/wasmtime.toml](https://github.com/jdx/mise/blob/main/registry/wasmtime.toml), [mise registry/wasm-tools.toml](https://github.com/jdx/mise/blob/main/registry/wasm-tools.toml)
- mise's registry has **no** entry for `wkg`, `binaryen`, `wit-bindgen` or `wac` (directory listing checked). The aqua registry does have `bytecodealliance/wasm-pkg-tools` (binary `wkg`) and `WebAssembly/binaryen`. — [aqua wasm-pkg-tools](https://github.com/aquaproj/aqua-registry/blob/main/pkgs/bytecodealliance/wasm-pkg-tools/registry.yaml), [aqua binaryen](https://github.com/aquaproj/aqua-registry/blob/main/pkgs/WebAssembly/binaryen/registry.yaml)
- CI: `bytecodealliance/actions/wasmtime/setup@v1`, `.../wasm-tools/setup@v1` and `.../wit-bindgen/setup@v1`, each with inputs `version` (default `latest`) and `github_token`. — [actions README](https://github.com/bytecodealliance/actions/blob/main/README.md)
- Other install paths: `curl https://wasmtime.dev/install.sh -sSf | bash`, release archives named `wasmtime-<version>-<arch>-<os>.tar.xz`, `cargo install wasmtime-cli`, `cargo binstall wasmtime-cli`. — [cli-install.md](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/cli-install.md)

`wasmtime run` and `--invoke`
- Default mode runs `wasi:cli/run` for components (or `_start` for core modules). Wasmtime options must come **before** the wasm file; everything after is passed to the guest. — [cli-options.md](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/cli-options.md)
- For components, `--invoke` takes a WAVE-encoded call: `wasmtime run --invoke 'add(1, 2)' foo.wasm`, `--invoke 'initialize("hello")'`. Source help adds: fully qualified form `your:pkg/iface.func("...")` or `wasi:cli/run.run@0.2.0()`; bare names "are searched for in all exported instances, and must be unambiguous". — [cli-options.md](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/cli-options.md), [run.rs](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/src/commands/run.rs)
- WAVE formats: bools `true`; integers `123`; floats `3.14`, `nan`, `-inf`; chars `'x'`; strings `"abc\t123"`; tuples `("abc", 123)`; lists `[1, 2, 3]`; records `{field-a: 1}`; variants `days(30)`; enums `south`; options `some(...)`/`none` (flat form allowed); results `ok(...)`/`err("oops")`; flags `{read, write}`. — [wasm-wave README](https://github.com/bytecodealliance/wasm-tools/blob/main/crates/wasm-wave/README.md)
- Results of a component invoke are printed with `println!("{}", DisplayFuncResults(&results))`, that is WAVE text on stdout. — [run.rs](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/src/commands/run.rs)
- Async exports: when concurrency support is on (the default), the invoke path calls the function through `store.run_concurrent(... func.call_concurrent ...)`; otherwise `call_async`. — [run.rs](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/src/commands/run.rs)
- Exit status: a WASI exit code is propagated with `process::exit(code)`; a trap prints `Error: ...` to stderr and exits with the SIGABRT-signalled status on Unix (3 on Windows); a `wasi:cli/run` returning `Err(())` becomes exit status 1. — [run.rs](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/src/commands/run.rs)
- For **core modules**, `--invoke` argument and result printing is declared "unstable" and warns on stderr. — [cli-options.md](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/cli-options.md), [run.rs](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/src/commands/run.rs)
- Relevant option names (group prefix in brackets): `[-W] component-model-async`, `component-model-async-stackful`, `component-model-more-async-builtins`, `component-model-gc`, `gc`, `function-references`, `exceptions`, `stack-switching`, `timeout`, `fuel`; `[-C] collector`, `compiler`, `cache`, `cache-config`; `[-D] debug-info`, `guest-debug`, `address-map`, `coredump`; `[-S] cli`, `p3`. Options can also be given via `--config file.toml` or environment variables such as `WASMTIME_OPTIMIZE_OPT_LEVEL=0`. — [cli-flags lib.rs](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/cli-flags/src/lib.rs), [cli-options.md](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/cli-options.md)

Making the suite fast
- `wasmtime compile foo.wasm` produces `foo.cwasm`, which `wasmtime run` can execute; pre-compilation "removes compilation from the critical path". — [cli-options.md](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/cli-options.md), [examples-pre-compiling-wasm.md](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/examples-pre-compiling-wasm.md)
- Wasmtime has an on-disk compilation cache configured by a TOML `[cache]` section (`directory`, `cleanup-interval`, `files-total-size-soft-limit`; zstd-compressed); `wasmtime config new` creates the file. — [cli-cache.md](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/cli-cache.md)
- Faster compilation options named by the docs: the cache, the Winch baseline compiler, parallel compilation. — [examples-fast-compilation.md](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/examples-fast-compilation.md)
- `wasmtime wast foo.wast` executes spec-style test scripts. The implementation has a component linker and component instance, value and function kinds behind the `component-model` feature, and "components each get their own store". Flags: `--generate-dwarf=true|false` (default true, gives line numbers in backtraces for text modules), `--precompile-save <dir>`, `--precompile-load <dir>`, `--async=true|false` (default true), `--wasmtime-builtins`, and a flag to ignore error-message text. — [cli-options.md](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/cli-options.md), [commands/wast.rs](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/src/commands/wast.rs), [crates/wast/src/wast.rs](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wast/src/wast.rs)
- wasm-tools has `json-from-wast` (convert a `.wast` to JSON commands) and `wast` (validate the structure of a `.wast`). — [wasm-tools README](https://github.com/bytecodealliance/wasm-tools/blob/main/README.md)
- `wasmtime serve` runs a component in the `wasi:http/proxy` world and is "intended solely for local development and testing"; since Wasmtime 39 it reuses instances for WASIp3 components by default. — [cli-options.md](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/cli-options.md), [release-39 notes](https://github.com/bytecodealliance/wasmtime/blob/release-39.0.0/RELEASES.md)

Node bindings
- Wasmtime's README lists Bytecode Alliance embeddings for Rust, C, C++, Python, .NET, Go and Ruby, and community ones for Elixir and Perl. JavaScript/Node is not listed. — [Wasmtime README](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/README.md)
- npm `wasmtime` is at 0.0.2, last published 2023-05-02. `@bytecodealliance/wasmtime` and `wasmtime-node` do not exist. — [registry: wasmtime](https://registry.npmjs.org/wasmtime), [registry: @bytecodealliance/wasmtime](https://registry.npmjs.org/@bytecodealliance/wasmtime)
- wasmtime-py tracks releases (tag 50.0.1 exists). — [wasmtime-py tags](https://github.com/bytecodealliance/wasmtime-py/tags)

### Inferences
- Three test tiers follow from the above. (1) Fixture programs that are `wasi:cli/command` components: spawn `wasmtime run prog.wasm`, assert stdout and exit status. (2) Exported functions: `wasmtime run --invoke 'f(args)' comp.wasm`, compare WAVE stdout. (3) Bulk assertions: generate one `.wast` per group of fixtures with `assert_return`/`assert_trap` and run a single `wasmtime wast` process.
- Trap detection from Node on Unix: the child reports a signal-style abort status with `Error:` on stderr, distinct from WASI exit codes; assert on both rather than on a numeric code alone.
- Pin Wasmtime to an exact version in `mise.toml`: async canonical-ABI details changed in releases 40 and 50, so a component built for one may not load in another.
- `-W component-model-async-stackful` exists if the compiler ever needs stackful lifts, but relying on an off-by-default gate makes outputs non-portable.

### Gaps
- **Startup overhead per invocation was not measured**, and no primary source gives a figure for process spawn plus component compile time. Needs a local benchmark (cold, cached, and `.cwasm`).
- Whether `wasmtime run` accepts a precompiled *component* `.cwasm` directly, and whether an `--allow-precompiled` flag is required in 50.x, was not confirmed (no match for that flag in `run.rs`; flag may live elsewhere).
- The exact `.wast` syntax Wasmtime accepts for invoking component exports with async functions, and whether WASI imports are linked in `wasmtime wast` (the context is `Linker<()>`, which suggests not), was not verified by running it.
- Whether `--invoke` can target an export that returns a `stream` or `future` was not checked.
- Community N-API bindings may exist under names I did not search; none is referenced by Wasmtime's own documentation.

## jco as a secondary or test runtime for WASI 0.3 + GC components

### Takeaway
jco 1.42.0 can transpile and run WASI 0.3 components on Node through `@bytecodealliance/preview3-shim` 0.14.1, and it is moving fast (four jco minors between 2026-10-16 and 2026-11-13). It is plausible as a secondary runtime, but its semantics differ from Wasmtime in documented ways and its handling of GC core modules is unverified.

### Cited Findings
- jco "transpiles" components into ES modules plus core wasm for Node and browsers, and has `jco run` ("Run a WASI Command component") and `jco serve`. — [jco README](https://github.com/bytecodealliance/jco/blob/main/README.md), [jco.ts](https://github.com/bytecodealliance/jco/blob/main/packages/jco/src/jco.ts)
- `preview3-shim` "implements WASI 0.3 (`wasi:cli`, `wasi:clocks`, `wasi:filesystem`, `wasi:http`, `wasi:random` and `wasi:sockets`) for Node.js and browsers"; "Preview 3 exports are asynchronous" (`await component.run.run()`). — [preview3-shim docs](https://github.com/bytecodealliance/jco/blob/main/docs/src/wasi/preview3-shim.md)
- "The Preview 3 shim has no `WASIShim` equivalent yet, so there is no per-instance sandbox and the setters above apply to every component in the process." — [preview3-shim docs](https://github.com/bytecodealliance/jco/blob/main/docs/src/wasi/preview3-shim.md)
- `jco scaffold` built-in worlds "default to WASI 0.3". — [jco README](https://github.com/bytecodealliance/jco/blob/main/README.md)
- `jco run` resolves `@bytecodealliance/preview3-shim/cli` and awaits its `_shutdown()` when present. — [run.ts](https://github.com/bytecodealliance/jco/blob/main/packages/jco/src/cmd/run.ts)
- Transpile flags `--async-mode jspi`, `--async-imports`, `--async-exports` are marked EXPERIMENTAL; a custom `WebAssembly` implementation "must provide the APIs used by the component, including JSPI APIs when needed". — [transpiling.md](https://github.com/bytecodealliance/jco/blob/main/docs/src/transpiling.md)
- jco documents behavioural differences from Wasmtime in instance teardown, stream interruption (`ERR_COMPONENT_STOPPED`), resource ownership and cleanup completion. — [differences-with-wasmtime.md](https://github.com/bytecodealliance/jco/blob/main/docs/src/advanced/differences-with-wasmtime.md)
- jco and jco-transpile are tested on the current even Node release and the two before it (26, 24, 22). — [jco README](https://github.com/bytecodealliance/jco/blob/main/README.md)
- Release cadence: jco 1.39.0 2026-10-16, 1.40.0 2026-10-28, 1.41.0 2026-11-02, 1.42.0 2026-11-13; preview3-shim 0.12.0 2026-10-28 to 0.14.1 2026-11-13. — [jco on npm](https://registry.npmjs.org/@bytecodealliance/jco), [preview3-shim on npm](https://registry.npmjs.org/@bytecodealliance/preview3-shim)

### Inferences
- Since the canonical ABI boundary is linear-memory based, a transpiled component's GC use stays inside its core module, which Node 26's engine would execute natively. That suggests jco can run GC components, but nothing in jco's docs or source that I searched mentions WasmGC, so treat it as untested.
- The process-global P3 shim state means in-process parallel tests of several components would share args, env and preopens; isolate per worker or run serially.
- Useful role: a fast in-process smoke test and a second opinion on canonical-ABI encoding. Not a substitute for Wasmtime as the reference, given the documented lifecycle differences and pre-1.0 shim.

### Gaps
- No statement in jco's documentation of P3 conformance level or known unsupported 0.3 features was found.
- GC core modules through `jco transpile` (including `--optimize`, which shells core modules through Binaryen with default flags that do not enable GC): untested.
- Whether Node 26 needs any flag for JSPI was not checked.

## Developer tooling: validation, printing, wasm-opt and components, debug info

### Takeaway
wasm-tools validates and prints GC and async components with default features. Optimisation must happen on the core module before `component new` (or per inner module afterwards, as jco does). For debug info, Wasmtime consumes DWARF, not source maps, and Binaryen can emit source maps and names but does not generate DWARF.

### Cited Findings
- `wasm-tools validate foo.wasm --features=exception-handling` enables a feature; `--features=-simd` disables one. — [wasm-tools README](https://github.com/bytecodealliance/wasm-tools/blob/main/README.md)
- Defaults in wasmparser: `gc` true, `cm_async` true, `cm_async_stackful` false, `cm_gc` false; the docs recommend enabling all features when decoding. — [features.rs](https://github.com/bytecodealliance/wasm-tools/blob/main/crates/wasmparser/src/features.rs)
- Other subcommands: `parse` (WAT to binary), `print`, `strip` (remove custom sections), `demangle`, `objdump`, `metadata show/add`, `addr2line` ("Translate wasm offsets to filename/line numbers with DWARF"), `component wit`, `json-from-wast`, `wast`. `wasm-tools compose` is marked deprecated. — [wasm-tools README](https://github.com/bytecodealliance/wasm-tools/blob/main/README.md)
- `component new` has a flag controlling whether debug names are added to the generated binary. — [component.rs](https://github.com/bytecodealliance/wasm-tools/blob/main/src/bin/wasm-tools/component.rs)
- Binaryen source maps: it "can read and write source maps (see the `-ism` and `-osm` flags to `wasm-opt`)" and text-format annotations; v124 added `sourcesContent`, `file`, `sourceRoot`. — [Binaryen README](https://github.com/WebAssembly/binaryen/blob/main/README.md), [CHANGELOG](https://github.com/WebAssembly/binaryen/blob/main/CHANGELOG.md)
- binaryen.js debug API at 132: `module.addDebugInfoFileName(filename)`, `getDebugInfoFileName(index)`, `setDebugLocation(func, expr, fileIndex, lineNumber, columnNumber)`, `emitBinary(sourceMapUrl)`, `binaryen.setDebugInfo(on)`. — [132 JS source](https://github.com/WebAssembly/binaryen/blob/version_132/src/js/binaryen.js-post.js)
- Binaryen DWARF: "optional support"; it "primarily just tracks the locations of expressions and rewrites the DWARF's locations accordingly", does not re-index locals, and "passes that might break DWARF are disabled by default", so it "is not suitable for a fully optimized release build". — [Binaryen README](https://github.com/WebAssembly/binaryen/blob/main/README.md)
- Wasmtime native debugging: `wasmtime run -D debug-info foo.wasm` under `gdb`/`lldb`, with `-O opt-level=0` recommended; the stability doc notes there is "no active maintainer of DWARF debugging support". — [native debugger doc](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/examples-debugging-native-debugger.md), [stability-tiers.md](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/stability-tiers.md)
- Wasmtime guest debugging: `wasmtime run -g 1234 foo.wasm` starts a gdbstub server for LLDB (v32 or later with Wasm support; wasi-sdk ships one); published CLI binaries include the feature; it works by code instrumentation on all platforms including Pulley. Introduced as work in progress in Wasmtime 39, with a gdbstub server in 44. — [guest debugging doc](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/examples-debugging-guest.md), [release-44 notes](https://github.com/bytecodealliance/wasmtime/blob/release-44.0.0/RELEASES.md)
- Other Wasmtime diagnostics: `-D coredump=<file>` after a trap, `wasmtime explore` and `wasmtime objdump` for compiled code, profiling guides for perf, VTune and samply. — [cli-flags lib.rs](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/cli-flags/src/lib.rs), [cli-options.md](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/cli-options.md), [docs SUMMARY](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/SUMMARY.md)
- Binaryen trunk (unreleased) adds reading and writing label names in the name section. — [CHANGELOG](https://github.com/WebAssembly/binaryen/blob/main/CHANGELOG.md)

### Inferences
- Order of operations: build core module, optimise it (binaryen.js or `wasm-opt`), then `component embed` and `component new`. Running `wasm-opt` on the finished component is not supported by Binaryen itself.
- With Binaryen `-all`, disable custom descriptors (`--disable-custom-descriptors` or an explicit feature set) so that exact reference types are not emitted; Wasmtime's 50.0 proposal tables do not list custom descriptors at all.
- Source maps from binaryen.js give no benefit inside Wasmtime. Source-level line numbers in Wasmtime backtraces require DWARF sections, which the compiler would have to write itself as custom sections; function, type and field names via the name section are the cheap first step.
- `wasm-tools print` on the final component plus `wasm-tools validate` is a cheap CI gate that is independent of both Binaryen and Wasmtime.

### Gaps
- Whether Wasmtime backtraces symbolise function names from the name section of a core module nested in a component was not verified.
- Whether `wit-component` preserves DWARF custom sections and the name section of the core module in the output component was not verified.
- Whether Wasmtime's guest debugger shows GC struct and array values was not checked.
- Wasmtime's support for the legacy exception encoding (what binaryen.js 132's `try` builder produces) was not verified; a `legacy_exceptions` option was not found in Wasmtime 50's CLI flags.
