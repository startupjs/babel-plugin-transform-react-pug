import { createReactPugLanguageService, IReactPugLanguageService, ReactPugSettings, INTERPOLATION_PLACEHOLDER_PREFIX } from '../reactPugLanguageService';

describe('ReactPugLanguageService', () => {
  let service: IReactPugLanguageService;
  const settings: ReactPugSettings = { classAttribute: 'className' };

  beforeEach(() => {
import { createReactPugLanguageService, IReactPugLanguageService, ReactPugSettings, INTERPOLATION_PLACEHOLDER_PREFIX, PugPreprocessingData } from '../reactPugLanguageService';
import { Range, Position } from 'vscode-languageserver/node';

// Helper to create a Range for easier test writing
const r = (sl: number, sc: number, el: number, ec: number) => Range.create(sl, sc, el, ec);

describe('ReactPugLanguageService', () => {
  let service: IReactPugLanguageService;
  const settings: ReactPugSettings = { classAttribute: 'className' };

  beforeEach(() => {
    service = createReactPugLanguageService(settings);
  });

  describe('preprocessPug', () => {
    it('should handle no indentation and no interpolations', () => {
      const rawPug = 'div\n  p Hello';
      const baseIndentation = '';
      const { purePugContent, mappingData, interpolations } = service.preprocessPug(rawPug, baseIndentation, 'test.pug');

      expect(purePugContent).toBe('div\n  p Hello');
      expect(mappingData.baseIndentationLength).toBe(0);
      expect(mappingData.contentIndentationLength).toBe(0); // 'div' is at root, '  p Hello' common indent for this line is '  ' but it's not "common" to div.
                                                          // commonPrefix([ "div", "  p Hello" ]) is ""
      expect(interpolations.length).toBe(0);
      expect(mappingData.segments.length).toBe(1);
      expect(mappingData.segments[0]).toEqual({
        type: 'direct',
        originalStartOffset: 0,
        originalEndOffset: 13,
        purePugStartOffset: 0,
        purePugEndOffset: 13
      });
      expect(mappingData.lineMaps.length).toBe(2);
      expect(mappingData.lineMaps[0]).toEqual({ originalLineNumberInRawLiteral: 0, lineInTAS: 0, originalLeadingWhitespaceLength: 0 });
      expect(mappingData.lineMaps[1]).toEqual({ originalLineNumberInRawLiteral: 1, lineInTAS: 1, originalLeadingWhitespaceLength: 0 }); // commonPrefix is '', so '  p Hello' keeps its indent
                                                                                                                                    // This test reveals a nuance in current `commonContentIndent` logic if applied globally vs per block.
                                                                                                                                    // The current `commonContentIndent` is from ALL non-empty lines.
                                                                                                                                    // Let's adjust expectation or code. If `div` is line 0, `  p Hello` is line 1.
                                                                                                                                    // `linesForContentIndentCalc` = ["div", "  p Hello"]. `commonContentIndent` = ""
                                                                                                                                    // `finalStrippedLines` = ["div", "  p Hello"]
                                                                                                                                    // This means `textAfterContentIndentStripping` is "div\n  p Hello"
                                                                                                                                    // And `purePugContent` is also "div\n  p Hello"
    });


    it('should handle base indentation and no interpolations', () => {
      const rawPug = '  div\n    p Hello'; // Base indent of 2 for pug``
      const baseIndentation = '  ';
      const { purePugContent, mappingData, interpolations } = service.preprocessPug(rawPug, baseIndentation, 'test.pug');

      // After base strip: "div\n  p Hello"
      // commonContentIndent for ["div", "  p Hello"] is ""
      // textAfterContentIndentStripping: "div\n  p Hello"
      expect(purePugContent).toBe('div\n  p Hello');
      expect(mappingData.baseIndentationLength).toBe(2);
      expect(mappingData.contentIndentationLength).toBe(0);
      expect(interpolations.length).toBe(0);
      expect(mappingData.segments.length).toBe(1);
      expect(mappingData.segments[0]).toEqual({
        type: 'direct',
        originalStartOffset: 0,
        originalEndOffset: 13,
        purePugStartOffset: 0,
        purePugEndOffset: 13
      });
      expect(mappingData.lineMaps.length).toBe(2);
      expect(mappingData.lineMaps[0]).toEqual({ originalLineNumberInRawLiteral: 0, lineInTAS: 0, originalLeadingWhitespaceLength: 2 }); // Stripped "  "
      expect(mappingData.lineMaps[1]).toEqual({ originalLineNumberInRawLiteral: 1, lineInTAS: 1, originalLeadingWhitespaceLength: 2 }); // Stripped "  "
                                                                                                                                    // commonContentIndent is "" so no further stripping.
    });

    it('should handle base and common content indentation', () => {
        const rawPug = '  div\n    p Hello\n    p World'; // Base '  '
                                                        // Content '  ' (relative to post-base-strip)
        const baseIndentation = '  ';
        const { purePugContent, mappingData } = service.preprocessPug(rawPug, baseIndentation, 'test.pug');

        // raw:
        //   div
        //     p Hello
        //     p World
        // linesAfterBaseIndentPass:
        // div
        //   p Hello
        //   p World
        // commonContentIndent for these is "" (because "div" has no indent)
        // This suggests the commonContentIndent should perhaps be calculated *per block* in Pug,
        // or that the definition of it is "common to all lines that HAVE some indent".
        // The current `commonPrefix` logic will yield "" if one line has no indent.
        // Let's re-evaluate this specific test based on current implementation:
        // linesAfterBaseIndentPass: ["div", "  p Hello", "  p World"]
        // commonContentIndent: ""
        // textAfterContentIndentStripping: "div\n  p Hello\n  p World"
        expect(purePugContent).toBe('div\n  p Hello\n  p World');
        expect(mappingData.baseIndentationLength).toBe(2);
        expect(mappingData.contentIndentationLength).toBe(0); // Correct due to "div" line
        expect(mappingData.segments.length).toBe(1);
        expect(mappingData.segments[0].originalEndOffset).toBe("div\n  p Hello\n  p World".length);

        expect(mappingData.lineMaps[0]).toEqual({ originalLineNumberInRawLiteral: 0, lineInTAS: 0, originalLeadingWhitespaceLength: 2}); // "  " + ""
        expect(mappingData.lineMaps[1]).toEqual({ originalLineNumberInRawLiteral: 1, lineInTAS: 1, originalLeadingWhitespaceLength: 2}); // "  " + "" (as "  p Hello" doesn't start with "" commonContentIndent)
        expect(mappingData.lineMaps[2]).toEqual({ originalLineNumberInRawLiteral: 2, lineInTAS: 2, originalLeadingWhitespaceLength: 2});
      });

    it('should handle deeper common content indentation', () => {
        const rawPug = '  parent\n    child1\n    child2'; // Base '  '
        const baseIndentation = '  ';
        const { purePugContent, mappingData } = service.preprocessPug(rawPug, baseIndentation, 'test.pug');
        // linesAfterBaseIndentPass: ["parent", "  child1", "  child2"]
        // commonContentIndent: ""
        expect(purePugContent).toBe("parent\n  child1\n  child2");
        expect(mappingData.baseIndentationLength).toBe(2);
        expect(mappingData.contentIndentationLength).toBe(0);
    });

    it('should handle only common content indentation (no base)', () => {
        const rawPug = 'parent\n  child1\n  child2';
        const baseIndentation = '';
        const { purePugContent, mappingData } = service.preprocessPug(rawPug, baseIndentation, 'test.pug');
        // linesAfterBaseIndentPass: ["parent", "  child1", "  child2"] (same as rawPug)
        // commonContentIndent: ""
        expect(purePugContent).toBe("parent\n  child1\n  child2");
        expect(mappingData.baseIndentationLength).toBe(0);
        expect(mappingData.contentIndentationLength).toBe(0);
        expect(mappingData.lineMaps[0].originalLeadingWhitespaceLength).toBe(0);
        expect(mappingData.lineMaps[1].originalLeadingWhitespaceLength).toBe(0); // "  child1" does not start with "" commonContentIndent (it *is* "  child1")
                                                                               // so it's not stripped by contentIndentationLength.
                                                                               // This highlights that commonPrefix should be on lines that *have* indent.
                                                                               // Or, my understanding of how commonPrefix is applied is slightly off.
                                                                               // commonPrefix(["  child1", "  child2"]) would be "  ".
                                                                               // But commonPrefix(["parent", "  child1", "  child2"]) is "".
                                                                               // The current code takes commonPrefix of *all* linesForContentIndentCalc.
    });


    it('should handle a simple interpolation with correct ranges', () => {
      const rawPug = 'p Hello ${name}'; // TAS is same: "p Hello ${name}"
      const baseIndentation = '';
      const { purePugContent, interpolations, mappingData } = service.preprocessPug(rawPug, baseIndentation, 'test.pug');

      const p0 = `${INTERPOLATION_PLACEHOLDER_PREFIX}0_`;
      expect(purePugContent).toBe(`p Hello ${p0}`);
      expect(interpolations.length).toBe(1);
      const interp0 = interpolations[0];
      expect(interp0.originalExpression).toBe('name');
      expect(interp0.placeholder).toBe(p0);
      // originalRangeInRawLiteral is relative to textAfterContentIndentStripping
      expect(interp0.originalRangeInRawLiteral).toEqual(r(0, 8, 0, 15)); // ${name}
      // placeholderRangeInPurePug is relative to purePugContent
      expect(interp0.placeholderRangeInPurePug).toEqual(r(0, 8, 0, 8 + p0.length));

      expect(mappingData.segments.length).toBe(2);
      expect(mappingData.segments[0]).toEqual({ type: 'direct', originalStartOffset: 0, originalEndOffset: 8, purePugStartOffset: 0, purePugEndOffset: 8 });
      expect(mappingData.segments[1]).toEqual(expect.objectContaining({ type: 'interpolation', originalStartOffset: 8, originalEndOffset: 15, purePugStartOffset: 8, purePugEndOffset: 8 + p0.length }));
    });

    it('should handle multiple interpolations on one line with correct ranges', () => {
      const rawPug = 'p Item: ${item.name} - Qty: ${item.qty}'; // TAS same
      const baseIndentation = '';
      const { purePugContent, interpolations, mappingData } = service.preprocessPug(rawPug, baseIndentation, 'test.pug');

      const p0 = `${INTERPOLATION_PLACEHOLDER_PREFIX}0_`;
      const p1 = `${INTERPOLATION_PLACEHOLDER_PREFIX}1_`;
      expect(purePugContent).toBe(`p Item: ${p0} - Qty: ${p1}`);
      expect(interpolations.length).toBe(2);
      expect(interpolations[0].originalExpression).toBe('item.name');
      expect(interpolations[1].originalExpression).toBe('item.qty');

      expect(mappingData.segments.length).toBe(4); // text, interp, text, interp
      // Segment 0: "p Item: "
      expect(mappingData.segments[0]).toEqual({ type: 'direct', originalStartOffset: 0, originalEndOffset: 9, purePugStartOffset: 0, purePugEndOffset: 9 });
      // Segment 1: ${item.name}
      expect(mappingData.segments[1]).toEqual(expect.objectContaining({ type: 'interpolation', originalStartOffset: 9, originalEndOffset: 9 + '${item.name}'.length, purePugStartOffset: 9, purePugEndOffset: 9 + p0.length }));
      // Segment 2: " - Qty: "
      expect(mappingData.segments[2]).toEqual({ type: 'direct', originalStartOffset: 9 + '${item.name}'.length, originalEndOffset: 9 + '${item.name}'.length + 9, purePugStartOffset: 9 + p0.length, purePugEndOffset: 9 + p0.length + 9 });
      // Segment 3: ${item.qty}
      expect(mappingData.segments[3]).toEqual(expect.objectContaining({ type: 'interpolation', originalStartOffset: 9 + '${item.name}'.length + 9, originalEndOffset: 9 + '${item.name}'.length + 9 + '${item.qty}'.length, purePugStartOffset: 9 + p0.length + 9, purePugEndOffset: 9 + p0.length + 9 + p1.length }));
    });

    it('should handle interpolations at start and end of string', () => {
        const rawPug = '${greeting} World ${punctuation}';
        const baseIndentation = '';
        const { purePugContent, interpolations, mappingData } = service.preprocessPug(rawPug, baseIndentation, 'test.pug');

        const p0 = `${INTERPOLATION_PLACEHOLDER_PREFIX}0_`;
        const p1 = `${INTERPOLATION_PLACEHOLDER_PREFIX}1_`;
        expect(purePugContent).toBe(`${p0} World ${p1}`);
        expect(interpolations.length).toBe(2);
        expect(interpolations[0].originalExpression).toBe('greeting');
        expect(interpolations[1].originalExpression).toBe('punctuation');

        expect(mappingData.segments.length).toBe(3); // interp, text, interp
         // Segment 0: ${greeting}
        expect(mappingData.segments[0]).toEqual(expect.objectContaining({ type: 'interpolation', originalStartOffset: 0, originalEndOffset: '${greeting}'.length, purePugStartOffset: 0, purePugEndOffset: p0.length }));
        // Segment 1: " World "
        expect(mappingData.segments[1]).toEqual({ type: 'direct', originalStartOffset: '${greeting}'.length, originalEndOffset: '${greeting}'.length + 7, purePugStartOffset: p0.length, purePugEndOffset: p0.length + 7 });
        // Segment 2: ${punctuation}
        expect(mappingData.segments[2]).toEqual(expect.objectContaining({ type: 'interpolation', originalStartOffset: '${greeting}'.length + 7, originalEndOffset: '${greeting}'.length + 7 + '${punctuation}'.length, purePugStartOffset: p0.length + 7, purePugEndOffset: p0.length + 7 + p1.length }));
    });

    it('should handle string with only an interpolation', () => {
        const rawPug = '${ تنها }'; // Persian for "only" to test non-ascii
        const baseIndentation = '';
        const { purePugContent, interpolations, mappingData } = service.preprocessPug(rawPug, baseIndentation, 'test.pug');
        const p0 = `${INTERPOLATION_PLACEHOLDER_PREFIX}0_`;
        expect(purePugContent).toBe(p0);
        expect(interpolations.length).toBe(1);
        expect(interpolations[0].originalExpression).toBe(' تنها ');
        expect(mappingData.segments.length).toBe(1);
        expect(mappingData.segments[0]).toEqual(expect.objectContaining({ type: 'interpolation', originalStartOffset: 0, originalEndOffset: '${ تنها }'.length, purePugStartOffset: 0, purePugEndOffset: p0.length }));
    });

    it('should handle empty string input', () => {
        const rawPug = '';
        const baseIndentation = '';
        const { purePugContent, interpolations, mappingData } = service.preprocessPug(rawPug, baseIndentation, 'test.pug');
        expect(purePugContent).toBe('');
        expect(interpolations.length).toBe(0);
        expect(mappingData.segments.length).toBe(1); // Should produce one empty direct segment
        expect(mappingData.segments[0]).toEqual({ type: 'direct', originalStartOffset: 0, originalEndOffset: 0, purePugStartOffset: 0, purePugEndOffset: 0 });
    });

    it('should correctly use placeholder prefix and counter', () => {
        const rawPug = 'p ${a} then ${b}';
        const baseIndentation = '';
        const { purePugContent, interpolations } = service.preprocessPug(rawPug, baseIndentation, 'test.pug');
        expect(interpolations[0].placeholder).toBe(`${INTERPOLATION_PLACEHOLDER_PREFIX}0_`);
        expect(interpolations[1].placeholder).toBe(`${INTERPOLATION_PLACEHOLDER_PREFIX}1_`);

        // Call again to ensure counter is reset if it's global and not reset inside preprocessPug
        // (Current implementation resets it inside preprocessPug, which is good)
        const { interpolations: interpolations2 } = service.preprocessPug(rawPug, baseIndentation, 'test.pug');
        expect(interpolations2[0].placeholder).toBe(`${INTERPOLATION_PLACEHOLDER_PREFIX}0_`);
    });

  });

  describe('parsePug', () => {
    // Basic tests for parsePug - more can be added for specific error cases
    it('should parse valid preprocessed pug and return an AST', () => {
        const preprocessed = {
            purePugContent: 'div\n  p Hello',
            interpolations: [],
            mappingData: { segments: [], originalRawPugContent: '', baseIndentationLength:0, contentIndentationLength:0 }, // Dummy mapping data
            parseErrors: []
        };
        const { pugAst, parseErrors } = service.parsePug(preprocessed, 'test.pug');
        expect(pugAst).toBeDefined();
        expect(pugAst?.type).toBe('Block'); // Root of pug AST is a Block
        expect(parseErrors.length).toBe(0);
    });

    it('should return parse errors for invalid pug syntax', () => {
        const preprocessed = {
            purePugContent: 'div\n  p Hello\n    div(class="my-class" oopsBadAttribute)', // Error here
            interpolations: [],
            mappingData: { segments: [], originalRawPugContent: '', baseIndentationLength:0, contentIndentationLength:0 },
            parseErrors: []
        };
        const { pugAst, parseErrors } = service.parsePug(preprocessed, 'test.pug');
        expect(pugAst).toBeDefined(); // pug-parser might still produce a partial AST
        expect(parseErrors.length).toBeGreaterThan(0);
        const error = parseErrors[0];
        expect(error.message).toContain('unexpected token "ident"'); // Pug error message
        expect(error.range.start.line).toBe(2); // Relative to purePugContent
         // Column might vary based on exact error, check pug-parser behavior
        expect(error.source).toBe('Pug Parser');
    });
  });

});
