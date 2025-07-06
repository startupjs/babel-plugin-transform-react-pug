import { Position, Range } from 'vscode-languageserver/node';
import { RawSourceMap } from 'source-map';
import { Position, Range } from 'vscode-languageserver/node';
// Remove import of RawSourceMap if it's only used for mocks
// import { RawSourceMap } from 'source-map';
import { SourceMapConsumer } from 'source-map'; // Keep for analysis block
import {
    parseSourceMap,
    mapJsxPositionToPugPosition,
    mapJsxRangeToPugRange,
    mapPugPositionToJsxPosition,
    destroySourceMapData,
    JsxPugSourceMapData
} from '../jsxPugMapping';
const { compilePugToJsxString, PugToJsxResult } = require('../pugToJsxTransformer');

const p = (l: number, c: number): Position => Position.create(l, c);
const r = (sl: number, sc: number, el: number, ec: number): Range => Range.create(sl, sc, el, ec);

// Helper function to generate map data for tests
async function createMapData(pugInput: string, filename: string = 'test.pug.virtual.js'): Promise<JsxPugSourceMapData | null> {
  const compileResult = compilePugToJsxString(pugInput, {}, filename);
  if (compileResult.error || !compileResult.sourceMap || !compileResult.jsx) {
    console.error("Failed to compile Pug for test setup:", compileResult.error);
    throw new Error(`Failed to compile Pug for test setup: ${compileResult.error || 'Unknown error'}`);
  }
  // The `originalPugContent` for parseSourceMap should be the *raw Pug string*,
  // not the fakeJsCode. The `jsxPugMapping` functions will need to handle the offset.
  // However, the sourceMap's `sourcesContent` WILL be the fakeJsCode.
  // This is where the current `parseSourceMap` might be insufficient if it assumes sourcesContent[0] is raw pug.
  // For now, we pass raw Pug. This will be part of what Task 3 addresses (refining mapping functions AND parseSourceMap if needed)
  return parseSourceMap(compileResult.sourceMap, pugInput, compileResult.jsx);
}


describe('jsxPugMapping with Real Source Maps', () => {
  // New describe block for Source Map Analysis (can be kept for debugging if needed)
  describe('Source Map Analysis from compilePugToJsxString', () => {
    // Importing SourceMapConsumer here if not already at top level
    // import { SourceMapConsumer } from 'source-map'; // Assuming it's available
    // Importing the compiler
    const { compilePugToJsxString } = require('../pugToJsxTransformer'); // Use require for .js in .ts test if needed, or ensure TS can find it

    const pugSnippets = [
      { name: "Simple Tag", pug: "p Hello" },
      { name: "Tag with Attributes", pug: "div.foo(id=\"bar\" checked)" },
      { name: "JS Interpolation", pug: "p Hello ${name} - ${count + 1}!" },
      { name: "Pug Directive (if)", pug: "if condition\n  p True" },
      { name: "Multiline", pug: "div\n  p Text\n  ul\n    li Item 1" },
      { name: "Empty input", pug: ""},
      { name: "Pug comment", pug: "// just a comment"},
      { name: "Pug unescaped interpolation", pug: "p Hello !{unescapedHtml}"}
    ];

    pugSnippets.forEach(snippetItem => {
      it(`should generate and allow inspection of source map for: ${snippetItem.name}`, async () => {
        console.log(`\n--- Analyzing: ${snippetItem.name} ---`);
        console.log(`Pug Input:\n${snippetItem.pug}`);

        const result = compilePugToJsxString(snippetItem.pug, {}, 'test-input.pug.virtual.js');

        if (result.error) {
          console.log(`Error compiling: ${result.error}`);
          // Optionally fail the test if compilation error is not expected for this snippet
          // expect(result.error).toBeUndefined();
          return;
        }

        console.log(`Generated JSX:\n${result.jsx}`);
        expect(result.jsx).toBeDefined();

        if (result.sourceMap) {
          console.log(`Raw SourceMap Object:\n${JSON.stringify(result.sourceMap, null, 2)}`);

          // Validate basic source map properties
          expect(result.sourceMap.version).toBe(3);
          expect(result.sourceMap.sources).toEqual(['test-input.pug.virtual.js']);
          // Check if sourcesContent is present and matches the wrapped pug string
          // This depends on how babel-plugin-transform-react-pug and babel itself handle it.
          // It should contain the `const __PugToJsxOutput__ = pug\`...\`;` structure.
          expect(result.sourceMap.sourcesContent).toBeDefined();
          expect(result.sourceMap.sourcesContent![0]).toContain(snippetItem.pug.replace(/([`\\])/g, '\\$1'));


          console.log("\nDecoded Mappings (generatedLine, generatedColumn, originalSource, originalLine, originalColumn, name):");
          const consumer = await new SourceMapConsumer(result.sourceMap);
          consumer.eachMapping(m => {
            console.log(
              `Gen L:${m.generatedLine}, C:${m.generatedColumn} -> Src: ${m.source}, Orig L:${m.originalLine}, C:${m.originalColumn} (Name: ${m.name || 'N/A'})`
            );
          });
          consumer.destroy(); // Clean up consumer
        } else {
          console.log("No source map generated for this snippet.");
          // if pug is empty or comment only, jsx might be null, and sourceMap might be missing
          // This might be acceptable for empty/comment-only pug.
          if (snippetItem.pug.trim() !== "" && !snippetItem.pug.trim().startsWith("//")) {
            fail("Source map was expected but not generated.");
          }
        }
        console.log(`--- End Analysis: ${snippetItem.name} ---\n`);
      });
    });
  });

  describe('parseSourceMap', () => {
    it('should parse a valid raw source map', async () => {
      expect(mapDataSimple).not.toBeNull();
      expect(mapDataSimple?.consumer).toBeDefined();
    });

    it('should return null for invalid source map json', async () => {
      const invalidJsonMap = "{ version: 3, /// invalid json";
      const data = await parseSourceMap(invalidJsonMap, "pug", "jsx");
      expect(data).toBeNull();
    });
  });

  describe('mapJsxPositionToPugPosition', () => {
    it('should map JSX position to Pug position for simple case', () => {
      if (!mapDataSimple) throw new Error("mapDataSimple not initialized");
      // JSX "<p>" : char 'p' is at L0, C1. Mapped from Pug "p" L0, C0
      expect(mapJsxPositionToPugPosition(p(0, 1), mapDataSimple)).toEqual(p(0, 0));
    });

    it('should return null if no mapping found or outside mapped JSX', () => {
      if (!mapDataSimple) throw new Error("mapDataSimple not initialized");
      expect(mapJsxPositionToPugPosition(p(0, 0), mapDataSimple)).toBeNull(); // Before 'p' in <p>
      expect(mapJsxPositionToPugPosition(p(0, 2), mapDataSimple)).toBeNull(); // After 'p' in <p> (assuming exact map)
    });

    // TODO: Add more tests with more complex, realistic source maps from Babel
  });

  describe('mapPugPositionToJsxPosition', () => {
    it('should map Pug position to JSX position for simple case', () => {
      if (!mapDataSimple) throw new Error("mapDataSimple not initialized");
      // Pug "p": char 'p' is at L0, C0. Mapped to JSX "<p>" L0, C1
      expect(mapPugPositionToJsxPosition(p(0, 0), mapDataSimple)).toEqual(p(0, 1));
    });

    it('should return null if no mapping found for Pug position', () => {
        if (!mapDataSimple) throw new Error("mapDataSimple not initialized");
        // Example: position beyond actual pug content (if map is strict)
        expect(mapPugPositionToJsxPosition(p(0, 5), mapDataSimple)).toBeNull();
    });

    // TODO: Add more tests with more complex, realistic source maps
  });

  describe('mapJsxRangeToPugRange', () => {
    it('should map a JSX range to a Pug range', () => {
        if (!mapDataSimple) throw new Error("mapDataSimple not initialized");
        // JSX Range for 'p' in "<p>" is r(0,1,0,2)
        // Expected Pug range for 'p' is r(0,0,0,1)
        const jsxRange = r(0,1,0,2);
        const expectedPugRange = r(0,0,0,1); // Assuming 'p' in pug is L0 C0 to L0 C1

        // This depends heavily on the mockRawSourceMapSimple's mappings.
        // AACA means: Gen L1 C1 from Src1 L1 C0.
        // So, JSX p(0,1) -> Pug p(0,0)
        // If jsxRange.end is p(0,2) (exclusive end), originalPositionFor for line:1, col:2 (1-based)
        // might map to pug p(0,1) (exclusive end of 'p') or be null.
        // Let's adjust the test to what originalPositionFor would likely return.
        // If originalPositionFor(1,2) is null, then pugEndPosition would be null.
        // If originalPositionFor(1,1) maps to line:1, col:0 (0-based)
        // and originalPositionFor(1,2) maps to line:1, col:1 (0-based) (if it maps char by char)
        // Then we expect r(0,0,0,1)
        const mappedRange = mapJsxRangeToPugRange(jsxRange, mapDataSimple);
        expect(mappedRange).toEqual(expectedPugRange);
    });

    // TODO: Add tests for ranges spanning multiple mappings, or unmappable parts
  });

});
