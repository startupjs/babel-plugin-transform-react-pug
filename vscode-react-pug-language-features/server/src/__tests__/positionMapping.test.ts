import { Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { PugLiteralInfo } from '../server'; // Assuming server.ts exports it or it's moved
import { PugPreprocessingData, InterpolationMapping } from '../reactPugLanguageService';
import { offsetToPosition, positionToOffset, mapDocumentPositionToPurePug, mapPurePugRangeToDocument } from '../positionMapping';

// Helper to create a Range for easier test writing
const r = (sl: number, sc: number, el: number, ec: number): Range => Range.create(sl, sc, el, ec);
// Helper to create a Position
const p = (l: number, c: number): Position => Position.create(l, c);

describe('positionMapping Utilities', () => {
  describe('offsetToPosition', () => {
    const text = "line1\nline2\nline3"; // offsets: l(0) i(1) n(2) e(3) 1(4) \n(5) l(6) ...
    it('should convert offset to position correctly', () => {
      expect(offsetToPosition(text, 0)).toEqual(p(0, 0)); // l
      expect(offsetToPosition(text, 4)).toEqual(p(0, 4)); // 1
      expect(offsetToPosition(text, 5)).toEqual(p(1, 0)); // \n -> start of line2
      expect(offsetToPosition(text, 6)).toEqual(p(1, 1)); // i in line2
      expect(offsetToPosition(text, text.length)).toEqual(p(2, 5)); // end of line3
    });

    it('should handle offset at start and end of lines', () => {
        expect(offsetToPosition(text, 0)).toEqual(p(0,0)); // Start of line1
        expect(offsetToPosition(text, 5)).toEqual(p(1,0)); // Start of line2 (after \n)
        expect(offsetToPosition(text, 11)).toEqual(p(2,0)); // Start of line3 (after \n)
    });

    it('should handle offset beyond text length (clamp to end)', () => {
      expect(offsetToPosition(text, 100)).toEqual(p(2, 5));
    });

    it('should handle negative offset (clamp to start)', () => {
      expect(offsetToPosition(text, -5)).toEqual(p(0, 0));
    });

    it('should handle empty string', () => {
      expect(offsetToPosition("", 0)).toEqual(p(0, 0));
      expect(offsetToPosition("", 5)).toEqual(p(0, 0));
    });

    it('should handle string with only newlines', () => {
        const textNL = "\n\n"; // L0: "", L1: "", L2: ""
        expect(offsetToPosition(textNL, 0)).toEqual(p(0,0));
        expect(offsetToPosition(textNL, 1)).toEqual(p(1,0));
        expect(offsetToPosition(textNL, 2)).toEqual(p(2,0));
        expect(offsetToPosition(textNL, 3)).toEqual(p(2,0)); // Clamp
    });
  });

  describe('positionToOffset', () => {
    const text = "line1\nline2\nline3";
    it('should convert position to offset correctly', () => {
      expect(positionToOffset(text, p(0, 0))).toBe(0);
      expect(positionToOffset(text, p(0, 4))).toBe(4);
      expect(positionToOffset(text, p(1, 0))).toBe(5); // Start of line2
      expect(positionToOffset(text, p(1, 1))).toBe(6); // 'i' in line2
      expect(positionToOffset(text, p(2, 5))).toBe(text.length);
    });

    it('should handle position character beyond line length (clamp to line end)', () => {
      expect(positionToOffset(text, p(0, 100))).toBe(5); // End of line1 (start of \n)
      expect(positionToOffset(text, p(1, 100))).toBe(11); // End of line2 (start of \n)
      expect(positionToOffset(text, p(2,100))).toBe(17); // End of line3 (text.length)
    });

    it('should handle position line beyond text lines (clamp to text end)', () => {
      expect(positionToOffset(text, p(10, 0))).toBe(text.length);
    });

    it('should handle empty string', () => {
      expect(positionToOffset("", p(0, 0))).toBe(0);
      expect(positionToOffset("", p(0, 5))).toBe(0);
      expect(positionToOffset("", p(1, 0))).toBe(0);
    });

    it('should handle string with only newlines', () => {
        const textNL = "\n\n";
        expect(positionToOffset(textNL, p(0,0))).toBe(0);
        expect(positionToOffset(textNL, p(1,0))).toBe(1);
        expect(positionToOffset(textNL, p(2,0))).toBe(2);
        expect(positionToOffset(textNL, p(3,0))).toBe(2); // Clamp
    });
  });

  // TODO: Add tests for mapDocumentPositionToPurePug
  // describe('mapDocumentPositionToPurePug', () => {});

  describe('mapDocumentPositionToPurePug', () => {
    const mockDocumentText = `
      const comp = () => pug\`
        div
          p Hello \${name}
            span World
      \`;
    `;
    const mockDocument = TextDocument.create('testfile:///test.js', 'javascript', 1, mockDocumentText);

    // Scenario 1: Simple case, no complex indentation, one interpolation
    const rawPug1 = 'div\n  p Hello ${name}\n    span World';
    const baseIndent1 = '        '; // 8 spaces for pug` line

    // Manually derived PreprocessingData for rawPug1 with baseIndent1
    // Base strip:
    // div
    //   p Hello ${name}
    //     span World
    // Content common indent (for ["div", "  p Hello ${name}", "    span World"]) is ""
    // So, textAfterContentIndentStripping (TAS) is same as above.
    const tas1 = "div\n  p Hello ${name}\n    span World";
    const p0_1 = `${INTERPOLATION_PLACEHOLDER_PREFIX}0_`; // For ${name}
    const purePug1 = `div\n  p Hello ${p0_1}\n    span World`;

    const preprocessingData1: PugPreprocessingData = {
      originalRawPugContent: rawPug1, // This is the content passed to preprocessPug
      baseIndentationLength: 0, // preprocessPug receives rawPugInLiteral which has baseIndent already conceptually "handled" by caller
                                // The baseIndentationString length is what it uses.
                                // Let's assume the `baseIndentationString` passed to preprocessPug was "" for this data.
                                // This means rawPug1 *is* the text after the `pug``` line's own indent is stripped by the server.
                                // This needs clarification: PugLiteralInfo.indentation is the indent of `pug``` line.
                                // preprocessPug's baseIndentationString param is this PugLiteralInfo.indentation.
                                // So, originalRawPugContent in PugPreprocessingData is the content *inside* pug`` marks.

      // Let's refine: PugLiteralInfo.indentation is the indent of the line `  const comp... pug\``.
      // The `rawPugContent` passed to `preprocessPug` is the content *within* the backticks.
      // The `baseIndentationString` passed to `preprocessPug` is the leading whitespace of the *first line within the backticks*.
      // This means `PugPreprocessingData.baseIndentationLength` refers to this inner base indent.

      // For rawPug1 = "div\n  p Hello ${name}\n    span World"
      // If baseIndentationString for preprocessPug was "", then baseIndentationLength = 0.
      // Then commonContentIndent for ["div", "  p Hello ${name}", "    span World"] is "". So contentIndentationLength = 0.
      // textAfterContentIndentStripping = rawPug1
      baseIndentationLength: 0,
      contentIndentationLength: 0,
      textAfterContentIndentStripping: tas1,
      lineMaps: [
        { originalLineNumberInRawLiteral: 0, lineInTAS: 0, originalLeadingWhitespaceLength: 0 },
        { originalLineNumberInRawLiteral: 1, lineInTAS: 1, originalLeadingWhitespaceLength: 0 }, // "  p Hello ${name}" -> `originalLeadingWhitespaceLength` should be 2 if contentIndent was "  "
        { originalLineNumberInRawLiteral: 2, lineInTAS: 2, originalLeadingWhitespaceLength: 0 }, // "    span World" -> `originalLeadingWhitespaceLength` should be 4 if contentIndent was "    "
        // The lineMaps need to be consistent with how preprocessPug calculates them based on its input.
        // If rawPug1 is "div\n  p Hello ${name}\n    span World" and baseIndent for preprocessPug is "",
        // then commonContentIndent is "" -> all originalLeadingWhitespaceLength are 0. This seems correct for this input.
      ],
      segments: [
        { type: 'direct', originalStartOffset: 0, originalEndOffset: 18, purePugStartOffset: 0, purePugEndOffset: 18 }, // "div\n  p Hello "
        {
          type: 'interpolation', originalStartOffset: 18, originalEndOffset: 25, // ${name} in TAS
          purePugStartOffset: 18, purePugEndOffset: 18 + p0_1.length,
          interpolation: { placeholder: p0_1, originalExpression: 'name', originalRangeInRawLiteral: r(1,11,1,18), placeholderRangeInPurePug: r(1,11,1,11+p0_1.length) }
        },
        { type: 'direct', originalStartOffset: 25, originalEndOffset: tas1.length, purePugStartOffset: 18 + p0_1.length, purePugEndOffset: purePug1.length } // "\n    span World"
      ]
    };

    const pugLiteralInfo1: PugLiteralInfo = {
      content: rawPug1, // This is textDocument.getText(literal.contentRange)
      range: r(1, 21, 4, 7), // Range of pug`...` in mockDocumentText (approx)
      contentRange: r(2, 8, 4, 7), // Range of content within backticks (approx)
                            // Line 2, char 8 is start of "div"
                            // Line 4, char 7 is end of "span World"
      indentation: '        ', // Indentation of the `pug``` line in document, passed as baseIndentationString to preprocessPug
                               // This is confusing. Let's assume PugLiteralInfo.indentation is the one *before* the first line of pug code if different.
                               // The `baseIndentationString` for `preprocessPug` is calculated from first line of rawPugContent itself usually.
                               // For this test, let's assume `PugLiteralInfo.indentation` is the `baseIndentationString` that `preprocessPug` used
                               // to achieve the `preprocessingData1.baseIndentationLength`.
                               // If `preprocessingData1.baseIndentationLength` is 0, it means the `rawPug1` *is* already after this first level of stripping.
    };
    // To make this test setup clearer, `preprocessingData.originalRawPugContent` should be the string
    // that `textAfterContentStripping` was derived from *after* `PugLiteralInfo.indentation` was handled.
    // Let's simplify: assume `PugLiteralInfo.indentation` is the `baseIndentationString` argument to `preprocessPug`.
    // And `preprocessingData.originalRawPugContent` is the `rawPugContent` argument to `preprocessPug`.

    it('should map position in direct segment', () => {
      // Targeting 'H' in "Hello" in "  p Hello ${name}"
      // Original doc: line 3, char 13 (approx: '        ' + '  ' + 'p ' + 'H')
      // `pugLiteral.contentRange.start` is L2 C8.
      // Position in rawPug1: L1 C10 ("  p Hello ${name}") -> 'H' is at char 4 of this line.
      // `lineMapEntry` for L1: originalLeadingWSLength = 2 (assuming contentIndent of "  " for p line)
      //   This needs `preprocessingData1` to be perfectly set up as `preprocessPug` would.
      //   Let's re-evaluate `preprocessingData1` based on `rawPug1` and `baseIndentation = ""` for `preprocessPug`.
      //   If rawPug1 = "div\n  p Hello ${name}\n    span World", baseIndent="",
      //   then linesForContentIndentCalc = ["div", "  p Hello ${name}", "    span World"]
      //   commonContentIndent = ""
      //   textAfterContentIndentStripping = rawPug1
      //   lineMaps[1].originalLeadingWhitespaceLength = 0
      //   charInTAS for 'H' (L1, C10 in raw, C4 in "  p Hello ${name}") -> 4.
      //   offsetInTAS for 'H' in "div\n  p Hello ${name}\n    span World"
      //   "div\n" (4) + "  p " (4) + "H" (0) = 8.
      //   Segment 0: "div\n  p Hello ". originalEndOffset=18. 8 is in this segment.
      //   offsetInTAS (8) - seg0.originalStartOffset (0) = 8.
      //   purePugOffset = seg0.purePugStartOffset (0) + 8 = 8.
      //   purePug1 = "div\n  p Hello __RPLS_INTERP_0_\n    span World"
      //   offsetToPosition(purePug1, 8) -> L1, C4 ('H')

      // Let's simplify the test setup to make it less dependent on perfect pre-calc of preprocessingData
      // and instead focus on the mapping logic given a consistent preprocessingData.

      const specificTAS = "p Hello ${name}"; // line 1 of tas1
      const specificPure = `p Hello ${p0_1}`; // line 1 of purePug1
      const specificSegments = [
          { type: 'direct', originalStartOffset: 0, originalEndOffset: 8, purePugStartOffset: 0, purePugEndOffset: 8 }, // "p Hello "
          { type: 'interpolation', originalStartOffset: 8, originalEndOffset: 15, purePugStartOffset: 8, purePugEndOffset: 8 + p0_1.length, interpolation: { placeholder: p0_1, originalExpression: 'name', originalRangeInRawLiteral: r(0,8,0,15), placeholderRangeInPurePug: r(0,8,0,8+p0_1.length)} },
      ];
      const testPreprocessingData: PugPreprocessingData = {
        originalRawPugContent: "p Hello ${name}", // This is the contentRange text
        baseIndentationLength: 0, // Assume this was stripped before this raw content
        contentIndentationLength: 0, // Assume this was stripped to get to originalRawPugContent
        textAfterContentIndentStripping: specificTAS,
        lineMaps: [{ originalLineNumberInRawLiteral: 0, lineInTAS: 0, originalLeadingWhitespaceLength: 0 }],
        segments: specificSegments
      };
      const testPugLiteralInfo: PugLiteralInfo = {
        content: "p Hello ${name}",
        range: r(0,0,0,15), // Dummy full range
        contentRange: r(0,0,0,15), // Doc position of "p Hello ${name}"
        indentation: ""
      };

      // Target 'H' in "Hello". In doc: L0, C2. In TAS: L0, C2. In Pure: L0, C2.
      let docPos = p(0, 2);
      let expectedPurePos = p(0, 2);
      expect(mapDocumentPositionToPurePug(docPos, testPugLiteralInfo, testPreprocessingData, mockDocument /* only for getText() consistency */))
        .toEqual(expectedPurePos);

      // Target space after "Hello". In doc: L0, C7. In TAS: L0, C7. In Pure: L0, C7.
      docPos = p(0, 7);
      expectedPurePos = p(0, 7);
      expect(mapDocumentPositionToPurePug(docPos, testPugLiteralInfo, testPreprocessingData, mockDocument))
        .toEqual(expectedPurePos);

      // Target start of ${name}. In doc: L0, C8. In TAS: L0, C8. Should map to start of placeholder.
      docPos = p(0, 8);
      expectedPurePos = p(0, 8); // Start of placeholder
      expect(mapDocumentPositionToPurePug(docPos, testPugLiteralInfo, testPreprocessingData, mockDocument))
          .toEqual(expectedPurePos);

      // Target inside ${name} (e.g., 'a'). In doc: L0, C10. In TAS: L0, C10. Should be null (inside interpolation).
      docPos = p(0, 10);
      expect(mapDocumentPositionToPurePug(docPos, testPugLiteralInfo, testPreprocessingData, mockDocument))
          .toBeNull();

      // Target end of ${name} (right after 'e}'). In doc: L0, C15. In TAS: L0, C15. Should map to end of placeholder.
      docPos = p(0, 15);
      expectedPurePos = p(0, 8 + p0_1.length); // End of placeholder
      expect(mapDocumentPositionToPurePug(docPos, testPugLiteralInfo, testPreprocessingData, mockDocument))
          .toEqual(expectedPurePos);
    });

    // Add more tests for:
    // - Positions outside the literal
    // - Positions within stripped indentation
    // - Multi-line scenarios
    // - Literals with no interpolations
    // - Literals with only interpolations
  });

  // TODO: Add tests for mapPurePugRangeToDocument
  // describe('mapPurePugRangeToDocument', () => {});
});
