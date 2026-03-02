# Revised Plan Sections: Pug-to-TSX Compilation & Source Mapping

> Authored by Arch-Beta. Incorporates findings from all three architects' reviews and debate convergence.

---

## 3.1 Document Model

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

  /** Volar-compatible source mappings for this region */
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
3. If the position falls **inside a region**: use the region's `mappings` array for character-level bidirectional mapping via Volar's `SourceMap` utilities.

The `regionDeltas` array stores precomputed cumulative offset adjustments:
```
regionDeltas[i] = sum of (region[j].tsxText.length - region[j].pugOriginalLength) for j < i
```

This allows O(log n) position mapping for positions outside pug regions.

---

## 3.2 Extracting Pug Regions (Host Parser)

### Approach

Use `@babel/parser` with TypeScript and JSX plugins to parse the host file and locate `TaggedTemplateExpression` nodes where `tag.name === 'pug'` (configurable via `pugReact.tagName` setting).

### Implementation

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

### Edge cases

- Multiple pug templates in one file: return all regions, sorted by offset.
- Nested pug templates (pug inside `${}` inside pug): handle via recursive extraction.
- Non-pug tagged templates: skip.
- Malformed template literals: skip, let TS handle the syntax error.

### Error recovery

If `@babel/parser` fails (rare for a file that VS Code considers valid), fall back to a regex-based region finder as a degraded mode.

---

## 3.3 Generating TSX from Pug (IntelliSense-Optimized)

### Core principle

The generated TSX must be **type-checkable and mappable**, not executable. It is optimized for TypeScript's type checker and IntelliSense features, not for React's runtime. It must be a **semantic superset** of the Babel plugin's output: everything the Babel plugin accepts should type-check in our TSX; we may accept additional constructs but never fewer.

### Pipeline

```
pug text
  -> @startupjs/pug-lexer  (tokens with precise loc)
  -> pug-strip-comments
  -> pug-parser             (AST with line/column)
  -> IntelliSense TSX emitter (TSX text + Volar mappings)
```

We reuse the existing `@startupjs/pug-lexer` + `pug-parser` + `pug-strip-comments` pipeline (same as the Babel plugin in `src/parse-pug.js`). We write a **new TSX text emitter** that walks the Pug AST and produces:
1. TSX expression text (string)
2. `CodeMapping[]` (Volar-compatible source mappings)

The lexer token stream is **retained alongside the AST** for sub-expression position resolution. The lexer provides precise `loc.start`/`loc.end` for every token, including attribute values, interpolated code expressions, class/id shorthands, and each/if/while keywords -- positions that the parser AST sometimes discards.

### Performance

Benchmarked: pug-lexer + pug-parser runs in **~0.9ms** per moderately complex 20-line template. TSX emission adds ~0.5ms. Total pipeline: **~1.5ms per template**. Well within the 150ms completion response budget, even for files with 10+ templates.

**Caching**: Cache parsed AST + generated TSX + mappings per pug region, keyed by region text content hash. Only re-parse regions whose text actually changed. Typical editing (user types in one template) re-parses one region per keystroke.

### Per-construct TSX shapes

For each Pug construct, we define the IntelliSense-optimized TSX shape and explain how it differs from the Babel plugin's build output.

#### Tags

| Pug | Babel Output | IntelliSense TSX |
|-----|-------------|------------------|
| `Button(onClick=handler)` | `<Button onClick={handler} />` | `<Button onClick={handler} />` (same) |
| `.card` | `<div className="card" />` | `<div className="card" />` (same) |

Tags map directly. The tag name from `node.name` is emitted as a JSX identifier. When the parser synthesizes `div` for shorthand-only elements (`.card`, `#main`), we emit `<div>` as the tag but mark it as synthetic in the mappings.

#### Attributes

| Pug | IntelliSense TSX |
|-----|------------------|
| `onClick=handler` | `onClick={handler}` |
| `disabled` (boolean) | `disabled={true}` |
| `...props` | `{...props}` |
| `data-value="hello"` | `data-value={"hello"}` |

Each attribute name and value expression is identity-mapped (same text, same length). The structural syntax (`=`, `{`, `}`) is synthetic (unmapped).

For boolean shorthand (`disabled` with no value), the `={true}` is synthetic.

For spread attributes (`...props`), the parser stores the name as `"...props"`. We emit `{...props}` in TSX, mapping just the `props` identifier (offset +3 to skip `...`).

Attribute name aliases are applied (matching the Babel plugin):
- `for` -> `htmlFor`
- `maxlength` -> `maxLength`
- `class` -> collected for className merging

#### Class and ID shorthands

| Pug | IntelliSense TSX |
|-----|------------------|
| `.foo` | `<div className="foo">` |
| `.foo.bar#baz` | `<div className="foo bar" id="baz">` |
| `.foo(className=dynamicClass)` | `<div className={"foo" + " " + dynamicClass}>` |

Class shorthands are merged into a single `className` attribute, matching the Babel plugin's behavior.

**Mapping**: The lexer provides individual tokens for each `.class` and `#id` with precise `loc`. Each class/id value maps to its substring within the generated `className`/`id` string. These mappings have `CodeInformation` with `{ completion: false, navigation: false, verification: false }` since they are CSS class names, not TypeScript identifiers.

When shorthand classes are combined with a dynamic `className` attribute, we emit `className={"foo" + " " + dynamicClass}` to keep the dynamic expression identity-mapped and hoverable.

#### Text content

| Pug | Babel Output | IntelliSense TSX |
|-----|-------------|------------------|
| `p Hello` | `<p>Hello</p>` | `<p>Hello</p>` (same) |
| `p Hello #{name}` | `<p>{["Hello ", name].join("")}</p>` | `<p>{"Hello "}{name}</p>` |
| `p #{a} and #{b}` | `<p>{[a, " and ", b].join("")}</p>` | `<p>{a}{" and "}{b}</p>` |

**Key divergence**: For text with interpolations, the Babel plugin produces `[...].join("")` which obscures type information. Our IntelliSense TSX uses JSX expression containers directly, preserving each interpolated expression as a standalone `{expr}`. This enables hover, go-to-def, and completions on each expression individually.

The `#{` and `}` Pug delimiters are NOT mapped (they are Pug syntax with no TSX counterpart). Only the expression content inside `#{}` is identity-mapped. The lexer's `interpolated-code` token provides the precise `loc` for the expression content.

#### Conditionals (if / else if / else)

| Pug | IntelliSense TSX |
|-----|------------------|
| `if show` / `else` | `show ? <consequent> : <alternate>` |
| `if a` / `else if b` / `else` | `a ? <c1> : b ? <c2> : <c3>` |

Ternary chains, same as the Babel plugin. This shape is excellent for IntelliSense -- TypeScript narrows types in each branch.

The `test` expression is identity-mapped. Position of test within the Pug line is computed as:
- `if `: column + 3
- `else if `: column + 8

For chained `if/else if/else`, each test maps to its corresponding nested ternary test.

#### Each loops

| Pug | Babel Output | IntelliSense TSX |
|-----|-------------|------------------|
| `each item, i in items` / body | `items.map((item, i) => { let _name; return [...]; })` | `items.map((item, i) => (<body/>))` |

**Key divergences**:
1. **No variable renaming**: The Babel plugin renames variables via `scope.generateUidIdentifier()` (e.g., `name` -> `_name`). We preserve original names for hover/go-to-def/rename correctness.
2. **Clean arrow body**: No null-interspersed arrays. The body is a direct JSX expression (or fragment for multiple children).
3. **Variable declarations inside loops**: Emitted as statements in a block body: `items.map((item, i) => { const name = "a"; return (<body/>); })`.

**Mapping challenge**: The parser AST node gives `{val: "item", key: "i", obj: "items", line, column}` without sub-positions. We extract sub-positions via a mini-parser:

```ts
function parseEachLine(pugText: string, node: EachNode): EachPositions {
  // "each item, i in items"
  //  ^^^^^     ^^    ^^^^^
  //  keyword   key   collection
  const lineText = getLineText(pugText, node.line);
  const eachKeywordEnd = node.column - 1 + "each ".length;
  const valStart = eachKeywordEnd;
  const valEnd = valStart + node.val.length;
  // ... parse ", key in collection" from remaining text
}
```

The lexer's `each` token provides the full span `loc` which we use to validate these computed positions.

**Iteration variable mapping**: `item` in Pug maps to `item` in the `.map()` arrow function parameter. `items` in Pug maps to `items` before `.map()`. When the user hovers over `item`, TS infers the element type of the `items` array.

**Each with else**:

```
each item in list       ->  Array.isArray(list) && list.length
  span= item                  ? list.map(item => (<span>{item}</span>))
else                          : <alternate>
  | No items
```

Matching the Babel plugin's conditional-wrapping behavior.

#### Code blocks (unbuffered code)

| Pug | Babel Output | IntelliSense TSX |
|-----|-------------|------------------|
| `- const x = 10` | `((_x = 10), null)` with hoisted `let _x` | `const x = 10;` as a statement |
| `- log('hello')` | `(log("hello"), null)` | `log("hello");` as a statement |
| `- x++` | `(x++, null)` | `x++;` as a statement |

**Key divergence**: The Babel plugin transforms variable declarations into assignment expressions with hoisted `let` declarations and renamed identifiers. For IntelliSense, we preserve the original declaration form and variable names.

When a pug template contains code blocks mixed with JSX-producing nodes, we wrap in an IIFE to allow statements:

```tsx
// Pug:                         IntelliSense TSX:
// - const x = 10              (() => {
// div= x                       const x = 10;
//                               return (<div>{x}</div>);
//                              })()
```

This preserves:
- Original variable names (hover shows `x`, not `_x`)
- Correct scoping (TS type-checks `const` correctly)
- Type narrowing (assignments narrow types as expected)

The code expression text is identity-mapped to the text after `- ` in the Pug source.

#### Buffered code (inline expressions)

| Pug | IntelliSense TSX |
|-----|------------------|
| `div= expr` | `<div>{expr}</div>` |
| `= expr` (standalone) | `{expr}` |

The expression is identity-mapped. Same as the Babel plugin.

#### While loops

| Pug | Babel Output | IntelliSense TSX |
|-----|-------------|------------------|
| `while test` / body | `(_pug => { while(test) { _pug[_pug.length]=...; } return _pug; })([])` | `(() => { const __result: JSX.Element[] = []; while (test) { __result.push(<body/>); } return __result; })()` |

**Key divergence**: The Babel plugin's IIFE pattern with array index assignment is replaced with a cleaner IIFE that TypeScript can type-check. The `test` expression and body expressions are identity-mapped. The structural wrapper is synthetic.

While loops are rare in React templates. The mapping priority is ensuring `test` and expressions within the body get proper IntelliSense, not the loop structure itself.

#### Case / When

| Pug | IntelliSense TSX |
|-----|------------------|
| `case n` / `when 1` / `when 2` / `default` | `n === 1 ? <p>One</p> : n === 2 ? <p>Two</p> : <default>` |

Chained ternaries, same shape as the Babel plugin. The case expression `n` maps to each `n ===` comparison. Each `when` expression maps to the corresponding comparison value. Position within the `when` line: `column + "when ".length`.

The Babel plugin creates a temp variable for complex case expressions. For IntelliSense we repeat the original expression in each comparison (no temp variable), preserving hover/go-to-def on the expression.

#### Multiple root nodes

| Pug | IntelliSense TSX |
|-----|------------------|
| `div` / `div` (two roots) | `<><div /><div /></>` |

Wrapped in a JSX fragment, same as the Babel plugin. The fragment delimiters `<>` and `</>` are synthetic (unmapped).

### Superset rule

Our IntelliSense TSX must accept everything the Babel plugin accepts. We enforce this by:

1. Replicating the same validation checks the Babel plugin performs (e.g., "Unescaped attributes not supported", "Attribute blocks not supported").
2. Emitting Pug-level diagnostics for constructs we reject.
3. Testing against the same 20+ fixture files from `src/__tests__/*.input.js` to verify type-equivalence.

---

## 3.4 Source Mapping (Volar's Mapping Format)

### Format

We use Volar's `Mapping<CodeInformation>` (aliased as `CodeMapping`):

```ts
import type { CodeMapping, CodeInformation } from '@volar/language-core';

// Mapping<CodeInformation> has:
interface Mapping<Data> {
  sourceOffsets: number[];      // positions in pug region text
  generatedOffsets: number[];   // positions in generated TSX text
  lengths: number[];            // span lengths (source side)
  generatedLengths?: number[];  // span lengths (generated side, if different)
  data: Data;                   // CodeInformation controlling features
}
```

### CodeInformation presets

We define standard presets for different mapping contexts:

```ts
/** Expressions, tag names, attribute names/values -- full IntelliSense */
const FULL_FEATURES: CodeInformation = {
  completion: true,
  navigation: true,
  verification: true,
  semantic: true,
};

/** Class/ID shorthands -- CSS names, not TS identifiers */
const CSS_CLASS: CodeInformation = {
  completion: false,
  navigation: false,
  verification: false,
  semantic: false,
};

/** Structural syntax (JSX brackets, keywords) -- no features */
const SYNTHETIC: CodeInformation = {
  completion: false,
  navigation: false,
  verification: false,
  semantic: false,
};

/** Expressions that should show diagnostics but not completions */
const VERIFY_ONLY: CodeInformation = {
  completion: false,
  navigation: true,
  verification: true,
  semantic: true,
};
```

### Mapping generation

The TSX emitter produces mappings alongside text using a builder pattern:

```ts
class TsxEmitter {
  private tsx: string = '';
  private mappings: CodeMapping[] = [];
  private offset: number = 0;  // current position in generated TSX

  /** Emit text that maps 1:1 to pug source */
  emitMapped(text: string, pugOffset: number, info: CodeInformation): void {
    this.mappings.push({
      sourceOffsets: [pugOffset],
      generatedOffsets: [this.offset],
      lengths: [text.length],
      data: info,
    });
    this.tsx += text;
    this.offset += text.length;
  }

  /** Emit text that maps to pug source with different lengths */
  emitDerived(text: string, pugOffset: number, pugLength: number, info: CodeInformation): void {
    this.mappings.push({
      sourceOffsets: [pugOffset],
      generatedOffsets: [this.offset],
      lengths: [pugLength],
      generatedLengths: [text.length],
      data: info,
    });
    this.tsx += text;
    this.offset += text.length;
  }

  /** Emit structural TSX with no pug source (unmapped) */
  emitSynthetic(text: string): void {
    this.tsx += text;
    this.offset += text.length;
  }

  getResult(): { tsx: string; mappings: CodeMapping[] } {
    return { tsx: this.tsx, mappings: this.mappings };
  }
}
```

### Bidirectional lookup

Volar's `SourceMap` class (from `@volar/source-map`) provides:
- `toSourceLocation(generatedOffset)` -- TSX position to Pug position
- `toGeneratedLocation(sourceOffset)` -- Pug position to TSX position
- `toSourceRange(start, end)` -- TSX range to Pug range
- `toGeneratedRange(start, end)` -- Pug range to TSX range

All methods accept a `filter` callback on `CodeInformation`, allowing feature-specific mapping (e.g., "only map if navigation is enabled").

### "Falls between segments" handling

When a position falls in an unmapped (synthetic) region of the generated TSX:
- Volar's `toSourceLocation` returns no results.
- The LSP layer should walk to the nearest mapped segment and return that position with a fuzzy flag.
- For **hover**: use fuzzy result (show info for nearest mapped construct).
- For **rename**: reject fuzzy results (don't rename structural syntax).
- For **completion**: use fuzzy result (complete at nearest expression position).
- For **diagnostics**: expand to cover the nearest Pug-side construct.

### Per-construct mapping examples

#### Tag with attributes

```
Pug:  Button(onClick=handler disabled)
TSX:  <Button onClick={handler} disabled={true} />
```

Mappings:
| Source range | Generated range | Length | Info |
|---|---|---|---|
| `Button` [0,6] | `Button` [1,7] | 6 | FULL_FEATURES |
| `onClick` [7,14] | `onClick` [8,15] | 7 | FULL_FEATURES |
| `handler` [15,22] | `handler` [17,24] | 7 | FULL_FEATURES |
| `disabled` [23,31] | `disabled` [26,34] | 8 | FULL_FEATURES |

Unmapped (synthetic): `<`, ` `, `={`, `}`, ` `, `={true}`, ` />`

#### Class shorthand

```
Pug:  .card.active#main
TSX:  <div className="card active" id="main" />
```

Mappings:
| Source range | Generated range | Src len | Gen len | Info |
|---|---|---|---|---|
| `card` [1,5] | `card` [16,20] | 4 | 4 | CSS_CLASS |
| `active` [6,12] | `active` [21,27] | 6 | 6 | CSS_CLASS |
| `main` [13,17] | `main` [34,38] | 4 | 4 | CSS_CLASS |

Unmapped: `<div className="`, ` `, `" id="`, `" />`

#### Text interpolation

```
Pug:  p Hello #{name}, welcome
TSX:  <p>{"Hello "}{name}{", welcome"}</p>
```

Mappings:
| Source range | Generated range | Info |
|---|---|---|
| `p` [0,1] | `p` [1,2] / `p` [33,34] | FULL_FEATURES |
| `Hello ` [2,8] | `Hello ` [5,11] | VERIFY_ONLY |
| `name` [10,14] | `name` [13,17] | FULL_FEATURES |
| `, welcome` [15,25] | `, welcome` [19,29] | VERIFY_ONLY |

Note: `#{` and `}` delimiters at positions [8,10] and [14,15] in Pug are NOT mapped.

#### Each loop

```
Pug:  each item, i in items
        div(key=i)= item
TSX:  items.map((item, i) => (<div key={i}>{item}</div>))
```

Mappings:
| Source range | Generated range | Info |
|---|---|---|
| `items` [20,25] | `items` [0,5] | FULL_FEATURES |
| `item` [5,9] | `item` [11,15] | FULL_FEATURES |
| `i` [11,12] | `i` [17,18] | FULL_FEATURES |
| `div` [indent...] | `div` in opening/closing tag | FULL_FEATURES |
| `key` | `key` | FULL_FEATURES |
| `i` (attr value) | `i` in `{i}` | FULL_FEATURES |
| `item` (buffered code) | `item` in `{item}` | FULL_FEATURES |

---

## 3.7 Diagnostics Strategy

### Diagnostic sources

1. **Pug parse errors** (syntax): Emitted immediately when `pug-lexer` or `pug-parser` throws. Mapped to the pug region in the original file.

2. **Pug validation errors**: Constraints matching the Babel plugin (unescaped attributes, attribute blocks, unsupported constructs). Emitted by the TSX emitter during generation.

3. **TypeScript diagnostics**: Semantic and syntactic diagnostics from TS on the shadow file. Positions mapped back to original Pug positions via Volar's mapping infrastructure.

### Error recovery

When a pug region has a parse error:

1. **Emit a diagnostic** for the parse error, positioned at the region in the original file.
2. **Replace the region** in the shadow file with a type-compatible placeholder:
   ```tsx
   (null as any as JSX.Element)
   ```
   This suppresses false TS errors on the placeholder while allowing the rest of the file to type-check normally.
3. **Cache the last successful shadow TSX** for the region. If the user introduces a typo, continue serving the stale-but-functional shadow until the error is fixed.

Strategy priority: (a) serve last-good cache if available, (b) fall back to placeholder if no cache.

### Diagnostic filtering

TS diagnostics from the shadow file must be filtered:

- **Include**: Diagnostics whose span falls within a mapped (non-synthetic) region of a pug template. These are real type errors in user expressions.
- **Exclude**: Diagnostics whose span falls entirely within synthetic/structural TSX (generated brackets, wrappers, IIFEs). These are artifacts of our generation.
- **Edge case**: Diagnostics that span both mapped and synthetic regions. Expand to the nearest Pug-side construct boundary.

### Diagnostic debouncing

Debounce diagnostic computation by 200-300ms after the last keystroke. Pug parsing + TSX generation (~1.5ms) is fast enough that we can re-generate on every debounce cycle.

---

## 3.8 Edge Cases and Known Limitations

### 3.8.1 Multiline attribute expressions

```pug
Button(
  onClick={() => {
    handleClick()
    doMore()
  }}
  disabled=isLoading
)
```

The attribute value spans multiple lines. Position computation via `column + name.length + 1` fails. **Solution**: Use the lexer's attribute token `loc.start`/`loc.end` to determine the exact span of each attribute name and value. The lexer correctly handles multiline values.

### 3.8.2 Implicit div tags

```pug
.card
  .title Hello
```

No `div` text exists in the Pug source. The TSX emits `<div className="card">`. **Solution**: The `<div>` tag in TSX is synthetic (unmapped). Cursor on `.card` in Pug maps to the `className` attribute region. Hover on `.card` will show `div` element type info because the cursor falls near the tag name, and Volar's fallback behavior returns the nearest mapped construct.

### 3.8.3 Spread attributes

```pug
div(...props after="after")
```

The parser stores `name: "...props"`. **Solution**: Emit `{...props}` in TSX. Map only the `props` identifier (at pug offset `name_start + 3`, skipping the `...`). The spread syntax `{...` and `}` are synthetic.

### 3.8.4 ${}` JS template interpolation

```js
const view = pug`
  h1 ${title}
  p ${content}
`
```

The existing Babel plugin handles `${}` via `getInterpolatedTemplate()`, which replaces `${}` expressions with `_react_pug_replace_N` placeholders in the Pug text.

**MVP approach**: Detect `${}` inside pug templates (the template literal has multiple `quasis`). Emit a diagnostic: "JS template interpolation is not recommended inside pug; use Pug's #{} interpolation instead." Treat these as pass-through expressions in the TSX, identity-mapped to the expression node positions from the host file's AST.

**Future**: Full support by stitching template segments and mapping `${}` expression offsets from the host AST to the generated TSX positions.

### 3.8.5 Each with destructuring

```pug
each {name, age}, i in users
```

The `val` field is `{name, age}` (a destructuring pattern). **Solution**: Emit this verbatim as the `.map()` arrow function parameter: `users.map(({name, age}, i) => ...)`. The entire destructuring pattern is identity-mapped from the Pug source. The lexer's `each` token span covers the full construct.

### 3.8.6 Template literals inside Pug expressions

```pug
div= `hello ${world}`
```

The backtick in the Pug expression conflicts with the outer tagged template literal. This is a **host parser limitation** -- the JS parser sees the inner backtick as closing the `pug` template. **Solution**: Document this as unsupported. Users must use `${}` interpolation for expressions containing backticks:

```js
const expr = `hello ${world}`;
const view = pug`div= ${expr}`
```

### 3.8.7 Adjacent text and interpolation segments

```pug
p Hello #{name}, welcome to #{place}!
```

The text is split into segments by interpolation references. **Solution**: Emit one mapping entry per segment:
- `"Hello "` -> text segment
- `name` -> expression (FULL_FEATURES)
- `", welcome to "` -> text segment
- `place` -> expression (FULL_FEATURES)
- `"!"` -> text segment

Each segment gets its own `CodeMapping` with appropriate `CodeInformation`.

### 3.8.8 Nested loops with same variable names

```pug
each item in outer
  each item in inner
    div= item
```

The Babel plugin renames the inner `item` to `_item` to avoid shadowing. Our IntelliSense TSX preserves both as `item`, relying on JavaScript's natural scoping in nested `.map()` arrow functions. TypeScript correctly resolves `item` to the inner scope. Hover shows the inner `item`'s type.

### 3.8.9 Empty blocks

```pug
if condition
else
  span Fallback
```

Empty consequent block. **Solution**: Emit `null` as the consequent: `condition ? null : <span>Fallback</span>`. The `null` is synthetic (unmapped).

### 3.8.10 UTF-16 position encoding

VS Code and TypeScript use UTF-16 code units for positions. The Pug lexer uses byte offsets (or character offsets depending on the implementation). **Solution**: All offset conversions must account for surrogate pairs (characters outside the BMP). Use a utility that converts between UTF-8/character offsets and UTF-16 code unit offsets.

---

## Appendix: Lexer Token Retention

The `@startupjs/pug-lexer` provides tokens with precise `loc` information. We retain the token stream and index it for fast lookup by line/column to resolve positions that the parser AST discards.

Key tokens we use:
- `tag`: precise tag name position
- `class`: precise class name position (for shorthand `.foo`)
- `id`: precise id value position (for shorthand `#bar`)
- `attribute`: precise name + value span
- `interpolated-code`: precise expression content position (inside `#{}`)
- `each`: full construct span (use to validate mini-parser positions)
- `if` / `else`: keyword positions
- `code`: unbuffered/buffered code expression position
- `case` / `when`: keyword + expression positions

Token index structure:
```ts
type TokenIndex = Map<string, PugToken[]>;  // keyed by "line:column"
```

This allows O(1) lookup of the lexer token corresponding to any parser AST node (which has `line` and `column` properties).
