# Revised Plan Sections: Architecture & TypeScript Integration

> Authored by Arch-Alpha. Reflects the team's converged architecture decision: custom TS plugin first, Volar as compatible fallback.

---

## 0) Goal (what we're building)

We will build **JSX-grade IntelliSense** in VS Code for React projects that use `babel-plugin-transform-react-pug`, where Pug templates are written inside **tagged template literals**:

```ts
const view = pug`
  .card
    Button(onClick=onClick) Click
`
```

Inside the Pug template, the developer gets:

* **Auto-completion**: component names, typed props, intrinsic HTML attributes, event handlers
* **Hover type info**: component signatures, variable types, expression return types
* **Go-to-definition / find references**: from component/variable usage in Pug to source declarations
* **Rename symbol**: across Pug and TypeScript boundaries (rename a component or variable everywhere)
* **Diagnostics**: type errors, missing props, unknown identifiers — underlined at the correct Pug position
* **Signature help**: parameter hints inside attribute expressions
* **Works with TS and JS**: TypeScript/TSX at minimum; JavaScript/JSX as a stretch goal

### How it works (high-level)

The extension **transforms** the file that TypeScript sees: each `pug`...`` expression is replaced inline with the equivalent JSX/TSX expression. TypeScript type-checks the transformed content and provides all IntelliSense features. A **bidirectional source map** translates positions between the original Pug text and the generated TSX, so all features report positions in the developer's actual code.

This runs as a **TypeScript Language Service Plugin** inside the user's existing `tsserver` — no separate language server, no conflict with VS Code's built-in TypeScript features, no duplicate completions.

### We deliver:

1. A **VS Code extension** that activates the TS plugin and provides Pug syntax highlighting
2. A **TypeScript plugin** (`tsserver` plugin) that patches the language service host to serve shadow TSX content
3. A **Pug-to-TSX compiler** with token-level source mapping
4. A **test suite** with golden mapping tests and TS integration tests

### Non-goals:

* Building a full Pug language implementation (we support exactly what the Babel plugin supports)
* Replacing or conflicting with VS Code's built-in TypeScript features
* Supporting Pug features beyond what `babel-plugin-transform-react-pug` handles

---

## 1) Constraints & Requirements

### 1.1 Hard requirements

* Must support tagged template literal syntax `pug`...`` in `.ts/.tsx` files (`.js/.jsx` as stretch goal).
* Must provide IntelliSense **inside the template literal content**, not just syntax highlighting.
* Must use the **existing TypeScript language service** (via tsserver plugin) for semantic features — no separate TS instance.
* Must **not conflict** with VS Code's built-in TypeScript language features. Outside pug regions, the developer's experience must be identical to stock VS Code.
* Must map edits, ranges, and diagnostics precisely back to original Pug positions.
* Must be stable on large projects (no full-project reparse on every keystroke).
* Must degrade gracefully:
  * If Pug parsing fails, emit a diagnostic but don't crash. Serve last-good shadow TSX or a type-safe placeholder.
  * If mapping fails for a specific construct, provide partial results rather than no results.
* Must have comprehensive automated tests:
  * Golden tests for mapping correctness
  * Integration tests for TS plugin features (completions, hover, definitions, diagnostics)
  * Regression tests for known tricky constructs
* Must include CI that blocks merge on failed tests/lint/typecheck.

### 1.2 Performance requirements

* Completion response <= 150ms for typical files (warm cache). The Pug-to-TSX pipeline runs in ~1.5ms per template (benchmarked); TS incremental checking handles the rest.
* Incremental update: re-generate shadow TSX only for pug regions whose content changed. Cache parsed AST + generated TSX per region, keyed by content hash.
* The TS plugin shares the existing tsserver project — no duplicate TS language service instance, no doubled memory.

### 1.3 Compatibility requirements

* Works with TypeScript 5.x used by the workspace.
* Works with React component resolution, including:
  * Local component imports (default and named exports)
  * JSX intrinsic elements (`div`, `span`, `input`, etc.)
  * Generic components with type parameters
* Works with common tooling stacks: Vite/React, Next.js, CRA (legacy).
* Works with project configurations: path aliases (`paths`/`baseUrl`), project references, monorepos with multiple tsconfigs.
* Windows/macOS/Linux.

### 1.4 Architectural constraint: no full LSP server for TS/TSX files

A full LSP server that registers for `typescript`/`typescriptreact` language IDs will conflict with VS Code's built-in TypeScript features — producing duplicate completions, duplicate hover, and conflicting diagnostics. This is fundamentally different from Svelte/Vue/Astro tooling, where the language server handles custom file types (`.svelte`, `.vue`, `.astro`) that the built-in TS doesn't claim.

Our files are `.ts/.tsx` — already fully owned by the built-in TS extension. We must work **within** tsserver, not alongside it. This drives the TS plugin architecture.

---

## 2) Architecture overview

### Core mechanism: TypeScript plugin with host patching

We use a **TypeScript Language Service Plugin** (`tsserver` plugin) that:

1. **Patches `getScriptSnapshot()`** on `info.languageServiceHost` to return **shadow TSX content** for files containing pug templates. From TypeScript's perspective, the file contains valid TSX — it never sees the pug syntax.

2. **Proxies `info.languageService` methods** (completions, hover, definitions, rename, diagnostics, etc.) to **map positions** between the original file and the shadow TSX using a bidirectional source map.

This is the same architectural pattern used by [Volar's `@vue/typescript-plugin`](https://github.com/vuejs/language-tools) for Vue hybrid mode. It is proven at massive scale (7M+ installs).

### Implementation strategy: start lean, keep Volar-compatible

We start with a **custom implementation** of the TS plugin infrastructure (host patching, LS proxying, position mapping). This keeps dependencies minimal, the VSIX small, and the code easy to debug.

However, we adopt **Volar's `Mapping` data structure format** (offset-pair arrays with `sourceOffsets`, `generatedOffsets`, `lengths`, `generatedLengths`, and `CodeInformation` data) as our mapping representation — regardless of whether we use the Volar npm packages. This is just a data format; it requires no runtime dependency.

**Complexity threshold**: If during implementation the custom infrastructure code exceeds ~1500 lines or edge cases around caching, versioning, and incremental updates multiply beyond reasonable maintenance cost, we pull in `@volar/typescript` and `@volar/source-map` packages. The core library (`src/language/`) remains unchanged either way — only the plugin wiring layer swaps.

### Considered alternative: Volar.js framework

[Volar.js](https://github.com/volarjs/volar.js) (`@volar/typescript`, `@volar/language-core`, `@volar/source-map`) provides a complete framework for embedded language tooling. It was designed for Vue/Svelte/Astro where custom file types (`.vue`, `.svelte`) need full language server infrastructure.

**Why we don't start with it:**
- Our files are `.ts/.tsx`, not custom file types. Volar's `VirtualCode` / `LanguagePlugin` abstractions expect to own the entire file, while we need partial-file replacement within files already handled by TS.
- Volar adds ~150KB bundled to the VSIX and introduces a dependency with historically breaking changes between major versions.
- The custom TS plugin approach is simpler for our use case (~500-800 lines for the plugin infrastructure layer).

**Why it remains a viable fallback:**
- `@volar/typescript` provides battle-tested `getScriptSnapshot` patching and version management.
- `@volar/source-map` provides bidirectional mapping with `CodeInformation`-based feature filtering.
- If our custom code reaches ~1500 lines, adopting these packages reduces maintenance burden.
- The Milestone 2 architecture spike includes a decision gate for this evaluation.

### Shadow TSX: in-place expression replacement

The shadow file is the original file with each `pug`...`` expression replaced by its compiled TSX equivalent:

```
Original:                          Shadow TSX:
─────────                          ──────────
import Button from './Button'      import Button from './Button'  (unchanged)

const view = pug`                  const view = (
  .card                              <div className="card">
    Button(onClick=onClick) Click      <Button onClick={onClick}>Click</Button>
`                                    </div>
                                   )

export default view                export default view  (unchanged)
```

Everything outside pug regions is **identical** (byte-for-byte). This means:
- **Module resolution just works** — the file path and imports are unchanged.
- **Positions outside pug regions are trivially mapped** — original offset + cumulative delta from prior region size changes.
- **One language service** — the entire shadow file is valid TSX processed by a single TS language service.

### Components

```
┌─────────────────────────────────────────────┐
│              VS Code Extension               │
│  - Activates TS plugin                       │
│  - TextMate grammar: pug syntax highlighting │
│  - "Show Shadow TSX" debug command           │
│  - Configuration forwarding                  │
└──────────────────┬──────────────────────────┘
                   │ activates via typescript.tsserver.pluginPaths
┌──────────────────▼──────────────────────────┐
│          TypeScript Plugin (tsserver)         │
│                                              │
│  create(info: PluginCreateInfo):             │
│                                              │
│  1. PATCH info.languageServiceHost           │
│     .getScriptSnapshot(fileName)             │
│       → if file has pug regions:             │
│           return shadow TSX snapshot         │
│       → else: return original snapshot       │
│     .getScriptVersion(fileName)              │
│       → bump when shadow content changes     │
│                                              │
│  2. PROXY info.languageService               │
│     For position-based methods:              │
│       → map original offset to shadow offset │
│       → call underlying LS method            │
│       → map result offsets back to original   │
│     For diagnostic methods:                  │
│       → get diagnostics from TS              │
│       → filter: keep mapped regions only     │
│       → map spans back to original offsets   │
│                                              │
│  Uses: Core Library                          │
└──────────────────┬──────────────────────────┘
                   │ imports
┌──────────────────▼──────────────────────────┐
│              Core Library                    │
│                                              │
│  extractPugRegions(text, filename)           │
│    → PugRegion[]                             │
│                                              │
│  compilePugToTsx(pugText, options)           │
│    → { tsx: string, mappings: CodeMapping[] }│
│                                              │
│  buildShadowDocument(text, regions)          │
│    → { shadowText, mappingIndex }            │
│                                              │
│  MappingIndex                                │
│    .originalToShadow(offset) → offset        │
│    .shadowToOriginal(offset) → offset        │
│    .isInPugRegion(offset) → boolean          │
│    .shadowSpanToOriginalSpan(start, len)     │
└─────────────────────────────────────────────┘
```

---

## 3.5 TypeScript Plugin Integration

### Mapping data format

Regardless of whether we use Volar packages or custom code, all source mappings use **Volar's `Mapping` data structure format**:

```ts
// This is a data format, not a library import.
// If we later adopt @volar/source-map, these types come from there.
// Otherwise we define them ourselves (~30 lines).

interface CodeMapping {
  sourceOffsets: number[];      // positions in pug region text
  generatedOffsets: number[];   // positions in generated TSX text
  lengths: number[];            // span lengths (source side)
  generatedLengths?: number[];  // span lengths (generated side, if different)
  data: CodeInformation;        // feature flags per mapping segment
}

interface CodeInformation {
  completion: boolean;    // enable completions at this position
  navigation: boolean;    // enable go-to-def, find-references
  verification: boolean;  // enable diagnostics
  semantic: boolean;      // enable semantic highlighting
}
```

This format is used by the Pug-to-TSX emitter (Section 3.3), the bidirectional position mapper, and the LS proxy's result mapping. Adopting Volar's format means we can swap in `@volar/source-map` later with zero changes to the core library.

### Plugin entry point

The TS plugin is a standard tsserver plugin, loaded via `typescript.tsserver.pluginPaths` in VS Code settings (configured by the extension):

```ts
// plugin/index.ts
function init(modules: { typescript: typeof ts }) {
  return {
    create(info: ts.server.PluginCreateInfo): ts.LanguageService {
      const config = info.config;
      const documentManager = new DocumentManager(config);

      // 1. Patch the host
      patchLanguageServiceHost(info.languageServiceHost, documentManager);

      // 2. Create the LS proxy
      return createLanguageServiceProxy(info.languageService, documentManager);
    },
    onConfigurationChanged(config: any) {
      // Forward configuration from VS Code extension
    },
  };
}

export = init;
```

### Host patching

We override two methods on `info.languageServiceHost`:

```ts
function patchLanguageServiceHost(
  host: ts.LanguageServiceHost,
  docs: DocumentManager
): void {
  const originalGetSnapshot = host.getScriptSnapshot.bind(host);
  const originalGetVersion = host.getScriptVersion.bind(host);

  host.getScriptSnapshot = (fileName: string) => {
    const shadow = docs.getShadowDocument(fileName);
    if (shadow) {
      return ts.ScriptSnapshot.fromString(shadow.shadowText);
    }
    return originalGetSnapshot(fileName);
  };

  host.getScriptVersion = (fileName: string) => {
    const shadow = docs.getShadowDocument(fileName);
    if (shadow) {
      return `${originalGetVersion(fileName)}-pug-${shadow.version}`;
    }
    return originalGetVersion(fileName);
  };
}
```

**Key details:**
- We only intercept files that contain pug regions. All other files pass through to the original host.
- The version string includes our shadow version to ensure TS re-checks when pug content changes.
- `DocumentManager` maintains a `Map<string, ShadowDocument>` and listens for file changes via the TS plugin's `onConfigurationChanged` and the host's project update cycle. Each `ShadowDocument` stores the shadow text, the `CodeMapping[]` array (Volar format), and a precomputed offset index for O(log n) position lookups.
- Crash resilience: if shadow generation throws, we catch and return the original snapshot (degraded mode with a logged warning).

### Complexity budget and Volar escape hatch

The custom plugin infrastructure (host patching + LS proxy + position mapping utilities) should stay under **~1500 lines**. This includes:
- `plugin/index.ts`: Plugin factory, host patching (~100 lines)
- `plugin/proxy.ts`: LS method proxying (~300-500 lines)
- `plugin/mapping.ts`: Bidirectional offset mapping using `CodeMapping[]` (~200-300 lines)
- `plugin/diagnostics.ts`: Diagnostic filtering and mapping (~150-200 lines)
- `plugin/documentManager.ts`: Shadow document lifecycle (~150-200 lines)

If during implementation this exceeds ~1500 lines or edge cases around incremental updates, script version management, or cross-file mapping multiply, we swap in `@volar/typescript` (replaces host patching + document management) and `@volar/source-map` (replaces bidirectional mapping). The core library (`src/language/`) and the LS proxy method overrides remain unchanged — only the infrastructure plumbing swaps.

### Language service proxy

We proxy the entire `ts.LanguageService` using the standard `for-in` pattern, then override specific methods:

```ts
function createLanguageServiceProxy(
  ls: ts.LanguageService,
  docs: DocumentManager
): ts.LanguageService {
  const proxy = Object.create(null) as ts.LanguageService;

  // Pass-through all methods
  for (const k of Object.keys(ls) as Array<keyof ts.LanguageService>) {
    const method = ls[k];
    if (typeof method === 'function') {
      (proxy as any)[k] = (...args: any[]) => (method as Function).apply(ls, args);
    }
  }

  // Override position-based methods
  proxy.getCompletionsAtPosition = (fileName, position, options) => {
    const mapped = docs.mapOriginalToShadow(fileName, position);
    if (!mapped) return ls.getCompletionsAtPosition(fileName, position, options);
    const result = ls.getCompletionsAtPosition(fileName, mapped.offset, options);
    // No position mapping needed for completion items themselves (they're inserted at cursor)
    return result;
  };

  proxy.getQuickInfoAtPosition = (fileName, position) => {
    const mapped = docs.mapOriginalToShadow(fileName, position);
    if (!mapped) return ls.getQuickInfoAtPosition(fileName, position);
    const result = ls.getQuickInfoAtPosition(fileName, mapped.offset);
    if (result) {
      result.textSpan = docs.mapShadowSpanToOriginal(fileName, result.textSpan);
    }
    return result;
  };

  // ... similar for getDefinitionAtPosition, findReferences, findRenameLocations, etc.

  // Override diagnostic methods (no input position; filter + map output spans)
  proxy.getSemanticDiagnostics = (fileName) => {
    const diagnostics = ls.getSemanticDiagnostics(fileName);
    return docs.filterAndMapDiagnostics(fileName, diagnostics);
  };

  return proxy;
}
```

### Methods requiring position mapping

**MVP (must have):**

| Method | Input mapping | Output mapping |
|--------|--------------|----------------|
| `getCompletionsAtPosition` | position → shadow offset | completion entries: no mapping needed (text insertions) |
| `getCompletionEntryDetails` | position → shadow offset | none |
| `getQuickInfoAtPosition` | position → shadow offset | `textSpan` → original span |
| `getDefinitionAtPosition` | position → shadow offset | result positions → original offsets (may be in different files) |
| `getDefinitionAndBoundSpan` | position → shadow offset | `textSpan` → original span; definitions → original offsets |
| `getTypeDefinitionAtPosition` | position → shadow offset | result positions → original offsets |
| `getSignatureHelpItems` | position → shadow offset | `applicableSpan` → original span |
| `getSyntacticDiagnostics` | none | filter + map spans |
| `getSemanticDiagnostics` | none | filter + map spans |
| `getSuggestionDiagnostics` | none | filter + map spans |

**v1 (should have):**

| Method | Input mapping | Output mapping |
|--------|--------------|----------------|
| `findRenameLocations` | position → shadow offset | all rename locations → original offsets (across files) |
| `getRenameInfo` | position → shadow offset | `triggerSpan` → original span |
| `findReferences` | position → shadow offset | all reference locations → original offsets |
| `getReferencesAtPosition` | position → shadow offset | all reference locations → original offsets |
| `getDocumentHighlights` | position → shadow offset | highlight spans → original spans |
| `getImplementationAtPosition` | position → shadow offset | result positions → original offsets |

**Nice to have:**

| Method | Input mapping | Output mapping |
|--------|--------------|----------------|
| `getApplicableRefactors` | position/range → shadow | `range` → original range |
| `getEditsForRefactor` | position/range → shadow | edit spans → original spans |
| `getCodeFixesAtPosition` | range → shadow | edit spans → original spans |
| `getFormattingEditsForRange` | range → shadow | edit spans → original spans |
| `getOutliningSpans` | none | spans → original spans |

### Cross-file results

Methods like `getDefinitionAtPosition` and `findRenameLocations` may return results in OTHER files. For each result:
- If the result file has pug regions and the result position is inside a shadow-replaced region → map back to original pug position.
- If the result file has pug regions but the position is outside replaced regions → apply cumulative delta offset shift.
- If the result file has no pug regions → pass through unchanged.

### Rename across pug/non-pug boundaries

When a user renames a symbol (e.g., component `Button`) that appears both in regular TS code and inside pug templates:

1. The TS plugin receives the rename request at the original position.
2. We map to the shadow offset and call `findRenameLocations`.
3. TS returns rename locations from the shadow file (which contains both the unchanged non-pug code and the generated TSX).
4. For locations outside pug regions: they're at the same offsets in the original file (identity-mapped), so pass through.
5. For locations inside pug regions: map back using the token-level source mappings.
6. Return the combined set of original-file rename locations.

This correctly handles renames that span both pug and non-pug code in the same file or across files.

---

## 3.6 Rationale: why not a full LSP server

The original plan proposed a full LSP server registering for `typescript`/`typescriptreact` language IDs and responding "only for pug regions." This approach has fundamental problems:

1. **LSP has no per-position routing.** When a server registers for a language ID, VS Code routes ALL requests for that language to it. There is no "respond only for certain positions" mechanism. Returning `null` for non-pug positions can cause VS Code to show empty results or merge them confusingly with the built-in TS server's results.

2. **Duplicate language services.** A full LSP server needs its own `ts.LanguageService` with its own program, type-checker, and file cache. This doubles memory usage for the TS project.

3. **Module resolution for virtual files.** The proposed `file.tsx.__pugtsx__.tsx` virtual filenames break TS module resolution (imports resolve relative to a non-existent path). Custom `resolveModuleNames` hooks can fix this but add complexity and fragility.

4. **The TS plugin approach avoids all of these.** It runs inside the user's existing tsserver, shares the single TS project, needs no virtual filenames, and has no provider conflicts.

The TS plugin approach is the same pattern used by:
- `@vue/typescript-plugin` (Vue's hybrid mode — 7M+ installs)
- `typescript-lit-html-plugin` (tagged template HTML completions)
- `typescript-styled-plugin` (tagged template CSS completions)

Note: if we later adopt `@volar/typescript`, this is still NOT a full LSP server. It is Volar's TS plugin mode, which runs inside the user's existing tsserver — exactly the same architectural position as our custom plugin. The difference is implementation, not architecture.

### When a lightweight server IS needed

The TS plugin handles all IntelliSense features, but there is one thing it cannot do: **proactively publish diagnostics.** TS plugins respond to requests but cannot push notifications.

If we find that VS Code's built-in diagnostic refresh cycle (which periodically calls `getSemanticDiagnostics`) is insufficient, we may add a **minimal diagnostic notification channel** between the VS Code extension and the TS plugin. This does NOT require a full LSP server — it can be a simple VS Code extension API callback that triggers diagnostic re-evaluation.

---

## 3.8 Configuration

The VS Code extension exposes these settings:

```json
{
  "pugReact.tagName": {
    "type": "string",
    "default": "pug",
    "description": "The tagged template literal tag name to recognize (e.g., 'pug', 'html')"
  },
  "pugReact.enableDiagnostics": {
    "type": "boolean",
    "default": true,
    "description": "Show type errors and pug parse errors inside pug templates"
  },
  "pugReact.classAttribute": {
    "type": "string",
    "default": "className",
    "description": "Attribute name for CSS classes (className for React, class for Preact)"
  },
  "pugReact.trace.server": {
    "type": "string",
    "enum": ["off", "messages", "verbose"],
    "default": "off",
    "description": "Trace logging level for debugging the TS plugin"
  }
}
```

Configuration is forwarded to the TS plugin via `onConfigurationChanged()`. The TS plugin reads:
- `tagName` to know which tagged template literals to recognize
- `classAttribute` to generate correct attribute names in shadow TSX
- `trace` to control logging verbosity

### Zero-configuration default

The extension works with **zero user configuration**. No `tsconfig.json` edits are needed — the extension automatically activates the TS plugin via `typescript.tsserver.pluginPaths`. Users who want to customize (e.g., different tag name) can do so via VS Code settings.

---

## 3.9 Logging & debugging

### Trace logging

When `pugReact.trace.server` is set to `"verbose"`, the TS plugin logs:
- Every file where pug regions are detected
- Shadow TSX generation timing and output (truncated)
- Position mapping operations (input offset → output offset)
- Diagnostic filtering decisions (kept/dropped and why)
- Cache hits/misses for shadow document generation

Logs appear in the VS Code "TypeScript" output channel (since the plugin runs inside tsserver).

### "Show Shadow TSX" command

The VS Code extension registers the command `pugReact.showShadowTsx` which:

1. Gets the active editor's file path.
2. Queries the TS plugin for the current shadow TSX content (via a custom plugin command).
3. Opens a new untitled editor tab with the shadow TSX content, formatted for readability.
4. Optionally highlights the mapped regions (using decorations) to show which shadow regions correspond to which pug regions.

This is the primary debugging tool for developers and for us during development. It allows visual verification that the shadow TSX is correct and mappings make sense.

### Error reporting

When the plugin encounters an error (Pug parse failure, mapping failure, unexpected TS API response):
1. Log the error with full context to the trace output.
2. Degrade gracefully — return partial results or fall back to the underlying LS method.
3. Never crash tsserver. All plugin code is wrapped in try-catch at the method proxy level.
