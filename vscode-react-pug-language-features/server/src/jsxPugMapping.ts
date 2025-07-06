// server/src/jsxPugMapping.ts
import { Position, Range } from 'vscode-languageserver/node';
import { SourceMapConsumer, RawSourceMap, NullablePosition, BasicSourceMapConsumer } from 'source-map';

// This will hold the parsed source map for a given Pug-to-JSX compilation
export interface JsxPugSourceMapData {
  consumer: BasicSourceMapConsumer; // Changed to BasicSourceMapConsumer as per new source-map usage
  originalPugContent: string;
  generatedJsxContent: string;
}

/**
 * Parses a raw source map and prepares it for querying.
 */
export async function parseSourceMap(
  rawMap: RawSourceMap | string, // Can be object or JSON string
  originalPugContent: string,
  generatedJsxContent: string
): Promise<JsxPugSourceMapData | null> {
  try {
    // The 'source-map' library's SourceMapConsumer is now typically used with `await SourceMapConsumer.with(...)`
    // or by passing the raw map directly if it's already parsed.
    // For simplicity with potential string or object input:
    const mapObject = typeof rawMap === 'string' ? JSON.parse(rawMap) : rawMap;
    const consumer = await new SourceMapConsumer(mapObject) as BasicSourceMapConsumer;
    return { consumer, originalPugContent, generatedJsxContent };
  } catch (err) {
    console.error("Failed to parse source map:", err);
    return null;
  }
}

/**
 * Maps a position in the generated JSX back to a position in the original Pug source.
 */
export function mapJsxPositionToPugPosition(
  jsxPosition: Position,
  mapData: JsxPugSourceMapData
): Position | null {
  if (!mapData || !mapData.consumer) return null;
  const originalPosition = mapData.consumer.originalPositionFor({
    line: jsxPosition.line + 1,
    column: jsxPosition.character,
    bias: SourceMapConsumer.LEAST_UPPER_BOUND
  });

  if (originalPosition.line === null || originalPosition.column === null) {
    return null;
  }
  return Position.create(originalPosition.line - 1, originalPosition.column);
}

/**
 * Maps a range in the generated JSX back to a range in the original Pug source.
 */
export function mapJsxRangeToPugRange(
  jsxRange: Range,
  mapData: JsxPugSourceMapData
): Range | null {
  if (!mapData || !mapData.consumer) return null;
  const pugStartPosition = mapJsxPositionToPugPosition(jsxRange.start, mapData);
  const pugEndPosition = mapJsxPositionToPugPosition(jsxRange.end, mapData);

  if (pugStartPosition && pugEndPosition) {
    if (pugStartPosition.line > pugEndPosition.line ||
        (pugStartPosition.line === pugEndPosition.line && pugStartPosition.character > pugEndPosition.character)) {
      // This can happen if the mapping is coarse or if the JSX range is unusual.
      // console.warn("mapJsxRangeToPugRange: Mapped start position is after end position. Consider swapping or collapsing.");
      return Range.create(pugEndPosition, pugStartPosition); // Or return specific error/null
    }
    return Range.create(pugStartPosition, pugEndPosition);
  }
  return null;
}

/**
 * Maps a position in the original Pug source to a position in the generated JSX.
 */
export function mapPugPositionToJsxPosition(
  pugPosition: Position,
  mapData: JsxPugSourceMapData
): Position | null {
  if (!mapData || !mapData.consumer) return null;

  // Ensure sources array is not empty and use the first source
  // This assumes the source map correctly identifies the original Pug file/content as its source.
  const sourceName = mapData.consumer.sources && mapData.consumer.sources.length > 0 ? mapData.consumer.sources[0] : undefined;
  if (!sourceName) {
      // console.warn("mapPugPositionToJsxPosition: No sources found in source map consumer.");
      return null;
  }

  const generatedPosition = mapData.consumer.generatedPositionFor({
    source: sourceName,
    line: pugPosition.line + 1,
    column: pugPosition.character,
    bias: SourceMapConsumer.LEAST_UPPER_BOUND
  });

  if (generatedPosition.line === null || generatedPosition.column === null) {
    return null;
  }
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
