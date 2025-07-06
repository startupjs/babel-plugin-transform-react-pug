import * as pugLexer from '@startupjs/pug-lexer';
import * as pugParser from 'pug-parser';
import * P speziellen from 'pug-error'; // pug-error uses 'pug-error' not P speziellen
import commonPrefix from 'common-prefix';
import he from 'he'; // For decoding HTML entities if necessary, though Pug usually handles this

import { Diagnostic, Range, Position, DiagnosticSeverity } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument'; // For type reference if needed

// Settings that might affect parsing or behavior
export interface ReactPugSettings {
  classAttribute: string;
}

// Data structure to hold information about JS interpolations
export interface InterpolationMapping {
  placeholder: string;
  originalExpression: string; // Content between ${ and }
  originalRangeInRawLiteral: Range; // Range of the full ${...} in rawPugInLiteral (after base indent, before content indent)
  placeholderRangeInPurePug: Range; // Range of the placeholder in purePugContent
}

// Detailed information about transformations applied during preprocessing
export interface PugPreprocessingData {
  originalRawPugContent: string; // The raw pug content as passed to preprocessPug
  baseIndentationLength: number; // Length of indentation stripped for the whole block first
  contentIndentationLength: number; // Length of common content indentation stripped next
  // Stores mapping for each line from its state after base/content indent stripping to purePugContent
  // Each entry: { originalLine: number, pureLine: number, charOffsetDelta: number (due to interpolations on this line up to a point) }
  // This might be too complex; a segment-based approach is better.

  // Segment-based mapping: Describes parts of rawPug (post-indent) and their purePug counterparts
  segments: Array<{
    type: 'direct' | 'interpolation';
    originalStartOffset: number; // Offset in rawPugContent (after base and content indent stripping)
    originalEndOffset: number;
    purePugStartOffset: number; // Offset in purePugContent
    purePugEndOffset: number;
    interpolation?: InterpolationMapping; // if type is 'interpolation'
  }>;
}


// Output of the preprocessing step
export interface PreprocessedPug {
  purePugContent: string;
  interpolations: InterpolationMapping[]; // Detailed info for each interpolation
  mappingData: PugPreprocessingData; // Data needed for robust position mapping
  parseErrors: Diagnostic[];
}

// Output of the parsing step
export interface ParsedPug extends Omit<PreprocessedPug, 'mappingData'> { // mappingData might not be needed by all consumers of ParsedPug directly
  // We might still want mappingData here if validation/completion needs it to adjust things.
  // For now, let's keep it.
  mappingData: PugPreprocessingData;
  pugAst?: pugParser.Node; // The Pug AST if parsing was successful (or partially successful)
  // Parse errors from pug-parser will be added to `parseErrors`
}


import { Diagnostic, Range, Position, DiagnosticSeverity, CompletionItem, CompletionList, CompletionItemKind, TextEdit, Hover, MarkupContent, MarkupKind } from 'vscode-languageserver/node';

// ... (other imports remain the same)

export interface IReactPugLanguageService {
  preprocessPug(rawPugContent: string, baseIndentation: string, documentUri: string): PreprocessedPug;
  parsePug(preprocessedResult: PreprocessedPug, documentUri: string): ParsedPug;
  doValidation(parsedResult: ParsedPug): Diagnostic[];
  doComplete(parsedResult: ParsedPug, positionInPurePug: Position): CompletionList | null;
  doHover(parsedResult: ParsedPug, positionInPurePug: Position): Hover | null;
}

const INTERPOLATION_PLACEHOLDER_PREFIX = '__RPLS_INTERP_'; // React Pug Language Service Interpolation
// Simple regex for placeholder: __RPLS_INTERP_(\d+)_
const INTERPOLATION_PLACEHOLDER_REGEX = /__RPLS_INTERP_(\d+)_/g;

let interpolationCounter = 0;

function createReactPugLanguageService(settings: ReactPugSettings): IReactPugLanguageService {

  function preprocessPug(rawPugContent: string, baseIndentationString: string, documentUri: string): PreprocessedPug {
    const parseErrors: Diagnostic[] = [];
    interpolationCounter = 0; // Reset for each preprocessing run

    // Stage 1: Indentation Normalization
    // First, remove the base indentation of the pug`` block itself.
    let lines = rawPugContent.split('\n');
    const baseIndentationLength = baseIndentationString.length;

    let contentAfterBaseIndent = lines.map(line => {
        // Only strip baseIndentation if the line actually starts with it.
        // Otherwise, keep the line as is (it might be an empty line or incorrectly indented).
        return line.startsWith(baseIndentationString) ? line.substring(baseIndentationLength) : line;
    }).join('\n');

    // Second, find and remove common leading whitespace from the *content* lines.
    const contentLines = contentAfterBaseIndent.split('\n');
    const nonEmptyContentLines = contentLines.filter(line => line.trim() !== '');
    const commonContentIndent = nonEmptyContentLines.length > 0 ? commonPrefix(nonEmptyContentLines.map(line => /^[ \t]*/.exec(line)?.[0] || '')) : '';
    const contentIndentationLength = commonContentIndent.length;

    let textAfterContentIndentStripping = contentLines.map(line => {
        return line.startsWith(commonContentIndent) ? line.substring(contentIndentationLength) : line;
    }).join('\n');

    // Stage 2: Handle JavaScript Interpolations and Build Segments
    const interpolations: InterpolationMapping[] = [];
    const segments: PugPreprocessingData['segments'] = [];
    let finalPurePugContent = "";
    let lastIndexOriginal = 0; // Tracks position in textAfterContentIndentStripping
    let currentPurePugOffset = 0;

    // Regex to find ${...}. This needs to be robust for nested braces, strings etc.
    // Using a simplified one for now, assuming non-nested simple expressions.
    // A proper JS parser for expressions would be much better.
    const interpolationRegex = /\$\{((?:[^\{\}]|\{[^}]*\})+)\}/g;


    let match;
    while ((match = interpolationRegex.exec(textAfterContentIndentStripping)) !== null) {
      const originalExpression = match[1]; // Content between ${ and }
      const fullMatch = match[0]; // Full ${...}

      // Add direct segment before interpolation
      if (match.index > lastIndexOriginal) {
        const textSegment = textAfterContentIndentStripping.substring(lastIndexOriginal, match.index);
        segments.push({
          type: 'direct',
          originalStartOffset: lastIndexOriginal,
          originalEndOffset: match.index,
          purePugStartOffset: currentPurePugOffset,
          purePugEndOffset: currentPurePugOffset + textSegment.length,
        });
        finalPurePugContent += textSegment;
        currentPurePugOffset += textSegment.length;
      }

      // Handle interpolation
      const placeholder = `${INTERPOLATION_PLACEHOLDER_PREFIX}${interpolationCounter++}_`;
      const originalStartOffsetInPostIndent = match.index;
      const originalEndOffsetInPostIndent = interpolationRegex.lastIndex;

      // For ranges, we need to convert offsets to Line/Character positions
      // This should be done by the caller or a utility, using textAfterContentIndentStripping
      // For now, store offsets. The actual Range objects can be computed later if needed by mapping utilities.
      // Let's assume for `InterpolationMapping` we store offsets for now.
      // TODO: Convert these offsets to Range objects if the interface demands.
      // For simplicity, `originalRangeInRawLiteral` and `placeholderRangeInPurePug` will be simplified.
      const currentInterpolation: InterpolationMapping = {
        placeholder,
        originalExpression,
        // These ranges are placeholders and need accurate calculation based on `textAfterContentIndentStripping`
        originalRangeInRawLiteral: Range.create(0, originalStartOffsetInPostIndent, 0, originalEndOffsetInPostIndent), // Incorrect line
        placeholderRangeInPurePug: Range.create(0, currentPurePugOffset, 0, currentPurePugOffset + placeholder.length) // Incorrect line
      };
      interpolations.push(currentInterpolation);

      segments.push({
        type: 'interpolation',
        originalStartOffset: originalStartOffsetInPostIndent,
        originalEndOffset: originalEndOffsetInPostIndent,
        purePugStartOffset: currentPurePugOffset,
        purePugEndOffset: currentPurePugOffset + placeholder.length,
        interpolation: currentInterpolation
      });
      finalPurePugContent += placeholder;
      currentPurePugOffset += placeholder.length;
      lastIndexOriginal = interpolationRegex.lastIndex;
    }

    // Add remaining direct segment
    if (lastIndexOriginal < textAfterContentIndentStripping.length) {
      const textSegment = textAfterContentIndentStripping.substring(lastIndexOriginal);
      segments.push({
        type: 'direct',
        originalStartOffset: lastIndexOriginal,
        originalEndOffset: textAfterContentIndentStripping.length,
        purePugStartOffset: currentPurePugOffset,
        purePugEndOffset: currentPurePugOffset + textSegment.length,
      });
      finalPurePugContent += textSegment;
    }

    // TODO: Handle unclosed interpolations or other preprocessing errors and add to parseErrors.

    const mappingData: PugPreprocessingData = {
      originalRawPugContent: rawPugContent, // The initial raw content
      baseIndentationLength,
      contentIndentationLength,
      segments
    };

    return {
      purePugContent: finalPurePugContent,
      interpolations,
      mappingData,
      parseErrors,
    };
  }

  function parsePug(preprocessedResult: PreprocessedPug, documentUri: string): ParsedPug {
    const { purePugContent, interpolations, mappingData, parseErrors: existingErrors } = preprocessedResult;
    const combinedErrors: Diagnostic[] = [...existingErrors];
    let pugAst: pugParser.Node | undefined = undefined;

    try {
      const tokens = pugLexer(purePugContent, { filename: documentUri });
      pugAst = pugParser(tokens, { filename: documentUri, src: purePugContent });
    } catch (e: any) { // Explicitly type 'e' as any or unknown then check
      if (e.code && e.msg && typeof e.line !== 'undefined' && typeof e.column !== 'undefined') {
        const line = e.line - 1;
        const column = e.column - 1;
        const severity = e.code?.startsWith('PUG:SYNTAX_ERROR') ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning;

        // Attempt to find the token at the error position to determine its length for a better range
        let errorTokenLength = 1; // Default length
        // This is a simplified way; a more robust way would be to inspect tokens around the error line/col
        // For now, we just use a default length or a small fixed range.
        // const errorLineContent = purePugContent.split('\\n')[line] || "";
        // const offendingTextMatch = errorLineContent.substring(column).match(/^\\S+/);
        // if (offendingTextMatch) {
        //    errorTokenLength = offendingTextMatch[0].length;
        // }

        const range = Range.create(
          Position.create(line, column),
          Position.create(line, column + errorTokenLength)
        );

        combinedErrors.push({
          severity,
          range,
          message: e.msg,
          source: 'Pug Parser'
        });
      } else if (e instanceof Error) {
         combinedErrors.push({
           severity: DiagnosticSeverity.Error,
           range: Range.create(0,0,0,1),
           message: `Pug processing failed: ${e.message}`,
           source: 'React Pug LS'
         });
      } else {
        combinedErrors.push({
          severity: DiagnosticSeverity.Error,
          range: Range.create(0,0,0,1),
          message: `An unknown error occurred during Pug processing.`,
          source: 'React Pug LS'
        });
      }
    }

    return {
      ...preprocessedResult,
      pugAst,
      parseErrors: combinedErrors,
    };
  }

  function doValidation(parsedResult: ParsedPug): Diagnostic[] {
    // For now, validation simply returns any errors found during preprocessing and parsing.
    // Later, this could be expanded to include semantic checks on the Pug AST.
    return parsedResult.parseErrors;
  }

  function doComplete(parsedResult: ParsedPug, positionInPurePug: Position): CompletionList | null {
    // For now, provide a static list of common Pug tags.
    // Later, this can be made context-aware using the `parsedResult.pugAst`
    // and the `positionInPurePug`.

    // Example: If typing at the start of a line or after a space, suggest tags.
    // This is a very simplified context check.
    const lineContentBeforeCursor = parsedResult.purePugContent.split('\\n')[positionInPurePug.line]?.substring(0, positionInPurePug.character);

    if (lineContentBeforeCursor === undefined) return null; // Should not happen if position is valid

    // Only offer completions if at the start of a "word" or line start
    if (lineContentBeforeCursor.match(/(^|\s)$/)) {
      const commonPugTags: CompletionItem[] = [
        { label: 'div', kind: CompletionItemKind.Keyword, detail: 'HTML <div> tag' },
        { label: 'p', kind: CompletionItemKind.Keyword, detail: 'HTML <p> tag' },
        { label: 'span', kind: CompletionItemKind.Keyword, detail: 'HTML <span> tag' },
        { label: 'a', kind: CompletionItemKind.Keyword, detail: 'HTML <a> tag' },
        { label: 'img', kind: CompletionItemKind.Keyword, detail: 'HTML <img> tag' },
        { label: 'ul', kind: CompletionItemKind.Keyword, detail: 'HTML <ul> tag' },
        { label: 'li', kind: CompletionItemKind.Keyword, detail: 'HTML <li> tag' },
        { label: 'h1', kind: CompletionItemKind.Keyword, detail: 'HTML <h1> tag' },
        { label: 'h2', kind: CompletionItemKind.Keyword, detail: 'HTML <h2> tag' },
        { label: 'h3', kind: CompletionItemKind.Keyword, detail: 'HTML <h3> tag' },
        { label: 'button', kind: CompletionItemKind.Keyword, detail: 'HTML <button> tag' },
        { label: 'input', kind: CompletionItemKind.Keyword, detail: 'HTML <input> tag' },
        { label: 'textarea', kind: CompletionItemKind.Keyword, detail: 'HTML <textarea> tag' },
        { label: 'label', kind: CompletionItemKind.Keyword, detail: 'HTML <label> tag' },
        { label: 'form', kind: CompletionItemKind.Keyword, detail: 'HTML <form> tag' },
        { label: 'if', kind: CompletionItemKind.Snippet, detail: 'Pug conditional: if condition' , insertText: 'if ${1:condition}\\n  '},
        { label: 'else if', kind: CompletionItemKind.Snippet, detail: 'Pug conditional: else if condition', insertText: 'else if ${1:condition}\\n  '},
        { label: 'else', kind: CompletionItemKind.Snippet, detail: 'Pug conditional: else', insertText: 'else\\n  '},
        { label: 'each', kind: CompletionItemKind.Snippet, detail: 'Pug loop: each item in items', insertText: 'each ${1:item} in ${2:items}\\n  '},
        { label: 'while', kind: CompletionItemKind.Snippet, detail: 'Pug loop: while condition', insertText: 'while ${1:condition}\\n  '},
        // TODO: Add attributes, mixins, etc. based on context
      ];
      return CompletionList.create(commonPugTags, false); // `isIncomplete` is false for now
    }
    return null;
  }

  return {
    preprocessPug,
    parsePug,
    doValidation,
    doComplete,
    doHover,
  };
}


function getWordAtPosition(text: string, position: Position): { text: string, range: Range } | null {
  const lineText = text.split('\n')[position.line];
  if (!lineText) return null;

  // Regex to find a "word" (alphanumeric + dashes for Pug tags/attributes)
  const wordRegex = /[\w-]+/g;
  let match;
  while ((match = wordRegex.exec(lineText)) !== null) {
    const wordStart = match.index;
    const wordEnd = match.index + match[0].length;
    if (position.character >= wordStart && position.character <= wordEnd) {
      return {
        text: match[0],
        range: Range.create(position.line, wordStart, position.line, wordEnd)
      };
    }
  }
  return null;
}

// Basic Hover implementation
function doHover(parsedResult: ParsedPug, positionInPurePug: Position): Hover | null {
  const { purePugContent, pugAst } = parsedResult;

  const wordInfo = getWordAtPosition(purePugContent, positionInPurePug);
  if (!wordInfo) return null;

  const { text: word, range: wordRange } = wordInfo;

  // Simple check for common Pug tags
  const commonTags = ['div', 'p', 'span', 'a', 'img', 'ul', 'li', 'h1', 'h2', 'h3', 'button', 'input', 'textarea', 'label', 'form'];
  if (commonTags.includes(word)) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**Pug Tag:** \`${word}\`\n\nStandard HTML element.`
      },
      range: wordRange // Range is relative to purePugContent
    };
  }

  // Simple check for Pug directives
  const directives = ['if', 'else if', 'else', 'each', 'while', 'case', 'when', 'default', 'mixin', 'block', 'extends', 'include'];
  if (directives.includes(word)) {
     return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**Pug Directive:** \`${word}\``
      },
      range: wordRange
    };
  }

  // TODO: More advanced hover by inspecting pugAst at the given position.
  // For example, show attribute info, variable types (if type info is available), mixin details.

  // Check if hovering over an interpolation placeholder
  for (const interp of parsedResult.interpolations) {
    // This check needs placeholderRangeInPurePug to be accurate Line/Char Range
    // For now, let's assume it's a simple text match if the placeholder is the word.
    if (word === interp.placeholder) {
       return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**JavaScript Interpolation:**\n\`\`\`javascript\n${interp.originalExpression}\n\`\`\``
        },
        // The range should ideally be interp.placeholderRangeInPurePug
        // If wordRange matches this, it's good.
        range: wordRange
      };
    }
  }


  return null;
}

// Export the factory
export { createReactPugLanguageService };
