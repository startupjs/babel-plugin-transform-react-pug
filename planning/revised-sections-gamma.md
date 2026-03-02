## 3.NEW) Syntax highlighting (TextMate grammar injection)

Syntax highlighting inside `pug\`...\`` template literals is a critical DX requirement. Without it, Pug code appears as plain strings regardless of IntelliSense quality.

### Approach: TextMate grammar injection

We use VS Code's grammar injection mechanism, the same pattern used by `vscode-styled-components` for CSS-in-JS.

* Create a JSON grammar file (`syntaxes/pug-template-literal.json`) with:
  * `injectionSelector`: `L:source.ts,L:source.tsx,L:source.js,L:source.jsx` (target TS/JS files)
  * Pattern matching `pug` identifier followed by backtick
  * `contentName: "source.pug"` to delegate to the Pug grammar
* Register in `package.json` under `contributes.grammars` with `"injectTo"` targeting the host languages
* Declare `"embeddedLanguages": { "source.pug": "jade" }` in the extension manifest to enable declarative language features in the embedded region

### Dependencies

* Requires a Pug TextMate grammar. Options:
  * Bundle the grammar from the existing `Better Pug` VS Code extension (MIT licensed)
  * Or declare a dependency on it via `extensionDependencies`
* Recommend bundling to avoid requiring users to install a second extension

### Limitations

* TextMate grammars are regex-based; complex Pug constructs (deeply nested interpolations) may not highlight perfectly
* Semantic highlighting from the TS plugin can supplement TextMate highlighting later

### Priority

This is the **first deliverable** (Milestone 1). It ships independently of the TS plugin, requires no Volar dependency, and gives users immediate visible value.

---

## 4) TDD / QA plan

### 4.1 Test layers

We implement tests at 2.5 levels:

#### Layer 1 -- Unit tests (vitest, fast, CI-gating)

All core logic is tested here:

* **Region extraction** (`extractPugRegions`):
  * Correct offsets in complex TS/TSX (decorators, generics, nested templates, multiple pug tags per file)
  * Edge cases: empty templates, templates with only whitespace, templates inside arrow functions, class methods, default exports

* **Pug-to-TSX generation** (`compilePugToTsx`):
  * **Snapshot tests** for TSX output across all supported Pug constructs (matching the existing babel plugin's 20+ test fixtures)
  * Verify output is valid TSX (parseable by `@babel/parser` or `typescript`)
  * Verify IntelliSense-optimized output preserves type equivalence with Babel plugin output

* **Source mapping**:
  * **Golden tests**: For each fixture, define expected mapped positions at specific offsets (tag names, attribute names, attribute values, interpolation expressions) and verify roundtrip accuracy
  * Mapping for synthetic ranges (JSX brackets, generated wrapper code) correctly returns "no source" or nearest meaningful position
  * UTF-16 offset correctness for non-ASCII content (emoji, CJK characters)

* **Shadow document generation** (`buildShadowDocument`):
  * Full-file shadow TSX is valid TypeScript
  * Mapping roundtrips at critical offsets across region boundaries
  * Multiple pug regions in one file produce correct combined shadow

#### Layer 2 -- Integration tests (vitest, medium speed, CI-gating)

Tests the assembled system end-to-end:

* **TS plugin integration**: Load the TS plugin with a sample tsconfig and fixture files. Verify:
  * `getCompletionsAtPosition` inside a pug region returns component props
  * `getQuickInfoAtPosition` returns type information for hovered identifiers
  * `getDefinitionAtPosition` navigates to component definition files
  * `getSemanticDiagnostics` returns correctly mapped diagnostics for type errors in pug expressions
  * Position mapping is correct (original pug offset -> shadow TSX offset -> TS result -> back to pug offset)

* **Diagnostics**: Verify that:
  * TS plugin's intercepted `getSemanticDiagnostics` returns diagnostics with correctly mapped pug positions
  * VS Code extension publishes pug parse error diagnostics with correct line/column
  * Diagnostics caused by synthetic wrapper code are suppressed

* **Incremental updates**: Change one pug template in a multi-template file; verify only that region's shadow TSX is regenerated

* **Error resilience**: Invalid pug syntax does not crash the plugin; partial results are returned for valid regions in the same file

#### Layer 2.5 -- VS Code smoke tests (vscode-test, nightly, NOT CI-gating)

Minimal end-to-end validation in a real VS Code instance:

* 3-5 tests maximum:
  1. Open a fixture `.tsx` file; verify syntax highlighting applies inside `pug\`...\``
  2. Place cursor after `Button(` inside pug; verify completion list includes typed props
  3. Hover over a component name; verify quick info tooltip appears
  4. Introduce a type error; verify diagnostic underline appears at correct position
  5. Trigger "Show Shadow TSX" command; verify output panel opens with content

* Run nightly in CI. Failures trigger alerts but do not block PRs.
* Use `@vscode/test-electron` for headless VS Code testing.

### 4.2 Required test fixtures

Create a `test/fixtures/` workspace containing a tsconfig.json and these files:

1. **Intrinsic elements**: `div`, `span`, `input` with HTML attributes
2. **Imported component with typed props**: `Button` component with `onClick`, `disabled`, `variant` props
3. **Union and optional props**: component with `variant: 'primary' | 'secondary'` and `label?: string`
4. **Event handler types**: `onClick` expects `(e: React.MouseEvent) => void`
5. **Text interpolation**: `#{foo}` referencing a typed variable; `#{obj.method()}` with method return type
6. **Conditionals**: `if condition` / `else` blocks with typed expressions
7. **Each loops**: `each item in items` with typed array
8. **Multiple pug templates in one file**: two or more `pug\`...\`` in the same component
9. **Nested components and children**: `Card` containing `Button` containing text
10. **Class/id shorthand**: `.foo#bar` resolving to `className`/`id` attributes
11. **Spread attributes**: `...props` passing typed spread
12. **Diagnostics fixtures**: wrong prop types, unknown identifiers, missing required props
13. **Robustness fixtures**: invalid pug syntax, empty templates, deeply nested structures
14. **Type-equivalence fixtures**: same pug inputs as the babel plugin's test suite, verified to type-check

### 4.3 Testing framework

* **vitest** for unit and integration tests (ESM-native, TypeScript-first, fast watch mode, built-in snapshot support)
* **@vscode/test-electron** for smoke tests
* Snapshot testing for TSX generation output (following the existing babel plugin's pattern)
* No property-based testing -- golden fixture tests provide better debuggability for the same coverage

### 4.4 No-regression policy

* Every bug gets a reproduction fixture and a test before the fix is merged
* CI runs unit + integration tests on every PR (must pass)
* Smoke tests run nightly (failures trigger alerts)
* Coverage target: >90% for `src/language/` (generator + mapping), no target for boilerplate/glue code

---

## 5) Implementation plan (milestones)

### Milestone 1 -- Syntax highlighting + project scaffold

* Create new repo `vscode-pug-react` with flat structure:
  ```
  src/
    language/       # Core logic: region extraction, pug-to-TSX generator, mapping
    plugin/         # TS plugin entry point (custom, Volar-compatible interfaces)
    extension/      # VS Code client: activation, pug parse diagnostics, commands
  test/
    fixtures/       # Pug/TSX test fixtures with tsconfig
    unit/           # Unit tests
    integration/    # Integration tests
  syntaxes/         # TextMate grammar for pug highlighting
  ```
* Implement TextMate grammar injection for pug syntax highlighting
* Set up tooling: TypeScript, vitest, eslint, esbuild
* Set up CI: GitHub Actions for lint, typecheck, tests
* Placeholder tests for each module

Deliverable: Installable extension with syntax highlighting. CI green.

### Milestone 2 -- Region extraction + pug-to-TSX generator + architecture spike (TDD)

**Architecture spike (2-3 days, first task in this milestone):**

* Build a minimal custom TS plugin that patches `getScriptSnapshot` on `info.languageServiceHost`
* Intercept a `.tsx` file containing a hardcoded `pug\`...\`` template
* Return hand-written shadow TSX with a simple position mapping
* Verify `getCompletionsAtPosition` returns expected results at a mapped position
* **Decision gate**: If custom plugin infra stays under ~1500 lines, continue building custom. If complexity exceeds this or edge cases multiply, pull in `@volar/typescript` and `@volar/language-core` packages. Either way, keep interfaces Volar-compatible so switching is low-cost.

**Core implementation (remainder of milestone):**

* Implement `extractPugRegions(sourceText, fileName)`:
  * Uses `@babel/parser` to find `TaggedTemplateExpression` nodes with `pug` tag
  * Returns region offsets (template content start/end, full expression start/end)
  * Handles multiple regions, nested expressions, various TS syntax

* Implement `compilePugToTsx(pugText, options)`:
  * Uses `@startupjs/pug-lexer` + `pug-parser` (same as babel plugin)
  * Custom TSX emitter optimized for IntelliSense (not reusing babel plugin's emitter)
  * Emits mapping segments alongside TSX output
  * Handles: tags, attributes, class/id shorthand, text interpolation, conditionals, each loops, code blocks

* Implement `buildShadowDocument(sourceText, regions)`:
  * Replaces each pug region with generated TSX expression
  * Produces combined source mapping for all regions

* Tests: Snapshot tests for all fixtures, golden mapping tests

Deliverable: Generator + mapping with comprehensive tests. Architecture spike report with custom-vs-Volar decision.

### Milestone 3 -- TS plugin + basic completions (end-to-end MVP)

* Wire TS plugin (custom or `@volar/typescript`, per spike decision):
  * `getScriptSnapshot` patching returns shadow TSX for files with pug regions
  * Position mapping for `getCompletionsAtPosition` and `getQuickInfoAtPosition`
* Wire VS Code extension:
  * Activates TS plugin via extension configuration
  * Registers "Show Shadow TSX" debug command
* Integration tests: completions and hover working in pug regions

Deliverable: **Working MVP** -- install extension, get completions and hover inside pug templates. Ship as pre-release on VS Code marketplace.

### Milestone 4 -- Diagnostics + go-to-definition

* **TS diagnostics via plugin interception** (Option C):
  * TS plugin intercepts `getSemanticDiagnostics` and `getSyntacticDiagnostics`
  * Maps diagnostic ranges from shadow TSX positions back to pug positions
  * Built-in TS extension handles publishing -- no separate diagnostics server needed
  * Suppress diagnostics caused by synthetic wrapper code (not user errors)
* **Pug parse error diagnostics** via VS Code extension:
  * Extension detects pug parse failures during shadow generation
  * Publishes pug-specific diagnostics directly via `vscode.languages.createDiagnosticCollection`
  * Debounced (200-300ms) to avoid keystroke spam
* Add position mapping for `getDefinitionAtPosition` and `getDefinitionAndBoundSpan`
* Integration tests for diagnostics and go-to-def

Deliverable: TS type error diagnostics at correct pug positions (via plugin). Pug parse error diagnostics (via extension). Go-to-def from pug to component source.

### Milestone 5 -- Rename + references

* Add position mapping for `findRenameLocations`, `getRenameInfo`, `getReferencesAtPosition`, `findReferences`
* Handle rename edits that span pug/non-pug regions:
  * Edits inside pug regions: map back to original positions
  * Edits outside pug regions: pass through unchanged
* Tests: rename component name, rename variable used in interpolation

Deliverable: Rename and find-references working across pug/TS boundaries.

### Milestone 6 -- Polish + additional features

* Signature help inside pug attribute expressions (function call arguments)
* Code actions for common fixes (add missing import, fix spelling)
* Improved diagnostics filtering (suppress wrapper-induced errors)
* Configuration settings:
  * `pugReact.tagName` (default `"pug"`)
  * `pugReact.enableDiagnostics` (default `true`)
  * `pugReact.trace.server` (for debug logging)

Deliverable: Feature-complete IntelliSense.

### Milestone 7 -- Hardening + release

* Edge cases:
  * Multiple workspaces / multi-root
  * File renames and deletions
  * tsconfig changes triggering re-initialization
  * Projects with path aliases, baseUrl, project references
  * Non-ASCII content (emoji, CJK) in pug templates
* Performance:
  * Benchmark completion latency (target: <150ms warm cache)
  * Profile and optimize incremental updates
  * Memory usage monitoring
* Error handling: graceful degradation for all failure modes
* Documentation: README with supported syntax, limitations, debugging guide
* Example project in `examples/`

Deliverable: v1.0 quality. Publish stable release on VS Code marketplace.

---

## 6) Acceptance criteria

A PR is "done" only if ALL are true:

* CI green (lint, typecheck, unit tests, integration tests)
* In the sample TSX fixture project:
  * Inside `pug\`...\`` typing `Button(` suggests typed props (`onClick`, `disabled`, etc.)
  * Hover on `Button` shows component type information
  * Go-to-definition from `Button` in pug navigates to the component's source file
  * A wrong prop type inside a pug attribute expression shows a diagnostic with correct underline position
  * Renaming a variable used in `#{varName}` updates all occurrences inside pug and outside
  * Pug syntax highlighting is visible inside template literals
* No crashes on invalid Pug syntax (graceful degradation to parse error diagnostic)
* "Show Shadow TSX" command shows generated content and mappings are visually consistent

---

## 7) Engineering notes / key pitfalls

* **UTF-16 positions**: VS Code and TypeScript both use UTF-16 code units. Our mapping must account for surrogate pairs (emoji, some CJK). Use `string.charCodeAt()` not `codePointAt()` for offset math.
* **Don't fight the built-in TS extension**: Our TS plugin runs INSIDE tsserver alongside it. Never provide duplicate features for non-pug code. The plugin only transforms `getScriptSnapshot` for files containing pug regions; all other files pass through unmodified.
* **Debounce diagnostics**: Don't re-publish on every keystroke. Debounce at 200-300ms.
* **Virtual content versioning**: When patching `getScriptSnapshot`, ensure the script version changes when shadow content changes, or TS will serve stale cached results.
* **React Fragment syntax**: Always use `<>...</>` (short fragment) in generated TSX. Avoid `React.Fragment` to reduce import dependencies in the shadow file.
* **Pug indentation stripping**: The babel plugin strips common leading indentation from template content. Our generator must do the same to produce correct pug AST. Match the logic in `src/index.js` lines 43-51.
* **Template literal expressions** (`${}`): MVP does not support JS template interpolation inside `pug\`...\``. Emit a clear diagnostic: "Use Pug interpolation `#{}` instead of JS interpolation `${}`".
* **Monorepos with multiple tsconfigs**: The TS plugin runs inside tsserver which already handles tsconfig routing. No special handling needed on our side.
* **Path aliases**: Module resolution uses the project's tsconfig.json automatically via tsserver. No custom resolution needed.
* **esbuild bundling caveats**: `@startupjs/pug-lexer` and `pug-parser` may use dynamic `require()`. Verify they bundle correctly with esbuild; if not, mark as external and include in the VSIX.
* **Volar version pinning (if adopted)**: If the Milestone 2 spike leads to adopting `@volar/typescript` and `@volar/language-core`, pin to exact versions in `package.json`. Volar has had breaking changes between major versions (v1.x to v2.0 renamed APIs). Test thoroughly before upgrading.
* **Two-compiler maintenance sync**: Our IntelliSense TSX generator diverges from the Babel plugin's output. When `babel-plugin-transform-react-pug` adds support for a new Pug construct, our generator must be updated too. Track the Babel plugin's changelog and maintain a compatibility matrix.
* **TS plugin runs inside tsserver**: Keep all plugin code synchronous. Avoid heavy allocations or blocking I/O in intercepted methods (`getCompletionsAtPosition`, `getSemanticDiagnostics`, etc.) since they run on tsserver's main thread and block ALL TS features for the workspace.
* **Start lean, keep Volar-compatible**: Build custom TS plugin infrastructure first. Use interfaces compatible with `@volar/language-core` mapping types (offset-pair arrays with source/generated ranges). If custom infra exceeds ~1500 lines or edge cases around caching/versioning/incremental updates multiply, swap in `@volar/typescript` and `@volar/language-core` packages with minimal refactoring. The core logic (`src/language/`) remains unchanged either way.

---

## 8) Deliverables

* **VS Code extension** (VSIX) published on VS Code marketplace
  * Bundled with esbuild (TS plugin + core logic in single JS file; extension client in separate JS file)
  * Target: VSIX total size under 2MB (lean custom plugin keeps this achievable; if Volar packages are pulled in, verify size impact)
  * Support pre-release channel for early adopters
* **TextMate grammar** for pug syntax highlighting inside template literals
* **README** with:
  * Installation instructions
  * Supported Pug syntax and known limitations
  * Debugging guide (Show Shadow TSX command, trace logging)
  * Compatibility notes (TypeScript version, React setup)
* **Example project** in `examples/` demonstrating all supported features
* **Full test suite** with fixtures (unit + integration + smoke)
* **CI pipeline** (GitHub Actions): lint, typecheck, test, build VSIX

### Build pipeline

```
src/ --[tsc]--> type checking
src/ --[esbuild]--> dist/plugin.js  (bundled TS plugin + core logic)
src/ --[esbuild]--> dist/client.js  (VS Code extension client: activation + pug diagnostics)
syntaxes/ + dist/ + package.json --[@vscode/vsce]--> extension.vsix
```

---

## 9) Project structure

Single package, separate repository from `babel-plugin-transform-react-pug`:

```
vscode-pug-react/
  src/
    language/              # Core logic (framework-agnostic)
      extractRegions.ts    # Find pug tagged template literals in TS/TSX
      pugToTsx.ts          # Pug-to-TSX generator with mapping segments
      shadowDocument.ts    # Build full shadow document from regions
      mapping.ts           # Mapping utilities and types
    plugin/                # TS plugin (custom, Volar-compatible interfaces)
      index.ts             # Plugin factory, getScriptSnapshot patching
      diagnostics.ts       # Intercept getSemanticDiagnostics, map positions
    extension/             # VS Code client (lightweight)
      index.ts             # Activation, TS plugin registration, commands
      pugDiagnostics.ts    # Pug parse error diagnostics (non-TS)
  test/
    fixtures/              # Sample TS project with tsconfig + components
    unit/                  # Unit tests (co-located by module)
      extractRegions.test.ts
      pugToTsx.test.ts
      mapping.test.ts
    integration/           # Integration tests
      completions.test.ts
      diagnostics.test.ts
      navigation.test.ts
    smoke/                 # VS Code e2e smoke tests
      basic.test.ts
  syntaxes/
    pug-template-literal.json  # TextMate grammar injection
  examples/
    sample-project/        # Example React+TS project using pug templates
  package.json             # Single package manifest + VS Code extension config
  tsconfig.json
  vitest.config.ts
  esbuild.config.ts        # Build configuration
  .github/workflows/ci.yml
```

Tests live next to the code they test, NOT in a separate package.

---

## 10) MVP scope vs v1 scope

### MVP (ship as pre-release at Milestone 3)

* **Syntax highlighting** inside `pug\`...\`` template literals
* **Completions**: component names, props/attributes, intrinsic elements
* **Hover**: type information for components, props, variables
* **Show Shadow TSX** debug command
* Mapping correct for:
  * Tag/component names
  * Attribute names and values (expressions)
  * `#{}` text interpolations
  * Nested elements
* TS projects (`.ts/.tsx`) only

### v1.0 (ship as stable at Milestone 7)

* **Diagnostics**: type errors, pug parse errors, mapped to correct positions
* **Go-to-definition**: from component/variable usage in pug to source
* **Rename**: across pug/TS boundaries
* **Find references**: across pug/TS boundaries
* **Signature help**: inside attribute expressions
* JS support (`.js/.jsx`)
* Configuration options (custom tag name, enable/disable features)
* Robust error handling and edge case coverage
* Performance within targets (<150ms completions)

### v1.x (future)

* Code actions (auto-import, quick fixes)
* Support for `${}` template interpolation inside pug templates
* Formatting support (pug formatting inside template literals)
* Multi-cursor / multi-selection support for rename
* Semantic highlighting from TS plugin (supplement TextMate grammar)

---

## 11) Success metric

"Feels like JSX" inside Pug:

* **Feature parity**: >80% of typical JSX IntelliSense features work correctly inside pug templates in real-world projects
* **Latency**: Completion response <150ms (warm cache) for typical files
* **Reliability**: <1% of IntelliSense requests return incorrect positions (mapping errors), enforced by golden tests
* **Adoption**: Extension installable in <30 seconds with zero configuration (no tsconfig edits required for basic usage)
* **Stability**: No crashes on any input, including malformed pug, empty templates, and files with syntax errors

END.
