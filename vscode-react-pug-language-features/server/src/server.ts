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
import * as walk from 'acorn-walk';
import * as ts from 'typescript';
import { pathToFileURL } from 'url';

import { IReactPugLanguageService, createReactPugLanguageService } from './reactPugLanguageService';
import { positionToOffset } from './utils/textPositions';
import { compilePugToJsxString, PugToJsxResult } from './pugToJsxTransformer';
import { parseSourceMap, mapJsxRangeToPugRange, mapPugPositionToJsxPosition, destroySourceMapData } from './jsxPugMapping';
import { transformJsxSnippetToPug } from './utils/jsxToPugSnippet'; // Import the new transformer

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// Cache for Acorn ASTs
const astCache = new Map<string, { version: number, ast: acorn.Node }>();

// Cache for Pug compilation results
const pugCompilationCache = new Map<string, PugToJsxResult>();

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
  enclosingScopeNode?: acorn.Node;
}

interface ReactPugSettings {
  maxNumberOfProblems: number;
  classAttribute: string;
}

const defaultSettings: ReactPugSettings = { maxNumberOfProblems: 100, classAttribute: 'className' };
let globalSettings: ReactPugSettings = defaultSettings;
const documentSettings: Map<string, Thenable<ReactPugSettings>> = new Map();
let oldPugLanguageService: IReactPugLanguageService;
let hasConfigurationCapability = false;

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;
  hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);
  let initialSettings = { ...globalSettings };
  if (params.initializationOptions?.classAttribute) {
    initialSettings.classAttribute = params.initializationOptions.classAttribute;
  }
  oldPugLanguageService = createReactPugLanguageService(initialSettings);
  globalSettings = initialSettings;
  connection.console.log('React Pug Language Server initialized.');
  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { resolveProvider: false },
      hoverProvider: true,
      definitionProvider: true,
    }
  };
  return result;
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }
});

connection.onDidChangeConfiguration(async (change) => {
  if (hasConfigurationCapability) {
    documentSettings.clear();
  } else {
    globalSettings = (change.settings.reactPug || defaultSettings) as ReactPugSettings;
  }
  const newSettings = await getDocumentSettings('');
  oldPugLanguageService = createReactPugLanguageService(newSettings);
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
});

documents.onDidChangeContent(change => {
  validateTextDocument(change.document);
});

function findPugLiterals(textDocument: TextDocument): PugLiteralInfo[] {
  const results: PugLiteralInfo[] = [];
  const text = textDocument.getText();
  try {
    const ast = acorn.parse(text, {
      ecmaVersion: 'latest', sourceType: 'module', locations: true,
      allowReturnOutsideFunction: true, allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true, allowSuperOutsideMethod: true, allowHashBang: true,
    }) as acorn.Node;

    walk.ancestor(ast, {
      TaggedTemplateExpression: (node, ancestors: acorn.Node[]) => {
        const ttNode = node as any;
        if (ttNode.tag.type === 'Identifier' && ttNode.tag.name === 'pug') {
          if (ttNode.quasi && ttNode.quasi.quasis && ttNode.quasi.quasis.length > 0) {
            const nodeStartPosition = Position.create(ttNode.loc.start.line - 1, ttNode.loc.start.column);
            const nodeEndPosition = Position.create(ttNode.loc.end.line - 1, ttNode.loc.end.column);
            const nodeRange = Range.create(nodeStartPosition, nodeEndPosition);
            const contentStartPosition = Position.create(ttNode.quasi.loc.start.line - 1, ttNode.quasi.loc.start.column + 1);
            const contentEndPosition = Position.create(ttNode.quasi.loc.end.line - 1, ttNode.quasi.loc.end.column - 1);
            const contentRange = Range.create(contentStartPosition, contentEndPosition);
            let extractedContent = "";
            for (let i = 0; i < ttNode.quasi.quasis.length; i++) {
              const quasi = ttNode.quasi.quasis[i];
              extractedContent += textDocument.getText(Range.create(Position.create(quasi.loc.start.line - 1, quasi.loc.start.column), Position.create(quasi.loc.end.line - 1, quasi.loc.end.column)));
              if (i < ttNode.quasi.expressions.length) {
                const expr = ttNode.quasi.expressions[i];
                extractedContent += `\${${textDocument.getText(Range.create(Position.create(expr.loc.start.line - 1, expr.loc.start.column), Position.create(expr.loc.end.line - 1, expr.loc.end.column)))}}`;
              }
            }
            let indentation = "";
            const lineOfOpeningBacktick = contentStartPosition.line;
            const textBeforeBacktick = textDocument.getText(Range.create(Position.create(lineOfOpeningBacktick, 0), Position.create(lineOfOpeningBacktick, contentStartPosition.character -1)));
            const match = textBeforeBacktick.match(/^(\s*)/);
            if (match) indentation = match[1];

            let enclosingScopeNode: acorn.Node | undefined = undefined;
            for (let i = ancestors.length - 2; i >= 0; i--) {
              const ancestorNode = ancestors[i];
              if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'BlockStatement', 'Program'].includes(ancestorNode.type)) {
                enclosingScopeNode = ancestorNode;
                break;
              }
            }
            results.push({ content: extractedContent, range: nodeRange, contentRange: contentRange, indentation: indentation, enclosingScopeNode });
          }
        }
      }
    });
  } catch (e: any) {
    connection.console.warn(`Acorn parsing error in findPugLiterals: ${e.message}. Document: ${textDocument.uri}`);
  }
  return results;
}

function extractDeclarationsAndParamsFromScope(scopeNode: acorn.Node | undefined, documentText: string): { declarations: string[], paramTexts: string[] } {
  const result = { declarations: [] as string[], paramTexts: [] as string[] };
  if (!scopeNode) return result;

  let bodyNodes: acorn.Node[] = [];

  if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(scopeNode.type)) {
    const funcNode = scopeNode as any;
    if (Array.isArray(funcNode.params)) {
      for (const param of funcNode.params) {
        // For simplicity, create 'let paramName: any;' for each.
        // More complex destructuring or default values would need more handling.
        if (param.type === 'Identifier') {
          result.paramTexts.push(`let ${param.name}: any;`);
        } else if (param.type === 'AssignmentPattern' && param.left.type === 'Identifier') {
          result.paramTexts.push(`let ${param.left.name}: any;`); // Default value not included in dummy declaration
        }
        // TODO: Handle ObjectPattern, ArrayPattern for destructured params
      }
    }
    if (funcNode.body && funcNode.body.type === 'BlockStatement' && Array.isArray(funcNode.body.body)) {
      bodyNodes = funcNode.body.body;
    }
  } else if (['BlockStatement', 'Program'].includes(scopeNode.type) && Array.isArray((scopeNode as any).body)) {
    bodyNodes = (scopeNode as any).body;
  }

  for (const node of bodyNodes) {
    if (['VariableDeclaration', 'FunctionDeclaration'].includes(node.type)) {
      if (typeof (node as any).start === 'number' && typeof (node as any).end === 'number') {
        result.declarations.push(documentText.substring((node as any).start, (node as any).end));
      }
    }
  }
  return result;
}

function extractImportStatements(document: TextDocument): string[] {
  const importStatements: string[] = [];
  try {
    const ast = acorn.parse(document.getText(), {
      ecmaVersion: 'latest', sourceType: 'module', locations: true,
      allowReturnOutsideFunction: true, allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true, allowSuperOutsideMethod: true, allowHashBang: true,
    });
    const body = (ast as any).body || ((ast as any).program ? (ast as any).program.body : []);
    for (const node of body) {
      if (node.type === 'ImportDeclaration') {
        if (typeof node.start === 'number' && typeof node.end === 'number') {
            importStatements.push(document.getText().substring(node.start, node.end));
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
  const documentText = textDocument.getText();
  let literalIndex = 0;

  for (const literal of pugLiterals) {
    const rawPugInLiteral = literal.content;
    const currentLiteralIndex = literalIndex++;
    const { declarations: localDeclarations, paramTexts: localParamTexts } = extractDeclarationsAndParamsFromScope(literal.enclosingScopeNode, documentText);

    const babelInputFilename = `${textDocument.uri}/literal-${currentLiteralIndex}.pug.virtual.js`;
    const virtualTsxFilename = `${textDocument.uri}/literal-${currentLiteralIndex}.pug.virtual.tsx`;

    const compileResult: PugToJsxResult = compilePugToJsxString(rawPugInLiteral, { classAttribute: settings.classAttribute }, babelInputFilename);

    if (compileResult.error || !compileResult.jsx || !compileResult.sourceMap) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error, range: literal.contentRange,
        message: `Pug to JSX compilation failed: ${compileResult.error || 'Unknown error.'}`, source: 'React Pug (Compiler)',
      });
      continue;
    }

    const virtualTsxContent = `
${importStatements.join('\n')}
${localParamTexts.join('\n')}
${localDeclarations.join('\n')}
import React from 'react';
const PugComponent = () => (<>${compileResult.jsx}</>);
export default PugComponent;
    `;
    updateVirtualFile(virtualTsxFilename, virtualTsxContent);

    const allTsDiagnostics = [
      ...tsLangService.getSyntacticDiagnostics(virtualTsxFilename),
      ...tsLangService.getSemanticDiagnostics(virtualTsxFilename)
    ];

    const mapData = await parseSourceMap(compileResult.sourceMap, rawPugInLiteral, compileResult.jsx);
    if (!mapData) {
      allTsDiagnostics.forEach(tsDiag => diagnostics.push({
        severity: tsDiag.category === ts.DiagnosticCategory.Error ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
        range: literal.contentRange, message: `(Unmapped TSX) ${ts.flattenDiagnosticMessageText(tsDiag.messageText, '\n')}`,
        source: 'React Pug (TS)', code: tsDiag.code
      }));
      continue;
    }

    for (const tsDiag of allTsDiagnostics) {
      if (tsDiag.start === undefined || tsDiag.length === undefined) continue;
      const sourceFile = tsLangService.getProgram()?.getSourceFile(virtualTsxFilename);
      if (!sourceFile) {
        diagnostics.push({ severity: DiagnosticSeverity.Warning, range: literal.contentRange, message: `(Internal Error) No sourceFile for ${virtualTsxFilename}`, source: 'React Pug (Mapping)'});
        continue;
      }
      const startLoc = ts.getLineAndCharacterOfPosition(sourceFile, tsDiag.start);
      const endLoc = ts.getLineAndCharacterOfPosition(sourceFile, tsDiag.start + tsDiag.length);
      const finalJsxDiagRange = Range.create(startLoc.line, startLoc.character, endLoc.line, endLoc.character);
      const pugRange = mapJsxRangeToPugRange(finalJsxDiagRange, mapData);

      if (pugRange) {
        diagnostics.push({
          severity: tsDiag.category === ts.DiagnosticCategory.Error ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
          range: Range.create(
            literal.contentRange.start.line + pugRange.start.line,
            (pugRange.start.line === 0 ? literal.contentRange.start.character : 0) + pugRange.start.character,
            literal.contentRange.start.line + pugRange.end.line,
            (pugRange.end.line === 0 ? literal.contentRange.start.character : 0) + pugRange.end.character
          ),
          message: ts.flattenDiagnosticMessageText(tsDiag.messageText, '\n'), source: 'React Pug (TS)', code: tsDiag.code,
        });
      } else {
        diagnostics.push({
          severity: DiagnosticSeverity.Warning, range: literal.contentRange,
          message: `(Unmapped TSX) ${ts.flattenDiagnosticMessageText(tsDiag.messageText, '\n')}`, source: 'React Pug (TS Mapping)', code: tsDiag.code
        });
      }
    }
    destroySourceMapData(mapData);
  }
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onCompletion(
  async (textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[] | null> => {
    const document = documents.get(textDocumentPosition.textDocument.uri);
    if (!document) return null;
    const settings = await getDocumentSettings(document.uri);
    const pugLiterals = findPugLiterals(document);
    const importStatements = extractImportStatements(document);
    const documentText = document.getText();
    let literalIndex = 0;

    for (const literal of pugLiterals) {
      const currentLiteralIndex = literalIndex++;
      const docOffset = positionToOffset(documentText, textDocumentPosition.position);
      const literalContentStartOffset = positionToOffset(documentText, literal.contentRange.start);
      const literalContentEndOffset = positionToOffset(documentText, literal.contentRange.end);

      if (docOffset >= literalContentStartOffset && docOffset <= literalContentEndOffset) {
        const rawPugInLiteral = literal.content;
        const { declarations: localDeclarations, paramTexts: localParamTexts } = extractDeclarationsAndParamsFromScope(literal.enclosingScopeNode, documentText);
        const cursorPugPosition = Position.create(
          textDocumentPosition.position.line - literal.contentRange.start.line,
          textDocumentPosition.position.character - (textDocumentPosition.position.line === literal.contentRange.start.line ? literal.contentRange.start.character : 0)
        );
        const babelInputFilename = `${document.uri}/literal-${currentLiteralIndex}.pug.virtual.js`;
        const virtualTsxFilename = `${document.uri}/literal-${currentLiteralIndex}.pug.virtual.tsx`;
        const compileResult = compilePugToJsxString(rawPugInLiteral, { classAttribute: settings.classAttribute }, babelInputFilename);

        if (compileResult.error || !compileResult.jsx || !compileResult.sourceMap) continue;
        const mapData = await parseSourceMap(compileResult.sourceMap, rawPugInLiteral, compileResult.jsx);
        if (!mapData) continue;
        const jsxPosition = mapPugPositionToJsxPosition(cursorPugPosition, mapData);
        if (!jsxPosition) { destroySourceMapData(mapData); continue; }

        const virtualTsxContent = `
${importStatements.join('\n')}
${localParamTexts.join('\n')}
${localDeclarations.join('\n')}
import React from 'react';
const PugComponent = () => (<>${compileResult.jsx}</>);
export default PugComponent;
        `;
        updateVirtualFile(virtualTsxFilename, virtualTsxContent);
        const jsxOffset = positionToOffset(virtualTsxContent, jsxPosition);
        const tsCompletions = tsLangService.getCompletionsAtPosition(virtualTsxFilename, jsxOffset, undefined);

        if (!tsCompletions || !tsCompletions.entries) { destroySourceMapData(mapData); return null; }

        const lspCompletionItems: CompletionItem[] = [];
        const tsProgram = tsLangService.getProgram();
        for (const entry of tsCompletions.entries) {
          const details = tsLangService.getCompletionEntryDetails(virtualTsxFilename, jsxOffset, entry.name, undefined, entry.source, undefined, entry.data);
          const lspItem: CompletionItem = {
            label: entry.name, kind: mapTsCompletionKindToLspKind(entry.kind),
            detail: details?.displayParts ? displayPartsToString(details.displayParts) : undefined,
            documentation: details?.documentation ? displayPartsToString(details.documentation) : undefined,
          };
          if (details?.codeActions?.length && details.codeActions[0].changes?.length && firstFileChangeIsCurrent(details.codeActions[0].changes[0], virtualTsxFilename)) {
            const tsTextChange = details.codeActions[0].changes[0].textChanges[0];
            const jsxSourceFile = tsProgram?.getSourceFile(virtualTsxFilename);
            if (jsxSourceFile && tsTextChange) {
              const startLoc = ts.getLineAndCharacterOfPosition(jsxSourceFile, tsTextChange.span.start);
              const endLoc = ts.getLineAndCharacterOfPosition(jsxSourceFile, tsTextChange.span.start + tsTextChange.span.length);
              const jsxRange = Range.create(startLoc.line, startLoc.character, endLoc.line, endLoc.character);
              const pugRange = mapJsxRangeToPugRange(jsxRange, mapData);
              if (pugRange) {
                lspItem.textEdit = TextEdit.replace(Range.create(
                  literal.contentRange.start.line + pugRange.start.line,
                  (pugRange.start.line === 0 ? literal.contentRange.start.character : 0) + pugRange.start.character,
                  literal.contentRange.start.line + pugRange.end.line,
                  (pugRange.end.line === 0 ? literal.contentRange.start.character : 0) + pugRange.end.character
                ), tsTextChange.newText);
              }
            }
          }
          lspCompletionItems.push(lspItem);
        }
        destroySourceMapData(mapData);
        return lspCompletionItems;
      }
    }
    return null;
  }
);

function firstFileChangeIsCurrent(change: ts.FileTextChanges, virtualTsxFilename: string): boolean {
    return change.fileName === virtualTsxFilename && change.textChanges.length > 0;
}

function mapTsCompletionKindToLspKind(tsKind: ts.ScriptElementKind): CompletionItemKind {
  // ... (implementation as previously defined)
  switch (tsKind) {
    case ts.ScriptElementKind.moduleElement: case ts.ScriptElementKind.externalModuleName: return CompletionItemKind.Module;
    case ts.ScriptElementKind.classElement: return CompletionItemKind.Class;
    case ts.ScriptElementKind.interfaceElement: return CompletionItemKind.Interface;
    case ts.ScriptElementKind.memberFunctionElement: case ts.ScriptElementKind.constructSignatureElement: case ts.ScriptElementKind.callSignatureElement: case ts.ScriptElementKind.indexSignatureElement: return CompletionItemKind.Method;
    case ts.ScriptElementKind.memberVariableElement: case ts.ScriptElementKind.memberGetAccessorElement: case ts.ScriptElementKind.memberSetAccessorElement: return CompletionItemKind.Field;
    case ts.ScriptElementKind.variableElement: case ts.ScriptElementKind.letElement: case ts.ScriptElementKind.constElement: case ts.ScriptElementKind.parameterElement: return CompletionItemKind.Variable;
    case ts.ScriptElementKind.functionElement: case ts.ScriptElementKind.localFunctionElement: return CompletionItemKind.Function;
    case ts.ScriptElementKind.keyword: return CompletionItemKind.Keyword;
    case ts.ScriptElementKind.primitiveType: return CompletionItemKind.Unit;
    case ts.ScriptElementKind.string: return CompletionItemKind.Text;
    default: return CompletionItemKind.Text;
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
    const documentText = document.getText();
    let literalIndex = 0;

    for (const literal of pugLiterals) {
      const currentLiteralIndex = literalIndex++;
      const docOffset = positionToOffset(documentText, textDocumentPosition.position);
      const literalContentStartOffset = positionToOffset(documentText, literal.contentRange.start);
      const literalContentEndOffset = positionToOffset(documentText, literal.contentRange.end);

      if (docOffset >= literalContentStartOffset && docOffset <= literalContentEndOffset) {
        const rawPugInLiteral = literal.content;
        const { declarations: localDeclarations, paramTexts: localParamTexts } = extractDeclarationsAndParamsFromScope(literal.enclosingScopeNode, documentText);
        const cursorPugPosition = Position.create(
          textDocumentPosition.position.line - literal.contentRange.start.line,
          textDocumentPosition.position.character - (textDocumentPosition.position.line === literal.contentRange.start.line ? literal.contentRange.start.character : 0)
        );
        const babelInputFilename = `${document.uri}/literal-${currentLiteralIndex}.pug.virtual.js`;
        const virtualTsxFilename = `${document.uri}/literal-${currentLiteralIndex}.pug.virtual.tsx`;
        const compileResult = compilePugToJsxString(rawPugInLiteral, { classAttribute: settings.classAttribute }, babelInputFilename);

        if (compileResult.error || !compileResult.jsx || !compileResult.sourceMap) continue;
        const mapData = await parseSourceMap(compileResult.sourceMap, rawPugInLiteral, compileResult.jsx);
        if (!mapData) continue;
        const jsxPosition = mapPugPositionToJsxPosition(cursorPugPosition, mapData);
        if (!jsxPosition) { destroySourceMapData(mapData); continue; }

        const virtualTsxContent = `
${importStatements.join('\n')}
${localParamTexts.join('\n')}
${localDeclarations.join('\n')}
import React from 'react';
const PugComponent = () => (<>${compileResult.jsx}</>);
export default PugComponent;
        `;
        updateVirtualFile(virtualTsxFilename, virtualTsxContent);
        const jsxOffset = positionToOffset(virtualTsxContent, jsxPosition);
        const quickInfo = tsLangService.getQuickInfoAtPosition(virtualTsxFilename, jsxOffset);

        if (!quickInfo) { destroySourceMapData(mapData); return null; }

        let hoverContentsValue = displayPartsToString(quickInfo.displayParts);
        if (quickInfo.documentation?.length) hoverContentsValue += "\n\n---\n" + displayPartsToString(quickInfo.documentation);
        let hoverRange: Range | undefined = undefined;

        if (quickInfo.textSpan) {
          const jsxSourceFile = tsLangService.getProgram()?.getSourceFile(virtualTsxFilename);
          if (jsxSourceFile) {
            const startLoc = ts.getLineAndCharacterOfPosition(jsxSourceFile, quickInfo.textSpan.start);
            const endLoc = ts.getLineAndCharacterOfPosition(jsxSourceFile, quickInfo.textSpan.start + quickInfo.textSpan.length);
            const jsxRangeVal = Range.create(startLoc.line, startLoc.character, endLoc.line, endLoc.character);
            const mappedPugRange = mapJsxRangeToPugRange(jsxRangeVal, mapData);
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
        return { contents: { kind: 'markdown', value: hoverContentsValue }, range: hoverRange };
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
    const documentText = document.getText();
    let literalIndex = 0;

    for (const literal of pugLiterals) {
      const currentLiteralIndex = literalIndex++;
      const docOffset = positionToOffset(documentText, textDocumentPosition.position);
      const literalContentStartOffset = positionToOffset(documentText, literal.contentRange.start);
      const literalContentEndOffset = positionToOffset(documentText, literal.contentRange.end);

      if (docOffset >= literalContentStartOffset && docOffset <= literalContentEndOffset) {
        const rawPugInLiteral = literal.content;
        const { declarations: localDeclarations, paramTexts: localParamTexts } = extractDeclarationsAndParamsFromScope(literal.enclosingScopeNode, documentText);
        const cursorPugPosition = Position.create(
          textDocumentPosition.position.line - literal.contentRange.start.line,
          textDocumentPosition.position.character - (textDocumentPosition.position.line === literal.contentRange.start.line ? literal.contentRange.start.character : 0)
        );
        const babelInputFilename = `${document.uri}/literal-${currentLiteralIndex}.pug.virtual.js`;
        const virtualTsxFilename = `${document.uri}/literal-${currentLiteralIndex}.pug.virtual.tsx`;
        const compileResult = compilePugToJsxString(rawPugInLiteral, { classAttribute: settings.classAttribute }, babelInputFilename);

        if (compileResult.error || !compileResult.jsx || !compileResult.sourceMap) continue;
        const mapData = await parseSourceMap(compileResult.sourceMap, rawPugInLiteral, compileResult.jsx);
        if (!mapData) continue;
        const jsxPosition = mapPugPositionToJsxPosition(cursorPugPosition, mapData);
        if (!jsxPosition) { destroySourceMapData(mapData); continue; }

        const virtualTsxContent = `
${importStatements.join('\n')}
${localParamTexts.join('\n')}
${localDeclarations.join('\n')}
import React from 'react';
const PugComponent = () => (<>${compileResult.jsx}</>);
export default PugComponent;
        `;
        updateVirtualFile(virtualTsxFilename, virtualTsxContent);
        const jsxOffset = positionToOffset(virtualTsxContent, jsxPosition);
        const definitionInfo = tsLangService.getDefinitionAtPosition(virtualTsxFilename, jsxOffset);

        if (!definitionInfo || definitionInfo.length === 0) { destroySourceMapData(mapData); return null; }

        const locations: Location[] = [];
        const tsProgram = tsLangService.getProgram();
        for (const defSite of definitionInfo) {
          const targetFileName = defSite.fileName;
          const targetTextSpan = defSite.textSpan;
          const targetSourceFile = tsProgram?.getSourceFile(targetFileName);
          if (!targetSourceFile) continue;

          const startLoc = ts.getLineAndCharacterOfPosition(targetSourceFile, targetTextSpan.start);
          const endLoc = ts.getLineAndCharacterOfPosition(targetSourceFile, targetTextSpan.start + targetTextSpan.length);
          const targetRange = Range.create(startLoc.line, startLoc.character, endLoc.line, endLoc.character);

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
              locations.push({ uri: pathToFileURL(targetFileName).toString(), range: targetRange });
            } catch (e) { /* console.error */ }
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
