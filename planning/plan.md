# plan.md — VS Code “First-Class” IntelliSense for `pug\`...\`` (babel-plugin-transform-react-pug)

## 0) Goal (what we’re building)
We will build **Svelte-grade editor support** in VS Code for React projects that use `babel-plugin-transform-react-pug`, where Pug templates are written inside **tagged template literals** like:

```ts
const view = pug`
  .card
    Button(onClick=onClick) Click
`
````

The desired outcome is that **inside the Pug template** the developer gets:

* **JSX/TSX-like auto-completion** (components, props/attributes, event handlers, JSX children)
* **hover type info**
* **go-to-definition / find references**
* **rename symbol**
* **diagnostics (errors + type errors)**
* ideally **code actions** for common fixes
* **works with TS and JS** projects (at minimum TS/TSX; JS/JSX as stretch)

This must feel “first-class” like Svelte’s VS Code tooling:

* use **shadow / virtual TSX documents**
* delegate intelligence to **TypeScript language service**
* implement robust **bidirectional source mapping** between Pug text and generated TSX

We will deliver:

1. A **VS Code extension** (client)
2. A **Language Server (LSP)** (server, Node)
3. A **shadow TSX generator** + mapping library
4. A **test harness** with **heavy TDD** and CI gates

Non-goals:

* Building a full Pug language implementation
* Supporting every Pug feature in the world (we will support exactly what the Babel plugin supports + common React patterns)

---

## 1) Constraints & Requirements

### 1.1 Hard requirements

* Must support tagged template literal syntax `pug\`...``in`.ts/.tsx/.js/.jsx`.
* Must provide IntelliSense **inside the template literal content** (not just syntax highlighting).
* Must use TypeScript LS for semantic features (components/props/types).
* Must map edits, ranges, and diagnostics precisely back to original Pug positions.
* Must be stable on large projects (no full-project reparse on every keystroke).
* Must degrade gracefully:

  * If TypeScript LS fails, still show Pug syntax errors.
  * If mapping fails for a specific construct, never crash; provide partial results.
* Must have **comprehensive automated tests**:

  * golden tests for mapping correctness
  * integration tests for LSP -> VS Code behaviors
  * regression tests for known tricky cases
* Must include CI that blocks merge on failed tests/lint/typecheck.

### 1.2 Performance requirements

* Completion response <= 150ms for typical files (warm cache).
* Incremental update: re-generate shadow TSX only for changed template(s) when possible.
* Avoid re-initializing TS language service per request (keep one per workspace; update snapshots).

### 1.3 Compatibility requirements

* Works with TypeScript 5.x used by the workspace.
* Works with React component resolution, including:

  * local component imports
  * default/named exports
  * JSX intrinsic elements (`div`, `span`, etc.)
* Works with common tooling stacks:

  * Vite/React
  * Next.js
  * CRA (legacy)
* Windows/macOS/Linux.

---

## 2) Architecture overview (high level)

We replicate the “Svelte pattern”:

1. Parse the host file (TS/JS) and locate `pug\`...`` template literal regions.
2. For each region, compile Pug → JSX/TSX (matching Babel plugin output semantics).
3. Create a **shadow TSX file** (virtual document) that is as close as possible to the original file, but with Pug templates replaced by generated TSX expressions.
4. Maintain a **source map**:

   * Original file offsets ↔ Shadow file offsets
   * Specifically: Pug text spans ↔ generated TSX spans
5. Use TypeScript language service on the shadow file:

   * completions, hovers, defs, refs, rename, diagnostics
6. Map results back to original positions and return through LSP.

### Components

* `vscode-extension/` (client)

  * starts LSP server, wires capabilities, optionally supplies configuration & file watching
* `language-server/` (server)

  * document manager, parser, shadow generator, TS LS host, mapping, feature providers
* `core/` (shared)

  * AST extraction for template literals
  * pug->tsx generator wrapper
  * mapping utilities & tests

---

## 3) Detailed design

### 3.1 Document model

Each open file has:

* `originalText: string`
* `regions: PugRegion[]` where each region includes:

  * `tagName` (must equal `pug`, configurable later)
  * `templateStartOffset` / `templateEndOffset` (content inside backticks)
  * `fullNodeStartOffset` / `fullNodeEndOffset` (entire tagged template expression)
  * `pugText`
* `shadowText: string`
* `mapping: MappingIndex` (bidirectional)
* `version: number`

We must track per-document versions and ensure all LSP replies correspond to the correct version.

### 3.2 Extracting pug regions (host parser)

We need a robust parser for TS/JS to locate tagged template literals:

* Use `@babel/parser` with plugins: `typescript`, `jsx`, `decorators`, etc.
* Walk AST and find `TaggedTemplateExpression` where `tag.name === 'pug'` (configurable).
* Extract cooked/raw template literal content and offsets using node loc + `start/end`.
* Handle:

  * nested templates in expressions
  * multiple pug templates per file
  * template strings with `${}` expressions: NOTE: `transform-react-pug` primarily uses Pug interpolation like `#{}`; but `${}` inside template literal is possible in JS. Decide support:

    * MVP: disallow `${}` inside `pug\`...`` and emit diagnostic “JS template interpolation not supported; use Pug interpolation”.
    * Later: support `${}` by stitching segments (more complex mapping).

### 3.3 Generating TSX from Pug

We need compilation compatible with `babel-plugin-transform-react-pug`.
Approach:

* Reuse the same underlying transformer or its dependencies to ensure identical semantics.
* If direct reuse is hard, implement a generator that matches output structure and is stable for IntelliSense.

Key principle for IntelliSense:

* The shadow TSX must preserve enough surrounding context so TS can resolve:

  * imports
  * in-scope variables used in Pug expressions
  * JSX component identifiers

#### Strategy: “in-place expression replacement”

We keep the original file text as-is, but replace each `pug\`...`` tagged template expression with a TSX expression representing the compiled JSX.
Example:
Original:

```ts
const x = pug`.a #{foo}`
```

Shadow:

```ts
const x = (<div className="a">{foo}</div>)
```

This ensures all surrounding symbols/imports remain identical.

#### Parentheses & typing

We will always produce a valid TSX expression:

* wrap in parentheses `(...)`
* ensure the expression type is a ReactNode-like value
* avoid statements; only expressions

#### Multiple root nodes

If Pug compiles to multiple root elements:

* wrap in fragment `<>...</>`
* or `React.Fragment` depending on project settings; default `<>`.

#### Attributes mapping

Pug uses e.g. `Button(onClick=onClick disabled)`

* must compile to `onClick={onClick} disabled={true}` etc.

#### Class/id shorthand

`.foo#bar` -> `className="foo" id="bar"`.

### 3.4 Source mapping

This is the hardest part and must be engineered carefully.

We need a mapping that supports:

* position mapping for:

  * completion request at cursor position in Pug text
  * hover at Pug offset
  * definitions/references results with ranges in shadow TSX
  * diagnostics spans in shadow TSX
  * rename edits affecting multiple files
* edits mapping back:

  * completion insert text edits must insert at the correct Pug location
  * rename workspace edits must map TSX edits back to Pug (where applicable)

#### Mapping granularity

We need at minimum:

* For each Pug region, a function:

  * `pugOffset -> tsxOffset`
  * `tsxOffset -> pugOffset` (best-effort)
    This requires us to know how generated TSX tokens correspond to Pug tokens.

#### Implementation plan

* Make the TSX generator emit, alongside TSX text, a list of “segments”:

  * Each segment indicates:

    * `source: 'pug' | 'synthetic'`
    * `pugStart`, `pugEnd` if source is pug
    * `tsxStart`, `tsxEnd`
* Build a `MappingIndex` with interval trees or sorted arrays for fast lookup.

Where do segments come from?

* Option A (preferred): Use a Pug parser that provides AST node ranges and generate TSX while threading ranges.
* Option B: Use heuristic mapping (line/column based) — NOT acceptable for “first-class”.
  We will do A.

#### Minimal mapping correctness goals

* Inside tag names, attribute names, attribute values (expressions), and text interpolations, mapping must be accurate.
* For whitespace and structural syntax, mapping can be approximate (closest meaningful node).

### 3.5 TypeScript Language Service integration

We will embed TS LS in the language server.

* Create a `ts.LanguageServiceHost` that serves:

  * script snapshots for original TS/JS files (as-is)
  * script snapshots for shadow TSX “virtual files” (one per original file; name with suffix)
* For each original file URI `file.tsx`, define virtual: `file.tsx.__pugtsx__.tsx` (not on disk).
* Host maps `getScriptFileNames()` to include both real + virtual.
* For module resolution:

  * delegate to TS’s default resolution using workspace `tsconfig.json`.
* Diagnostics:

  * get semantic + syntactic diagnostics for virtual files
  * map relevant diagnostics back to original

Important: only virtual files should be analyzed for pug templates. The original file remains normal, but when responding to LSP requests inside pug regions we route the request to virtual file at mapped position.

### 3.6 LSP feature routing rules

Given (uri, position):

1. If position is inside a pug region:

   * map to (virtualUri, virtualPosition)
   * call TS LS method
   * map result ranges/edits back
2. Otherwise:

   * forward to normal TS LS on the original file (or let VS Code’s default handle; but since we own LSP, we’ll provide JS/TS features too or at least not break them)

To avoid conflicts with built-in TS extension:

* Our extension should either:

  * run as a **supplemental** provider only for pug regions (preferred)
  * OR run as the TS provider (harder and can conflict)
    We will implement as supplemental:
* language server registers for `typescriptreact`, `javascriptreact`, `typescript`, `javascript`
* but it only responds for positions in pug regions; otherwise returns null / empty.
  This minimizes interference.

### 3.7 Diagnostics strategy

Diagnostics sources:

1. Pug parse errors (syntax)
2. Pug->TSX generation errors
3. TS diagnostics on virtual file:

   * type errors in expressions, props mismatch, missing imports, etc.

We will merge and publish diagnostics to the original file.

* TS diagnostics must be filtered to those that originate inside replaced regions (or that are strongly related).
* Some TS errors may be caused by our wrapper code; those must be suppressed.

### 3.8 Configuration

Expose VS Code settings:

* `pugReact.tagName` default `"pug"`
* `pugReact.enableDiagnostics` default true
* `pugReact.enableCompletions` default true
* `pugReact.trace.server` for debug logs
* `pugReact.experimental.supportDollarInterpolation` (future)

### 3.9 Logging & debugging

* Provide LSP trace logging toggles.
* Provide command: “Pug React: Show Shadow TSX for Current File” which opens the virtual document for debugging.

---

## 4) TDD / QA plan (must be heavy)

### 4.1 Test layers

We will implement tests at 4 levels:

#### Layer A — Pure unit tests (fast)

* `extractRegions()`:

  * finds correct regions and offsets in complex TSX
* `compilePugToTsx()`:

  * snapshot tests for TSX output for many Pug samples
* `mapping`:

  * property-based tests:

    * for each node type, pick random offsets and verify roundtrip mapping within tolerance
  * golden tests:

    * compare expected mapped positions for known samples

#### Layer B — TypeScript LS integration tests (medium)

* In-memory TS project with a tsconfig and sample files.
* Request TS completions/hover/defs at virtual positions and verify results.
* Ensure caching works (no full rebuild each time).
* Verify diagnostics from TS map correctly.

#### Layer C — LSP contract tests (medium/slow)

* Start language server in test harness.
* Send LSP messages for completion/hover/definition/rename/diagnostics.
* Verify returned positions are in original file and edits apply correctly.

#### Layer D — End-to-end VS Code smoke tests (slowest, nightly or gated)

* Use `vscode-test` to launch VS Code with extension installed.
* Open sample workspace; place cursor in Pug template; assert completion includes component props.
* Run minimal checks only, to keep stable.

### 4.2 Required test cases (minimum set)

Create a `fixtures/` workspace containing:

1. Intrinsic element completion:

   * `div`, `span` etc.
2. Imported component props:

   * `Button` with typed props and default export
   * verify attribute completion offers `onClick`, `disabled`, etc.
3. Union props and optional props:

   * hover should show types
4. Event handler types:

   * `onClick` expects `(e: MouseEvent) => void` etc. ensure hover info
5. Text interpolation:

   * `#{foo}` referencing typed variable
6. Conditional / loops if supported by plugin:

   * If plugin supports Pug conditionals; verify mapping
7. Multiple pug templates in one file
8. Nested components and children completion
9. Diagnostics mapping:

   * wrong prop type inside pug attribute expression
   * unknown identifier inside interpolation
10. Rename:

* rename `Button` import; references inside Pug should update
* rename a prop variable used inside Pug; updates inside Pug should work

11. Go to definition:

* from component usage in Pug to its definition file

12. Robustness:

* invalid pug syntax should not crash; diagnostic shown; no TS requests made

### 4.3 “No-regression” policy

* Every bug found must get a reproduction fixture and a test before fix.
* CI must run unit + integration + LSP tests on every PR.
* VS Code e2e can be nightly or required if stable.

---

## 5) Implementation plan (milestones)

### Milestone 1 — Repository scaffolding & CI (TDD starts)

* Create monorepo structure:

  * `packages/core`
  * `packages/language-server`
  * `packages/vscode-extension`
  * `packages/tests`
* Tooling:

  * TypeScript
  * eslint
  * vitest (unit/integration)
  * a simple LSP test harness
  * GitHub Actions CI: lint, typecheck, tests

Deliverable:

* CI green with placeholder tests.

### Milestone 2 — Region extraction with exhaustive tests

* Implement `extractPugRegions(text, filename)` in `core`.
* Add tests for many TS/TSX syntax patterns:

  * decorators, generics, nested templates, multiple tags
* Ensure offsets are correct (byte offset in UTF-16 as VS Code uses).

Deliverable:

* Passing unit tests with high coverage.

### Milestone 3 — Pug → TSX generator wrapper

* Implement `compilePugToTsx(pugText)` with:

  * stable TSX output
  * emits mapping segments (AST-based)
* Add snapshot tests for output + mapping.
* Ensure output is valid TSX expression.

Deliverable:

* compile + mapping tests passing.

### Milestone 4 — Shadow file generator

* Implement `buildShadowDocument(originalText, regions)`:

  * produce `shadowText`
  * produce `MappingIndex` for all regions
* Add golden tests verifying:

  * shadow text validity
  * mapping roundtrips at critical offsets
* Add performance sanity test (large file).

Deliverable:

* shadow generation + mapping stable.

### Milestone 5 — TypeScript LS host for virtual files

* Implement `TsServiceManager`:

  * loads tsconfig
  * supplies snapshots for real and virtual files
  * incremental updates when documents change
* Tests:

  * completions/hover in virtual file return expected results.

Deliverable:

* TS LS integration tests passing.

### Milestone 6 — LSP server with completion/hover/definition/diagnostics

* Implement LSP server capabilities:

  * completion
  * hover
  * definition
  * references (optional)
  * rename (later milestone)
  * diagnostics publish
* Route requests only for positions within pug regions.
* Mapping of positions and ranges.

Deliverable:

* LSP contract tests passing for core features.

### Milestone 7 — Rename + workspace edits

* Implement rename:

  * map rename request into virtual file
  * map returned edits back; apply only if they fall inside pug regions
  * for edits outside pug regions, allow them through if safe (optional) or return only inside-pug edits
* Tests: rename scenarios.

Deliverable:

* Rename tests passing.

### Milestone 8 — VS Code extension integration

* Implement extension activation:

  * start language server
  * register document selectors
  * configuration sync
  * command “Show Shadow TSX”
* Add basic vscode-test smoke tests.

Deliverable:

* Installable extension; manual testing in sample project works.

### Milestone 9 — Hardening & edge cases

* Improve error handling and logging.
* Handle:

  * multiple workspaces
  * file renames
  * tsconfig changes
* Add more fixtures and regressions.

Deliverable:

* v1.0 quality.

---

## 6) Acceptance criteria (must pass)

A PR is “done” only if all are true:

* CI green
* In sample TSX project:

  * inside `pug\`...``typing`Button(` suggests props
  * hover on `Button` shows component type info
  * go-to-definition from `Button` goes to component declaration
  * wrong prop type shows a diagnostic with correct underline in Pug
  * rename a variable used in `#{}` updates inside Pug
* No crashes on invalid Pug
* Shadow TSX debug command shows content and is consistent.

---

## 7) Engineering notes / key pitfalls

* VS Code uses UTF-16 positions; ensure mapping accounts for surrogate pairs.
* TS LS positions are also in UTF-16 code units; use consistent index conversions.
* Don’t fight VS Code’s built-in TS extension: keep our LSP “scoped” to pug regions.
* Avoid spamming diagnostics on every keystroke; debounce (e.g., 200–300ms).
* Ensure virtual filenames are stable and unique to avoid TS caching bugs.
* Watch out for React Fragment syntax in TSX generation; always valid.

---

## 8) Deliverables

* VSIX build pipeline
* README:

  * supported syntax
  * limitations
  * debugging (shadow TSX command)
* Example project in `examples/`
* Full test suite with fixtures

---

## 9) Work breakdown (Agent Team roles)

### Orchestrator agent

* Owns overall sequencing and merge policy.
* Enforces TDD: no feature code without tests first.
* Maintains acceptance criteria checklist.

### Dev agent

* Implements core + server + extension.
* Writes tests with fixtures.
* Prioritizes correctness/mapping.

### QA agent

* Expands fixtures, adds negative tests, fuzz/property tests.
* Runs VS Code smoke tests and reports UX gaps.
* Files regressions and ensures test coverage.

---

## 10) MVP scope vs v1 scope

### MVP (must ship)

* completion, hover, definition, diagnostics
* mapping correct for:

  * tag/component names
  * attributes names/values
  * `#{}` interpolations
  * nested elements
* TS projects (`.ts/.tsx`) at minimum

### v1 (target)

* rename, references
* JS support (`.js/.jsx`)
* more pug features supported by plugin
* stronger performance caching
* more robust diagnostics filtering

---

## 11) Success metric

* “Feels like JSX” inside Pug:

  * > 80% of typical JSX IntelliSense features work in Pug templates in real projects
  * latency acceptable
  * low bug rate due to mapping errors (enforced by tests)

END.
