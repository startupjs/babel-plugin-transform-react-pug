# plan.md — VS Code "First-Class" IntelliSense for `pug\`...\`` (babel-plugin-transform-react-pug)

## 0) Goal

Build **JSX-grade editor support** in VS Code for React projects that use `babel-plugin-transform-react-pug`, where Pug templates are written inside **tagged template literals**:

```ts
const view = pug`
  .card
    Button(onClick=onClick) Click
`
```

Inside Pug templates the developer gets:

* **Syntax highlighting** (TextMate grammar injection)
* **JSX/TSX-like auto-completion** (components, props/attributes, event handlers)
* **Hover type info**
* **Go-to-definition / find references**
* **Rename symbol** (across pug/TS boundaries)
* **Diagnostics** (type errors + Pug parse errors, correctly positioned)
* **Works with TS and JS** projects

This must feel "first-class" — the same quality as writing JSX directly.

We deliver:

1. A **VS Code extension** (lightweight client + TextMate grammar)
2. A **TypeScript plugin** (runs inside tsserver, provides all IntelliSense via shadow TSX)
3. A **Pug-to-TSX generator** with precise bidirectional source mapping
4. A **test harness** with heavy TDD and CI gates

Non-goals:

* Building a full Pug language server
* Supporting every Pug feature (we support exactly what the Babel plugin supports + common React patterns)

---

## 1) Constraints & Requirements

### 1.1 Hard requirements

* Must support tagged template literal syntax `pug\`...\`` in `.ts/.tsx/.js/.jsx`.
* Must provide IntelliSense **inside the template literal content** (not just syntax highlighting).
* Must use TypeScript's language service for semantic features (components/props/types).
* Must not conflict with VS Code's built-in TypeScript extension.
* Must map edits, ranges, and diagnostics precisely back to original Pug positions.
* Must be stable on large projects (no full-project reparse on every keystroke).
* Must degrade gracefully:
  * If Pug parsing fails, show syntax errors but don't crash.
  * If mapping fails for a specific construct, provide partial results.
* Must have **comprehensive automated tests**:
  * Golden tests for mapping correctness
  * Integration tests for TS plugin behavior
  * Snapshot tests for TSX generation
* Must include CI that blocks merge on failed tests/lint/typecheck.

### 1.2 Performance requirements

* Completion response ≤ 150ms for typical files (warm cache).
* Pug-to-TSX pipeline: ~1.5ms per template (benchmarked: pug-lexer + pug-parser ~0.9ms, TSX emission ~0.5ms).
* Incremental update: re-generate shadow TSX only for changed template(s).
* No separate TS language service — share the existing tsserver instance via the TS plugin.

### 1.3 Compatibility requirements

* Works with TypeScript 5.x used by the workspace.
* Works with React component resolution:
  * Local component imports
  * Default/named exports
  * JSX intrinsic elements (`div`, `span`, etc.)
* Works with common tooling stacks: Vite/React, Next.js, CRA
* Works with project configurations: path aliases (`paths`/`baseUrl`), project references, monorepos with multiple tsconfigs.
* Windows/macOS/Linux.

### 1.4 Architectural constraint: no full LSP server for TS/TSX files

A full LSP server that registers for `typescript`/`typescriptreact` language IDs will conflict with VS Code's built-in TypeScript features — producing duplicate completions, hover, and diagnostics. Our files are `.ts/.tsx` — already fully owned by the built-in TS extension. We must work **within** tsserver, not alongside it. This drives the TS plugin architecture.

---

## 2) Architecture overview

### The "Volar Hybrid" pattern

We use the same architectural pattern as Vue's language tools (Volar v2 "Hybrid Mode"): a **TypeScript plugin** that runs inside tsserver, patching the LanguageServiceHost to serve shadow TSX content, combined with a **lightweight VS Code extension** for activation and Pug-specific features.

This was chosen over three alternatives after rigorous evaluation:

| Approach | Verdict | Reason |
|----------|---------|--------|
| **Full LSP server** (original plan) | Rejected | Registers for `typescript`/`typescriptreact` language IDs → duplicate completions/hover/diagnostics with built-in TS. Requires separate TS language service (double memory). |
| **Pure TS plugin** (`TemplateLanguageService`) | Rejected | Can only provide custom intelligence for template literal strings (must embed own TS service). Lacks rename support. |
| **Full Volar framework** (`@volar/language-server`) | Rejected for primary | Designed for custom file types (.vue, .svelte); our files are standard .ts/.tsx already owned by built-in TS. Full Volar LSP for .ts/.tsx creates the same conflict. |
| **TS plugin with host patching** (chosen) | ✓ | Patches `getScriptSnapshot` so tsserver natively sees shadow TSX. All IntelliSense features work through existing tsserver. Zero conflict. Proven at scale by Vue. |

### Architecture diagram

```
┌─────────────────────────────────────────────┐
│              VS Code Extension               │
│  - Activates TS plugin                       │
│  - TextMate grammar for pug highlighting     │
│  - "Show Shadow TSX" command                 │
│  - Pug parse error diagnostics               │
│  - Configuration settings                    │
└──────────────────┬──────────────────────────┘
                   │ activates
┌──────────────────▼──────────────────────────┐
│           TypeScript Plugin                  │
│       (runs inside tsserver)                 │
│                                              │
│  create(info: PluginCreateInfo):             │
│                                              │
│  1. Patch info.languageServiceHost           │
│     .getScriptSnapshot() → shadow TSX        │
│     .getScriptVersion() → bump on change     │
│                                              │
│  2. Proxy info.languageService methods       │
│     For position-based methods:              │
│     - Check if position is in pug region     │
│     - Map original offset → shadow offset    │
│     - Call underlying LS method              │
│     - Map result offsets back                │
│     For diagnostic methods:                  │
│     - Get diagnostics from shadow TSX        │
│     - Map spans back to original offsets     │
│     - Filter out synthetic-region artifacts  │
│                                              │
│  Uses: Core Library                          │
└──────────────────┬──────────────────────────┘
                   │ imports
┌──────────────────▼──────────────────────────┐
│              Core Library                    │
│                                              │
│  - extractPugRegions(text) → PugRegion[]     │
│  - compilePugToTSX(pugText) → {tsx, maps}    │
│  - buildShadowDocument(text, regions)        │
│    → {shadowText, mappingIndex}              │
│  - MappingIndex (via @volar/source-map)      │
│    .originalToShadow(offset) → offset        │
│    .shadowToOriginal(offset) → offset        │
│    .isInPugRegion(offset) → boolean          │
│                                              │
│  Uses: @volar/source-map (bidirectional      │
│         offset mapping with binary search)   │
└─────────────────────────────────────────────┘
```

### Selective Volar usage

* **USE `@volar/source-map`**: Battle-tested bidirectional offset lookup with binary search. Small, focused package.
* **DON'T USE `@volar/language-core`**: `VirtualCode`, `LanguagePlugin`, `embeddedCodes` — designed for custom file types, wrong abstraction for our embedded-regions-in-standard-TS case.
* **DON'T USE `@volar/language-server`**: We don't need an LSP server; the TS plugin handles everything.
* **DON'T USE `@volar/typescript`**: We write the host patching ourselves, informed by Volar's `decorateLanguageServiceHost.ts`. If total plugin infrastructure exceeds ~1500 lines, we re-evaluate pulling in `@volar/typescript`.

### Complexity budget

The custom plugin infrastructure should stay under ~1500 lines:
- `plugin/index.ts`: Plugin factory, host patching (~100 lines)
- `plugin/proxy.ts`: LS method proxying with position mapping (~300-500 lines)
- `plugin/mapping.ts`: Bidirectional offset mapping using CodeMapping[] (~200-300 lines)
- `plugin/diagnostics.ts`: Diagnostic filtering and mapping (~150-200 lines)
- `plugin/documentManager.ts`: Shadow document lifecycle and caching (~150-200 lines)

If this threshold is exceeded, swap in `@volar/typescript` + `@volar/source-map`. The core library (`src/language/`) remains unchanged.

### Components

* `src/extension/` — VS Code client: starts TS plugin, provides TextMate grammar, debug commands, pug parse error diagnostics
* `src/plugin/` — TS plugin: host patching, LS method proxying with position mapping
* `src/language/` — Core library: region extraction, pug-to-TSX generator, source mapping

---

## 3) Detailed design

### 3.1 Document model

Each open file with pug regions has:

```ts
interface PugDocument {
  /** Original file text as the user sees it */
  originalText: string;

  /** File URI / path */
  uri: string;

  /** Detected pug`` template literal regions */
  regions: PugRegion[];

  /** Shadow TSX text (original with pug regions replaced by generated TSX) */
  shadowText: string;

  /** Version counter, bumped on every edit */
  version: number;

  /** Cumulative offset deltas for mapping positions outside pug regions */
  regionDeltas: number[];
}

interface PugRegion {
  /** Offset of the entire tagged template expression (pug`...`) in the original file */
  originalStart: number;
  originalEnd: number;

  /** Offset of just the template content (inside backticks) */
  pugTextStart: number;
  pugTextEnd: number;

  /** Extracted pug source text (with common indent stripped) */
  pugText: string;

  /** Offset of the generated TSX expression in the shadow file */
  shadowStart: number;
  shadowEnd: number;

  /** Generated TSX expression text */
  tsxText: string;

  /** Source mappings for this region (Volar-compatible format) */
  mappings: CodeMapping[];

  /** Retained lexer tokens for sub-expression position resolution */
  lexerTokens: PugToken[];

  /** Pug parse error, if any (null = parsed successfully) */
  parseError: PugParseError | null;
}
```

### Position mapping rules

For any position in the original file:

1. **Binary search `regions` by `originalStart`/`originalEnd`.**
2. If the position falls **outside all regions**: the shadow position equals the original position plus the cumulative delta from all preceding regions (each region may change length when pug is replaced with TSX).
3. If the position falls **inside a region**: use the region's `mappings` array for character-level bidirectional mapping via `@volar/source-map`.

The `regionDeltas` array stores precomputed cumulative offset adjustments:
```
regionDeltas[i] = sum of (region[j].tsxText.length - region[j].pugOriginalLength) for j < i
```

This allows O(log n) position mapping for positions outside pug regions.

---

### 3.2 Extracting pug regions (host parser)

#### Approach

Use `@babel/parser` with TypeScript and JSX plugins to parse the host file and locate `TaggedTemplateExpression` nodes where `tag.name === 'pug'` (configurable via `pugReact.tagName` setting).

#### Implementation

```ts
function extractPugRegions(text: string, filename: string): PugRegion[]
```

1. Parse with `@babel/parser` using plugins: `typescript`, `jsx`, `decorators-legacy`.
2. Walk AST to find `TaggedTemplateExpression` with `tag.name === 'pug'`.
3. For each match, extract:
   - `originalStart` / `originalEnd` from node `start`/`end`
   - `pugTextStart` / `pugTextEnd` from `quasi.quasis[0].start`/`quasi.quasis[last].end` (adjusted for backtick)
   - `pugText`: raw template content with common indent stripped (matching the existing Babel plugin's `common-prefix` stripping logic from `src/index.js:43-51`)
4. Handle `${}` template interpolations:
   - **MVP**: Emit a diagnostic "JS template interpolation not supported inside pug; use Pug's #{} interpolation" and treat the region as having a parse error.
   - **Later**: Support `${}` by stitching template segments, matching the existing plugin's `getInterpolatedTemplate()` approach.

#### Edge cases

- Multiple pug templates in one file: return all regions, sorted by offset.
- Nested pug templates (pug inside `${}` inside pug): handle via recursive extraction.
- Non-pug tagged templates: skip.
- Malformed template literals: skip, let TS handle the syntax error.

#### Error recovery

If `@babel/parser` fails (rare for a file that VS Code considers valid), fall back to a regex-based region finder as a degraded mode.

---

### 3.3 Generating TSX from Pug (IntelliSense-optimized)

#### Core principle

The generated TSX must be **type-checkable and mappable**, not executable. It is optimized for TypeScript's type checker and IntelliSense features, not for React's runtime. It must be a **semantic superset** of the Babel plugin's output: everything the Babel plugin accepts should type-check in our TSX; we may accept additional constructs but never fewer.

#### Pipeline

```
pug text
  -> @startupjs/pug-lexer  (tokens with precise loc)
  -> pug-strip-comments
  -> pug-parser             (AST with line/column)
  -> IntelliSense TSX emitter (TSX text + source mappings)
```

We reuse the existing `@startupjs/pug-lexer` + `pug-parser` + `pug-strip-comments` pipeline (same as the Babel plugin in `src/parse-pug.js`). We write a **new TSX text emitter** that walks the Pug AST and produces:
1. TSX expression text (string)
2. `CodeMapping[]` (Volar-compatible source mappings)

The lexer token stream is **retained alongside the AST** for sub-expression position resolution. The lexer provides precise `loc.start`/`loc.end` for every token — positions that the parser AST sometimes discards.

#### Performance

Benchmarked: pug-lexer + pug-parser runs in **~0.9ms** per moderately complex 20-line template. TSX emission adds ~0.5ms. Total pipeline: **~1.5ms per template**. Well within the 150ms completion response budget, even for files with 10+ templates.

**Caching**: Cache parsed AST + generated TSX + mappings per pug region, keyed by region text content hash. Only re-parse regions whose text actually changed.

#### Per-construct IntelliSense TSX shapes

For each Pug construct, the IntelliSense TSX shape may differ from the Babel plugin's build output where this improves type-checking or mapping accuracy.

##### Tags

| Pug | IntelliSense TSX |
|-----|------------------|
| `Button(onClick=handler)` | `<Button onClick={handler} />` |
| `.card` | `<div className="card" />` |

Tags map directly. When the parser synthesizes `div` for shorthand-only elements (`.card`), we emit `<div>` but mark it as synthetic in the mappings.

##### Attributes

| Pug | IntelliSense TSX |
|-----|------------------|
| `onClick=handler` | `onClick={handler}` |
| `disabled` (boolean) | `disabled={true}` |
| `...props` | `{...props}` |

Each attribute name and value expression is identity-mapped. Structural syntax (`=`, `{`, `}`) is synthetic.

##### Class and ID shorthands

| Pug | IntelliSense TSX |
|-----|------------------|
| `.foo` | `<div className="foo">` |
| `.foo.bar#baz` | `<div className="foo bar" id="baz">` |
| `.foo(className=dynamicClass)` | `<div className={"foo" + " " + dynamicClass}>` |

Shorthands are marked with `CSS_CLASS` CodeInformation (no completions/navigation — they're CSS class names, not TS identifiers).

##### Text content (KEY DIVERGENCE)

| Pug | Babel Output | IntelliSense TSX |
|-----|-------------|------------------|
| `p Hello` | `<p>Hello</p>` | `<p>Hello</p>` (same) |
| `p Hello #{name}` | `<p>{["Hello ", name].join("")}</p>` | `<p>{"Hello "}{name}</p>` |
| `p #{a} and #{b}` | `<p>{[a, " and ", b].join("")}</p>` | `<p>{a}{" and "}{b}</p>` |

For text with interpolations, the Babel plugin produces `[...].join("")` which obscures type information. Our TSX uses JSX expression containers directly, preserving each interpolated expression for hover, go-to-def, and completions.

##### Conditionals (if / else if / else)

| Pug | IntelliSense TSX |
|-----|------------------|
| `if show` / `else` | `show ? <consequent> : <alternate>` |
| `if a` / `else if b` / `else` | `a ? <c1> : b ? <c2> : <c3>` |

Ternary chains, same as the Babel plugin. This shape is excellent for IntelliSense — TypeScript narrows types in each branch.

##### Each loops (KEY DIVERGENCE)

| Pug | Babel Output | IntelliSense TSX |
|-----|-------------|------------------|
| `each item, i in items` / body | `items.map((item, i) => { let _name; return [...]; })` | `items.map((item, i) => (<body/>))` |

Key divergences: **no variable renaming** (preserve original names for hover/rename), **clean arrow body** (no null-interspersed arrays).

**Mapping challenge**: The parser AST gives `{val: "item", key: "i", obj: "items", line, column}` without sub-positions. We extract sub-positions via a mini-parser for the `each` line, validated against the lexer token span.

##### Code blocks (KEY DIVERGENCE)

| Pug | Babel Output | IntelliSense TSX |
|-----|-------------|------------------|
| `- const x = 10` | `((_x = 10), null)` with hoisted `let _x` | `const x = 10;` as a statement |

The Babel plugin renames variables and hoists declarations. For IntelliSense, we preserve original declaration forms and variable names. When code blocks mix with JSX-producing nodes, we wrap in an IIFE to allow statements:

```tsx
// Pug:                         IntelliSense TSX:
// - const x = 10              (() => {
// div= x                       const x = 10;
//                               return (<div>{x}</div>);
//                              })()
```

##### While loops (KEY DIVERGENCE)

| Pug | Babel Output | IntelliSense TSX |
|-----|-------------|------------------|
| `while test` / body | IIFE with array push | `(() => { const __r: JSX.Element[] = []; while (test) { __r.push(<body/>); } return __r; })()` |

Simplified wrapper that TypeScript can type-check. The `test` expression and body expressions are identity-mapped.

##### Case / When

Chained ternaries, same shape as the Babel plugin. Each `when` expression maps to the corresponding comparison value.

##### Multiple root nodes

Wrapped in a JSX fragment `<>...</>`, same as the Babel plugin.

#### Superset rule

Our IntelliSense TSX must accept everything the Babel plugin accepts. Enforced by testing against the same 20+ fixture files from `src/__tests__/*.input.js`.

---

### 3.4 Source mapping

#### Format

We use Volar's `Mapping<CodeInformation>` format (aliased as `CodeMapping`):

```ts
interface Mapping<Data> {
  sourceOffsets: number[];      // positions in pug region text
  generatedOffsets: number[];   // positions in generated TSX text
  lengths: number[];            // span lengths (source side)
  generatedLengths?: number[];  // span lengths (generated side, if different)
  data: Data;                   // CodeInformation controlling features
}
```

#### CodeInformation presets

```ts
/** Expressions, tag names, attribute names/values — full IntelliSense */
const FULL_FEATURES: CodeInformation = {
  completion: true, navigation: true, verification: true, semantic: true,
};

/** Class/ID shorthands — CSS names, not TS identifiers */
const CSS_CLASS: CodeInformation = {
  completion: false, navigation: false, verification: false, semantic: false,
};

/** Structural syntax (JSX brackets, keywords) — no features */
const SYNTHETIC: CodeInformation = {
  completion: false, navigation: false, verification: false, semantic: false,
};

/** Expressions that should show diagnostics but not completions */
const VERIFY_ONLY: CodeInformation = {
  completion: false, navigation: true, verification: true, semantic: true,
};
```

#### Mapping generation via TsxEmitter builder

```ts
class TsxEmitter {
  private tsx = '';
  private mappings: CodeMapping[] = [];
  private offset = 0;

  /** Emit text that maps 1:1 to pug source */
  emitMapped(text: string, pugOffset: number, info: CodeInformation): void { ... }

  /** Emit text that maps with different lengths */
  emitDerived(text: string, pugOffset: number, pugLength: number, info: CodeInformation): void { ... }

  /** Emit structural TSX with no pug source (unmapped) */
  emitSynthetic(text: string): void { ... }

  getResult(): { tsx: string; mappings: CodeMapping[] } { ... }
}
```

#### Bidirectional lookup

`@volar/source-map`'s `SourceMap` class provides:
- `toSourceLocation(generatedOffset)` — TSX → Pug
- `toGeneratedLocation(sourceOffset)` — Pug → TSX
- Methods accept a `filter` callback on `CodeInformation` for feature-specific mapping.

#### "Falls between segments" handling

When a position falls in an unmapped (synthetic) region:
- **Hover**: use nearest mapped segment (fuzzy result)
- **Rename**: reject fuzzy results
- **Completion**: use nearest expression position
- **Diagnostics**: expand to nearest Pug-side construct boundary

---

### 3.5 TypeScript plugin integration

#### Host patching

The TS plugin patches `info.languageServiceHost` in its `create()` function:

```ts
function create(info: ts.server.PluginCreateInfo) {
  const host = info.languageServiceHost;
  const originalGetSnapshot = host.getScriptSnapshot.bind(host);
  const originalGetVersion = host.getScriptVersion.bind(host);

  host.getScriptSnapshot = (fileName) => {
    const pugDoc = getPugDocument(fileName);
    if (pugDoc) {
      return ts.ScriptSnapshot.fromString(pugDoc.shadowText);
    }
    return originalGetSnapshot(fileName);
  };

  host.getScriptVersion = (fileName) => {
    const pugDoc = getPugDocument(fileName);
    if (pugDoc) {
      return String(pugDoc.version);
    }
    return originalGetVersion(fileName);
  };
}
```

Key properties:
- Shadow content is served **under the original filename** — no virtual filenames, no `__pugtsx__` paths.
- Module resolution works identically to the original project.
- Only files containing pug regions are intercepted; all other files pass through unmodified.
- One tsserver project per tsconfig root (handled by tsserver, not by us).

#### LS method proxying

The plugin proxies ALL relevant `info.languageService` methods via a `for-in` loop:

```ts
const proxy = Object.create(null) as ts.LanguageService;
for (const k in info.languageService) {
  proxy[k] = function () { return info.languageService[k].apply(info.languageService, arguments); };
}
// Then override specific methods with position mapping
proxy.getCompletionsAtPosition = (fileName, position, options) => { /* map, call, map back */ };
// ... etc
```

The pattern for each position-based method is identical:
1. Check if `fileName` has pug regions and `position` falls inside one
2. Map original offset → shadow TSX offset
3. Call underlying LS method with mapped position
4. Map result positions/ranges back to original offsets
5. Return mapped results

For diagnostic methods (`getSemanticDiagnostics`, `getSyntacticDiagnostics`, `getSuggestionDiagnostics`): get all diagnostics, filter to those inside mapped pug regions, map their spans back, suppress synthetic-region artifacts.

### 3.6 Feature routing

#### Methods to intercept

**Must have (MVP):**
- `getCompletionsAtPosition` / `getCompletionEntryDetails` — completions
- `getQuickInfoAtPosition` — hover
- `getDefinitionAtPosition` / `getDefinitionAndBoundSpan` — go-to-def
- `getTypeDefinitionAtPosition` — go-to-type-def
- `getSyntacticDiagnostics` / `getSemanticDiagnostics` / `getSuggestionDiagnostics` — diagnostics
- `getSignatureHelpItems` — parameter hints

**Should have (v1):**
- `findRenameLocations` / `getRenameInfo` — rename
- `findReferences` / `getReferencesAtPosition` — find references
- `getDocumentHighlights` — highlight occurrences
- `getImplementationAtPosition` — go-to-implementation

**Nice to have:**
- `getApplicableRefactors` / `getEditsForRefactor`
- `getCodeFixesAtPosition` / `getCombinedCodeFix`

#### Non-pug positions

When the cursor is **outside** a pug region, all proxied methods simply delegate to the underlying LanguageService with no position transformation. The built-in TS experience is unaffected.

---

### 3.7 Diagnostics strategy

#### Diagnostic sources

1. **Pug parse errors** (syntax): Emitted by the VS Code extension when `pug-lexer` or `pug-parser` throws. Positioned at the pug region via `vscode.languages.createDiagnosticCollection`.

2. **Pug validation errors**: Constraints matching the Babel plugin. Emitted by the TSX emitter.

3. **TypeScript diagnostics**: The TS plugin intercepts `getSemanticDiagnostics` and `getSyntacticDiagnostics`, maps spans from shadow TSX back to pug positions, and returns mapped diagnostics. The built-in TS extension handles publishing — no separate diagnostic pipeline needed.

#### Error recovery

When a pug region has a parse error:
1. Emit a diagnostic for the error, positioned at the region.
2. Replace the region in the shadow file with a type-compatible placeholder: `(null as any as JSX.Element)`.
3. Cache the last successful shadow TSX for the region. Serve stale-but-functional shadow until the error is fixed.

#### Diagnostic filtering

- **Include**: Diagnostics whose span falls within a mapped (non-synthetic) region.
- **Exclude**: Diagnostics whose span falls entirely within synthetic/structural TSX.
- **Edge**: Diagnostics spanning both — expand to nearest Pug construct boundary.

#### Debouncing

Pug parse error diagnostics: debounce at 200-300ms via the VS Code extension.
TS diagnostics: handled by tsserver's built-in update cycle.

---

### 3.8 Edge cases and known limitations

#### 3.8.1 Multiline attribute expressions

Use the lexer's attribute token `loc.start`/`loc.end` (not computed column offsets) to determine exact spans.

#### 3.8.2 Implicit div tags

`.card` → `<div className="card">`. The `<div>` is synthetic. Cursor on `.card` maps to the `className` attribute region.

#### 3.8.3 Spread attributes

Parser stores `name: "...props"`. Emit `{...props}`, mapping only `props` (at offset +3).

#### 3.8.4 `${}` JS template interpolation

MVP: emit diagnostic "use Pug #{} interpolation instead". Later: full support via segment stitching.

#### 3.8.5 Each with destructuring

`each {name, age}, i in users` → emit destructuring verbatim as `.map()` parameter.

#### 3.8.6 Template literals inside Pug expressions

`div= \`hello ${world}\`` — backtick conflicts with outer template literal. Document as unsupported; users must extract to a variable.

#### 3.8.7 Adjacent text and interpolation

Each text fragment and interpolated expression gets its own `CodeMapping` with appropriate `CodeInformation`.

#### 3.8.8 Nested loops with same variable names

Preserve both as original names; JavaScript's natural scoping in nested `.map()` handles it correctly.

#### 3.8.9 Empty blocks

Emit `null` as the empty consequent/body. Synthetic (unmapped).

#### 3.8.10 UTF-16 position encoding

All offset conversions must account for surrogate pairs. Use consistent UTF-16 code unit arithmetic.

---

### 3.9 Configuration

Expose VS Code settings:

* `pugReact.tagName` — default `"pug"`. The tagged template literal identifier to recognize.
* `pugReact.enableDiagnostics` — default `true`. Toggle TS diagnostic mapping for pug regions.
* `pugReact.classAttribute` — default `"className"`. Attribute name for CSS classes (`className` for React, `class` for Preact). Matches the Babel plugin's `classAttribute` option.
* `pugReact.trace.server` — `"off"` / `"messages"` / `"verbose"`. Debug logging level.

### 3.10 Logging & debugging

* **"Pug React: Show Shadow TSX"** command: opens the generated shadow TSX for the current file in a read-only editor. Essential for debugging mapping issues.
* **Trace logging**: configurable via `pugReact.trace.server` setting. Logs region extraction, TSX generation, position mapping, and diagnostic filtering.

---

## 3.NEW) Syntax highlighting (TextMate grammar injection)

Syntax highlighting inside `pug\`...\`` is a critical DX requirement. Without it, Pug code appears as plain strings.

### Approach

Use VS Code's grammar injection mechanism (same pattern as `vscode-styled-components` for CSS-in-JS):

* Create `syntaxes/pug-template-literal.json` with:
  * `injectionSelector`: `L:source.ts,L:source.tsx,L:source.js,L:source.jsx`
  * Pattern matching `pug` identifier followed by backtick
  * `contentName: "source.pug"` to delegate to the Pug grammar
* Register in `package.json` under `contributes.grammars`
* Declare `"embeddedLanguages": { "source.pug": "jade" }`

### Dependencies

Bundle the Pug TextMate grammar from the `Better Pug` VS Code extension (MIT licensed) to avoid requiring a separate install.

### Priority

**First deliverable** (Milestone 1). Ships independently of the TS plugin, gives users immediate visible value.

---

## 4) TDD / QA plan

### 4.1 Test layers

#### Layer 1 — Unit tests (vitest, fast, CI-gating)

* **Region extraction**: correct offsets in complex TS/TSX (decorators, generics, nested templates, multiple tags per file)
* **Pug-to-TSX generation**: snapshot tests for all supported constructs, type-equivalence with Babel plugin output
* **Source mapping**: golden tests for mapped positions at specific offsets, roundtrip accuracy
* **Shadow document generation**: full-file validity, multi-region correctness

#### Layer 2 — Integration tests (vitest, medium, CI-gating)

* Load TS plugin with sample tsconfig and fixtures
* Verify completions, hover, go-to-def, diagnostics at mapped positions
* Incremental update correctness
* Error resilience (invalid pug doesn't crash)

#### Layer 2.5 — VS Code smoke tests (vscode-test, nightly, NOT CI-gating)

3-5 tests maximum:
1. Syntax highlighting applies inside pug templates
2. Completions include typed props
3. Hover shows type info
4. Diagnostics appear at correct positions
5. "Show Shadow TSX" command works

### 4.2 Required test fixtures

14 fixture categories: intrinsic elements, imported components with typed props, union/optional props, event handlers, text interpolation, conditionals, each loops, multiple templates per file, nested components, class/id shorthand, spread attributes, diagnostics (wrong types), robustness (invalid syntax), and type-equivalence against Babel plugin fixtures.

### 4.3 Testing framework

* **vitest** (ESM-native, TypeScript-first, fast, built-in snapshot support)
* **@vscode/test-electron** for smoke tests
* No property-based testing — golden fixtures provide better debuggability
* Coverage target: >90% for `src/language/`

### 4.4 No-regression policy

* Every bug gets a reproduction fixture + test before fix
* CI runs unit + integration on every PR (must pass)
* Smoke tests run nightly

---

## 5) Implementation plan (milestones)

### Milestone 0 — Architecture spike (2-3 days)

Validate the TS plugin approach:

* Set up a minimal TS plugin that patches `getScriptSnapshot` for a test `.tsx` file
* Return hand-written shadow TSX with a simple mapping
* Verify `getCompletionsAtPosition` returns expected results at a mapped position
* Test with `@volar/source-map` for bidirectional offset lookup

**Note**: Research during planning revealed that `@volar/typescript`'s `decorateLanguageServiceHost` internally uses `VirtualCode`/`LanguagePlugin` abstractions — the same ones that power Vue's hybrid mode. The spike should evaluate whether adopting `@volar/typescript` with these abstractions (which handles ~40 LS method proxies with automatic position mapping) is preferable to building ~800-1200 lines of custom proxying code. Start lean; adopt Volar packages if the custom infrastructure exceeds ~1500 lines.

**Gate**: If the spike succeeds (completions work at mapped positions), proceed. If it hits fundamental blockers, fall back to full custom implementation informed by Volar's patterns.

Deliverable: Spike report with go/no-go and Volar adoption recommendation.

### Milestone 1 — Syntax highlighting + project scaffold

* Create new repo `vscode-pug-react` with flat structure
* Implement TextMate grammar injection for pug syntax highlighting
* Set up tooling: TypeScript, vitest, eslint, esbuild
* Set up CI: GitHub Actions for lint, typecheck, tests

Deliverable: Installable extension with syntax highlighting. CI green.

### Milestone 2 — Region extraction + pug-to-TSX generator (TDD)

* Implement `extractPugRegions()` with `@babel/parser`
* Implement `compilePugToTsx()` with IntelliSense-optimized emitter
* Implement `buildShadowDocument()`
* Snapshot tests, golden mapping tests

Deliverable: Generator + mapping with comprehensive tests passing.

### Milestone 3 — TS plugin + basic completions (end-to-end MVP)

* Wire TS plugin: `getScriptSnapshot` patching, position mapping for completions + hover
* Wire VS Code extension: activation, "Show Shadow TSX" command
* Integration tests

Deliverable: **Working MVP**. Ship as pre-release on VS Code marketplace.

### Milestone 4 — Diagnostics + go-to-definition

* TS plugin intercepts `getSemanticDiagnostics`/`getSyntacticDiagnostics`, maps positions
* Extension publishes pug parse error diagnostics
* Position mapping for `getDefinitionAtPosition`

Deliverable: Diagnostics at correct positions. Go-to-def works.

### Milestone 5 — Rename + references

* Position mapping for `findRenameLocations`, `getRenameInfo`, `getReferencesAtPosition`
* Handle edits spanning pug/non-pug boundaries

Deliverable: Rename and find-references across boundaries.

### Milestone 6 — Polish + additional features

* Signature help, code actions, improved diagnostics filtering
* Configuration settings
* JS/JSX support

Deliverable: Feature-complete IntelliSense.

### Milestone 7 — Hardening + release

* Multi-workspace, file renames, tsconfig changes, path aliases
* Performance benchmarking and optimization
* Documentation, example project
* Error handling for all failure modes

Deliverable: v1.0 stable release.

---

## 6) Acceptance criteria

A PR is "done" only if ALL are true:

* CI green (lint, typecheck, unit tests, integration tests)
* In the sample TSX fixture project:
  * Inside `pug\`...\`` typing `Button(` suggests typed props
  * Hover on `Button` shows component type information
  * Go-to-definition from `Button` navigates to source file
  * Wrong prop type shows a diagnostic with correct underline position
  * Renaming a variable used in `#{varName}` updates all occurrences
  * Pug syntax highlighting is visible inside template literals
* No crashes on invalid Pug syntax
* "Show Shadow TSX" command shows content consistent with mappings

---

## 7) Engineering notes / key pitfalls

* **UTF-16 positions**: VS Code and TypeScript use UTF-16 code units. Account for surrogate pairs.
* **Don't fight built-in TS**: Our plugin runs INSIDE tsserver. Only transform `getScriptSnapshot` for files with pug regions.
* **Debounce diagnostics**: Pug parse error diagnostics debounced at 200-300ms via extension. TS diagnostics handled by tsserver's update cycle.
* **Script version**: Bump `getScriptVersion` when shadow content changes, or TS serves stale cached results.
* **React fragments**: Always use `<>...</>` in generated TSX.
* **Pug indentation stripping**: Match the Babel plugin's `common-prefix` logic (`src/index.js:43-51`).
* **Template interpolation** (`${}`): MVP unsupported. Emit clear diagnostic.
* **Monorepos**: TS plugin runs inside tsserver which handles tsconfig routing.
* **Path aliases**: Module resolution uses tsconfig.json automatically.
* **esbuild bundling**: `@startupjs/pug-lexer` and `pug-parser` may use dynamic `require()`. Test bundling; if needed, mark as external.
* **Two-compiler sync risk**: Our IntelliSense generator and the Babel build plugin must stay in sync. Type-equivalence tests against Babel fixtures enforce this.
* **TS plugin is synchronous**: Runs inside tsserver's event loop. Keep pug parsing/emission fast (~1.5ms) and avoid heavy allocations.

---

## 8) Deliverables

* **VS Code extension** (VSIX) on VS Code marketplace
  * Bundled with esbuild (plugin + core in single JS file)
  * Target: VSIX under 2MB
  * Pre-release channel for early adopters
* **TextMate grammar** for pug syntax highlighting
* **README**: installation, supported syntax, limitations, debugging guide
* **Example project** in `examples/`
* **Full test suite** with fixtures
* **CI pipeline** (GitHub Actions): lint, typecheck, test, build VSIX

### Build pipeline

```
src/ --[tsc]--> type checking
src/ --[esbuild]--> dist/plugin.js  (bundled TS plugin + core logic)
src/ --[esbuild]--> dist/client.js  (VS Code extension client)
syntaxes/ + dist/ + package.json --[@vscode/vsce]--> extension.vsix
```

---

## 9) Project structure

Single package, separate repository from `babel-plugin-transform-react-pug`:

```
vscode-pug-react/
  src/
    language/              # Core logic (framework-agnostic)
      extractRegions.ts    # Find pug tagged template literals
      pugToTsx.ts          # Pug-to-TSX generator with mappings
      shadowDocument.ts    # Build full shadow document
      mapping.ts           # Mapping utilities and types
    plugin/                # TS plugin (runs inside tsserver)
      index.ts             # Plugin factory, host patching
      diagnostics.ts       # Intercept diagnostics, map positions
    extension/             # VS Code client (lightweight)
      index.ts             # Activation, plugin registration, commands
      pugDiagnostics.ts    # Pug parse error diagnostics
  test/
    fixtures/              # Sample TS project with tsconfig + components
    unit/                  # Unit tests
    integration/           # Integration tests
    smoke/                 # VS Code e2e smoke tests
  syntaxes/
    pug-template-literal.json  # TextMate grammar injection
  examples/
    sample-project/        # Example React+TS project
  package.json
  tsconfig.json
  vitest.config.ts
  esbuild.config.ts
  .github/workflows/ci.yml
```

---

## 10) MVP scope vs v1 scope

### MVP (ship as pre-release at Milestone 3)

* Syntax highlighting inside `pug\`...\`` template literals
* Completions: component names, props/attributes, intrinsic elements
* Hover: type information for components, props, variables
* "Show Shadow TSX" debug command
* TS projects (`.ts/.tsx`) only

### v1.0 (ship as stable at Milestone 7)

* Diagnostics: type errors + pug parse errors, correctly positioned
* Go-to-definition from pug to component source
* Rename and find-references across pug/TS boundaries
* Signature help, code actions
* JS/JSX support
* Configuration options
* Robust error handling, performance within targets

### v1.x (future)

* Code actions (auto-import, quick fixes)
* `${}` template interpolation support
* Formatting support inside pug templates
* Semantic highlighting

---

## 11) Success metric

"Feels like JSX" inside Pug:

* **Feature parity**: >80% of typical JSX IntelliSense features work correctly in pug templates
* **Latency**: Completion response <150ms (warm cache)
* **Reliability**: <1% of IntelliSense requests return incorrect positions (enforced by golden tests)
* **Adoption**: Extension installable in <30 seconds with zero configuration
* **Stability**: No crashes on any input

END.
