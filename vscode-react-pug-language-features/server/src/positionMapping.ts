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

  // 1. Check if documentPosition is within the pugLiteral.contentRange
  const docContent = document.getText();
  const documentOffset = positionToOffset(docContent, documentPosition);
  const literalContentStartOffsetDoc = positionToOffset(docContent, pugLiteral.contentRange.start);
  const literalContentEndOffsetDoc = positionToOffset(docContent, pugLiteral.contentRange.end);

  if (documentOffset < literalContentStartOffsetDoc || documentOffset > literalContentEndOffsetDoc) {
    return null;
  }

  // 2. Calculate position relative to the start of the raw Pug literal's content (originalRawPugContent)
  // This is the content that was fed to preprocessPug.
  const lineInRawLiteral = documentPosition.line - pugLiteral.contentRange.start.line;
  const charInRawLiteral = (documentPosition.line === pugLiteral.contentRange.start.line)
    ? documentPosition.character - pugLiteral.contentRange.start.character
    : documentPosition.character;

  // 3. Use lineMaps to find corresponding line in textAfterContentIndentStripping (TAS)
  //    and adjust character for stripped total indentation for that line.
  if (lineInRawLiteral < 0 || lineInRawLiteral >= preprocessingData.lineMaps.length) {
    // console.warn(`mapDocToPure: lineInRawLiteral ${lineInRawLiteral} is out of bounds for lineMaps.`);
    return null;
  }
  const lineMapEntry = preprocessingData.lineMaps[lineInRawLiteral];

  // Character position within the line *after* all indentation for that line was stripped.
  let charInTAS = charInRawLiteral - lineMapEntry.originalLeadingWhitespaceLength;

  if (charInTAS < 0) { // Cursor was in the stripped whitespace
    charInTAS = 0;
  }

  const tasLines = preprocessingData.textAfterContentIndentStripping.split('\n');
  const targetTASLineText = tasLines[lineMapEntry.lineInTAS];
  if (targetTASLineText === undefined) { // Should not happen if lineMaps are correct
    // console.warn(`mapDocToPure: TAS line ${lineMapEntry.lineInTAS} is undefined.`);
    return null;
  }
  charInTAS = Math.min(charInTAS, targetTASLineText.length); // Clamp to end of line in TAS

  const positionInTAS = Position.create(lineMapEntry.lineInTAS, charInTAS);
  const offsetInTAS = positionToOffset(preprocessingData.textAfterContentIndentStripping, positionInTAS);

  // 4. Find the segment in textAfterContentIndentStripping containing offsetInTAS and map through it.
  for (const segment of preprocessingData.segments) {
    if (offsetInTAS >= segment.originalStartOffset && offsetInTAS <= segment.originalEndOffset) {
      if (segment.type === 'direct') {
        const offsetWithinOriginalSegment = offsetInTAS - segment.originalStartOffset;
        const purePugOffset = segment.purePugStartOffset + offsetWithinOriginalSegment;
        const boundedPurePugOffset = Math.min(purePugOffset, preprocessingData.purePugContent.length);
        return offsetToPosition(preprocessingData.purePugContent, boundedPurePugOffset);
      } else if (segment.type === 'interpolation' && segment.interpolation) {
        if (offsetInTAS === segment.originalStartOffset) {
            return offsetToPosition(preprocessingData.purePugContent, segment.purePugStartOffset);
        } else if (offsetInTAS === segment.originalEndOffset) {
            return offsetToPosition(preprocessingData.purePugContent, segment.purePugEndOffset);
        }
        return null; // Inside JS expression
      }
    }
  }

  if (offsetInTAS === preprocessingData.textAfterContentIndentStripping.length) {
    const lastSegment = preprocessingData.segments[preprocessingData.segments.length - 1];
    if (lastSegment && lastSegment.originalEndOffset === offsetInTAS) {
        return offsetToPosition(preprocessingData.purePugContent, lastSegment.purePugEndOffset);
    }
    return offsetToPosition(preprocessingData.purePugContent, preprocessingData.purePugContent.length);
  }

  return null;
}

function mapPurePugPositionToDocumentPosition(
  purePugPosition: Position,
  pugLiteral: PugLiteralInfo,
  preprocessingData: PugPreprocessingData,
  document: TextDocument
): Position | null {
  const purePugOffset = positionToOffset(preprocessingData.purePugContent, purePugPosition);
  let offsetInTAS: number | null = null;

  // 1. Map offsetInPurePug to offsetInTAS using segments
  for (const segment of preprocessingData.segments) {
    if (purePugOffset >= segment.purePugStartOffset && purePugOffset <= segment.purePugEndOffset) {
      if (segment.type === 'direct') {
        const offsetWithinPureSegment = purePugOffset - segment.purePugStartOffset;
        offsetInTAS = segment.originalStartOffset + offsetWithinPureSegment;
        offsetInTAS = Math.min(offsetInTAS, segment.originalEndOffset);
        break;
      } else if (segment.type === 'interpolation' && segment.interpolation) {
        // If position in placeholder, map to start of original ${...} for simplicity,
        // or map proportionally if more precision needed for JS features (not current scope).
        // If exactly at placeholder end, map to original end.
        if (purePugOffset === segment.purePugEndOffset) {
             offsetInTAS = segment.originalEndOffset;
        } else {
            offsetInTAS = segment.originalStartOffset;
        }
        break;
      }
    }
  }

   if (offsetInTAS === null && purePugOffset === preprocessingData.purePugContent.length) {
    const lastSegment = preprocessingData.segments[preprocessingData.segments.length -1];
    offsetInTAS = lastSegment ? lastSegment.originalEndOffset : 0;
  }

  if (offsetInTAS === null) {
    return null;
  }

  offsetInTAS = Math.min(offsetInTAS, preprocessingData.textAfterContentIndentStripping.length);

  // 2. Convert offsetInTAS to positionInTAS
  const positionInTAS = offsetToPosition(preprocessingData.textAfterContentIndentStripping, offsetInTAS);

  // 3. Use lineMaps to find originalLineNumberInRawLiteral and re-add stripped whitespace for that line
  if (positionInTAS.line < 0 || positionInTAS.line >= preprocessingData.lineMaps.length) {
    // console.warn(`mapPureToDoc: positionInTAS.line ${positionInTAS.line} is out of bounds for lineMaps.`);
    return null;
  }
  const lineMapEntry = preprocessingData.lineMaps[positionInTAS.line];

  const charInRawLiteralContent = positionInTAS.character + lineMapEntry.originalLeadingWhitespaceLength;
  // originalLineNumberInRawLiteral is the line index in rawPugContent (the input to preprocessPug)
  const originalLineInRawLiteral = lineMapEntry.originalLineNumberInRawLiteral;

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
