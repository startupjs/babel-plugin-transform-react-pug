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

  // 1. Check if documentPosition is within the pugLiteral.contentRange (already done by caller typically, but good for safety)
  const docContent = document.getText(); // Get full document text once
  const documentOffset = positionToOffset(docContent, documentPosition);
  const literalContentStartOffsetDoc = positionToOffset(docContent, pugLiteral.contentRange.start);
  const literalContentEndOffsetDoc = positionToOffset(docContent, pugLiteral.contentRange.end);

  if (documentOffset < literalContentStartOffsetDoc || documentOffset > literalContentEndOffsetDoc) {
    // console.warn("mapDocToPure: Doc position is outside pug literal content range.");
    return null;
  }

  // 2. Calculate position relative to the start of the raw Pug literal's content
  // This rawPugContent is what was fed to preprocessPug
  const positionInRawLiteralContent = Position.create(
    documentPosition.line - pugLiteral.contentRange.start.line,
    documentPosition.line === pugLiteral.contentRange.start.line
      ? documentPosition.character - pugLiteral.contentRange.start.character
      : documentPosition.character
  );

  // 3. Use lineMaps to find corresponding line in textAfterContentIndentStripping (TAS) and adjust character for stripped indentation
  const lineMapEntry = preprocessingData.lineMaps[positionInRawLiteralContent.line];
  if (!lineMapEntry) {
    // console.warn(`mapDocToPure: No lineMap entry for raw literal line ${positionInRawLiteralContent.line}`);
    return null; // Line out of bounds
  }

  let charInTAS = positionInRawLiteralContent.character - lineMapEntry.originalLeadingWhitespaceLength;

  // If charInTAS is negative, it means the original document cursor was within the stripped leading whitespace.
  // For Pug purposes, this effectively means it's at the beginning of the content on that line in TAS.
  if (charInTAS < 0) {
    charInTAS = 0;
  }

  // Ensure charInTAS does not exceed the length of the line in textAfterContentIndentStripping
  const tasLines = preprocessingData.textAfterContentIndentStripping.split('\n');
  const targetTASLineLength = tasLines[lineMapEntry.lineInTAS]?.length || 0;
  charInTAS = Math.min(charInTAS, targetTASLineLength);

  const positionInTAS = Position.create(lineMapEntry.lineInTAS, charInTAS);
  const offsetInTAS = positionToOffset(preprocessingData.textAfterContentIndentStripping, positionInTAS);

  // 4. Find the segment in textAfterContentIndentStripping containing the offsetInTAS and map through it.
  for (const segment of preprocessingData.segments) {
    // Important: For cursor position, if it's at the end of a segment, it might belong to the next one for typing.
    // However, if it's for querying what's *at* the position, originalEndOffset inclusive is okay.
    // Let's use inclusive end for original, exclusive for pure when finding "before" a placeholder.
    if (offsetInTAS >= segment.originalStartOffset && offsetInTAS <= segment.originalEndOffset) {
      if (segment.type === 'direct') {
        const offsetWithinOriginalSegment = offsetInTAS - segment.originalStartOffset;
        const purePugOffset = segment.purePugStartOffset + offsetWithinOriginalSegment;
        // Ensure purePugOffset is within bounds of purePugContent
        const boundedPurePugOffset = Math.min(purePugOffset, preprocessingData.purePugContent.length);
        return offsetToPosition(preprocessingData.purePugContent, boundedPurePugOffset);
      } else if (segment.type === 'interpolation' && segment.interpolation) {
        // If the position is within an original interpolation block:
        // Option 1: Return null (no Pug features inside JS) - Current choice
        // Option 2: Map to the start/end of the placeholder.
        //   - If offsetInTAS is closer to segment.originalStartOffset, map to placeholder start.
        //   - If closer to segment.originalEndOffset, map to placeholder end.
        // This allows completions *around* the placeholder.
        if (offsetInTAS === segment.originalStartOffset) { // Cursor exactly at start of ${...}
            return offsetToPosition(preprocessingData.purePugContent, segment.purePugStartOffset);
        } else if (offsetInTAS === segment.originalEndOffset) { // Cursor exactly at end of ${...}
            return offsetToPosition(preprocessingData.purePugContent, segment.purePugEndOffset);
        }
        // Otherwise, cursor is *inside* the JS expression. For Pug features, this is usually not a target.
        return null;
      }
    }
  }

  // Case: Position is exactly at the end of textAfterContentIndentStripping
  if (offsetInTAS === preprocessingData.textAfterContentIndentStripping.length) {
    const lastSegment = preprocessingData.segments[preprocessingData.segments.length -1];
    if (lastSegment && lastSegment.originalEndOffset === offsetInTAS) { // Defensive check
        return offsetToPosition(preprocessingData.purePugContent, lastSegment.purePugEndOffset);
    }
     // Or simply, end of purePugContent
    return offsetToPosition(preprocessingData.purePugContent, preprocessingData.purePugContent.length);
  }

  // console.warn(`mapDocToPure: Offset ${offsetInTAS} in TAS did not fall into any segment.`);
  return null;
}

function mapPurePugPositionToDocumentPosition(
  purePugPosition: Position,
  pugLiteral: PugLiteralInfo,
  preprocessingData: PugPreprocessingData,
  document: TextDocument // Or just document.getText() if that's all that's needed
): Position | null {
  const purePugOffset = positionToOffset(preprocessingData.purePugContent, purePugPosition);
  let offsetInTAS: number | null = null;

  // 1. Map offsetInPurePug to offsetInTAS using segments
  for (const segment of preprocessingData.segments) {
    if (purePugOffset >= segment.purePugStartOffset && purePugOffset <= segment.purePugEndOffset) {
      if (segment.type === 'direct') {
        const offsetWithinPureSegment = purePugOffset - segment.purePugStartOffset;
        offsetInTAS = segment.originalStartOffset + offsetWithinPureSegment;
        // Ensure it doesn't exceed the original segment's length due to boundary conditions
        offsetInTAS = Math.min(offsetInTAS, segment.originalEndOffset);
        break;
      } else if (segment.type === 'interpolation' && segment.interpolation) {
        // If position is within a placeholder, map it to the start of the original interpolation expression.
        // Or, could choose to map to originalStart/End based on proximity to placeholder start/end.
        // For simplicity, mapping to originalStartOffset for any position within placeholder.
        offsetInTAS = segment.originalStartOffset;
        // If purePugOffset is exactly at segment.purePugEndOffset, map to originalEndOffset
        if (purePugOffset === segment.purePugEndOffset) {
            offsetInTAS = segment.originalEndOffset;
        }
        break;
      }
    }
  }
   // Case: Position is exactly at the end of purePugContent
   if (offsetInTAS === null && purePugOffset === preprocessingData.purePugContent.length) {
    const lastSegment = preprocessingData.segments[preprocessingData.segments.length -1];
    if (lastSegment) { // Defensive check
        offsetInTAS = lastSegment.originalEndOffset;
    } else { // Empty purePugContent, map to start of original empty content
        offsetInTAS = 0;
    }
  }

  if (offsetInTAS === null) {
    // console.warn(`mapPureToDoc: Could not map purePugOffset ${purePugOffset} to offsetInTAS.`);
    return null;
  }

  // Ensure offsetInTAS is within bounds of textAfterContentIndentStripping
  offsetInTAS = Math.min(offsetInTAS, preprocessingData.textAfterContentIndentStripping.length);

  // 2. Convert offsetInTAS to positionInTAS
  const positionInTAS = offsetToPosition(preprocessingData.textAfterContentIndentStripping, offsetInTAS);

  // 3. Use lineMaps to find originalLineNumberInRawLiteral and re-add stripped whitespace
  const lineMapEntry = preprocessingData.lineMaps[positionInTAS.line];
  if (!lineMapEntry) {
    // console.warn(`mapPureToDoc: No lineMap entry for TAS line ${positionInTAS.line}`);
    return null;
  }

  const charInRawLiteralContent = positionInTAS.character + lineMapEntry.originalLeadingWhitespaceLength;
  const originalLineInRawLiteral = lineMapEntry.originalLineNumberInRawLiteral; // This is already the correct line index in rawPugContent

  // 4. Calculate final document position by adding pugLiteral.contentRange.start
  const finalDocLine = pugLiteral.contentRange.start.line + originalLineInRawLiteral;
  const finalDocChar = (originalLineInRawLiteral === 0 ? pugLiteral.contentRange.start.character : 0) + charInRawLiteralContent;

  return Position.create(finalDocLine, finalDocChar);
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
  const docStartPosition = mapPurePugPositionToDocumentPosition(purePugRange.start, pugLiteral, preprocessingData, document);
  const docEndPosition = mapPurePugPositionToDocumentPosition(purePugRange.end, pugLiteral, preprocessingData, document);

  if (docStartPosition && docEndPosition) {
    // Ensure start is not after end (can happen with complex mappings or zero-length ranges)
    if (docStartPosition.line > docEndPosition.line ||
        (docStartPosition.line === docEndPosition.line && docStartPosition.character > docEndPosition.character)) {
      // console.warn("mapPurePugRangeToDocument: Mapped start position is after end position. Returning collapsed range at start.");
      return Range.create(docStartPosition, docStartPosition); // Or swap them, or return null
    }
    return Range.create(docStartPosition, docEndPosition);
  }

  // If only one end could be mapped, we might return a zero-length range at that point, or null.
  // For now, if either fails, the whole range mapping fails.
  // console.warn("mapPurePugRangeToDocument: Could not map one or both positions of the range.");
  return null;
}
