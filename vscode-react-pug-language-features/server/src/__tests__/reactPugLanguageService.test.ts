import { createReactPugLanguageService, IReactPugLanguageService, ReactPugSettings, INTERPOLATION_PLACEHOLDER_PREFIX } from '../reactPugLanguageService';

describe('ReactPugLanguageService', () => {
  let service: IReactPugLanguageService;
  const settings: ReactPugSettings = { classAttribute: 'className' };

  beforeEach(() => {
    service = createReactPugLanguageService(settings);
    // Reset interpolation counter if it's global in the service module, for consistent placeholder names
    // This depends on how interpolationCounter is scoped in the actual service file.
    // If it's internal to preprocessPug or reset there, this might not be needed here.
    // For now, assuming it's reset within preprocessPug as per previous implementation.
  });

  describe('preprocessPug', () => {
    it('should handle basic indentation and no interpolations', () => {
      const rawPug = '  div\n    p Hello';
      const baseIndentation = '  '; // Indentation of the pug`` line itself
      const { purePugContent, mappingData, interpolations } = service.preprocessPug(rawPug, baseIndentation, 'test.pug');

      expect(purePugContent).toBe('div\n  p Hello'); // commonContentIndent is '  ' for the 'p' line
      expect(mappingData.baseIndentationLength).toBe(2);
      expect(mappingData.contentIndentationLength).toBe(0); // Because 'div' has no further indent, common is empty for the block
      expect(interpolations.length).toBe(0);
      expect(mappingData.segments.length).toBe(1);
      expect(mappingData.segments[0]).toEqual({
        type: 'direct',
        originalStartOffset: 0, // Offset in 'div\n  p Hello' (after base and content indent strip)
        originalEndOffset: 13,  // Length of 'div\n  p Hello'
        purePugStartOffset: 0,
        purePugEndOffset: 13
      });
    });

    it('should handle contentIndentation correctly', () => {
        const rawPug = '  div\n    p Hello\n    p World';
        const baseIndentation = '  ';
        const { purePugContent, mappingData } = service.preprocessPug(rawPug, baseIndentation, 'test.pug');

        // Expected: base '  ' stripped. Then common content indent for 'p Hello' and 'p World' is '  '.
        // div
        // p Hello  (from '    p Hello' after base strip -> '  p Hello', then content strip -> 'p Hello')
        // p World
        expect(purePugContent).toBe('div\np Hello\np World');
        expect(mappingData.baseIndentationLength).toBe(2);
        expect(mappingData.contentIndentationLength).toBe(2);
        expect(mappingData.segments.length).toBe(1);
        expect(mappingData.segments[0]).toEqual({
            type: 'direct',
            originalStartOffset: 0, // Offset in the string after base AND content indent are conceptually stripped
            originalEndOffset: 19,  // Length of "div\np Hello\np World"
            purePugStartOffset: 0,
            purePugEndOffset: 19
          });
      });

    it('should handle a simple interpolation', () => {
      const rawPug = 'p Hello ${name}';
      const baseIndentation = '';
      const { purePugContent, interpolations, mappingData } = service.preprocessPug(rawPug, baseIndentation, 'test.pug');

      const expectedPlaceholder = `${INTERPOLATION_PLACEHOLDER_PREFIX}0_`;
      expect(purePugContent).toBe(`p Hello ${expectedPlaceholder}`);
      expect(interpolations.length).toBe(1);
      expect(interpolations[0].originalExpression).toBe('name');
      expect(interpolations[0].placeholder).toBe(expectedPlaceholder);

      expect(mappingData.segments.length).toBe(2); // "p Hello " and placeholder
      expect(mappingData.segments[0]).toEqual({ // "p Hello "
        type: 'direct',
        originalStartOffset: 0,
        originalEndOffset: 8, // "p Hello ".length
        purePugStartOffset: 0,
        purePugEndOffset: 8
      });
      expect(mappingData.segments[1]).toEqual(expect.objectContaining({
        type: 'interpolation',
        originalStartOffset: 8, // Start of ${name} in "p Hello ${name}"
        originalEndOffset: 8 + '${name}'.length,
        purePugStartOffset: 8, // After "p Hello "
        purePugEndOffset: 8 + expectedPlaceholder.length,
        interpolation: expect.objectContaining({ placeholder: expectedPlaceholder, originalExpression: 'name' })
      }));
    });

    it('should handle multiple interpolations on one line', () => {
      const rawPug = 'p Item: ${item.name} - Qty: ${item.qty}';
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
