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
  originalRawPugContent: string;
  baseIndentationLength: number;
  contentIndentationLength: number;
  textAfterContentIndentStripping: string; // Store this intermediate string explicitly
  lineMaps: Array<{
    originalLineNumberInRawLiteral: number; // 0-indexed line in rawPugContent (the block from the editor)
    lineInTAS: number; // 0-indexed line in textAfterContentIndentStripping
    originalLeadingWhitespaceLength: number; // Total whitespace stripped (base + content) for this line
    // lengthOfLineInTAS: number; // Length of this line in textAfterContentIndentStripping
  }>;
  segments: Array<{
    type: 'direct' | 'interpolation';
    originalStartOffset: number; // Offset in textAfterContentIndentStripping
    originalEndOffset: number;   // Offset in textAfterContentIndentStripping
    purePugStartOffset: number;
    purePugEndOffset: number;
    interpolation?: InterpolationMapping;
  }>;
}


// Output of the preprocessing step
export interface PreprocessedPug {
  purePugContent: string;
  interpolations: InterpolationMapping[];
  mappingData: PugPreprocessingData;
  parseErrors: Diagnostic[];
}

// Output of the parsing step
export interface ParsedPug extends PreprocessedPug { // Keep mappingData for now
  pugAst?: pugParser.Node; // The Pug AST if parsing was successful (or partially successful)
  // Parse errors from pug-parser will be added to `parseErrors`
}


import { Diagnostic, Range, Position, DiagnosticSeverity, CompletionItem, CompletionList, CompletionItemKind, TextEdit, Hover, MarkupContent, MarkupKind } from 'vscode-languageserver/node';

import { Diagnostic, Range, Position, DiagnosticSeverity, CompletionItem, CompletionList, CompletionItemKind, TextEdit, Hover, MarkupContent, MarkupKind } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as pugLexer from '@startupjs/pug-lexer';
import * as pugParser from 'pug-parser';
// import P speziellen from 'pug-error'; // Corrected import name if this was intended, or remove if not used directly
import commonPrefix from 'common-prefix';
// import he from 'he'; // Not actively used yet

import { offsetToPosition } from './utils/textPositions'; // Import the new helper

// ... (other interface definitions remain the same)


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
    interpolationCounter = 0;
    const lineMaps: PugPreprocessingData['lineMaps'] = [];

    // Stage 1: Indentation Normalization & Line Mapping
    const originalLines = rawPugContent.split('\n');
    const baseIndentationLength = baseIndentationString.length;

    const linesAfterBaseIndent: string[] = [];
    originalLines.forEach((line, index) => {
      if (line.startsWith(baseIndentationString)) {
        linesAfterBaseIndent.push(line.substring(baseIndentationLength));
      } else if (line.trim() === '') { // Keep empty lines as they are (don't strip base from them if they don't have it)
        linesAfterBaseIndent.push(line);
      } else { // Line doesn't have base indent but isn't empty - could be an error or mixed indent
        linesAfterBaseIndent.push(line);
        // Consider adding a diagnostic here for inconsistent base indentation if strictness is desired
      }
    });

    const nonEmptyContentLines = linesAfterBaseIndent.filter(line => line.trim() !== '');
    const commonContentIndent = nonEmptyContentLines.length > 0 ? commonPrefix(nonEmptyContentLines.map(line => /^[ \t]*/.exec(line)?.[0] || '')) : '';
    const contentIndentationLength = commonContentIndent.length;

    const finalStrippedLines: string[] = [];
    linesAfterBaseIndent.forEach((line, originalLineIndexOffset) => { // originalLineIndexOffset is line in linesAfterBaseIndent
        let strippedLine = line;
        let currentLineOriginalWSLength = 0;

        if (line.startsWith(baseIndentationString)) { // This check is on originalLines logic, effectively
            currentLineOriginalWSLength += baseIndentationLength;
        }

        if (line.startsWith(commonContentIndent)) { // This check is on line from linesAfterBaseIndent
            strippedLine = line.substring(contentIndentationLength);
            currentLineOriginalWSLength += contentIndentationLength;
            // Note: This assumes commonContentIndent is *additional* to baseIndentation for lines that had both.
            // If commonContentIndent *includes* baseIndentation, logic would differ.
            // The current commonPrefix is on lines *after* base was stripped, so this is additive.
        } else if (line.trim() !== '' && contentIndentationLength > 0) {
             // Line does not have the common content indent but is not empty.
             // This might be an inconsistent indentation within the block.
             // For mapping, we treat it as if no *content* indent was stripped from this specific line.
        }
        finalStrippedLines.push(strippedLine);
        lineMaps.push({
            originalLineNumberInRawLiteral: originalLineIndexOffset, // This is line in rawPugContent passed to function
            lineInTAS: originalLineIndexOffset, // Line number is preserved till interpolation stage
            originalLeadingWhitespaceLength: currentLineOriginalWSLength, // Total stripped for *this* line
        });
    });
    const textAfterContentIndentStripping = finalStrippedLines.join('\n');

    // Stage 2: Handle JavaScript Interpolations and Build Segments
    const interpolations: InterpolationMapping[] = [];
    const segments: PugPreprocessingData['segments'] = [];
    let finalPurePugContent = "";
    let lastIndexOriginalTAS = 0; // Tracks position in textAfterContentIndentStripping
    let currentPurePugOffset = 0;

    const interpolationRegex = /\$\{((?:[^\{\}]|\{[^}]*\})+)\}/g; // Simplified regex

    let match;
    while ((match = interpolationRegex.exec(textAfterContentIndentStripping)) !== null) {
      const originalExpression = match[1];

      if (match.index > lastIndexOriginalTAS) {
        const textSegment = textAfterContentIndentStripping.substring(lastIndexOriginalTAS, match.index);
        segments.push({
          type: 'direct',
          originalStartOffset: lastIndexOriginalTAS,
          originalEndOffset: match.index,
          purePugStartOffset: currentPurePugOffset,
          purePugEndOffset: currentPurePugOffset + textSegment.length,
        });
        finalPurePugContent += textSegment;
        currentPurePugOffset += textSegment.length;
      }

      const placeholder = `${INTERPOLATION_PLACEHOLDER_PREFIX}${interpolationCounter++}_`;
      const originalStartOffsetInTAS = match.index;
      const originalEndOffsetInTAS = interpolationRegex.lastIndex;

      const currentInterpolation: InterpolationMapping = {
        placeholder,
        originalExpression,
        originalRangeInRawLiteral: Range.create( // This range is in textAfterContentIndentStripping coordinates
          offsetToPosition(textAfterContentIndentStripping, originalStartOffsetInTAS),
          offsetToPosition(textAfterContentIndentStripping, originalEndOffsetInTAS)
        ),
        placeholderRangeInPurePug: Range.create(
          offsetToPosition(finalPurePugContent, currentPurePugOffset),
          offsetToPosition(finalPurePugContent + placeholder, currentPurePugOffset + placeholder.length)
        )
      };
      interpolations.push(currentInterpolation);

      segments.push({
        type: 'interpolation',
        originalStartOffset: originalStartOffsetInTAS,
        originalEndOffset: originalEndOffsetInTAS,
        purePugStartOffset: currentPurePugOffset,
        purePugEndOffset: currentPurePugOffset + placeholder.length,
        interpolation: currentInterpolation
      });
      finalPurePugContent += placeholder;
      currentPurePugOffset += placeholder.length;
      lastIndexOriginalTAS = interpolationRegex.lastIndex;
    }

    if (lastIndexOriginalTAS < textAfterContentIndentStripping.length) {
      const textSegment = textAfterContentIndentStripping.substring(lastIndexOriginalTAS);
      segments.push({
        type: 'direct',
        originalStartOffset: lastIndexOriginalTAS,
        originalEndOffset: textAfterContentIndentStripping.length,
        purePugStartOffset: currentPurePugOffset,
        purePugEndOffset: currentPurePugOffset + textSegment.length,
      });
      finalPurePugContent += textSegment;
    }

    const mappingData: PugPreprocessingData = {
      originalRawPugContent: rawPugContent,
      baseIndentationLength,
      contentIndentationLength,
      textAfterContentIndentStripping, // Store this
      lineMaps, // Store this
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
    const { purePugContent, pugAst } = parsedResult;
    const items: CompletionItem[] = [];

    // Get text on the current line up to the cursor
    const currentLine = purePugContent.split('\n')[positionInPurePug.line] || "";
    const linePrefix = currentLine.substring(0, positionInPurePug.character);

    // Simplistic context checking for attribute completion
    // e.g., "div(" or "input(" or "div(type="text" " <-- space after an attribute
    const attributeContextMatch = linePrefix.match(/([\w-]+)\s*\(\s*([\w-]+\s*=\s*("[^"]*"|'[^']*'|[\w-]+)\s*,\s*)*([\w-]*)$/);
    // थोड़ा और बेहतर Context check: tagName(attr1="val1", attr2=val2, partialAttr <-- here
    const betterAttributeContextMatch = linePrefix.match(/([\w-]+)\s*\(([^)]*)$/);


    if (betterAttributeContextMatch) {
        const tagName = betterAttributeContextMatch[1];
        const existingAttrsString = betterAttributeContextMatch[2];
        const charAfterLastAttr = existingAttrsString.match(/,\s*$/) || existingAttrsString.trim() === '' || existingAttrsString.endsWith('(');

        // Only suggest attributes if we are clearly in the attribute list parentheses
        // and either at the start, or after a comma and optional space.
        if (charAfterLastAttr || existingAttrsString.match(/[\w-]$/)) { // also if typing an attribute name
            // Common HTML attributes (very basic list)
            const commonAttributes: CompletionItem[] = [
                { label: 'id', kind: CompletionItemKind.Property, detail: 'Specifies a unique id for an element' },
                { label: 'class', kind: CompletionItemKind.Property, detail: 'Specifies one or more classnames for an element' },
                { label: 'style', kind: CompletionItemKind.Property, detail: 'Specifies an inline CSS style for an element' },
                { label: 'title', kind: CompletionItemKind.Property, detail: 'Specifies extra information about an element' },
            ];
            // Tag-specific attributes (example for 'input')
            const inputAttributes: CompletionItem[] = [
                { label: 'type', kind: CompletionItemKind.Property, detail: 'Specifies the type of an <input> element' },
                { label: 'value', kind: CompletionItemKind.Property, detail: 'Specifies the value of an <input> element' },
                { label: 'placeholder', kind: CompletionItemKind.Property, detail: 'Specifies a short hint that describes the expected value of an input field' },
                { label: 'name', kind: CompletionItemKind.Property, detail: 'Specifies the name of an <input> element' },
            ];

            items.push(...commonAttributes);
            if (tagName === 'input') {
                items.push(...inputAttributes);
            }
            // TODO: Prevent suggesting already existing attributes.
        }
    }

    // Offer tag completions if at the start of a "word" or line start, and not in attribute context
    if (linePrefix.match(/(^|\s)([\w-]*)$/) && !betterAttributeContextMatch) {
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
        { label: 'if', kind: CompletionItemKind.Snippet, detail: 'Pug conditional: if condition' , insertText: 'if ${1:condition}\n  '},
        { label: 'else if', kind: CompletionItemKind.Snippet, detail: 'Pug conditional: else if condition', insertText: 'else if ${1:condition}\n  '},
        { label: 'else', kind: CompletionItemKind.Snippet, detail: 'Pug conditional: else', insertText: 'else\n  '},
        { label: 'each', kind: CompletionItemKind.Snippet, detail: 'Pug loop: each item in items', insertText: 'each ${1:item} in ${2:items}\n  '},
        { label: 'while', kind: CompletionItemKind.Snippet, detail: 'Pug loop: while condition', insertText: 'while ${1:condition}\n  '},
      ];
      items.push(...commonPugTags);
    }

    // If items have been added, return them, otherwise null.
    return items.length > 0 ? CompletionList.create(items, false) : null;
  }

  // Helper to find AST node at a given offset
  // This is a very basic version. A more robust one would handle nested structures better.
  function findPugNodeAtOffset(ast: pugParser.Node | undefined, offset: number): pugParser.Node | null {
    if (!ast) return null;

    let foundNode: pugParser.Node | null = null;

    function walk(node: pugParser.Node) {
      // Check if node.line and node.column exist and are numbers
      // The pug-parser AST nodes don't have direct offset or end line/column.
      // This makes precise node finding by offset difficult without pre-calculating ranges for all nodes.
      // For now, this function is a placeholder for a more complex AST traversal.
      // A simple strategy: if a Tag node's line matches, and its name is at/before the column.
      // This won't work well for finding attributes or content.

      // Placeholder for a more advanced AST lookup.
      // For a Tag node, its `line` and `column` refer to the start of the tag name.
      if (node.type === 'Tag' && typeof node.line === 'number' && typeof node.column === 'number') {
         // This is a very rough check
         // We need to convert positionInPurePug to an offset to compare with a conceptual node offset
      }

      if (node.type === 'Block' && node.nodes) {
        for (const child of node.nodes) {
          walk(child);
          if (foundNode) return; // Stop if found
        }
      }
      // For Tag nodes, also check attrs and block
      if (node.type === 'Tag') {
        if (node.attrs) {
            // node.attrs is an array of {name, val, line, column, mustEscape}
            // Need to check these too
        }
        if (node.block) {
          walk(node.block);
          if (foundNode) return;
        }
      }
    }
    // walk(ast); // Disabled for now as it's not effective yet
    return foundNode;
  }


  function doHover(parsedResult: ParsedPug, positionInPurePug: Position): Hover | null {
    const { purePugContent, pugAst, interpolations } = parsedResult;

    const wordInfo = getWordAtPosition(purePugContent, positionInPurePug);
    if (!wordInfo) return null;

    const { text: word, range: wordRange } = wordInfo;

    // Check if hovering over an interpolation placeholder first
    for (const interp of interpolations) {
      // Compare wordRange with interp.placeholderRangeInPurePug
      // placeholderRangeInPurePug is a Range object.
      if (interp.placeholderRangeInPurePug &&
          interp.placeholderRangeInPurePug.start.line === wordRange.start.line &&
          interp.placeholderRangeInPurePug.start.character === wordRange.start.character &&
          interp.placeholderRangeInPurePug.end.character === wordRange.end.character // Simple check if it's the placeholder
         ) {
         return {
          contents: {
            kind: MarkupKind.Markdown,
            value: `**JavaScript Interpolation:**\n\`\`\`javascript\n${interp.originalExpression}\n\`\`\``
          },
          range: wordRange
        };
      }
    }

    // TODO: Implement a more robust way to find the AST node at positionInPurePug.
    // const astNodeAtPosition = findPugNodeAtOffset(pugAst, positionToOffset(purePugContent, positionInPurePug));
    // if (astNodeAtPosition) {
    //   if (astNodeAtPosition.type === 'Tag') {
    //     return { contents: `Pug Tag: \`${(astNodeAtPosition as pugParser.Tag).name}\``, range: wordRange };
    //   }
    //   // Add more checks for attributes, text, etc.
    // }

    // Fallback to simple word checks if AST inspection is not yet fully implemented
    const commonTags = ['div', 'p', 'span', 'a', 'img', 'ul', 'li', 'h1', 'h2', 'h3', 'button', 'input', 'textarea', 'label', 'form'];
    if (commonTags.includes(word)) {
      return {
        contents: { kind: MarkupKind.Markdown, value: `**Pug Tag:** \`${word}\`\n\nStandard HTML element.` },
        range: wordRange
      };
    }

    const directives = ['if', 'else if', 'else', 'each', 'while', 'case', 'when', 'default', 'mixin', 'block', 'extends', 'include'];
    if (directives.includes(word)) {
       return {
        contents: { kind: MarkupKind.Markdown, value: `**Pug Directive:** \`${word}\`` },
        range: wordRange
      };
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

// Export the factory
export { createReactPugLanguageService };
