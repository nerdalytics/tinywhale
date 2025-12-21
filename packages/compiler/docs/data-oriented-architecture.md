# Strategic Implementation of Data-Oriented Compiler Architectures: A Transformation Roadmap for the Tiny Whale Toolchain

The modern landscape of systems programming language implementation has undergone a paradigmatic shift, moving away from the pointer-heavy, object-oriented abstractions that characterized early compiler designs. At the forefront of this evolution is the Carbon compiler, which prioritizes performance, scalability, and cache efficiency through a rigorous data-oriented architecture.
The Tiny Whale project, a minimalist compiler designed to target WebAssembly, currently resides within the TypeScript ecosystem—a language traditionally associated with high-level object abstractions and managed memory. This report delineates a comprehensive architectural transformation for Tiny Whale, mapping its existing structures onto the vectorized, iterative, and instruction-centric paradigms established by the Carbon toolchain.

## Architectural Philosophy: From Objects to Vectorized Streams

The core deficiency of traditional compiler designs, such as the Clang Abstract Syntax Tree (AST), lies in the fragmentation of memory and the lack of a clear distinction between syntactic structure and semantic intent. Carbon addresses these challenges by employing a pipeline of distinct processing steps, each producing a compact, vectorized output that serves as a read-only input for the subsequent stage. This design avoids the overhead of recursive function calls and heap-allocated objects, which are particularly costly in managed environments like the JavaScript engines that execute TypeScript.

In the context of Tiny Whale, the refactoring must transition the codebase from a recursive-descent model that produces a tree of polymorphic objects into a linear pipeline that manipulates flat arrays of primitive data. This transformation is not merely a change in data structure but a fundamental reimagining of the compiler as a high-speed data processor. By adopting Carbon’s "flyweight" pattern—where complex entities are represented by simple integer indices—Tiny Whale can achieve a level of performance that approaches native C++ implementations while remaining entirely within the TypeScript type system.

## Phase One: The Tokenized Buffer and Source Mapping

The first stage of the Carbon pipeline involves converting a raw source buffer into a `Lex::TokenizedBuffer`. In a standard TypeScript implementation, a lexer might return an array of token objects, each containing properties like `kind`, `lexeme`, and `location`. However, the memory overhead for a single small object in the V8 engine can be upwards of 40 to 208 bytes, depending on its hidden class and property layout.

### Vectorized Token Representation

To align with Carbon, the Tiny Whale lexer should be refactored to populate a single `Uint32Array`. This approach ensures that token data is contiguous, maximizing the effectiveness of the CPU’s spatial locality and L1 cache. A token in this refactored model is no longer an object but a 12-byte record stored across three 32-bit slots in the array.

| Slot Offset | Field Name | Description                                                                           |
| ----------- | ---------- | ------------------------------------------------------------------------------------- |
| `+0`        | `Kind`     | An unsigned 32-bit integer representing the token category (e.g., Keyword, Operator). |
| `+4`        | `Offset`   | The absolute byte offset from the start of the source buffer.                         |
| `+8`        | `Length`   | The length of the token in bytes, allowing for O(1) lexeme extraction.                |

By utilizing `Uint32Array`, the Tiny Whale toolchain avoids the "pointer chasing" inherent in `Array<Token>` structures, where the main array contains pointers to disparate heap locations. In the refactored model, the engine can prefetch the next set of tokens into the cache because they are physically adjacent in memory.

### String Interning and Flyweight Identifiers

Carbon minimizes memory usage by interning all identifiers and string literals into a central table. For Tiny Whale, identifiers should be stored in a `StringStore` that maps unique string values to a `StringId` (a 32-bit integer). This allows the rest of the compiler to perform comparisons using simple integer equality rather than expensive string comparisons. This pattern is critical for maintaining performance as the codebase grows, as it reduces the pressure on the garbage collector by minimizing the number of transient string objects created during compilation.

## Phase Two: The Iterative Parser and the Compact Parse Tree

The second major transition involves the replacement of a recursive parser with an iterative state machine that produces a `Parse::Tree`. Carbon's `Parse::Tree` is stored as a vector of `NodeImpl` structures, where each node is exactly 12 bytes.

### Node Anatomy and Bit-Packing

The refactored Tiny Whale `Parse::Tree` will employ a similar 12-byte structure. To implement this in TypeScript while maintaining type safety, the system should use a `Uint32Array` indexed by a branded `NodeId` type.

| Field         | Bit Width | Functionality                                                                 |
| ------------- | --------- | ----------------------------------------------------------------------------- |
| `Kind`        | 16 bits   | The syntactic category of the node (e.g., `ReturnStatement`, `FunctionDecl`). |
| `Flags`       | 16 bits   | Boolean metadata (e.g., `HasError`, `IsPublic`).                              |
| `Token`       | 32 bits   | Index into the `TokenizedBuffer` for the primary token of this node.          |
| `SubtreeSize` | 32 bits   | The total number of nodes in the subtree, including the current node.         |

The `SubtreeSize` field is the cornerstone of Carbon’s efficient tree representation. By knowing the subtree size, the compiler can navigate the tree post-order or pre-order without requiring child pointers. In a post-order traversal, the children of a node immediately precede it in the array, allowing the checker to process dependencies before the parent node is reached.

### The State Machine and Stack-Based Parsing

Recursive descent parsers are susceptible to stack overflow when processing deeply nested expressions. Carbon avoids this by maintaining an explicit `state_stack_` and an iterative loop within `Parse::Tree::Parse`. Tiny Whale should adopt this by defining a `ParseState` enumeration and a `NodeStack`.

As the parser encounters new syntactic constructs, it pushes the corresponding state onto the stack. When a construct is completed (e.g., reaching a closing brace or semicolon), the parser pops the state and records the completed node in the `Uint32Array`. This approach not only improves stability but also enhances diagnostic capabilities, as the parser's entire context is visible in the stack at any given time.

## Phase Three: Semantic Intermediate Representation (SemIR)

The most distinctive aspect of the Carbon architecture is the transition from the syntactic `Parse::Tree` to the semantic `SemIR::File`. SemIR is a flat, instruction-based representation in Static Single Assignment (SSA) form. It is the stage where name resolution, type checking, and constant evaluation occur.

### Fixed-Size Semantic Instructions

Every semantic operation in Carbon is modeled as a 16-byte instruction. For Tiny Whale, this will be implemented as a `Uint32Array` where each instruction occupies four 32-bit slots.

| Slot | Content          | Semantic Role                                         |
| ---- | ---------------- | ----------------------------------------------------- |
| `0`  | `Kind \| TypeId` | The `InstKind` and the ID of the result type.         |
| `1`  | `Arg0`           | The first operand (usually an `InstId`).              |
| `2`  | `Arg1`           | The second operand (usually an InstId).               |
| `3`  | `ParseNode`      | A backreference to the `Parse::Node` for diagnostics. |

This fixed-size layout is essential for performance. It allows the lowering stage to iterate over the instructions as if they were a stream of machine code. The TypeId system is similarly data-oriented; types themselves are stored in a TypeStore and referenced by integer IDs, ensuring that type checking is a matter of comparing integers rather than traversing complex object graphs.

### The Checking Pass: Parse Tree as Bytecode

A profound insight of the Carbon design is that the sequence of `Parse::Node`s can be interpreted as a bytecode input for the checking step. The "Check" phase in Tiny Whale will implement a core loop that iterates through the vectorized `Parse::Tree` and calls specific `Handle` functions based on the node kind.

For example, when the checker encounters an `IntegerLiteral` node, it calls `HandleIntegerLiteral`, which adds a `SemIR::IntegerLiteral` instruction to the `InstStore` and pushes the resulting `InstId` onto a `NodeStack`. When a `BinaryOperator` node is reached, `HandleBinaryOperator` pops the necessary operand IDs from the stack, performs type validation, and emits a new instruction representing the operation. This iterative, stack-based processing ensures that the semantic analysis is both fast and memory-efficient.

## Phase Four: Memory Management and the TypeScript Execution Model

Implementing a data-oriented design in a managed language like TypeScript requires a nuanced understanding of how modern JavaScript engines, such as V8, manage memory and optimize code. Standard JavaScript objects are flexible but come with significant hidden costs. Every object has a "hidden class" (or "shape") that the engine uses to optimize property access. If properties are added or removed dynamically, the object’s shape changes, potentially causing "de-optimization" and slowing down the execution.

### The Efficiency of TypedArrays in V8

By using `TypedArrays` to store tokens, nodes, and instructions, the refactored Tiny Whale compiler provides a stable, predictable data layout to the engine. `TypedArrays` are backed by contiguous blocks of memory (ArrayBuffers) that the engine does not need to inspect for garbage collection as frequently as it does for object graphs.

| Data Structure   | V8 Representation                  | GC Pressure                            | Cache Locality            |
| ---------------- | ---------------------------------- | -------------------------------------- | ------------------------- |
| `Array<ASTNode>` | Array of pointers to heap objects. | High (Needs to trace every object).    | Low (Random heap access). |
| `Uint32Array`    | Continuous segment of raw bytes.   | Low (Treated as a single opaque blob). | High (Linear access).     |

Furthermore, `TypedArrays` are ideally suited for the WebAssembly backend of Tiny Whale. When the compiler is ready to emit the final Wasm binary, it can use the `TypedArray.set()` method or `DataView` to write the instruction stream directly into the output buffer, minimizing the overhead of data conversion.

### DataView and Heterogeneous Access

While `Uint32Array` is efficient for homogeneous 4-byte data, some parts of the Carbon architecture require more complex structures. For example, a `SemIR` instruction might need to store a 64-bit floating-point constant alongside 32-bit integers. In these cases, Tiny Whale should employ a `DataView` over the same `ArrayBuffer`. This allows the compiler to read or write different types (e.g., `getFloat64`, `getUint32`) at specific byte offsets within the same contiguous memory block, providing the flexibility of a C-style `struct` while maintaining the performance of a flat buffer.

## Phase Five: The Refactoring Roadmap for Tiny Whale

The transformation of Tiny Whale must be executed through a series of tactical milestones to ensure that the compiler remains functional and testable throughout the process.

### Stage 1: Infrastructure and Branding

The initial step is the creation of the storage infrastructure. This involves defining the `Store` classes that will manage the `TypedArrays`. To maintain TypeScript’s type safety, "Branded Types" should be introduced for all ID types. A `NodeId` should not be interchangeable with an `InstId`, even though both are internally represented as `number`.

```TypeScript
type Brand<K, T> = K & { __brand: T };
type NodeId = Brand<number, 'NodeId'>;
type InstId = Brand<number, 'InstId'>;
type TypeId = Brand<number, 'TypeId'>;
```

This ensures that the refactored code is as robust as a traditional object-oriented implementation, with the TypeScript compiler catching errors where an index for one table is accidentally used in another.

### Stage 2: The Lexical and Syntactic Layer

The existing lexer should be modified to write directly into a `Uint32Array`. Simultaneously, the parser must be transitioned to the iterative model. The focus here is on the construction of the `Parse::Tree` and the calculation of `SubtreeSize`. A helper class, `TreeBuilder`, can be used to manage the node stack and ensure that the tree is formed correctly. This stage is complete when the parser can recreate the original source's syntactic structure from the vectorized `Uint32Array`.

### Stage 3: Semantic Checking and SSA Construction

This is the most complex stage of the refactor. It involves implementing the `Check` loop and the handle functions for each node kind. The checking pass will populate the `InstStore` and perform name resolution using a `ScopeStack`. The `ScopeStack` should also be data-oriented, mapping `StringId`s to `InstId`s using a compact hash table or a series of flat arrays.

During this stage, the concept of `TypeId` must be fully implemented. Every expression in Tiny Whale must result in an `InstId` that has an associated `TypeId`. The compiler will use these IDs to validate that, for example, an integer cannot be added to a string, or that a function is called with the correct number of arguments.

### Stage 4: Lowering to WebAssembly

The final stage is the implementation of the `Lower` pass, which translates the `SemIR` instructions into WebAssembly binary format. Because `SemIR` is already in a linear, instruction-based format, the lower pass can be implemented as a simple loop over the `InstStore`. This stage will also handle the layout of the Wasm memory and the creation of the Wasm function table.

### Advanced Semantic Design: Patterns and Matching

Carbon’s handling of complex patterns and matching provides a blueprint for extending Tiny Whale's capabilities. Pattern matching in Carbon is emitted in three steps: traversing the parse tree to emit abstract pattern SemIR, evaluating the scrutinee, and then traversing the pattern SemIR pre-order to emit the actual match instructions.

### Match Step and Instruction Ordering

In the refactored Tiny Whale, the `SemIR` for a match operation will be generated by following this three-step process. While most `SemIR` is produced in post-order, the match traversal is performed pre-order, starting with the root of the pattern and descending into its dependencies. This requires the `SemIR` instructions for patterns to be designed such that they can be easily traversed in both directions, possibly by including a `DependencyBlock` that lists the IDs of child patterns.

### Function Parameters and Call Semantics

The semantic representation of function calls in Carbon diverges from the colloquial meaning of "parameters" and "arguments". A Call instruction in SemIR refers to an instruction block containing the arguments, which may include implicit parameters like the return value's storage address. Tiny Whale should adopt this model to support more complex features in the future, such as returning structs or handling variadic arguments. By representing a function as a block of instructions—one per parameter—the compiler can unify the handling of regular variables and function parameters.

## Performance and Scalability Metrics

The success of the refactoring can be measured against several performance and memory metrics. The shift to a data-oriented design is expected to yield substantial improvements in both compile-time latency and peak memory usage.

| Metric             | Pre-Refactor (Object-Oriented) | Post-Refactor (Carbon-Inspired) | Expected Improvement  |
| ------------------ | ------------------------------ | ------------------------------- | --------------------- |
| Node Creation Time | High (Heap Allocation)         | Low (Array Indexing)            | 3x - 5x               |
| Memory Per Node    | ~150 - 200 bytes               | 12 bytes                        | 10x - 15x             |
| Cache Miss Rate    | High (Pointer Chasing)         | Low (Contiguous Access)         | Significant Reduction |
| GC Interruption    | Frequent                       | Minimal                         | 2x - 4x throughput    |

Benchmarks in similar domains have shown that an "array of classes" approach is often significantly slower than a "class of arrays" (struct-of-arrays) approach due to the overhead of the JavaScript object model. By moving to a vectorized model, Tiny Whale will bypass these bottlenecks, allowing it to scale to much larger source files without a linear increase in compilation time.

## Diagnostic Quality and Error Recovery

A common trade-off in high-performance compilers is the loss of diagnostic detail. However, Carbon’s architecture avoids this by including backreferences to the `Parse::Node` in every `SemIR::Inst`. In the refactored Tiny Whale, if an error is detected during the checking pass—such as a type mismatch—the compiler can immediately retrieve the `ParseNode` index from the current instruction.

From the `ParseNode`, the compiler can look up the `TokenIndex`, which in turn provides the byte offset and length of the problematic code in the `SourceBuffer`. This chain of integer references allows for the generation of high-quality error messages that include the exact line and column number, as well as a snippet of the source code, all without needing to maintain a complex, pointer-heavy AST.

## Consistency with Carbon's "Full Fidelity" Model

A key proposal in Carbon's development (Proposal #3833) emphasizes the importance of a "full fidelity" semantic model. This means that the `SemIR` should capture the full semantics of the language, including implicit conversions, overloaded operators, and library-defined generic models.

For Tiny Whale, this implies that the refactoring should not just simplify the IR for the sake of performance but should ensure that every semantic decision is explicitly represented. For example, if Tiny Whale supports implicit casting from an integer to a float, the `SemIR` should not just "allow" the operation; it should emit an explicit `ImplicitCast` instruction. This preservation of semantic detail is critical for building powerful tooling, such as static analyzers or refactoring engines, that need to reason about the code's behavior beyond simple code generation.

## Strategic Conclusion: The Future of the Tiny Whale Toolchain

The proposed refactor of Tiny Whale to match the Carbon compiler's architecture is a strategic investment in the project's long-term viability and performance. By embracing the data-oriented paradigms of vectorized storage and instruction-centric semantic representation, Tiny Whale can overcome the inherent limitations of the JavaScript object model.

The transition to a 12-byte `Parse::Tree` node and a 16-byte `SemIR` instruction format, managed through TypeScript's `TypedArrays` and branded types, provides a unique combination of high-level safety and low-level efficiency. This architecture ensures that the compiler is not only fast and cache-efficient but also stable, scalable, and capable of producing high-quality diagnostics. Ultimately, this transformation positions Tiny Whale as a modern, high-performance toolchain in the WebAssembly ecosystem, demonstrating that the architectural rigor of a systems language like Carbon can be successfully ported to the world of managed TypeScript development.

## Operational Semantics and ABI Considerations

The Carbon design also addresses the computation of vtable layouts and other ABI-specific details during the semantic checking phase. For Tiny Whale, this means that as the compiler completes a class definition, it should explicitly represent the vtable as a `VTable` instruction in `SemIR`. This instruction would contain a list of `FunctionDecl` IDs, allowing the lowering layer to build the necessary dispatch logic without needing to re-scan the class members.

This hybrid approach—where the `Check` layer builds the list and the `Lower` layer performs the final binary emission—aligns with the principle that `SemIR` should describe the operational semantics of the program. By making these low-level details explicit in the IR, Tiny Whale can support advanced features like compile-time virtual function evaluation and complex C++ interoperability in the future, should the language design evolve in that direction.

## The Role of Generics and Type Checking

Carbon's "checked generics" system offers a significant advantage over C++ templates by type-checking generic definitions once, rather than upon every instantiation. For Tiny Whale, adopting this model in the SemIR would involve creating `GenericFunction` and `GenericClass` instructions that are validated during the checking pass.

When a generic is instantiated, the compiler can use a "SpecificFunction" or "SpecificClass" instruction that references the checked generic and the specific type arguments. This avoids the compile-time explosion associated with template instantiation and ensures that usage errors are identified earlier with clearer diagnostics.

## Final Implementation Considerations

As Tiny Whale continues to be written in TypeScript, the use of snake_case for internal naming and the adoption of trailing return types for functions—mirroring Carbon's own C++ style guide—can help keep the codebase consistent with the toolchain it emulates. While the style guide is primarily intended for Carbon's C++ contributors, its focus on consistency, readability, and the use of modern language features is equally applicable to a high-performance TypeScript project.

The refactoring of Tiny Whale is more than a technical update; it is an architectural commitment to the principles of modern compiler engineering. By systematically applying the lessons learned from the Carbon project, Tiny Whale can achieve a level of sophistication and performance that belies its "tiny" moniker, serving as a powerful example of what is possible when data-oriented design is applied to the TypeScript landscape.
