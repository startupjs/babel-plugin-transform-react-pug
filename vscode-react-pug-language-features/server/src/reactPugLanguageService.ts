import { Diagnostic, Range, Position, DiagnosticSeverity, CompletionItem, CompletionList, CompletionItemKind, TextEdit, Hover, MarkupContent, MarkupKind } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as pugLexer from '@startupjs/pug-lexer';
import * as pugParser from 'pug-parser';
// import P speziellen from 'pug-error'; // Corrected import name if this was intended, or remove if not used directly
import commonPrefix from 'common-prefix';
// import he from 'he'; // Not actively used yet

import { offsetToPosition } from './utils/textPositions'; // Import the new helper

export interface ReactPugSettings {
  classAttribute: string;
}

export interface InterpolationMapping {
  placeholder: string;
  originalExpression: string;
  originalRangeInRawLiteral: Range; // Range of the full ${...} in textAfterContentIndentStripping
  placeholderRangeInPurePug: Range; // Range of the placeholder in purePugContent
}

export interface PugPreprocessingData {
  originalRawPugContent: string;
  baseIndentationLength: number;
  contentIndentationLength: number;
  textAfterContentIndentStripping: string;
  lineMaps: Array<{
    originalLineNumberInRawLiteral: number;
    lineInTAS: number;
    originalLeadingWhitespaceLength: number;
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

export interface PreprocessedPug {
  purePugContent: string;
  interpolations: InterpolationMapping[];
  mappingData: PugPreprocessingData;
  parseErrors: Diagnostic[];
}

export interface ParsedPug extends PreprocessedPug {
  pugAst?: pugParser.Node;
}

export interface IReactPugLanguageService {
  preprocessPug(rawPugContent: string, baseIndentation: string, documentUri: string): PreprocessedPug;
  parsePug(preprocessedResult: PreprocessedPug, documentUri: string): ParsedPug;
  doValidation(parsedResult: ParsedPug): Diagnostic[];
  doComplete(parsedResult: ParsedPug, positionInPurePug: Position): CompletionList | null;
  doHover(parsedResult: ParsedPug, positionInPurePug: Position): Hover | null;
}

const INTERPOLATION_PLACEHOLDER_PREFIX = '__RPLS_INTERP_';
const INTERPOLATION_PLACEHOLDER_REGEX = /__RPLS_INTERP_(\d+)_/g;
let interpolationCounter = 0;

function createReactPugLanguageService(settings: ReactPugSettings): IReactPugLanguageService {

  function preprocessPug(rawPugContent: string, baseIndentationString: string, documentUri: string): PreprocessedPug {
    const parseErrors: Diagnostic[] = [];
    interpolationCounter = 0;
    const lineMaps: PugPreprocessingData['lineMaps'] = [];

    const originalLines = rawPugContent.split('\n');
    const baseIndentationLength = baseIndentationString.length;

    const linesAfterBaseIndentPass: string[] = [];
    const baseStrippedLengths: number[] = [];

    originalLines.forEach(line => {
        if (line.startsWith(baseIndentationString)) {
            linesAfterBaseIndentPass.push(line.substring(baseIndentationLength));
            baseStrippedLengths.push(baseIndentationLength);
        } else if (line.trim() === '') {
            linesAfterBaseIndentPass.push(line);
            baseStrippedLengths.push(0);
        } else {
            linesAfterBaseIndentPass.push(line);
            baseStrippedLengths.push(0);
        }
    });

    const linesForContentIndentCalc = linesAfterBaseIndentPass; // Use this directly
    const nonEmptyContentLines = linesForContentIndentCalc.filter(line => line.trim() !== '');
    const commonContentIndent = nonEmptyContentLines.length > 0 ? commonPrefix(nonEmptyContentLines.map(line => (/^[ \t]*/.exec(line)?.[0] || ''))) : '';
    const contentIndentationLength = commonContentIndent.length;

    const finalStrippedLines: string[] = [];
    linesAfterBaseIndentPass.forEach((lineAfterBaseStrip, index) => {
        let finalLine = lineAfterBaseStrip;
        let currentContentStrippedLength = 0;
        if (lineAfterBaseStrip.startsWith(commonContentIndent)) {
            finalLine = lineAfterBaseStrip.substring(contentIndentationLength);
            currentContentStrippedLength = contentIndentationLength;
        } else if (lineAfterBaseStrip.trim() !== '' && contentIndentationLength > 0) {
            // No common content indent stripped from this line
        }
        finalStrippedLines.push(finalLine);
        lineMaps.push({
            originalLineNumberInRawLiteral: index,
            lineInTAS: index,
            originalLeadingWhitespaceLength: baseStrippedLengths[index] + currentContentStrippedLength,
        });
    });

    const textAfterContentIndentStripping = finalStrippedLines.join('\n');

    const interpolations: InterpolationMapping[] = [];
    const segments: PugPreprocessingData['segments'] = [];
    let finalPurePugContent = "";
    let lastIndexOriginalTAS = 0;
    let currentPurePugOffset = 0;

    const interpolationRegex = /\$\{((?:[^\{\}]|\{[^}]*\})+)\}/g;

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
        originalRangeInRawLiteral: Range.create(
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
      textAfterContentIndentStripping,
      lineMaps,
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
    } catch (e: any) {
      if (e.code && e.msg && typeof e.line !== 'undefined' && typeof e.column !== 'undefined') {
        const line = e.line - 1;
        const column = e.column - 1;
        const severity = e.code?.startsWith('PUG:SYNTAX_ERROR') ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning;

        let errorTokenLength = 1;
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
      ...preprocessedResult, // This includes purePugContent, interpolations, mappingData
      pugAst,
      parseErrors: combinedErrors,
    };
  }

  function doValidation(parsedResult: ParsedPug): Diagnostic[] {
    return parsedResult.parseErrors;
  }

  function doComplete(parsedResult: ParsedPug, positionInPurePug: Position): CompletionList | null {
    const { purePugContent, pugAst } = parsedResult;
    const items: CompletionItem[] = [];
    const currentLine = purePugContent.split('\n')[positionInPurePug.line] || "";
    const linePrefix = currentLine.substring(0, positionInPurePug.character);
    const betterAttributeContextMatch = linePrefix.match(/([\w-]+)\s*\(([^)]*)$/);

    if (betterAttributeContextMatch) {
        const tagName = betterAttributeContextMatch[1];
        const existingAttrsString = betterAttributeContextMatch[2];
        const charAfterLastAttr = existingAttrsString.match(/,\s*$/) || existingAttrsString.trim() === '' || existingAttrsString.endsWith('(');

        if (charAfterLastAttr || existingAttrsString.match(/[\w-]$/)) {
            const commonAttributes: CompletionItem[] = [
                { label: 'id', kind: CompletionItemKind.Property, detail: 'Specifies a unique id for an element' },
                { label: 'class', kind: CompletionItemKind.Property, detail: 'Specifies one or more classnames for an element' },
                { label: 'style', kind: CompletionItemKind.Property, detail: 'Specifies an inline CSS style for an element' },
                { label: 'title', kind: CompletionItemKind.Property, detail: 'Specifies extra information about an element' },
            ];
            const inputAttributes: CompletionItem[] = [
                { label: 'type', kind: CompletionItemKind.Property, detail: 'Specifies the type of an <input> element' },
                { label: 'value', kind: CompletionItemKind.Property, detail: 'Specifies the value of an <input> element' },
                { label: 'placeholder', kind: CompletionItemKind.Property, detail: 'Specifies a short hint that describes the expected value of an input field' },
                { label: 'name', kind: CompletionItemKind.Property, detail: 'Specifies the name of an <input> element' },
            ];
            items.push(...commonAttributes);
            if (tagName === 'input') items.push(...inputAttributes);
        }
    }

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
    return items.length > 0 ? CompletionList.create(items, false) : null;
  }

  function findPugNodeAtOffset(ast: pugParser.Node | undefined, offset: number): pugParser.Node | null {
    // Placeholder for a more advanced AST lookup.
    return null;
  }

  function doHover(parsedResult: ParsedPug, positionInPurePug: Position): Hover | null {
    const { purePugContent, pugAst, interpolations } = parsedResult;
    const wordInfo = getWordAtPosition(purePugContent, positionInPurePug);
    if (!wordInfo) return null;
    const { text: word, range: wordRange } = wordInfo;

    for (const interp of interpolations) {
      if (interp.placeholderRangeInPurePug &&
          interp.placeholderRangeInPurePug.start.line === wordRange.start.line &&
          interp.placeholderRangeInPurePug.start.character === wordRange.start.character &&
          interp.placeholderRangeInPurePug.end.character === wordRange.end.character
         ) {
         return {
          contents: { kind: MarkupKind.Markdown, value: `**JavaScript Interpolation:**\n\`\`\`javascript\n${interp.originalExpression}\n\`\`\`` },
          range: wordRange
        };
      }
    }

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

function getWordAtPosition(text: string, position: Position): { text: string, range: Range } | null {
  const lineText = text.split('\n')[position.line];
  if (!lineText) return null;
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

export { createReactPugLanguageService };
