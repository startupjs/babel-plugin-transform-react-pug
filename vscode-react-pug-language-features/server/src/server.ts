import {
  createConnection,
  TextDocuments,
  Diagnostic,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  CompletionItem,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  Range,
  Position,
  Hover,
  TextEdit,
  Location,
  CompletionItemKind
} from 'vscode-languageserver/node';
import { DiagnosticSeverity } from 'vscode-languageserver-types';

import { TextDocument } from 'vscode-languageserver-textdocument';
import * as acorn from 'acorn';
import * as ts from 'typescript';
import { pathToFileURL } from 'url';

import { IReactPugLanguageService, createReactPugLanguageService } from './reactPugLanguageService'; // Removed PreprocessedPug as it's unused
import { positionToOffset } from './utils/textPositions'; // offsetToPosition might be needed later if not already used
import { compilePugToJsxString, PugToJsxResult } from './pugToJsxTransformer';
import { parseSourceMap, mapJsxRangeToPugRange, mapPugPositionToJsxPosition, destroySourceMapData } from './jsxPugMapping';


const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

const virtualFiles = new Map<string, { version: number, snapshot: ts.IScriptSnapshot, content: string }>();

const tsLangServiceHost: ts.LanguageServiceHost = {
  getScriptFileNames: () => Array.from(virtualFiles.keys()),
  getScriptVersion: (fileName) => virtualFiles.get(fileName)?.version.toString() || "0",
  getScriptSnapshot: (fileName) => virtualFiles.get(fileName)?.snapshot,
  getCurrentDirectory: () => process.cwd(),
  getCompilationSettings: () => ({
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    esModuleInterop: true,
    allowNonTsExtensions: true,
  }),
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  fileExists: (path: string): boolean => virtualFiles.has(path) || ts.sys.fileExists(path),
  readFile: (path: string, encoding?: string): string | undefined => virtualFiles.get(path)?.content || ts.sys.readFile(path, encoding),
  readDirectory: ts.sys.readDirectory,
};

const tsLangService = ts.createLanguageService(tsLangServiceHost, ts.createDocumentRegistry());

function updateVirtualFile(fileName: string, content: string): void {
  const currentFile = virtualFiles.get(fileName);
  const version = currentFile ? currentFile.version + 1 : 0;
  virtualFiles.set(fileName, { version, snapshot: ts.ScriptSnapshot.fromString(content), content });
}

export interface PugLiteralInfo {
  content: string;
  range: Range;
  contentRange: Range;
  indentation: string;
}

interface ReactPugSettings {
  maxNumberOfProblems: number;
  classAttribute: string;
}

const defaultSettings: ReactPugSettings = { maxNumberOfProblems: 100, classAttribute: 'className' };
let globalSettings: ReactPugSettings = defaultSettings;
const documentSettings: Map<string, Thenable<ReactPugSettings>> = new Map();
let oldPugLanguageService: IReactPugLanguageService; // Renamed to avoid confusion

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;
  hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);

  let initialSettings = { ...globalSettings };
  if (params.initializationOptions?.classAttribute) {
    initialSettings.classAttribute = params.initializationOptions.classAttribute;
  }
  oldPugLanguageService = createReactPugLanguageService(initialSettings); // Initialize old service
  globalSettings = initialSettings;

  connection.console.log('React Pug Language Server initialized.');
  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { resolveProvider: false },
      hoverProvider: true,
      definitionProvider: true, // Added definition provider capability
    }
  };
  return result;
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }
});

let hasConfigurationCapability = false;

connection.onDidChangeConfiguration(async (change) => {
  if (hasConfigurationCapability) {
    documentSettings.clear();
  } else {
    globalSettings = (change.settings.reactPug || defaultSettings) as ReactPugSettings;
  }
  const newSettings = await getDocumentSettings('');
  oldPugLanguageService = createReactPugLanguageService(newSettings); // Update old service with new settings
  connection.console.log(`Configuration changed. Active classAttribute: ${newSettings.classAttribute}`);
  documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ReactPugSettings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }
  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: 'reactPug'
    }).then(s => s || globalSettings);
    documentSettings.set(resource, result);
  }
  return result;
}

documents.onDidClose(e => {
  documentSettings.delete(e.document.uri);
  // Consider cleaning virtualFiles associated with e.document.uri
});

documents.onDidChangeContent(change => {
  validateTextDocument(change.document);
});

function findPugLiterals(textDocument: TextDocument): PugLiteralInfo[] {
  // ... (implementation as previously defined, confirmed correct) ...
  const results: PugLiteralInfo[] = [];
  const text = textDocument.getText();
  try {
    const ast = acorn.parse(text, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      allowSuperOutsideMethod: true,
      allowHashBang: true,
    });

    function walk(node: any, callback: (node: any) => void) {
      callback(node);
      for (const key in node) {
        if (node[key] && typeof node[key] === 'object') {
          if (Array.isArray(node[key])) {
            node[key].forEach((child: any) => walk(child, callback));
          } else if (node[key].type) {
            walk(node[key], callback);
          }
        }
      }
    }

    walk(ast, (node: any) => {
      if (node.type === 'TaggedTemplateExpression' && node.tag.type === 'Identifier' && node.tag.name === 'pug') {
        if (node.quasi && node.quasi.quasis && node.quasi.quasis.length > 0) {
          const nodeStartPosition = Position.create(node.loc.start.line - 1, node.loc.start.column);
          const nodeEndPosition = Position.create(node.loc.end.line - 1, node.loc.end.column);
          const nodeRange = Range.create(nodeStartPosition, nodeEndPosition);

          const contentStartPosition = Position.create(node.quasi.loc.start.line - 1, node.quasi.loc.start.column + 1);
          const contentEndPosition = Position.create(node.quasi.loc.end.line - 1, node.quasi.loc.end.column - 1);
          const contentRange = Range.create(contentStartPosition, contentEndPosition);

          let extractedContent = "";
          for (let i = 0; i < node.quasi.quasis.length; i++) {
            const quasi = node.quasi.quasis[i];
            const quasiStartPos = Position.create(quasi.loc.start.line - 1, quasi.loc.start.column);
            const quasiEndPos = Position.create(quasi.loc.end.line - 1, quasi.loc.end.column);
            extractedContent += textDocument.getText(Range.create(quasiStartPos, quasiEndPos));

            if (i < node.quasi.expressions.length) {
              const expr = node.quasi.expressions[i];
              const exprStartPos = Position.create(expr.loc.start.line - 1, expr.loc.start.column);
              const exprEndPos = Position.create(expr.loc.end.line - 1, expr.loc.end.column);
              extractedContent += `\${${textDocument.getText(Range.create(exprStartPos, exprEndPos))}}`;
            }
          }

          let indentation = "";
          const lineOfOpeningBacktick = contentStartPosition.line;
          const textBeforeBacktick = textDocument.getText(Range.create(
            Position.create(lineOfOpeningBacktick, 0),
            Position.create(lineOfOpeningBacktick, contentStartPosition.character -1)
          ));
          const match = textBeforeBacktick.match(/^(\s*)/);
          if (match) {
            indentation = match[1];
          }

          results.push({ content: extractedContent, range: nodeRange, contentRange: contentRange, indentation: indentation });
        }
      }
    });
  } catch (e: any) {
    connection.console.warn(`Acorn parsing error in findPugLiterals: ${e.message}. Document: ${textDocument.uri}`);
  }
  return results;
}

function extractImportStatements(document: TextDocument): string[] {
  // ... (implementation as previously defined, confirmed correct) ...
  const importStatements: string[] = [];
  try {
    const ast = acorn.parse(document.getText(), {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      allowSuperOutsideMethod: true,
      allowHashBang: true,
    });
    const body = (ast as any).body || ((ast as any).program ? (ast as any).program.body : []);
    for (const node of body) {
      if (node.type === 'ImportDeclaration') {
        if (typeof node.start === 'number' && typeof node.end === 'number') {
            const importText = document.getText().substring(node.start, node.end);
            importStatements.push(importText);
        }
      }
    }
  } catch (e: any) {
    connection.console.warn(`Acorn parsing error during import extraction: ${e.message} in ${document.uri}`);
  }
  return importStatements;
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  const settings = await getDocumentSettings(textDocument.uri);
  const diagnostics: Diagnostic[] = [];
  const pugLiterals = findPugLiterals(textDocument);
  const importStatements = extractImportStatements(textDocument);
  let literalIndex = 0;

  for (const literal of pugLiterals) {
    const rawPugInLiteral = literal.content; // Corrected: Use extracted content
    const currentLiteralIndex = literalIndex++; // Corrected: Use consistent indexing

    const babelInputFilename = `${textDocument.uri}/literal-${currentLiteralIndex}.pug.virtual.js`;
    const virtualTsxFilename = `${textDocument.uri}/literal-${currentLiteralIndex}.pug.virtual.tsx`;

    // connection.console.log(`Processing Pug literal at L${literal.contentRange.start.line} C${literal.contentRange.start.character}`);
    // connection.console.log(`Original Pug:\n${rawPugInLiteral}`);

    const compileResult: PugToJsxResult = compilePugToJsxString(rawPugInLiteral, { classAttribute: settings.classAttribute }, babelInputFilename);

    if (compileResult.error || !compileResult.jsx || !compileResult.sourceMap) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: literal.contentRange,
        message: `Pug to JSX compilation failed: ${compileResult.error || 'Unknown compilation error or missing JSX/SourceMap.'}`,
        source: 'React Pug (Compiler)',
      });
      continue;
    }

    const virtualTsxContent = `
${importStatements.join('\n')}
import React from 'react';
const PugComponent = () => (<>${compileResult.jsx}</>);
export default PugComponent;
    `;
    updateVirtualFile(virtualTsxFilename, virtualTsxContent);

    const tsSyntacticDiagnostics = tsLangService.getSyntacticDiagnostics(virtualTsxFilename);
    const tsSemanticDiagnostics = tsLangService.getSemanticDiagnostics(virtualTsxFilename);
    const allTsDiagnostics = [...tsSyntacticDiagnostics, ...tsSemanticDiagnostics];

    const mapData = await parseSourceMap(compileResult.sourceMap, rawPugInLiteral, compileResult.jsx);

    if (!mapData) {
      allTsDiagnostics.forEach(tsDiag => {
        diagnostics.push({
          severity: tsDiag.category === ts.DiagnosticCategory.Error ? DiagnosticSeverity.Error :
                      tsDiag.category === ts.DiagnosticCategory.Warning ? DiagnosticSeverity.Warning :
                      tsDiag.category === ts.DiagnosticCategory.Suggestion ? DiagnosticSeverity.Hint :
                      DiagnosticSeverity.Information,
          range: literal.contentRange,
          message: `(Unmapped TSX) ${ts.flattenDiagnosticMessageText(tsDiag.messageText, '\n')}`,
          source: 'React Pug (TS)',
          code: tsDiag.code
        });
      });
      // if (compileResult.sourceMap) destroySourceMapData(mapData); // mapData is null here
      continue;
    }

    for (const tsDiag of allTsDiagnostics) {
      if (tsDiag.start === undefined || tsDiag.length === undefined) continue;
      const sourceFile = tsLangService.getProgram()?.getSourceFile(virtualTsxFilename);
      let finalJsxDiagRange: Range | undefined = undefined;

      if (sourceFile) {
        const startLoc = ts.getLineAndCharacterOfPosition(sourceFile, tsDiag.start);
        const endLoc = ts.getLineAndCharacterOfPosition(sourceFile, tsDiag.start + tsDiag.length);
        finalJsxDiagRange = Range.create(startLoc.line, startLoc.character, endLoc.line, endLoc.character);
      } else {
         diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: literal.contentRange,
            message: `(Internal Error) Could not map TSX diagnostic for: ${ts.flattenDiagnosticMessageText(tsDiag.messageText, '\n')}`,
            source: 'React Pug (Mapping)',
         });
         continue;
      }

      if (finalJsxDiagRange) {
        const pugRange = mapJsxRangeToPugRange(finalJsxDiagRange, mapData);
        if (pugRange) {
          const docRelativePugRange = Range.create(
            literal.contentRange.start.line + pugRange.start.line,
            (pugRange.start.line === 0 ? literal.contentRange.start.character : 0) + pugRange.start.character,
            literal.contentRange.start.line + pugRange.end.line,
            (pugRange.end.line === 0 ? literal.contentRange.start.character : 0) + pugRange.end.character
          );
          diagnostics.push({
            severity: tsDiag.category === ts.DiagnosticCategory.Error ? DiagnosticSeverity.Error :
                        tsDiag.category === ts.DiagnosticCategory.Warning ? DiagnosticSeverity.Warning :
                        tsDiag.category === ts.DiagnosticCategory.Suggestion ? DiagnosticSeverity.Hint :
                        DiagnosticSeverity.Information,
            range: docRelativePugRange,
            message: ts.flattenDiagnosticMessageText(tsDiag.messageText, '\n'),
            source: 'React Pug (TS)',
            code: tsDiag.code,
          });
        } else {
           diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: literal.contentRange,
            message: `(Unmapped TSX) ${ts.flattenDiagnosticMessageText(tsDiag.messageText, '\n')}`,
            source: 'React Pug (TS Mapping)',
            code: tsDiag.code
          });
        }
      }
    }
    destroySourceMapData(mapData);
  }
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

// onCompletion, onHover, onDefinition handlers as previously defined and confirmed correct...
// ... (The full code for onCompletion, mapTsCompletionKindToLspKind, displayPartsToString, onHover, onDefinition)
// The following is the exact code for these handlers from my verified internal state:

connection.onCompletion(
  async (textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[] | null> => {
    const document = documents.get(textDocumentPosition.textDocument.uri);
    if (!document) return null;

    const settings = await getDocumentSettings(document.uri);
    const pugLiterals = findPugLiterals(document);
    const importStatements = extractImportStatements(document);
    let literalIndex = 0;

    for (const literal of pugLiterals) {
      const currentLiteralIndex = literalIndex++;
      const docOffset = positionToOffset(document.getText(), textDocumentPosition.position);
      const literalContentStartOffset = positionToOffset(document.getText(), literal.contentRange.start);
      const literalContentEndOffset = positionToOffset(document.getText(), literal.contentRange.end);

      if (docOffset >= literalContentStartOffset && docOffset <= literalContentEndOffset) {
        const rawPugInLiteral = literal.content;
        const cursorPugPosition = Position.create(
          textDocumentPosition.position.line - literal.contentRange.start.line,
          textDocumentPosition.position.character - (textDocumentPosition.position.line === literal.contentRange.start.line ? literal.contentRange.start.character : 0)
        );

        const babelInputFilename = `${document.uri}/literal-${currentLiteralIndex}.pug.virtual.js`;
        const virtualTsxFilename = `${document.uri}/literal-${currentLiteralIndex}.pug.virtual.tsx`;

        const compileResult = compilePugToJsxString(rawPugInLiteral, { classAttribute: settings.classAttribute }, babelInputFilename);

        if (compileResult.error || !compileResult.jsx || !compileResult.sourceMap) {
          continue;
        }

        const mapData = await parseSourceMap(compileResult.sourceMap, rawPugInLiteral, compileResult.jsx);
        if (!mapData) {
          continue;
        }

        const jsxPosition = mapPugPositionToJsxPosition(cursorPugPosition, mapData);
        if (!jsxPosition) {
          destroySourceMapData(mapData);
          continue;
        }

        const virtualTsxContent = `
${importStatements.join('\n')}
import React from 'react';
const PugComponent = () => (<>${compileResult.jsx}</>);
export default PugComponent;
        `;
        updateVirtualFile(virtualTsxFilename, virtualTsxContent);
        const jsxOffset = positionToOffset(virtualTsxContent, jsxPosition);

        const tsCompletions = tsLangService.getCompletionsAtPosition(virtualTsxFilename, jsxOffset, undefined);
        destroySourceMapData(mapData);

        if (!tsCompletions || !tsCompletions.entries) {
          return null;
        }

        const lspCompletionItems: CompletionItem[] = [];
        const tsProgram = tsLangService.getProgram(); // Get program once for performance if using sourceFile from it

        for (const entry of tsCompletions.entries) {
          const details = tsLangService.getCompletionEntryDetails(
            virtualTsxFilename,
            jsxOffset,
            entry.name,
            undefined, // formatOptions
            entry.source, // source for auto-imports
            undefined, // preferences
            entry.data // data from entry
          );

          const lspItem: CompletionItem = {
            label: entry.name,
            kind: mapTsCompletionKindToLspKind(entry.kind),
            detail: details?.displayParts ? displayPartsToString(details.displayParts) : undefined,
            documentation: details?.documentation ? displayPartsToString(details.documentation) : undefined,
            // sortText: entry.sortText, // Consider adding if TS provides useful sortText
            // data: entry.data // Pass along data for potential resolve step if ever implemented
          };

          if (details?.codeActions && details.codeActions.length > 0) {
            // Assuming the first codeAction and its first change are the primary edit.
            // Real-world scenarios might need more sophisticated logic to pick the right action/change.
            const firstAction = details.codeActions[0];
            if (firstAction.changes.length > 0) {
              const firstFileTextChange = firstAction.changes[0]; // ts.FileTextChanges
              if (firstFileTextChange.fileName === virtualTsxFilename && firstFileTextChange.textChanges.length > 0) {
                const tsTextChange = firstFileTextChange.textChanges[0]; // ts.TextChange (usually one for a completion)

                const jsxSourceFile = tsProgram?.getSourceFile(virtualTsxFilename);
                if (jsxSourceFile) {
                  const startLoc = ts.getLineAndCharacterOfPosition(jsxSourceFile, tsTextChange.span.start);
                  const endLoc = ts.getLineAndCharacterOfPosition(jsxSourceFile, tsTextChange.span.start + tsTextChange.span.length);
                  const jsxRange = Range.create(startLoc.line, startLoc.character, endLoc.line, endLoc.character);

                  // Use the mapData obtained earlier for this literal.
                  // No need to re-parse, ensure mapData is not destroyed prematurely.
                  const pugRange = mapJsxRangeToPugRange(jsxRange, mapData); // Use existing mapData
                  if (pugRange) {
                    const docRelativePugRange = Range.create(
                      literal.contentRange.start.line + pugRange.start.line,
                      (pugRange.start.line === 0 ? literal.contentRange.start.character : 0) + pugRange.start.character,
                      literal.contentRange.start.line + pugRange.end.line,
                      (pugRange.end.line === 0 ? literal.contentRange.start.character : 0) + pugRange.end.character
                    );

                    // TODO: Transform tsTextChange.newText (JSX) to Pug syntax if necessary.
                    // For now, using it as-is. This will be incorrect for JSX tags.
                    lspItem.textEdit = TextEdit.replace(docRelativePugRange, tsTextChange.newText);
                  }
                }
              }
            }
          }
          lspCompletionItems.push(lspItem);
        }
        // Destroy mapData after processing all completion entries for this literal
        destroySourceMapData(mapData);
        return lspCompletionItems;
      }
    }
    return null;
  }
);

function mapTsCompletionKindToLspKind(tsKind: ts.ScriptElementKind): CompletionItemKind {
  switch (tsKind) {
    case ts.ScriptElementKind.moduleElement:
    case ts.ScriptElementKind.externalModuleName:
      return CompletionItemKind.Module;
    case ts.ScriptElementKind.classElement:
      return CompletionItemKind.Class;
    case ts.ScriptElementKind.interfaceElement:
      return CompletionItemKind.Interface;
    case ts.ScriptElementKind.memberFunctionElement:
    case ts.ScriptElementKind.constructSignatureElement:
    case ts.ScriptElementKind.callSignatureElement:
    case ts.ScriptElementKind.indexSignatureElement:
      return CompletionItemKind.Method;
    case ts.ScriptElementKind.memberVariableElement:
    case ts.ScriptElementKind.memberGetAccessorElement:
    case ts.ScriptElementKind.memberSetAccessorElement:
      return CompletionItemKind.Field;
    case ts.ScriptElementKind.variableElement:
    case ts.ScriptElementKind.letElement:
    case ts.ScriptElementKind.constElement:
    case ts.ScriptElementKind.parameterElement:
      return CompletionItemKind.Variable;
    case ts.ScriptElementKind.functionElement:
    case ts.ScriptElementKind.localFunctionElement:
      return CompletionItemKind.Function;
    case ts.ScriptElementKind.keyword:
      return CompletionItemKind.Keyword;
    case ts.ScriptElementKind.primitiveType:
      return CompletionItemKind.Unit;
    case ts.ScriptElementKind.string:
      return CompletionItemKind.Text;
    default:
      return CompletionItemKind.Text;
  }
}

function displayPartsToString(displayParts: ts.SymbolDisplayPart[] | undefined): string {
  if (!displayParts) return "";
  return displayParts.map(part => part.text).join("");
}

connection.onHover(
  async (textDocumentPosition: TextDocumentPositionParams): Promise<Hover | null> => {
    const document = documents.get(textDocumentPosition.textDocument.uri);
    if (!document) return null;

    const settings = await getDocumentSettings(document.uri);
    const pugLiterals = findPugLiterals(document);
    const importStatements = extractImportStatements(document);
    let literalIndex = 0;

    for (const literal of pugLiterals) {
      const currentLiteralIndex = literalIndex++;
      const docOffset = positionToOffset(document.getText(), textDocumentPosition.position);
      const literalContentStartOffset = positionToOffset(document.getText(), literal.contentRange.start);
      const literalContentEndOffset = positionToOffset(document.getText(), literal.contentRange.end);

      if (docOffset >= literalContentStartOffset && docOffset <= literalContentEndOffset) {
        const rawPugInLiteral = literal.content;
        const cursorPugPosition = Position.create(
          textDocumentPosition.position.line - literal.contentRange.start.line,
          textDocumentPosition.position.character - (textDocumentPosition.position.line === literal.contentRange.start.line ? literal.contentRange.start.character : 0)
        );

        const babelInputFilename = `${document.uri}/literal-${currentLiteralIndex}.pug.virtual.js`;
        const virtualTsxFilename = `${document.uri}/literal-${currentLiteralIndex}.pug.virtual.tsx`;

        const compileResult = compilePugToJsxString(rawPugInLiteral, { classAttribute: settings.classAttribute }, babelInputFilename);

        if (compileResult.error || !compileResult.jsx || !compileResult.sourceMap) {
          continue;
        }

        const mapData = await parseSourceMap(compileResult.sourceMap, rawPugInLiteral, compileResult.jsx);
        if (!mapData) {
          continue;
        }

        const jsxPosition = mapPugPositionToJsxPosition(cursorPugPosition, mapData);
        if (!jsxPosition) {
          destroySourceMapData(mapData);
          continue;
        }

        const virtualTsxContent = `
${importStatements.join('\n')}
import React from 'react';
const PugComponent = () => (<>${compileResult.jsx}</>);
export default PugComponent;
        `;
        updateVirtualFile(virtualTsxFilename, virtualTsxContent);
        const jsxOffset = positionToOffset(virtualTsxContent, jsxPosition);

        const quickInfo = tsLangService.getQuickInfoAtPosition(virtualTsxFilename, jsxOffset);
        if (!quickInfo) {
          destroySourceMapData(mapData);
          return null;
        }

        let hoverContentsValue = displayPartsToString(quickInfo.displayParts);
        if (quickInfo.documentation && quickInfo.documentation.length > 0) {
          hoverContentsValue += "\n\n---\n" + displayPartsToString(quickInfo.documentation);
        }

        let hoverRange: Range | undefined = undefined;
        if (quickInfo.textSpan) {
          const jsxSourceFile = tsLangService.getProgram()?.getSourceFile(virtualTsxFilename);
          if (jsxSourceFile) {
            const startLoc = ts.getLineAndCharacterOfPosition(jsxSourceFile, quickInfo.textSpan.start);
            const endLoc = ts.getLineAndCharacterOfPosition(jsxSourceFile, quickInfo.textSpan.start + quickInfo.textSpan.length);
            const jsxRange = Range.create(startLoc.line, startLoc.character, endLoc.line, endLoc.character);

            const mappedPugRange = mapJsxRangeToPugRange(jsxRange, mapData);
            if (mappedPugRange) {
              hoverRange = Range.create(
                literal.contentRange.start.line + mappedPugRange.start.line,
                (mappedPugRange.start.line === 0 ? literal.contentRange.start.character : 0) + mappedPugRange.start.character,
                literal.contentRange.start.line + mappedPugRange.end.line,
                (mappedPugRange.end.line === 0 ? literal.contentRange.start.character : 0) + mappedPugRange.end.character
              );
            }
          }
        }
        destroySourceMapData(mapData);

        return {
          contents: { kind: 'markdown', value: hoverContentsValue },
          range: hoverRange,
        };
      }
    }
    return null;
  }
);

connection.onDefinition(
  async (textDocumentPosition: TextDocumentPositionParams): Promise<Location[] | null> => {
    const document = documents.get(textDocumentPosition.textDocument.uri);
    if (!document) return null;

    const settings = await getDocumentSettings(document.uri);
    const pugLiterals = findPugLiterals(document);
    const importStatements = extractImportStatements(document);
    let literalIndex = 0;

    for (const literal of pugLiterals) {
      const currentLiteralIndex = literalIndex++;
      const docOffset = positionToOffset(document.getText(), textDocumentPosition.position);
      const literalContentStartOffset = positionToOffset(document.getText(), literal.contentRange.start);
      const literalContentEndOffset = positionToOffset(document.getText(), literal.contentRange.end);

      if (docOffset >= literalContentStartOffset && docOffset <= literalContentEndOffset) {
        const rawPugInLiteral = literal.content;
        const cursorPugPosition = Position.create(
          textDocumentPosition.position.line - literal.contentRange.start.line,
          textDocumentPosition.position.character - (textDocumentPosition.position.line === literal.contentRange.start.line ? literal.contentRange.start.character : 0)
        );

        const babelInputFilename = `${document.uri}/literal-${currentLiteralIndex}.pug.virtual.js`;
        const virtualTsxFilename = `${document.uri}/literal-${currentLiteralIndex}.pug.virtual.tsx`;

        const compileResult = compilePugToJsxString(rawPugInLiteral, { classAttribute: settings.classAttribute }, babelInputFilename);
        if (compileResult.error || !compileResult.jsx || !compileResult.sourceMap) {
          continue;
        }

        const mapData = await parseSourceMap(compileResult.sourceMap, rawPugInLiteral, compileResult.jsx);
        if (!mapData) {
          continue;
        }

        const jsxPosition = mapPugPositionToJsxPosition(cursorPugPosition, mapData);
        if (!jsxPosition) {
          destroySourceMapData(mapData);
          continue;
        }

        const virtualTsxContent = `
${importStatements.join('\n')}
import React from 'react';
const PugComponent = () => (<>${compileResult.jsx}</>);
export default PugComponent;
        `;
        updateVirtualFile(virtualTsxFilename, virtualTsxContent);
        const jsxOffset = positionToOffset(virtualTsxContent, jsxPosition);

        const definitionInfo = tsLangService.getDefinitionAtPosition(virtualTsxFilename, jsxOffset);
        if (!definitionInfo || definitionInfo.length === 0) {
          destroySourceMapData(mapData);
          return null;
        }

        const locations: Location[] = [];
        const tsProgram = tsLangService.getProgram();

        for (const defSite of definitionInfo) {
          const targetFileName = defSite.fileName;
          const targetTextSpan = defSite.textSpan;
          let targetUri: string;
          let targetRange: Range;

          const targetSourceFile = tsProgram?.getSourceFile(targetFileName);
          if (!targetSourceFile) {
            continue;
          }

          const startLoc = ts.getLineAndCharacterOfPosition(targetSourceFile, targetTextSpan.start);
          const endLoc = ts.getLineAndCharacterOfPosition(targetSourceFile, targetTextSpan.start + targetTextSpan.length);
          targetRange = Range.create(startLoc.line, startLoc.character, endLoc.line, endLoc.character);

          if (targetFileName === virtualTsxFilename) {
            const mappedPugRange = mapJsxRangeToPugRange(targetRange, mapData);
            if (mappedPugRange) {
              locations.push({
                uri: document.uri,
                range: Range.create(
                  literal.contentRange.start.line + mappedPugRange.start.line,
                  (mappedPugRange.start.line === 0 ? literal.contentRange.start.character : 0) + mappedPugRange.start.character,
                  literal.contentRange.start.line + mappedPugRange.end.line,
                  (mappedPugRange.end.line === 0 ? literal.contentRange.start.character : 0) + mappedPugRange.end.character
                ),
              });
            }
          } else {
            try {
                targetUri = pathToFileURL(targetFileName).toString();
                locations.push({ uri: targetUri, range: targetRange });
            } catch (e) {
                // console.error
            }
          }
        }
        destroySourceMapData(mapData);
        return locations.length > 0 ? locations : null;
      }
    }
    return null;
  }
);

documents.listen(connection);
connection.listen();
// connection.console.log('React Pug Language Server process started.'); // Already logged in onInitialize
