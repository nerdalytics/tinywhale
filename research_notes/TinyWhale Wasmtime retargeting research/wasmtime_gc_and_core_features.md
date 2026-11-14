# Wasmtime: WasmGC and core-Wasm proposal support (state as of 14 November 2026)

Method note: release notes, docs and source were read directly from the `bytecodealliance/wasmtime` repository on the `release-NN.0.0` branches (raw files), plus the Bytecode Alliance blog and the WebAssembly/proposals repo. Where a doc comment and the actual code disagree, both are reported. "Unverified" marks anything not confirmed from a primary source. Source-file links point at the `release-50.0.0` branch unless stated otherwise (50.0.x is the latest stable line today).

URL shorthand used below:
- REL-NN = `https://github.com/bytecodealliance/wasmtime/blob/release-NN.0.0/RELEASES.md`
- CONFIG-50 = `https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wasmtime/src/config.rs`
- CLIFLAGS-50 = `https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/cli-flags/src/lib.rs`

---

## 1. Latest stable Wasmtime version, release cadence, LTS policy, and which version to pin

### Takeaway
The latest stable release is **Wasmtime 50.0.1 (2026-10-29)**; 51.0.0 is at rc.1 and due around 20 November 2026. **Wasmtime 48 (released 2026-08-20) is the current LTS** (24 months of support) and already has GC + exceptions on by default, so a new project can pin either 48.0.x (stability) or the newest monthly release (newest GC optimisations).

### Cited Findings
- The GitHub releases page (fetched 2026-11-14) shows `v50.0.1` marked "Latest", published 29 Oct; alongside it `v49.0.5`, `v48.0.8`, `v36.0.20` (all 29 Oct) and a pre-release `v51.0.0-rc.1` (05 Nov) — [GitHub releases](https://github.com/bytecodealliance/wasmtime/releases)
- 50.0.0 was "Released 2026-10-20"; 50.0.1 "Released 2026-10-29" — [RELEASES.md, release-50.0.0](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/RELEASES.md)
- 51.0.0 is "Unreleased" on its release branch; `main` is at 52.0.0 "Unreleased" — [RELEASES.md, release-51.0.0](https://github.com/bytecodealliance/wasmtime/blob/release-51.0.0/RELEASES.md); [RELEASES.md, main](https://github.com/bytecodealliance/wasmtime/blob/main/RELEASES.md)
- Recent major release dates: 44.0.0 2026-04-20; 45.0.0 2026-05-21; 46.0.0 2026-06-22; 47.0.0 2026-07-20; 48.0.0 2026-08-20; 49.0.0 2026-09-21; 50.0.0 2026-10-20 — [REL-44](https://github.com/bytecodealliance/wasmtime/blob/release-44.0.0/RELEASES.md), [REL-45](https://github.com/bytecodealliance/wasmtime/blob/release-45.0.0/RELEASES.md), [REL-46](https://github.com/bytecodealliance/wasmtime/blob/release-46.0.0/RELEASES.md), [REL-47](https://github.com/bytecodealliance/wasmtime/blob/release-47.0.0/RELEASES.md), [REL-48](https://github.com/bytecodealliance/wasmtime/blob/release-48.0.0/RELEASES.md), [REL-49](https://github.com/bytecodealliance/wasmtime/blob/release-49.0.0/RELEASES.md), [REL-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/RELEASES.md)
- Cadence: "A new major version of Wasmtime will be made available on the 20th of each month"; the `release-X.0.0` branch is cut on the 5th; `X.0.0-rc.1` is published at branch time and carries no support/stability guarantees — [Release Process doc](https://docs.wasmtime.dev/stability-release.html)
- LTS: "Each release that is a multiple of 12 is considered an LTS release and is supported for 24 months. Other releases are supported for 2 months." "At any one time Wasmtime has two supported LTS releases and up to two supported normal releases." — [Release Process doc](https://docs.wasmtime.dev/stability-release.html)
- "Security bugs are guaranteed to be backported to all supported releases"; patch releases are "only ... for security and critical correctness issues for on-by-default behavior" and "guaranteed to maintain API and behavior backwards-compatibility"; new features are never backported — [Release Process doc](https://docs.wasmtime.dev/stability-release.html)
- Every major release "reserves the right to break both behavior and API backwards-compatibility" — [Release Process doc](https://docs.wasmtime.dev/stability-release.html)
- 36.0.0 was released 2025-08-20 and is still receiving patches (36.0.20 on 2026-10-29) — [REL-36](https://github.com/bytecodealliance/wasmtime/blob/release-36.0.0/RELEASES.md); [GitHub releases](https://github.com/bytecodealliance/wasmtime/releases)
- Patch-release volume is high: the 48 line reached 48.0.8 within ~10 weeks, mostly security advisories (GHSA links) — [REL-48](https://github.com/bytecodealliance/wasmtime/blob/release-48.0.0/RELEASES.md)

### Inferences
- By the "multiple of 12" rule, the two supported LTS lines today are 36 (to ~Aug 2027) and 48 (to ~Aug 2028); supported normal lines are 49 (to ~20 Nov 2026) and 50 (to ~20 Dec 2026). The docs' version table is rendered by JavaScript and could not be read, so the exact EOL dates are computed, not quoted.
- Pinning recommendation for a GC-based language: **48.0.x LTS** is the first and only LTS with GC/exceptions default-on (36 LTS predates it). The trade-off is that 48 lacks later GC work (e.g. 49: wide-arithmetic default-on; 50: finer GC alias analysis, `Store::gc_heap_grow`). A project that only uses the CLI and wants the fastest GC code should track the latest monthly release and re-pin monthly; always take the latest patch (GC-related security fixes landed in Oct 2026, see section 6).
- 51.0.0 should land around 20 Nov 2026 per the cadence; not yet released as of this research.

### Gaps
- The official supported-versions table (with EOL dates) is JS-rendered and was not retrievable; EOL dates above are derived from the stated policy.

---

## 2. In which version did GC, typed function references and exception handling become default-on?

### Takeaway
The author's belief is **correct for the default compiler (Cranelift)**: GC and exception handling became default-on in **Wasmtime 47.0.0 (2026-07-20)**, and typed function references flipped to default-on in the same release as part of moving the default feature set to "Wasm 3.0". Caveat: with the Winch baseline compiler these are *not* on by default (and GC/function-references are unsupported there).

### Cited Findings
- 47.0.0 "Released 2026-07-20. Added: Wasmtime now has the WebAssembly GC proposal enabled by default. [#13594] ... Wasmtime now has the WebAssembly exception-handling proposal enabled by default. [#13603]" — [REL-47](https://github.com/bytecodealliance/wasmtime/blob/release-47.0.0/RELEASES.md)
- Bytecode Alliance blog, "GC and Exceptions in Wasmtime", Nick Fitzgerald, 20 July 2026: the Wasm GC and exceptions proposals are both enabled by default in the Wasmtime 47 release — [bytecodealliance.org/articles/wasmtime-gc](https://bytecodealliance.org/articles/wasmtime-gc)
- Function references: in the 46 branch the `Config::wasm_function_references` doc says "This feature is `false` by default" and the default feature set is `WASM2` + multi-memory, relaxed-simd, tail-call, extended-const, memory64 — [config.rs, release-46.0.0](https://github.com/bytecodealliance/wasmtime/blob/release-46.0.0/crates/wasmtime/src/config.rs)
- In the 47 branch the same doc says "This feature is `true` by default" and the default set is `features |= WasmFeatures::WASM3` — [config.rs, release-47.0.0](https://github.com/bytecodealliance/wasmtime/blob/release-47.0.0/crates/wasmtime/src/config.rs)
- Current (50) defaults for Cranelift: `features = WasmFeatures::WASM3; features |= WasmFeatures::WIDE_ARITHMETIC;`. For Winch: `WASM2` minus `GC_TYPES`, plus extended-const, memory64, multi-memory — [CONFIG-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wasmtime/src/config.rs)
- `Config::wasm_gc`: "gates `struct` and `array` type definitions and references, the `i31ref` type, and all related instructions ... This feature is `true` by default." `Config::wasm_exceptions`: "`true` by default, except when using `Strategy::Winch` where it defaults to `false`." — [CONFIG-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wasmtime/src/config.rs)
- 50.0.0 "Changed: Winch no longer enables the GC types, exceptions, or tail-call proposals by default as support for these is not yet Tier 1." — [REL-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/RELEASES.md)
- History before 47: GC was implemented but opt-in; e.g. the 44 notes (2026-04-20) add C API support for exceptions and "more support for the GC proposal"; 46 (2026-06-22) adds C API type reflection of GC values — [REL-44](https://github.com/bytecodealliance/wasmtime/blob/release-44.0.0/RELEASES.md); [REL-46](https://github.com/bytecodealliance/wasmtime/blob/release-46.0.0/RELEASES.md)
- A maintainer (cfallin) stated on 26 May 2026 that GC was "not yet tier-1" at that time, i.e. before 47 — [wasmtime issue #13470](https://github.com/bytecodealliance/wasmtime/issues/13470)
- Standardisation status: GC and typed function references finished at WG 2024-07-10, exception handling at WG 2025-07-23; all are part of the Wasm 3.0 spec — [WebAssembly/proposals finished-proposals.md](https://github.com/WebAssembly/proposals/blob/main/finished-proposals.md)
- The legacy (pre-`exnref`) exception encoding is not a supported feature: `wasm_legacy_exceptions` is `#[doc(hidden)]` and deprecated, "only exists for internal usage with the spec testsuite" — [CONFIG-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wasmtime/src/config.rs)

### Conflicts between sources
- No conflict on the headline: RELEASES.md (47.0.0) and the blog post agree on version 47 and date 2026-07-20.
- The 47 release notes do **not** mention function-references explicitly; its default flip is only visible in source/doc-comment diffs between the 46 and 47 branches.
- A search-result snippet referenced "Wasmtime 27.0: Complete Wasm GC support" (a late-2024 Bytecode Alliance post, [link](https://bytecodealliance.org/articles/wasmtime-27.0)); that was implementation completeness behind a flag, not default-on. Not fetched in full — treat details as unverified.

### Inferences
- A compiler targeting Wasmtime >= 47 with Cranelift needs no `-W` flags for `struct`/`array`/`i31`/`ref.cast`/`call_ref`/`try_table`/`throw`.
- binaryen.js must emit the *new* exception encoding (`try_table`/`exnref`), not legacy `try`/`catch`, if exceptions are ever used.

### Gaps
- The PR that flipped function-references (likely #13594) was not opened; the attribution to that PR is unverified.

---

## 3. Which garbage collectors ship, which is default, and their properties/configuration

### Takeaway
Wasmtime ships three collectors — **copying** (Cheney semi-space, stop-the-world, collects cycles), **DRC** (deferred reference counting, no cycle collection) and **null** (never collects). The **copying collector has been the default since 46.0.0 (2026-06-22)**, having first appeared in 45.0.0; before that DRC was the default. Select with `-C collector=drc|null|copying` or `Config::collector`.

### Cited Findings
- 45.0.0 (2026-05-21): "Wasmtime now has an initial implementation of a copying collector for GC, which notably enables collecting cycles unlike the DRC collector. [#13093] [#13107]" — [REL-45](https://github.com/bytecodealliance/wasmtime/blob/release-45.0.0/RELEASES.md)
- 46.0.0 (2026-06-22): "Wasmtime's default garbage collector is now the copying collector instead of the deferred-reference-counting collector. This collector should be more performant in most situations and additionally have the ability to collect cycles. [#13439]" — [REL-46](https://github.com/bytecodealliance/wasmtime/blob/release-46.0.0/RELEASES.md)
- `Collector::Auto` (the default): "Currently this always defaults to the copying collector, but the default value may change over time." Code: Auto resolves to Copying if the `gc-copying` crate feature is built, else DRC, else Null — [CONFIG-50, `enum Collector`](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wasmtime/src/config.rs)
- Official property table (doc comment): Copying — collects garbage "Yes, including cycles", latency poor, throughput good, allocation speed good, heap utilisation poor. DRC — "Yes, but not cycles", latency good, throughput poor, allocation fair, heap utilisation fair. Null — collects nothing; best on all other axes — [CONFIG-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wasmtime/src/config.rs)
- Copying: "splits the GC heap in half, bump-allocates objects in one half until it fills up, and then does a GC and copies live objects into the other half ... suffers from poor latency due to its stop-the-world collections and poor heap utilization due to only using half the GC heap's full capacity at any given time." — [CONFIG-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wasmtime/src/config.rs)
- DRC: avoids refcount updates for on-stack objects and traces the stack at collection time; "This collector cannot currently collect cycles; they will leak until the GC heap's store is dropped." — [CONFIG-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wasmtime/src/config.rs)
- Null: "simply allocates objects until it runs out of memory, at which point further objects allocation attempts will trap"; intended for very short-lived instances and for measuring other collectors' overhead — [CONFIG-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wasmtime/src/config.rs)
- Blog description of the default: "a simple Cheney-style semi-space copying collector"; allocation is a bump pointer; "the collector does not require any read or write barriers" — [bytecodealliance.org/articles/wasmtime-gc](https://bytecodealliance.org/articles/wasmtime-gc)
- Heap design: the GC heap is built on a Wasm linear memory; "A reference to a GC object is not a native pointer, it is a 32-bit index into the GC heap's underlying linear memory." Stated benefits: sandboxing holds even with collector bugs, guard-page bounds-check elision, pooling-allocator integration, compact references — [bytecodealliance.org/articles/wasmtime-gc](https://bytecodealliance.org/articles/wasmtime-gc)
- All three collectors are in the `wasmtime` crate's default features (`gc`, `gc-copying`, `gc-drc`, `gc-null`) — [crates/wasmtime/Cargo.toml, release-50.0.0](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wasmtime/Cargo.toml)
- CLI: `-C collector=<drc|null|copying>` ("Which garbage collector to use") — [CLIFLAGS-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/cli-flags/src/lib.rs)
- GC heap tunables (CLI `-O` group / `Config`): `gc-heap-initial-size` (default 0; heap grows on demand), `gc-heap-reservation`, `gc-heap-reservation-for-growth`, `gc-heap-guard-size`, `gc-heap-may-move`; plus `pooling-total-gc-heaps`. If no `gc_heap_*` option is set they mirror the linear-memory tunables — [CLIFLAGS-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/cli-flags/src/lib.rs); [Config API docs](https://docs.wasmtime.dev/api/wasmtime/struct.Config.html)
- These separate GC tunables were introduced in 45.0.0 ("a separate set of GC tunables different from the main set of tunables for linear memory" #13080), together with an "improved grow-vs-collect heuristic" (#12942) — [REL-45](https://github.com/bytecodealliance/wasmtime/blob/release-45.0.0/RELEASES.md)
- 46.0.0: copying collector got "an in-wasm fast path for its bump allocator" (#13323); GC heap corruption is now reported as a `WasmtimeBug` error instead of panicking/aborting (#13321, #13444) — [REL-46](https://github.com/bytecodealliance/wasmtime/blob/release-46.0.0/RELEASES.md)
- 50.0.0: "A new `Store::gc_heap_grow` method can be used to manually grow the GC heap of a store." — [REL-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/RELEASES.md)
- `Config::gc_support` (CLI `-W gc-support`) turns all GC infrastructure on/off; it is required for wasm_gc, function-references and exceptions — [CONFIG-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wasmtime/src/config.rs)

### Conflicts between sources (stale documentation)
- The `Collector::Copying` doc comment on release-50 still says "Note that this collector is still under construction and is not yet functional", and the CLI help for `-C collector` says "`copying` is the copying garbage collector (not yet implemented)". Both contradict the same file's `Auto` doc ("always defaults to the copying collector"), the code (`Auto` -> `Copying`), the 46.0.0 release note, and the July 2026 blog. Treat the "not yet functional" text as stale — [CONFIG-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wasmtime/src/config.rs); [CLIFLAGS-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/cli-flags/src/lib.rs); [REL-46](https://github.com/bytecodealliance/wasmtime/blob/release-46.0.0/RELEASES.md)

### Inferences
- Because references are 32-bit indices into a linear-memory-backed heap, a single store's GC heap is bounded by a 32-bit address space (4 GiB), and the semi-space design means at most about half is usable for live data. This limit is inferred from the design; no primary source states a maximum number.
- No generational, incremental or concurrent collector exists; pauses scale with live-set size. Fine for a compiler test-suite/CLI workload, relevant for long-running large-heap programs.
- For a language test harness, `-C collector=null` is a useful differential check (isolates collector bugs from codegen bugs).

### Gaps
- No documented maximum GC heap size, and no documented flag to cap the GC heap from the CLI was found (embedders use `ResourceLimiter`; not verified for GC heaps).
- Whether a tunable for the grow-vs-collect ratio (discussed in issue #13470) has landed was not verified.

---

## 4. Known limitations and performance (vs V8 etc.), Cranelift vs Winch, platforms, Pulley

### Takeaway
Wasmtime's own maintainers say its GC throughput/latency "won't match" V8/SpiderMonkey today; the design optimises for many small short-lived instances. GC works only with **Cranelift** (all of x86_64, aarch64, s390x, riscv64 and the Pulley interpreter); **Winch does not support GC or function-references at all**. No rigorous public Wasmtime-vs-V8 GC benchmark was found — only anecdotal issue-thread numbers.

### Cited Findings
- "Our collector's throughput and latency won't match theirs today" (V8, SpiderMonkey); designed for "creating many small, disposable Wasm instances" and "to scale horizontally across many instances" — [bytecodealliance.org/articles/wasmtime-gc](https://bytecodealliance.org/articles/wasmtime-gc)
- Planned performance work named in the blog: extending alias analysis (store-to-load forwarding, redundant-load elimination) with GC type information; next functional milestone is prototyping GC integration with the component model — [bytecodealliance.org/articles/wasmtime-gc](https://bytecodealliance.org/articles/wasmtime-gc)
- 50.0.0 delivered part of that: "Cranelift's alias analysis is faster and more precise, and GC struct fields, array elements, and GC header fields now all have their own alias regions." — [REL-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/RELEASES.md)
- 47.0.0: `call_indirect` of `final` types optimised when GC is enabled (#13572) — [REL-47](https://github.com/bytecodealliance/wasmtime/blob/release-47.0.0/RELEASES.md)
- Open GC performance issues (10 open with labels `wasm-proposal:gc` + `performance` on 2026-11-14) include: #9349 escape analysis for Wasm GC (none today); #13484 subtype checks not done inline in O(1) (type registry supertypes not exposed to Wasm); #13485 `ref.cast` check codegen; #9352 locks taken for subtyping checks; #9347 slow funcref fields/elements in GC objects; #13386 `array.fill`/`array.copy` still libcall-based for some collectors; #15133 subtype-check cache hit costs ~70 ns — [wasmtime issue search](https://github.com/bytecodealliance/wasmtime/issues?q=is%3Aissue%20state%3Aopen%20label%3Awasm-proposal%3Agc%20label%3Aperformance)
- Anecdotal benchmark 1 (Kotlin/Wasm benchmarks, issue #13279, May 2026): originally Wasmtime 44.0.1 was far slower than Node (~8 s for Node vs no output after ~1 min), ~70% of time in the `array.copy` libcall. After fixes (#13382 "Optimize `array.fill` and `array.copy`", #13381) on `main`, 15 May 2026: null 3.455, drc 14.424, copying 3.407, node 6.984 (units not stated; total run time). Issue closed — [wasmtime issue #13279](https://github.com/bytecodealliance/wasmtime/issues/13279)
- Anecdotal benchmark 2 (issue #13470, May 2026, a user's language "Wado"): `syntax_highlight` per iteration — drc 13.45 ms / 38.9 MB RSS; copying 2.34 ms / 38.2 MB; null 1.75 ms / 205 MB. DRC regressed ~2x from 44 to 45 due to the grow-vs-collect heuristic (#12942). Issue still open — [wasmtime issue #13470](https://github.com/bytecodealliance/wasmtime/issues/13470)
- Maintainer statement (fitzgen, May 2026): Wasmtime will not match engines with far more GC engineering investment, but "we shouldn't be multiple order of magnitude slower in general" — [wasmtime issue #13279](https://github.com/bytecodealliance/wasmtime/issues/13279)
- Compiler support matrix: `gc` is supported by Cranelift on x86_64, aarch64, s390x, riscv64 and Pulley; Winch: unsupported on all. Winch on x86_64 "lacks relaxed-simd, function-references, and gc"; on aarch64 also lacks threads and wide-arithmetic; Winch has no s390x/riscv64/Pulley support — [Tiers doc](https://docs.wasmtime.dev/stability-tiers.html)
- Code confirms: with `Strategy::Winch`, `GC`, `FUNCTION_REFERENCES`, `RELAXED_SIMD`, `STACK_SWITCHING` are marked unsupported — [CONFIG-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wasmtime/src/config.rs)
- Winch progress: "initial experimental support" for exception handling in 49.0.0; tail calls on x86_64 and AArch64 in 50.0.0; neither is default-on under Winch — [REL-49](https://github.com/bytecodealliance/wasmtime/blob/release-49.0.0/RELEASES.md); [REL-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/RELEASES.md)
- Winch does handle `externref`-style GC references (params, results, locals, globals, stack maps, barriers) but not the GC proposal's types — [Tiers doc, footnote a](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/stability-tiers.md)
- Pulley (portable interpreter, Tier 2 "More time fuzzing/baking"): Cranelift-to-Pulley supports every listed proposal including gc, except threads and stack-switching — [Tiers doc](https://docs.wasmtime.dev/stability-tiers.html)
- Platform tiers: Tier 1 targets are x86_64 Linux (gnu), macOS, Windows (msvc). Tier 2: aarch64 Linux, aarch64 macOS, s390x Linux, x86_64 Windows-gnu (missing "continuous fuzzing"). Tier 3: riscv64gc Linux, aarch64 Windows, musl targets, Android, iOS, etc. — [Tiers doc](https://docs.wasmtime.dev/stability-tiers.html)
- Fuzzing blind spot acknowledged: wasm-smith "will never generate non-nullable references" for GC programs; two extra GC-specific fuzzers exist — [bytecodealliance.org/articles/wasmtime-gc](https://bytecodealliance.org/articles/wasmtime-gc)
- Context only (not Wasmtime): Andy Wingo's Wastrel AOT posts are the nearest thing to published WasmGC micro-benchmarks outside browsers — [wingolog, Feb 2026](https://wingolog.org/archives/2026/02/06/ahead-of-time-wasm-gc-in-wastrel) (found via search, not read in full; unverified)

### Inferences
- Missing escape analysis and non-inline subtype checks mean that allocation-heavy functional code (tuples, closures, small records, `ref.cast`-heavy pattern matching) pays full allocation/cast cost in Wasmtime; a compiler targeting it benefits from doing its own unboxing/scalar replacement (TinyWhale's existing "flatten into locals" path remains valuable as an optimisation) and from running Binaryen's GC optimisations (`--gufa`, type refinement, heap2local) before handing code to Wasmtime.
- The non-nullable-reference fuzzing blind spot is relevant: a statically typed language will naturally emit lots of `(ref $t)`; that is the less-fuzzed path.
- Apple Silicon developer machines are Tier 2 for Wasmtime; CI on x86_64 Linux is the Tier 1 path.

### Gaps
- No controlled, published benchmark comparing Wasmtime's GC with V8/SpiderMonkey/WasmEdge etc. was found. A third-party blog (hostmycode.com) gives numbers without methodology and was excluded as unreliable.
- No numbers for GC pause times or for GC on Pulley were found.

---

## 5. Status of other proposals relevant to a language implementer

### Takeaway
With Cranelift on Wasmtime 50 the default feature set is "Wasm 3.0 + wide-arithmetic": tail calls, multi-value, multi-memory, memory64, bulk memory, reference types, function references, GC, exceptions, extended-const, SIMD/relaxed-SIMD and threads (shared memory + atomics) are all on. Off by default: custom-page-sizes, branch-hinting, compact-imports, stack-switching (WIP, x86_64 only), shared-everything-threads (unimplemented). Stringref does not exist in Wasmtime.

### Cited Findings

Per-proposal table (Wasmtime 50, Cranelift). CLI flags are `-W <name>[=y|n]`; `wasmtime -W help` lists them. Flag names are the Rust field names in the CLI option struct with `_` shown as `-`.

| Proposal | Default | CLI flag / Config | Tier | Notes and source |
|---|---|---|---|---|
| multi-value | on | `-W multi-value` / `wasm_multi_value` | 1 | [Proposals doc](https://docs.wasmtime.dev/stability-wasm-proposals.html) |
| bulk-memory | on | `-W bulk-memory` | 1 | [Proposals doc](https://docs.wasmtime.dev/stability-wasm-proposals.html) |
| reference-types | on | `-W reference-types` | 1 | Winch not Tier 1 — [Proposals doc](https://docs.wasmtime.dev/stability-wasm-proposals.html) |
| tail-call | on (Cranelift); off under Winch since 50 | `-W tail-call` / `wasm_tail_call` | 1 | Default-on since 22.0.0 (2024-06-20); 21.0.0 intended it but a mistake left it off. — [REL-22](https://github.com/bytecodealliance/wasmtime/blob/release-22.0.0/RELEASES.md); [REL-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/RELEASES.md) |
| multi-memory | on | `-W multi-memory` | 1 | [CONFIG-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wasmtime/src/config.rs) |
| memory64 | on | `-W memory64` | 1 | Default-on and Tier 1 since 30.0.0 (2025-02-20). — [REL-30](https://github.com/bytecodealliance/wasmtime/blob/release-30.0.0/RELEASES.md) |
| extended-const | on | `-W extended-const` | 1 | [CONFIG-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wasmtime/src/config.rs) |
| function-references | on since 47 | `-W function-references` | 1 | See section 2 |
| gc | on since 47 | `-W gc`, `-W gc-support` | 1 | See section 2 |
| exception-handling | on since 47 | `-W exceptions` | 1 | See section 2 |
| wide-arithmetic | on since 49.0.0 (2026-09-21) | `-W wide-arithmetic` | 1 | "The wide-arithmetic WebAssembly proposal is now enabled by default." Phase 4 upstream. — [REL-49](https://github.com/bytecodealliance/wasmtime/blob/release-49.0.0/RELEASES.md); [WebAssembly/proposals](https://github.com/WebAssembly/proposals/blob/main/README.md) |
| simd / relaxed-simd | on | `-W simd`, `-W relaxed-simd` | 1 | [Proposals doc](https://docs.wasmtime.dev/stability-wasm-proposals.html) |
| threads (shared memory, atomics) | on when the `threads` crate feature is built (default) | `-W threads`, `-W shared-memory` | 2 | No thread spawning in core proposal; known issues (#4245), not in pooling allocator, not fuzzed, unsupported on Pulley. wasi-threads was removed in 47. — [CONFIG-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wasmtime/src/config.rs); [Proposals doc](https://docs.wasmtime.dev/stability-wasm-proposals.html); [REL-47](https://github.com/bytecodealliance/wasmtime/blob/release-47.0.0/RELEASES.md) |
| custom-page-sizes | off | `-W custom-page-sizes` | 2 | Only 64 KiB and 1-byte pages valid. Phase 3 upstream. — [CONFIG-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wasmtime/src/config.rs); [WebAssembly/proposals](https://github.com/WebAssembly/proposals/blob/main/README.md) |
| branch-hinting | off ("until the proposal has been fuzzed") | `-W branch-hinting` / `wasm_branch_hinting` | 3 | Added in 46.0.0; hints are advisory (cold-block layout). Finished upstream (Wasm 3.0). — [REL-46](https://github.com/bytecodealliance/wasmtime/blob/release-46.0.0/RELEASES.md); [Proposals doc](https://docs.wasmtime.dev/stability-wasm-proposals.html) |
| compact-import-section | off (pending fuzzing) | `-W compact-imports` / `wasm_compact_imports` | 3 | Added in 50.0.0. Phase 4 upstream. — [REL-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/RELEASES.md) |
| stack-switching | off | `-W stack-switching` / `wasm_stack_switching` | 3 | WIP; tests/finished marked in-progress, no API, not fuzzed. Docs say "only for x86_64 Linux"; code allows x86_64 Linux and macOS, never Pulley or Winch. Phase 3 upstream. Release notes for 48 and 50 say "Work continues". — [Proposals doc](https://docs.wasmtime.dev/stability-wasm-proposals.html); [CONFIG-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wasmtime/src/config.rs); [REL-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/RELEASES.md) |
| shared-everything-threads | unimplemented | `-W shared-everything-threads` exists as a validator gate only | n/a | Listed under "Unimplemented proposals" (#9466). Phase 1 upstream. — [Proposals doc](https://docs.wasmtime.dev/stability-wasm-proposals.html); [WebAssembly/proposals](https://github.com/WebAssembly/proposals/blob/main/README.md) |
| stringref (reference-typed strings) | not present | none | n/a | Not mentioned anywhere in the proposals doc, tiers doc, Config or CLI flags. Phase 1 upstream. — [Proposals doc](https://docs.wasmtime.dev/stability-wasm-proposals.html); [WebAssembly/proposals](https://github.com/WebAssembly/proposals/blob/main/README.md) |
| JS string builtins | not applicable | none | n/a | Finished upstream (WG 2025-07-23) but a JS-embedding API feature; no Wasmtime flag exists. — [finished-proposals.md](https://github.com/WebAssembly/proposals/blob/main/finished-proposals.md); [CLIFLAGS-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/cli-flags/src/lib.rs) |
| flexible-vectors, memory-control | unimplemented | none | n/a | [Proposals doc](https://docs.wasmtime.dev/stability-wasm-proposals.html) |
| component-model GC (`-W component-model-gc`) | off | `wasm_component_model_gc` | n/a | GC types cannot yet cross component boundaries by default; blog calls component-model GC integration the "next big milestone" to prototype. — [CLIFLAGS-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/cli-flags/src/lib.rs); [blog](https://bytecodealliance.org/articles/wasmtime-gc) |

- Definition of default-on: "on-by-default features require no explicit action to use the feature"; default-on requires Phase 4, passing spec tests, finished implementation on Tier 1 targets, at least a week of fuzzing, Rust API and C API — [Proposals doc](https://docs.wasmtime.dev/stability-wasm-proposals.html)
- Other upstream phases (for planning): custom descriptors Phase 3; more array constructors Phase 1; multibyte array access Phase 2; type imports Phase 1 — [WebAssembly/proposals](https://github.com/WebAssembly/proposals/blob/main/README.md)

### Conflicts between sources (stale documentation)
- `Config::wasm_memory64` doc comment (release-50) says "the upstream specification is not finalized ... This is `false` by default", but the code enables it by default (`WASM3`, and already in 46's explicit list), the 30.0.0 release note says default-on/Tier 1, and the proposals doc lists it as Tier 1. The doc comment is stale — [CONFIG-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/wasmtime/src/config.rs); [REL-30](https://github.com/bytecodealliance/wasmtime/blob/release-30.0.0/RELEASES.md)
- Stack-switching platform scope: docs say x86_64 Linux only; `config.rs` treats x86_64 Linux and macOS as supported.

### Inferences
- No string type is provided by the runtime: strings must be `(array (mut i8))` (or i16) GC arrays or linear memory, with all string operations compiled in or imported. Passing strings to WASI or the host from a core module requires copying into linear memory, as WASI p1 and the component model's canonical ABI are linear-memory based (component-model GC is off/experimental).
- Tail calls being Tier 1 and default-on (Cranelift) makes guaranteed TCO a safe language-level promise on Wasmtime; closures can use `call_ref` with typed function references plus GC structs for environments.
- Stack switching is not usable for effect handlers/coroutines in a portable way yet; exceptions are available for non-local control flow.

### Gaps
- Whether wasmparser's `WASM3` set includes `THREADS` was not checked in wasmparser source; the "threads on by default" row relies on the Config doc comment and the tiers doc.
- Custom descriptors, more-array-constructors and multibyte-array-access have no entry in Wasmtime's proposals doc; presumed unimplemented but not explicitly stated.

---

## 6. Tier/stability documentation: production readiness and security coverage of GC

### Takeaway
As of the 47+ docs, **`gc`, `function-references` and `exception-handling` are Tier 1 ("Production Ready") WebAssembly proposals** under Cranelift, and Tier 1 features are within the security policy (CVEs/security releases). GC-related security advisories have in fact been issued and patched in Oct 2026.

### Cited Findings
- Tier 1 WebAssembly proposals list includes `function-references`, `gc`, `exception-handling`, `wide-arithmetic`, `tail-call`, `memory64`, `multi-memory` etc.; each carries the footnote "Winch does not yet support this proposal at Tier 1" where applicable — [Proposals doc](https://docs.wasmtime.dev/stability-wasm-proposals.html); [Tiers doc](https://docs.wasmtime.dev/stability-tiers.html)
- Tier 1 is titled "Production Ready": "the highest level of support in Wasmtime for any particular feature, indicating that it is suitable for production environments"; includes continuous fuzzing and "CVEs and security releases will be performed as necessary for any bugs found" — [Tiers doc](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/stability-tiers.md)
- Security scope: "Bugs must affect a tier 1 platform or feature to be considered a security vulnerability." Sandbox escapes, host memory unsafety and execution-time DoS (panics, aborts) count; "execution that diverges from Wasm semantics (such as computing incorrect values)" confined to the sandbox does not — [What is considered a security vulnerability?](https://docs.wasmtime.dev/security-what-is-considered-a-security-vulnerability.html)
- Compilers are "not required to support the full matrix of all tier 1 targets/proposals" — Tier 1 status of GC applies via Cranelift — [Tiers doc](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/stability-tiers.md)
- Tier 2 = "Almost Production Ready" (e.g. aarch64 targets, Pulley, threads, custom-page-sizes); Tier 3 = "Not Production Ready" (riscv64, stack-switching, branch-hinting, compact-imports, DWARF debugging) — [Tiers doc](https://docs.wasmtime.dev/stability-tiers.html)
- GC/exception-related security fixes since default-on: "Mis-typed WebAssembly tag imports can lead to GC heap corruption" (GHSA-cfhf-m2cr-62wj) and "Rooting for GC values live across `try_call` may be missing, causing GC heap corruption" (GHSA-hw8m-q44c-ggrf), fixed 2026-10-02 in 48.0.4/49.0.2; "Exception tags can cause host data structures to be unaligned" (GHSA-p79w-pv2r-29qp), 2026-10-14; "Cross-engine type confusion with host-created struct-types-with-supertypes" (GHSA-qw58-7h65-crq2) and "Panic with typed functions with `i31` or `nullref` arguments" (GHSA-3982-jqvv-277m), 2026-10-29 in 48.0.8/49.0.5/50.0.1; 47.0.3 (2026-07-31) fixed type-index mixing between engines (GHSA-hgjw-h833-99q9) — [REL-48](https://github.com/bytecodealliance/wasmtime/blob/release-48.0.0/RELEASES.md); [REL-49](https://github.com/bytecodealliance/wasmtime/blob/release-49.0.0/RELEASES.md); [REL-47](https://github.com/bytecodealliance/wasmtime/blob/release-47.0.0/RELEASES.md)
- Sandboxing argument for GC: because the GC heap is a linear memory indexed by 32-bit offsets, collector bugs corrupt only the guest's GC heap rather than host memory; corruption is surfaced as a `WasmtimeBug` error (since 46) — [blog](https://bytecodealliance.org/articles/wasmtime-gc); [REL-46](https://github.com/bytecodealliance/wasmtime/blob/release-46.0.0/RELEASES.md)

### Inferences
- GC went from "not tier-1, no stability commitment" (maintainer comment, late May 2026) to Tier 1 in under two months; it is officially production-ready but young. The stream of October 2026 advisories shows both active scrutiny and that bugs are still being found — pin to the latest patch release.
- Several of those advisories involve the embedder API (host-created types, multiple engines, `try_call`), which a CLI-only workflow does not exercise.

### Gaps
- The docs do not single out individual collectors by tier; it is not stated whether DRC and null are covered at the same tier as the default copying collector.
- Severity ratings of the listed GHSAs were not checked.

---

## 7. Running a core GC module from the CLI, inspecting results, and debugging support

### Takeaway
`wasmtime run --invoke <export> module.wasm <args...>` calls an exported function of a core module and prints numeric results one per line, but the argument/result syntax is officially unstable and GC references print only as opaque placeholders (`<anyref>`). Debugging options: gdbstub-based guest debugging with LLDB (`-g <port>`, since 44), native DWARF debugging (`-D debug-info`, Tier 3), Wasm core dumps (`-D coredump=`), and perf/VTune/samply/guest profilers.

### Cited Findings
- "`wasmtime run --invoke initialize foo.wasm`" invokes a named export of a core module; "`wasmtime run --invoke add add.wasm 1 2`" passes arguments parsed from CLI args. "this syntax is unstable at this time and may change in the future" — [CLI options doc](https://docs.wasmtime.dev/cli-options.html)
- All Wasmtime options must come before the wasm file; arguments after it go to the module — [CLI options doc](https://docs.wasmtime.dev/cli-options.html)
- Implementation detail (release-50 `run.rs`): results are printed with `println!`, one per line — i32/i64 as decimal, f32/f64 via Rust float formatting, v128 as a u128; reference results print only `<anyref>` / `<null anyref>`, `<externref>`, `<funcref>`, `<exnref>`, `<contref>`. Warnings are printed to stderr: "using `--invoke` with a function that takes arguments is experimental and may break in the future" and likewise for functions that return values — [src/commands/run.rs, release-50.0.0](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/src/commands/run.rs)
- Without `--invoke`, a core module's `_start` (or the empty-string export) is run — [CLI options doc](https://docs.wasmtime.dev/cli-options.html)
- Components use WAVE syntax instead: `--invoke 'add(1, 2)'` — [CLI options doc](https://docs.wasmtime.dev/cli-options.html)
- Option groups: `-O` (optimize/tuning), `-C` (codegen), `-D` (debug), `-W` (wasm semantics), `-S` (WASI); each takes `KEY[=VAL[,..]]`; `-W help`, `-C help`, etc. list keys. Also settable via `--config <toml>` and, since 49.0.0, environment variables `WASMTIME_<GROUP>_<OPTION>` — [CLI options doc](https://docs.wasmtime.dev/cli-options.html); [REL-49](https://github.com/bytecodealliance/wasmtime/blob/release-49.0.0/RELEASES.md)
- Relevant `-W` keys: `gc`, `gc-support`, `function-references`, `exceptions`, `tail-call`, `memory64`, `multi-memory`, `threads`, `stack-switching`, `custom-page-sizes`, `wide-arithmetic`, `branch-hinting`, `compact-imports`, `extended-const`. Relevant `-C` keys: `compiler=cranelift|winch`, `collector=drc|null|copying`, `inlining`, `cranelift-debug-verifier` — [CLIFLAGS-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/cli-flags/src/lib.rs)
- `-D` keys: `debug-info` (DWARF), `guest-debug`, `address-map`, `logging`, `log-to-files`, `coredump=<file>`, `debugger=<component>`; `-D max-backtrace=N` since 45 — [CLIFLAGS-50](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/crates/cli-flags/src/lib.rs); [REL-45](https://github.com/bytecodealliance/wasmtime/blob/release-45.0.0/RELEASES.md)
- Guest debugging: since 44.0.0 "The `wasmtime` CLI now supports a `-g` flag which runs a built-in wasm program to host a `gdbstub`-compatible server (can be connected to with LLDB)". Usage: `wasmtime run -g 1234 foo.wasm`, then in LLDB `process connect --plugin wasm connect://127.0.0.1:1234`; needs LLDB "v32 or later" with Wasm support (wasi-sdk ships one); published CLI binaries include the `gdbstub` feature; works on all native ISAs and Pulley because it is instrumentation-based; allows Wasm-bytecode-level single-stepping and breakpoints — [REL-44](https://github.com/bytecodealliance/wasmtime/blob/release-44.0.0/RELEASES.md); [Guest debugging doc](https://docs.wasmtime.dev/examples-debugging-guest.html)
- Native debugging: `lldb -- wasmtime run -D debug-info foo.wasm` (optionally `-O opt-level=0`) to debug guest + host via DWARF translation — [Native debugger doc](https://docs.wasmtime.dev/examples-debugging-native-debugger.html)
- DWARF debugging is Tier 3: "Currently there is no active maintainer of DWARF debugging support and support is currently best-effort. Additionally there are known shortcomings and bugs." — [Tiers doc](https://github.com/bytecodealliance/wasmtime/blob/release-50.0.0/docs/stability-tiers.md)
- `Config::debug_info` and `Config::guest_debug` are not compatible with Winch — [Config API docs](https://docs.wasmtime.dev/api/wasmtime/struct.Config.html)
- Core dumps: `wasmtime -D coredump=./trap.coredump ./trap.wasm` writes the standard Wasm core-dump format on trap, consumable by tools such as `wasmgdb` — [Core dumps doc](https://docs.wasmtime.dev/examples-debugging-core-dumps.html)
- Profiling: perf (Linux), VTune (Intel, Linux/Windows), samply (Linux/macOS), and a cross-platform guest profiler that measures only guest time and writes a Firefox-profiler-format file; since 45 a `wasmtime hot-blocks` subcommand shows hot Wasm basic blocks from perf data — [Profiling doc](https://docs.wasmtime.dev/examples-profiling.html); [REL-45](https://github.com/bytecodealliance/wasmtime/blob/release-45.0.0/RELEASES.md)
- Other subcommands sharing these option groups: `compile`, `explore`, `wast`, `serve` — [CLI options doc](https://docs.wasmtime.dev/cli-options.html)

### Inferences
- For end-to-end tests of a GC-based language, `--invoke` is only good for functions returning scalars. Records/lists/strings returned as GC refs are opaque on the CLI, so a test harness should either (a) export accessor/"to-scalar" functions, (b) print via WASI `fd_write` from linear memory, (c) use `wasmtime wast` scripts with `assert_return` on scalar projections, or (d) embed Wasmtime via an API (Rust/C; wasmtime-py etc. exist but lag features) to inspect `StructRef`/`ArrayRef`.
- Parsing of `--invoke` output should be isolated behind one harness function because the format is declared unstable, and stderr warnings must be ignored.
- Debuggers' source-level features rely on DWARF in the module; Binaryen-emitted modules need DWARF or at least a name section for readable backtraces. How well LLDB/gdbstub display WasmGC struct/array values is not documented.

### Gaps
- No documentation found on inspecting GC heap objects (struct fields, arrays) in the gdbstub debugger or in core dumps; whether core dumps include the GC heap is unverified.
- `wasmtime wast` support details for GC-typed `assert_return` (e.g. `ref.struct`, `ref.i31` patterns) were not checked.
- Exact spelling of some CLI keys (hyphenated forms) is inferred from Rust field names; confirm with `wasmtime -W help` / `-C help` / `-O help` / `-D help` on the pinned version.
