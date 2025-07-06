// server/src/jsxPugMapping.ts
import { Position, Range } from 'vscode-languageserver/node';
import { SourceMapConsumer, RawSourceMap, NullablePosition, BasicSourceMapConsumer } from 'source-map';

// This will hold the parsed source map for a given Pug-to-JSX compilation
export interface JsxPugSourceMapData {
  consumer: BasicSourceMapConsumer; // Changed to BasicSourceMapConsumer as per new source-map usage
  originalPugContent: string; // The raw Pug string, for reference and potentially for content validation
  generatedJsxContent: string;
  // We don't store fakeJsCodePrefixLength here, calculate on the fly or pass if needed by specific functions
}

// Defines the prefix of the fake JavaScript code used to wrap the Pug literal for Babel transformation.
// const fakeJsCode = `const __PugToJsxOutput__ = pug\`${pugString}\`;`;
const FAKE_JS_CODE_PREFIX = "const __PugToJsxOutput__ = pug`";
// const FAKE_JS_CODE_SUFFIX = "`;"; // Not currently needed for start position adjustments

/**
 * Parses a raw source map and prepares it for querying.
 */
export async function parseSourceMap(
  rawMap: RawSourceMap | string, // Can be object or JSON string
  originalPugContent: string,
  generatedJsxContent: string
): Promise<JsxPugSourceMapData | null> {
  try {
    const mapObject = typeof rawMap === 'string' ? JSON.parse(rawMap) : rawMap;
    const consumer = await new SourceMapConsumer(mapObject) as BasicSourceMapConsumer;
    // To verify, ensure consumer.sourcesContent[0] contains the fakeJsCode
    // console.log("Source content from map:", consumer.sourceContentFor(consumer.sources[0]));
    return { consumer, originalPugContent, generatedJsxContent };
  } catch (err) {
    // console.error("Failed to parse source map:", err);
    return null;
  }
}

/**
 * Maps a position in the generated JSX back to a position in the original Pug source.
 * JSX positions are 0-indexed. Pug positions returned are 0-indexed.
 */
export function mapJsxPositionToPugPosition(
  jsxPosition: Position, // 0-indexed
  mapData: JsxPugSourceMapData
): Position | null {
  if (!mapData || !mapData.consumer) return null;

  // query `originalPositionFor` with 1-indexed line and 0-indexed column for source-map lib
  const originalBabelPosition = mapData.consumer.originalPositionFor({
    line: jsxPosition.line + 1, // source-map lib expects 1-indexed line
    column: jsxPosition.character, // source-map lib expects 0-indexed column
    bias: SourceMapConsumer.LEAST_UPPER_BOUND
  });

  // originalBabelPosition: line is 1-indexed, column is 0-indexed, relative to fakeJsCode
  if (originalBabelPosition.line === null || originalBabelPosition.column === null || originalBabelPosition.source === null) {
    return null;
  }

  // Convert Babel's 1-indexed line to 0-indexed pugLine
  const pugLine = originalBabelPosition.line - 1;
  let pugColumn: number;

  if (pugLine === 0) { // Mapping is to the first line of fakeJsCode where pug literal starts
    pugColumn = originalBabelPosition.column - FAKE_JS_CODE_PREFIX.length;
  } else { // Mapping is to subsequent lines of a multi-line pug string within fakeJsCode
    pugColumn = originalBabelPosition.column;
  }

  // If column is negative, it means the mapping was into the prefix, not the Pug content.
  if (pugColumn < 0) {
    return null;
  }

  // TODO: Add validation against originalPugContent's line lengths if necessary,
  // e.g., if pugColumn > length of mapData.originalPugContent.split('\n')[pugLine]

  return Position.create(pugLine, pugColumn);
}

/**
 * Maps a range in the generated JSX back to a range in the original Pug source.
 */
export function mapJsxRangeToPugRange(
  jsxRange: Range,
  mapData: JsxPugSourceMapData
): Range | null {
  if (!mapData || !mapData.consumer) return null;

  // For ranges, LEAST_UPPER_BOUND for start and GREATEST_LOWER_BOUND for end often work best.
  // However, mapJsxPositionToPugPosition already uses LEAST_UPPER_BOUND.
  // Consider if bias needs to be different for end position.
  // For now, using the existing mapJsxPositionToPugPosition logic.
  const pugStartPosition = mapJsxPositionToPugPosition(jsxRange.start, mapData);

  // When mapping the end of a JSX range, we often want the position *before* the character,
  // so GREATEST_LOWER_BOUND might be more appropriate if we were calling originalPositionFor directly.
  // Let's test with current mapJsxPositionToPugPosition first.
  // If jsxRange.end is exclusive, then mapping it directly might be correct.
  const pugEndPosition = mapJsxPositionToPugPosition(jsxRange.end, mapData);

  if (pugStartPosition && pugEndPosition) {
    // Ensure start is not after end (can happen with coarse mappings or unusual ranges)
    if (pugStartPosition.line > pugEndPosition.line ||
        (pugStartPosition.line === pugEndPosition.line && pugStartPosition.character > pugEndPosition.character)) {
      // console.warn("mapJsxRangeToPugRange: Mapped start position is after end position. Swapping them.");
      return Range.create(pugEndPosition, pugStartPosition);
    }
    return Range.create(pugStartPosition, pugEndPosition);
  }
  // If only one end maps, we might return a collapsed range or null.
  // For now, if either is null, the whole range mapping fails.
  return null;
}

/**
 * Maps a position in the original Pug source (0-indexed) to a position in the generated JSX (0-indexed).
 */
export function mapPugPositionToJsxPosition(
  pugPosition: Position, // 0-indexed, relative to the raw Pug string
  mapData: JsxPugSourceMapData
): Position | null {
  if (!mapData || !mapData.consumer) return null;

  const sourceName = mapData.consumer.sources && mapData.consumer.sources.length > 0 ? mapData.consumer.sources[0] : undefined;
  if (!sourceName) {
    // console.warn("mapPugPositionToJsxPosition: No sources found in source map consumer.");
    return null;
  }

  // Convert 0-indexed pugPosition to coordinates relative to fakeJsCode for source-map query
  const fakeJsCodeLine = pugPosition.line + 1; // source-map lib expects 1-indexed line
  let fakeJsCodeColumn: number;

  if (pugPosition.line === 0) { // Pug position is on the first line of the (potentially multiline) pug string
    fakeJsCodeColumn = pugPosition.character + FAKE_JS_CODE_PREFIX.length;
  } else { // Pug position is on a subsequent line
    fakeJsCodeColumn = pugPosition.character;
  }

  // Query with 1-indexed line and 0-indexed column for source-map lib
  const generatedPosition = mapData.consumer.generatedPositionFor({
    source: sourceName,
    line: fakeJsCodeLine,
    column: fakeJsCodeColumn, // source-map lib expects 0-indexed column
    bias: SourceMapConsumer.LEAST_UPPER_BOUND // Or GREATEST_LOWER_BOUND depending on desired behavior for edges
  });

  // generatedPosition: line is 1-indexed, column is 0-indexed
  if (generatedPosition.line === null || generatedPosition.column === null) {
    return null;
  }

  // Convert to 0-indexed for LSP
  return Position.create(generatedPosition.line - 1, generatedPosition.column);
}

/**
 * Utility to destroy the SourceMapConsumer to free resources.
 * Call this when the JsxPugSourceMapData is no longer needed.
 */
export function destroySourceMapData(mapData: JsxPugSourceMapData): void {
  if (mapData && mapData.consumer && typeof (mapData.consumer as any).destroy === 'function') {
    (mapData.consumer as any).destroy();
  }
}
