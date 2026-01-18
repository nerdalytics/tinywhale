# SpecTec Integration Analysis for TinyWhale

## Executive Summary

**SpecTec** is a domain-specific language (DSL) adopted by the WebAssembly community in March 2025 for formally specifying language semantics. It provides a single source of truth that generates formal LaTeX specifications, reference interpreters, and Coq proof definitions.

This document analyzes whether and how SpecTec could be integrated into TinyWhale to formally specify the entire language.

---

## 1. What is SpecTec?

SpecTec is a DSL designed to express programming language semantics in "textbook-style" mathematical notation. From a single SpecTec source, it can generate:

1. **LaTeX Formal Specifications** - Publication-quality type rules and evaluation rules
2. **Reference Interpreter** - Executable semantics that can run test suites
3. **Coq Definitions** - Mechanized proofs in the Coq/Rocq proof assistant
4. **Prose Descriptions** - Human-readable pseudocode documentation

### SpecTec DSL Constructs

| Keyword | Purpose | Example |
|---------|---------|---------|
| `syntax` | Abstract syntax/types | `syntax valtype = I32 \| I64 \| F32 \| F64` |
| `relation` | Typing/evaluation predicates | `relation Instr_ok: context \|- instr : functype` |
| `rule` | Inference rules | `rule Instr_ok/nop: C \|- NOP : eps -> eps` |
| `def` | Meta-level functions | `def $local(state, x) = ...` |
| `grammar` | Binary/text format grammars | `grammar Bvaltype : valtype = \| 0x7F => I32` |
| `var` | Meta-variable declarations | `var C : context` |

---

## 2. Current TinyWhale Specification State

### How TinyWhale Currently Specifies Language Semantics

| Aspect | Current Approach | Location |
|--------|------------------|----------|
| **Syntax** | Ohm PEG grammar | `src/parse/tinywhale.ohm` |
| **AST Types** | TypeScript enums/types | `src/core/nodes.ts`, `src/core/tokens.ts` |
| **Type System** | Imperative TypeScript code | `src/check/*.ts` |
| **Semantics** | Imperative TypeScript code | `src/check/checker.ts`, `src/codegen/index.ts` |
| **Documentation** | Markdown prose | `docs/*.md` |

### Current Architecture Strengths

- **Data-oriented design** with dense arrays and branded types
- **Modular checker** split into focused modules
- **Property-based testing** for compiler invariants
- **Clear separation of phases** (lex → parse → check → codegen)

### Current Gaps

1. **No formal specification** - Semantics are defined only in implementation code
2. **No mechanized proofs** - Type safety is not formally verified
3. **Documentation/implementation drift risk** - Prose docs can diverge from code
4. **No reference interpreter** - Only the full compiler exists

---

## 3. Integration Feasibility Analysis

### 3.1 Can SpecTec Specify TinyWhale?

**Yes, with adaptation.** SpecTec was designed for WebAssembly but its core abstractions are general enough for any typed language with similar structure:

| TinyWhale Feature | SpecTec Support | Notes |
|-------------------|-----------------|-------|
| Primitive types (`i32`, `i64`, `f32`, `f64`) | ✅ Native | Same as Wasm |
| Nominal types (`type X = i32`) | ✅ Expressible | Define as distinct syntax variant |
| Record types | ✅ Expressible | Use record syntax definitions |
| Fixed-size lists | ✅ Expressible | Parameterized syntax |
| Pattern matching | ✅ Expressible | Define match semantics as rules |
| Refinement types | ⚠️ Requires extension | Side conditions can encode constraints |
| Indentation syntax | ⚠️ Not designed for | SpecTec handles abstract syntax, not concrete |

### 3.2 What Would a SpecTec Specification of TinyWhale Look Like?

```spectec
;; ==========================================
;; Abstract Syntax
;; ==========================================

syntax valtype = I32 | I64 | F32 | F64
syntax typeid hint(show %) = nat  ;; Type table indices

syntax typeref =
  | PRIM valtype
  | NAMED typeid
  | LIST typeref nat        ;; [T; size]
  | REFINED valtype int int ;; T<min, max>

syntax field = (name, typeref)
syntax typedef =
  | DISTINCT name typeref
  | RECORD name field*

syntax pattern =
  | WILDCARD
  | LITERAL val
  | BINDING name
  | OR pattern pattern

syntax matcharm = (pattern, expr)

syntax expr =
  | CONST valtype val
  | VAR name
  | BINOP binop expr expr
  | UNOP unop expr
  | FIELD expr name
  | INDEX expr nat
  | LIST expr*
  | RECORD (name, expr)*
  | MATCH expr matcharm*

syntax stmt =
  | BIND name typeref expr
  | PANIC

syntax program = typedef* stmt*

;; ==========================================
;; Typing Relations
;; ==========================================

syntax context = {
  TYPES typedef*,
  VARS (name, typeref)*
}

relation Expr_ok: context |- expr : typeref

rule Expr_ok/const-i32:
  C |- CONST I32 n : PRIM I32

rule Expr_ok/var:
  C |- VAR x : t
  -- if (x, t) <- C.VARS

rule Expr_ok/binop-add-i32:
  C |- BINOP ADD e1 e2 : PRIM I32
  -- if C |- e1 : PRIM I32
  -- if C |- e2 : PRIM I32

rule Expr_ok/field:
  C |- FIELD e f : t
  -- if C |- e : NAMED id
  -- if C.TYPES[id] = RECORD _ fields
  -- if (f, t) <- fields

rule Expr_ok/index:
  C |- INDEX e i : t
  -- if C |- e : LIST t n
  -- if i < n

rule Expr_ok/match:
  C |- MATCH e arms : t
  -- if C |- e : t_scrutinee
  -- if (forall (p, body) <- arms:
        C |- p : t_scrutinee /\
        C |- body : t)

;; ==========================================
;; Evaluation Semantics (Small-Step)
;; ==========================================

syntax val =
  | I32_VAL int
  | I64_VAL int
  | F32_VAL float
  | F64_VAL float
  | RECORD_VAL (name, val)*
  | LIST_VAL val*

syntax store = (name, val)*

relation Step: store; expr ~> store; expr

rule Step/binop-add-i32:
  s; BINOP ADD (CONST I32 n1) (CONST I32 n2) ~>
  s; CONST I32 $(n1 + n2)

rule Step/field:
  s; FIELD (RECORD_VAL fields) f ~> s; v
  -- if (f, v) <- fields

rule Step/index:
  s; INDEX (LIST_VAL vals) i ~> s; vals[i]

rule Step/match-hit:
  s; MATCH v ((p, body) :: _) ~> s'; body
  -- if $matches(p, v) = (true, bindings)
  -- if s' = s ++ bindings

rule Step/match-miss:
  s; MATCH v ((p, _) :: rest) ~> s; MATCH v rest
  -- if $matches(p, v) = (false, _)

;; ==========================================
;; Meta-Functions
;; ==========================================

def $matches(pattern, val) : (bool, store)

def $matches(WILDCARD, v) = (true, eps)
def $matches(LITERAL c, c) = (true, eps)
def $matches(LITERAL c, v) = (false, eps)  -- if v =/= c
def $matches(BINDING x, v) = (true, (x, v))
def $matches(OR p1 p2, v) = $matches(p1, v)  -- if fst($matches(p1, v))
def $matches(OR p1 p2, v) = $matches(p2, v)  -- otherwise
```

---

## 4. Integration Strategies

### Strategy A: Specification-First (Recommended for New Languages)

**Approach:** Write the formal SpecTec specification first, then generate implementation artifacts.

```
SpecTec Spec (.watsup)
        │
        ├──► LaTeX Documentation
        ├──► Reference Interpreter (for testing)
        ├──► Coq Proofs (type safety)
        └──► [Custom Backend] ──► TypeScript Checker
```

**Pros:**
- Single source of truth
- Guaranteed consistency between spec and implementation
- Mechanized proofs available

**Cons:**
- Requires rewriting existing implementation
- SpecTec tooling is OCaml-based (not TypeScript)
- Custom backend development needed

**Effort:** High (6+ months for a complete rewrite)

---

### Strategy B: Parallel Specification (Recommended for TinyWhale)

**Approach:** Maintain SpecTec specification alongside TypeScript implementation, using tests to verify consistency.

```
SpecTec Spec (.watsup)           TypeScript Implementation
        │                                    │
        ├──► LaTeX Docs                      │
        ├──► Reference Interpreter ◄─────────┤ (cross-validation)
        └──► Coq Proofs                      │
                                             ▼
                                    Binaryen Codegen
```

**Implementation Steps:**

1. **Create `/spec/` directory** with SpecTec files:
   - `spec/syntax.watsup` - Abstract syntax
   - `spec/typing.watsup` - Type system rules
   - `spec/semantics.watsup` - Evaluation rules
   - `spec/README.md` - How to build and use

2. **Set up SpecTec toolchain** (OCaml-based):
   ```bash
   # Install SpecTec
   opam install spectec

   # Generate LaTeX
   watsup spec/*.watsup -o latex

   # Generate reference interpreter
   watsup spec/*.watsup -o interpreter
   ```

3. **Cross-validate with test suite:**
   - Run same `.tw` programs through both TypeScript compiler and SpecTec interpreter
   - Assert identical type errors and runtime behavior

4. **Generate Coq proofs** for type safety theorems

**Pros:**
- Preserves existing investment in TypeScript compiler
- Incremental adoption possible
- Formal specification provides independent validation

**Cons:**
- Two implementations to maintain
- Risk of specification/implementation drift (mitigated by tests)

**Effort:** Medium (2-3 months for initial specification)

---

### Strategy C: Documentation-Only Specification

**Approach:** Use SpecTec only for generating formal documentation, not as an executable specification.

```
SpecTec Spec (.watsup)
        │
        └──► LaTeX Documentation (formal type rules, etc.)

TypeScript Implementation (remains authoritative)
```

**Pros:**
- Lowest effort
- Improves documentation quality
- No runtime tooling required

**Cons:**
- No mechanized verification
- Specification can drift from implementation
- Limited value beyond documentation

**Effort:** Low (1-2 months)

---

## 5. Technical Requirements

### SpecTec Toolchain Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| OCaml | 4.14+ | SpecTec runtime |
| opam | 2.0+ | Package manager |
| LaTeX | TeXLive 2023+ | Documentation generation |
| Coq/Rocq | 8.18+ | (Optional) Proof generation |

### Repository Structure Changes

```
tinywhale/
├── packages/
│   └── compiler/          # Existing TypeScript compiler
├── spec/                  # NEW: SpecTec specification
│   ├── syntax.watsup      # Abstract syntax
│   ├── typing.watsup      # Type system
│   ├── semantics.watsup   # Operational semantics
│   ├── auxiliary.watsup   # Helper functions
│   └── Makefile           # Build LaTeX/interpreter
├── docs/
│   └── formal/            # NEW: Generated LaTeX PDFs
└── test/
    └── cross-validation/  # NEW: Spec vs impl tests
```

---

## 6. Challenges and Limitations

### 6.1 SpecTec Limitations for TinyWhale

| Challenge | Description | Mitigation |
|-----------|-------------|------------|
| **Indentation syntax** | SpecTec handles abstract syntax, not concrete/surface syntax | Keep Ohm grammar for parsing; SpecTec specifies post-parse AST |
| **Binaryen codegen** | SpecTec generates interpreters, not optimized Wasm | Use SpecTec for semantics only; keep Binaryen for production |
| **TypeScript ecosystem** | SpecTec is OCaml; no direct TypeScript generation | Cross-validate via test suite |
| **Refinement types** | SpecTec has limited dependent type support | Encode constraints as side conditions |

### 6.2 When NOT to Use SpecTec

- If the primary goal is just "better documentation," simpler tools (mdBook, Sphinx) may suffice
- If the team lacks OCaml expertise and formal methods background
- If rapid iteration is more important than formal correctness

---

## 7. Recommended Path Forward

### Phase 1: Experiment (2-4 weeks)

1. Install SpecTec toolchain locally
2. Write a minimal SpecTec specification covering:
   - Primitive types only
   - A few typing rules (const, binop)
   - Basic evaluation rules
3. Generate LaTeX output and reference interpreter
4. Evaluate usability and team fit

### Phase 2: Core Specification (1-2 months)

1. Specify complete type system in SpecTec
2. Specify complete operational semantics
3. Set up CI to build specification artifacts
4. Create cross-validation test harness

### Phase 3: Formal Verification (2-3 months)

1. Generate Coq definitions from SpecTec
2. Prove type safety (progress + preservation)
3. Document proof structure and assumptions

### Phase 4: Maintenance

1. Update SpecTec spec when language changes
2. Keep cross-validation tests passing
3. Regenerate documentation on releases

---

## 8. Conclusion

**SpecTec can be integrated into TinyWhale** to provide a formal specification of the language. The recommended approach is **Strategy B: Parallel Specification**, which:

- Preserves the existing TypeScript compiler
- Adds a formal, executable specification as a second source of truth
- Enables mechanized proofs of type safety
- Generates high-quality formal documentation

The main costs are:
- Learning OCaml/SpecTec toolchain
- Maintaining two representations
- Building cross-validation infrastructure

For a research/educational compiler like TinyWhale, the benefits of formal specification (rigor, documentation, proofs) likely outweigh these costs.

---

## References

- [SpecTec GitHub Repository](https://github.com/Wasm-DSL/spectec)
- [SpecTec Adoption Announcement](https://webassembly.org/news/2025-03-27-spectec/)
- [PLDI 2024 Paper: Bringing the WebAssembly Standard up to Speed with SpecTec](https://dl.acm.org/doi/10.1145/3656440)
- [Wasm SpecTec: Engineering a Formal Language Standard (arXiv)](https://arxiv.org/abs/2311.07223)
