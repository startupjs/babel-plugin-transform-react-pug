import { Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { PugLiteralInfo } from './server'; // Assuming PugLiteralInfo is exported or moved
import { PugPreprocessingData, InterpolationMapping } from './reactPugLanguageService';
import { positionToOffset, offsetToPosition } from './utils/textPositions';

/**
 * Maps a Position from the original document to a Position within the purePugContent.
 *
 * @param documentPosition The position in the original JS/TS document.
 * @param pugLiteral The information about the Pug literal block in the document.
 * @param preprocessingData The detailed mapping data from the preprocessing step.
 * @param document The full TextDocument object (needed for text access if not all info is in pugLiteral/preprocessingData).
 * @returns The corresponding position in purePugContent, or null if the documentPosition is outside the Pug literal's relevant area.
 */
export function mapDocumentPositionToPurePug(
  documentPosition: Position,
  pugLiteral: PugLiteralInfo, // Contains contentRange for raw Pug in document
  preprocessingData: PugPreprocessingData, // Contains segments and indentation info
  document: TextDocument // The full document
): Position | null {
  // 1. Check if documentPosition is within the pugLiteral.contentRange
  const documentOffset = positionToOffset(document.getText(), documentPosition);
  const literalContentStartOffsetDoc = positionToOffset(document.getText(), pugLiteral.contentRange.start);
  const literalContentEndOffsetDoc = positionToOffset(document.getText(), pugLiteral.contentRange.end);

  if (documentOffset < literalContentStartOffsetDoc || documentOffset > literalContentEndOffsetDoc) {
    return null; // Position is outside the Pug literal's content
  }

  // 2. Calculate offset relative to the start of the raw Pug literal's content
  const offsetInRawLiteralContent = documentOffset - literalContentStartOffsetDoc;

  // 3. Account for baseIndentation and contentIndentation that was stripped.
  //    This requires knowing which line the offsetInRawLiteralContent falls on,
  //    and how much total indentation was stripped from that line to get to
  //    the coordinate system of `preprocessingData.segments[].originalStart/EndOffset`.

  // `preprocessingData.originalRawPugContent` is the string that `segments[].originalStart/EndOffset` refer to.
  // This `originalRawPugContent` is `rawPugInLiteral` from server.ts AFTER baseIndentation stripping.
  // So, we first need to map `offsetInRawLiteralContent` to an offset in `preprocessingData.originalRawPugContent`.

  // This is tricky. `PugLiteralInfo.indentation` is the base indent of the pug``` line.
  // `preprocessingData.baseIndentationLength` is its length.
  // `preprocessingData.contentIndentationLength` is the common indent *within* the block.

  // Let's get the text that segments relate to:
  // `textAfterContentIndentStripping` was used in `preprocessPug` to generate segments.
  // This text is `pugLiteral.rawPugContent` (from server) after `baseIndentation` and `contentIndentation` were stripped.
  // We need to map `offsetInRawLiteralContent` to an offset in this `textAfterContentIndentStripping`.

  // This part is complex because indentation stripping is line-based.
  // A robust way is to reconstruct the `textAfterContentIndentStripping` or iterate line by line.

  // Simplified placeholder for this complex step:
  // For now, assume offsetInRawLiteralContent can be roughly used with segments,
  // knowing this is where precision will be lost without full line-by-line de-indentation mapping.
  // TODO: Implement precise mapping from `offsetInRawLiteralContent` to an offset in the conceptual
  // string that `preprocessingData.segments[].originalStartOffset` refers to.

  let currentOffsetInTextAfterContentIndentStripping = offsetInRawLiteralContent; // Placeholder for more complex calculation

  // 4. Find the segment containing the position and map through it.
  for (const segment of preprocessingData.segments) {
    if (currentOffsetInTextAfterContentIndentStripping >= segment.originalStartOffset &&
        currentOffsetInTextAfterContentIndentStripping <= segment.originalEndOffset) {

      if (segment.type === 'direct') {
        const offsetWithinOriginalSegment = currentOffsetInTextAfterContentIndentStripping - segment.originalStartOffset;
        const purePugOffset = segment.purePugStartOffset + offsetWithinOriginalSegment;
        return offsetToPosition(preprocessingData.purePugContent, purePugOffset);
      } else if (segment.type === 'interpolation' && segment.interpolation) {
        // Position is within a JS interpolation.
        // For now, we don't map into the content of the placeholder itself for Pug features.
        // We might return the start or end of the placeholder, or null.
        // Or, if the goal is to get features for the JS inside, that's a different mapping.
        // Let's return null for now if inside an interpolation for Pug context.
        return null;
      }
    }
  }

  // If it's exactly at the end of the last segment (e.g. typing at the end of the literal)
  const lastSegment = preprocessingData.segments[preprocessingData.segments.length - 1];
  if (lastSegment && currentOffsetInTextAfterContentIndentStripping === lastSegment.originalEndOffset) {
      return offsetToPosition(preprocessingData.purePugContent, lastSegment.purePugEndOffset);
  }

  return null; // Should not be reached if logic is correct and position is within a segment
}


/**
 * Maps a Range from purePugContent back to a Range in the original document.
 *
 * @param purePugRange The range in purePugContent.
 * @param pugLiteral The information about the Pug literal block in the document.
 * @param preprocessingData The detailed mapping data from the preprocessing step.
 * @param document The full TextDocument object.
 * @returns The corresponding range in the original document, or null if mapping is not possible.
 */
export function mapPurePugRangeToDocument(
  purePugRange: Range,
  pugLiteral: PugLiteralInfo,
  preprocessingData: PugPreprocessingData,
  document: TextDocument
): Range | null {
  const purePugStartOffset = positionToOffset(preprocessingData.purePugContent, purePugRange.start);
  const purePugEndOffset = positionToOffset(preprocessingData.purePugContent, purePugRange.end);

  let docStartOffset: number | null = null;
  let docEndOffset: number | null = null;

  // Helper to map a single purePug offset to an offset in rawLiteralContent (before base indent re-addition)
  function mapPureOffsetToOriginalPostIndentOffset(pureOffset: number): number | null {
    for (const segment of preprocessingData.segments) {
      if (pureOffset >= segment.purePugStartOffset && pureOffset <= segment.purePugEndOffset) {
        if (segment.type === 'direct') {
          const offsetWithinPureSegment = pureOffset - segment.purePugStartOffset;
          return segment.originalStartOffset + offsetWithinPureSegment;
        } else if (segment.type === 'interpolation') {
          // If a range spans an interpolation, how should it be mapped?
          // Option 1: Map to the original ${...} range.
          // Option 2: Consider it unmappable or return a collapsed range.
          // For diagnostics on placeholders, we might want to map to original ${...}
          // For now, let's try to map to the start of the original interpolation
          if (pureOffset === segment.purePugStartOffset) return segment.originalStartOffset;
          if (pureOffset === segment.purePugEndOffset) return segment.originalEndOffset;
          // If inside a placeholder, map to the original expression's full span
          return segment.originalStartOffset; // Or originalEndOffset, or average... this is tricky
        }
      }
    }
     // If exactly at the end of the last segment
    const lastSegment = preprocessingData.segments[preprocessingData.segments.length - 1];
    if (lastSegment && pureOffset === lastSegment.purePugEndOffset) {
        return lastSegment.originalEndOffset;
    }
    return null;
  }

  const originalStartOffsetPostIndent = mapPureOffsetToOriginalPostIndentOffset(purePugStartOffset);
  const originalEndOffsetPostIndent = mapPureOffsetToOriginalPostIndentOffset(purePugEndOffset);

  if (originalStartOffsetPostIndent === null || originalEndOffsetPostIndent === null) {
    return null; // Part of the range couldn't be mapped
  }

  // TODO: Now, re-apply indentations (base and content) to these offsets to get document offsets.
  // This is the reverse of the complex de-indentation logic.
  // This step is also highly complex and requires careful line-by-line reconstruction or offset adjustment.
  // Placeholder for this complex step:
  const mappedDocStartOffset = positionToOffset(document.getText(), pugLiteral.contentRange.start) + originalStartOffsetPostIndent;
  const mappedDocEndOffset = positionToOffset(document.getText(), pugLiteral.contentRange.start) + originalEndOffsetPostIndent;


  if (mappedDocStartOffset > mappedDocEndOffset && purePugStartOffset <= purePugEndOffset) {
      // This can happen if mapping of start/end via interpolations causes inversion
      console.warn("mapPurePugRangeToDocument: mapped start offset is greater than end offset. Clamping.");
      return Range.create(offsetToPosition(document.getText(), mappedDocEndOffset), offsetToPosition(document.getText(), mappedDocEndOffset));
  }

  return Range.create(
    offsetToPosition(document.getText(), mappedDocStartOffset),
    offsetToPosition(document.getText(), mappedDocEndOffset)
  );
}
