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
import { transformJsxSnippetToPug } from './utils/jsxToPugSnippet';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

const astCache = new Map<string, { version: number, ast: acorn.Node }>();
const pugCompilationCache = new Map<string, PugToJsxResult>();
const virtualFiles = new Map<string, { version: number, snapshot: ts.IScriptSnapshot, content: string }>();

const tsLangServiceHost: ts.LanguageServiceHost = {
  getScriptFileNames: () => Array.from(virtualFiles.keys()),
  getScriptVersion: (fileName) => virtualFiles.get(fileName)?.version.toString() || "0",
  getScriptSnapshot: (fileName) => virtualFiles.get(fileName)?.snapshot,
  getCurrentDirectory: () => process.cwd(),
  getCompilationSettings: () => ({
    jsx: ts.JsxEmit.ReactJSX, allowJs: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, esModuleInterop: true, allowNonTsExtensions: true,
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
  content: string; range: Range; contentRange: Range; indentation: string;
  enclosingScopeNode?: acorn.Node;
}

interface ReactPugSettings { maxNumberOfProblems: number; classAttribute: string; }
const defaultSettings: ReactPugSettings = { maxNumberOfProblems: 100, classAttribute: 'className' };
let globalSettings: ReactPugSettings = defaultSettings;
const documentSettings: Map<string, Thenable<ReactPugSettings>> = new Map();
let oldPugLanguageService: IReactPugLanguageService;
let hasConfigurationCapability = false;

connection.onInitialize((params: InitializeParams) => {
  hasConfigurationCapability = !!(params.capabilities.workspace && !!params.capabilities.workspace.configuration);
  let initialSettings = { ...globalSettings };
  if (params.initializationOptions?.classAttribute) {
    initialSettings.classAttribute = params.initializationOptions.classAttribute;
  }
  oldPugLanguageService = createReactPugLanguageService(initialSettings);
  globalSettings = initialSettings;
  connection.console.log('React Pug Language Server initialized.');
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { resolveProvider: false }, hoverProvider: true, definitionProvider: true,
    }
  };
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
  astCache.clear();
  pugCompilationCache.clear();
  connection.console.log(`Configuration changed. Active classAttribute: ${newSettings.classAttribute}`);
  documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ReactPugSettings> { /* ... (as before) ... */
  if (!hasConfigurationCapability) { return Promise.resolve(globalSettings); }
  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({ scopeUri: resource, section: 'reactPug' }).then(s => s || globalSettings);
    documentSettings.set(resource, result);
  }
  return result;
}

documents.onDidClose(e => { documentSettings.delete(e.document.uri); astCache.delete(e.document.uri); });
documents.onDidChangeContent(change => { validateTextDocument(change.document); });

function findPugLiterals(textDocument: TextDocument): PugLiteralInfo[] { /* ... (as before with acorn-walk and enclosingScopeNode) ... */
  const results: PugLiteralInfo[] = [];
  const text = textDocument.getText();
  const cachedAstEntry = astCache.get(textDocument.uri);
  let ast: acorn.Node;
  if (cachedAstEntry && cachedAstEntry.version === textDocument.version) {
    ast = cachedAstEntry.ast;
  } else {
    try {
      ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowReturnOutsideFunction: true, allowImportExportEverywhere: true, allowAwaitOutsideFunction: true, allowSuperOutsideMethod: true, allowHashBang: true }) as acorn.Node;
      astCache.set(textDocument.uri, { version: textDocument.version, ast });
    } catch (e: any) { connection.console.warn(`Acorn parsing error in findPugLiterals: ${e.message}`); return results; }
  }
  try {
    walk.ancestor(ast, {
      TaggedTemplateExpression: (node, ancestors: acorn.Node[]) => {
        const ttNode = node as any;
        if (ttNode.tag.type === 'Identifier' && ttNode.tag.name === 'pug') {
          if (ttNode.quasi?.quasis?.length > 0) {
            const nodeRange = Range.create(Position.create(ttNode.loc.start.line - 1, ttNode.loc.start.column), Position.create(ttNode.loc.end.line - 1, ttNode.loc.end.column));
            const contentRange = Range.create(Position.create(ttNode.quasi.loc.start.line - 1, ttNode.quasi.loc.start.column + 1), Position.create(ttNode.quasi.loc.end.line - 1, ttNode.quasi.loc.end.column - 1));
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
            const match = textDocument.getText(Range.create(Position.create(contentRange.start.line, 0), contentRange.start)).match(/^(\s*)/);
            if (match) indentation = match[1];
            let enclosingScopeNode: acorn.Node | undefined = ancestors.slice().reverse().find(a => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'BlockStatement', 'Program'].includes(a.type)) || ancestors[0];
            results.push({ content: extractedContent, range: nodeRange, contentRange: contentRange, indentation: indentation, enclosingScopeNode });
          }
        }
      }
    });
  } catch (e: any) { connection.console.warn(`Error during AST walk in findPugLiterals: ${e.message}`); }
  return results;
}

interface ExtractedScopeInfo { declarations: string[]; parameterNames: string[]; }

function extractDeclarationsAndParamsFromScope(scopeNode: acorn.Node | undefined, documentText: string): ExtractedScopeInfo {
  const result: ExtractedScopeInfo = { declarations: [], parameterNames: [] };
  if (!scopeNode) return result;

  function extractNamesFromPattern(patternNode: any, names: string[]) {
    if (!patternNode) return;
    if (patternNode.type === 'Identifier') names.push(patternNode.name);
    else if (patternNode.type === 'ObjectPattern') patternNode.properties.forEach(prop => extractNamesFromPattern(prop.value, names));
    else if (patternNode.type === 'ArrayPattern') patternNode.elements.forEach(el => el && extractNamesFromPattern(el, names));
    else if (patternNode.type === 'RestElement') extractNamesFromPattern(patternNode.argument, names);
    else if (patternNode.type === 'AssignmentPattern') extractNamesFromPattern(patternNode.left, names);
  }

  let bodyNodes: acorn.Node[] = [];
  if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(scopeNode.type)) {
    const funcNode = scopeNode as any;
    if (Array.isArray(funcNode.params)) funcNode.params.forEach(param => extractNamesFromPattern(param, result.parameterNames));
    if (funcNode.body?.type === 'BlockStatement' && Array.isArray(funcNode.body.body)) bodyNodes = funcNode.body.body;
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

function extractImportStatements(document: TextDocument): string[] { /* ... (as before, using astCache) ... */
  const importStatements: string[] = [];
  const text = document.getText();
  const cachedAstEntry = astCache.get(document.uri);
  let ast: acorn.Node;
  if (cachedAstEntry && cachedAstEntry.version === document.version) {
    ast = cachedAstEntry.ast;
  } else {
    try {
      ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowReturnOutsideFunction: true, allowImportExportEverywhere: true, allowAwaitOutsideFunction: true, allowSuperOutsideMethod: true, allowHashBang: true }) as acorn.Node;
      astCache.set(document.uri, { version: document.version, ast });
    } catch (e: any) { connection.console.warn(`Acorn parsing error in extractImportStatements: ${e.message}`); return importStatements; }
  }
  try {
    const body = (ast as any).body || ((ast as any).program?.body);
    if (Array.isArray(body)) {
      for (const node of body) {
        if (node.type === 'ImportDeclaration' && typeof node.start === 'number' && typeof node.end === 'number') {
          importStatements.push(text.substring(node.start, node.end));
        }
      }
    }
  } catch (e: any) { connection.console.warn(`Error during AST access in extractImportStatements: ${e.message}`);}
  return importStatements;
}

// Centralized function to get or compile Pug
async function getOrCompilePug(rawPugInLiteral: string, settings: ReactPugSettings, babelInputFilename: string): Promise<PugToJsxResult> {
  const compilationCacheKey = `${settings.classAttribute}###${rawPugInLiteral}`;
  let compileResult = pugCompilationCache.get(compilationCacheKey);
  if (!compileResult) {
    compileResult = compilePugToJsxString(rawPugInLiteral, { classAttribute: settings.classAttribute }, babelInputFilename);
    pugCompilationCache.set(compilationCacheKey, compileResult);
  }
  return compileResult;
}

// Centralized function to create virtual TSX content
function createVirtualTsxContent(
  importStatements: string[],
  parameterNames: string[],
  localDeclarations: string[],
  jsx: string
): string {
  const paramDeclarations = parameterNames.map(name => `let ${name}: any;`).join('\n');
  return `
${importStatements.join('\n')}
${paramDeclarations}
${localDeclarations.join('\n')}
import React from 'react';
const PugComponent = () => (<>${jsx}</>);
export default PugComponent;
  `;
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
    const { declarations: localDeclarations, parameterNames } = extractDeclarationsAndParamsFromScope(literal.enclosingScopeNode, documentText);
    const babelInputFilename = `${textDocument.uri}/literal-${currentLiteralIndex}.pug.virtual.js`;
    const virtualTsxFilename = `${textDocument.uri}/literal-${currentLiteralIndex}.pug.virtual.tsx`;

    const compileResult = await getOrCompilePug(rawPugInLiteral, settings, babelInputFilename);

    if (compileResult.error || !compileResult.jsx || !compileResult.sourceMap) { /* ... (error handling as before) ... */
      diagnostics.push({ severity: DiagnosticSeverity.Error, range: literal.contentRange, message: `Pug to JSX compilation failed: ${compileResult.error || 'Unknown error.'}`, source: 'React Pug (Compiler)'});
      continue;
    }
    const virtualTsxContent = createVirtualTsxContent(importStatements, parameterNames, localDeclarations, compileResult.jsx);
    updateVirtualFile(virtualTsxFilename, virtualTsxContent);

    const allTsDiagnostics = [...tsLangService.getSyntacticDiagnostics(virtualTsxFilename), ...tsLangService.getSemanticDiagnostics(virtualTsxFilename)];
    const mapData = await parseSourceMap(compileResult.sourceMap, rawPugInLiteral, compileResult.jsx);
    if (!mapData) { /* ... (unmapped error handling as before) ... */
      allTsDiagnostics.forEach(tsDiag => diagnostics.push({ severity: tsDiag.category === ts.DiagnosticCategory.Error ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning, range: literal.contentRange, message: `(Unmapped TSX) ${ts.flattenDiagnosticMessageText(tsDiag.messageText, '\n')}`, source: 'React Pug (TS)', code: tsDiag.code }));
      continue;
    }
    for (const tsDiag of allTsDiagnostics) { /* ... (diagnostic mapping as before) ... */
      if (tsDiag.start === undefined || tsDiag.length === undefined) continue;
      const sourceFile = tsLangService.getProgram()?.getSourceFile(virtualTsxFilename);
      if (!sourceFile) { diagnostics.push({ severity: DiagnosticSeverity.Warning, range: literal.contentRange, message: `(Internal Error) No sourceFile for ${virtualTsxFilename}`, source: 'React Pug (Mapping)'}); continue; }
      const startLoc = ts.getLineAndCharacterOfPosition(sourceFile, tsDiag.start);
      const endLoc = ts.getLineAndCharacterOfPosition(sourceFile, tsDiag.start + tsDiag.length);
      const finalJsxDiagRange = Range.create(startLoc.line, startLoc.character, endLoc.line, endLoc.character);
      const pugRange = mapJsxRangeToPugRange(finalJsxDiagRange, mapData);
      if (pugRange) {
        diagnostics.push({ severity: tsDiag.category === ts.DiagnosticCategory.Error ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning, range: Range.create(literal.contentRange.start.line + pugRange.start.line, (pugRange.start.line === 0 ? literal.contentRange.start.character : 0) + pugRange.start.character, literal.contentRange.start.line + pugRange.end.line, (pugRange.end.line === 0 ? literal.contentRange.start.character : 0) + pugRange.end.character), message: ts.flattenDiagnosticMessageText(tsDiag.messageText, '\n'), source: 'React Pug (TS)', code: tsDiag.code });
      } else {
        diagnostics.push({ severity: DiagnosticSeverity.Warning, range: literal.contentRange, message: `(Unmapped TSX) ${ts.flattenDiagnosticMessageText(tsDiag.messageText, '\n')}`, source: 'React Pug (TS Mapping)', code: tsDiag.code });
      }
    }
    destroySourceMapData(mapData);
  }
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onCompletion( async (textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[] | null> => { /* ... (updated to use getOrCompilePug and createVirtualTsxContent) ... */
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
        const { declarations: localDeclarations, parameterNames } = extractDeclarationsAndParamsFromScope(literal.enclosingScopeNode, documentText);
        const cursorPugPosition = Position.create(textDocumentPosition.position.line - literal.contentRange.start.line, textDocumentPosition.position.character - (textDocumentPosition.position.line === literal.contentRange.start.line ? literal.contentRange.start.character : 0));
        const babelInputFilename = `${document.uri}/literal-${currentLiteralIndex}.pug.virtual.js`;
        const virtualTsxFilename = `${document.uri}/literal-${currentLiteralIndex}.pug.virtual.tsx`;
        const compileResult = await getOrCompilePug(rawPugInLiteral, settings, babelInputFilename);
        if (compileResult.error || !compileResult.jsx || !compileResult.sourceMap) continue;
        const mapData = await parseSourceMap(compileResult.sourceMap, rawPugInLiteral, compileResult.jsx);
        if (!mapData) continue;
        const jsxPosition = mapPugPositionToJsxPosition(cursorPugPosition, mapData);
        if (!jsxPosition) { destroySourceMapData(mapData); continue; }
        const virtualTsxContent = createVirtualTsxContent(importStatements, parameterNames, localDeclarations, compileResult.jsx);
        updateVirtualFile(virtualTsxFilename, virtualTsxContent);
        const jsxOffset = positionToOffset(virtualTsxContent, jsxPosition);
        const tsCompletions = tsLangService.getCompletionsAtPosition(virtualTsxFilename, jsxOffset, undefined);
        if (!tsCompletions || !tsCompletions.entries) { destroySourceMapData(mapData); return null; }
        const lspCompletionItems: CompletionItem[] = [];
        const tsProgram = tsLangService.getProgram();
        for (const entry of tsCompletions.entries) {
          const details = tsLangService.getCompletionEntryDetails(virtualTsxFilename, jsxOffset, entry.name, undefined, entry.source, undefined, entry.data);
          const lspItem: CompletionItem = { label: entry.name, kind: mapTsCompletionKindToLspKind(entry.kind), detail: details?.displayParts ? displayPartsToString(details.displayParts) : undefined, documentation: details?.documentation ? displayPartsToString(details.documentation) : undefined };
          if (details?.codeActions?.length && details.codeActions[0].changes?.length && firstFileChangeIsCurrent(details.codeActions[0].changes[0], virtualTsxFilename)) {
            const tsTextChange = details.codeActions[0].changes[0].textChanges[0];
            const jsxSourceFile = tsProgram?.getSourceFile(virtualTsxFilename);
            if (jsxSourceFile && tsTextChange) {
              const startLoc = ts.getLineAndCharacterOfPosition(jsxSourceFile, tsTextChange.span.start);
              const endLoc = ts.getLineAndCharacterOfPosition(jsxSourceFile, tsTextChange.span.start + tsTextChange.span.length);
              const jsxRange = Range.create(startLoc.line, startLoc.character, endLoc.line, endLoc.character);
              const pugRange = mapJsxRangeToPugRange(jsxRange, mapData);
              if (pugRange) {
                const transformedNewText = transformJsxSnippetToPug(tsTextChange.newText) ?? tsTextChange.newText;
                lspItem.textEdit = TextEdit.replace(Range.create(literal.contentRange.start.line + pugRange.start.line, (pugRange.start.line === 0 ? literal.contentRange.start.character : 0) + pugRange.start.character, literal.contentRange.start.line + pugRange.end.line, (pugRange.end.line === 0 ? literal.contentRange.start.character : 0) + pugRange.end.character), transformedNewText);
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

function firstFileChangeIsCurrent(change: ts.FileTextChanges, virtualTsxFilename: string): boolean { /* ... (as before) ... */
    return change.fileName === virtualTsxFilename && change.textChanges.length > 0;
}
function mapTsCompletionKindToLspKind(tsKind: ts.ScriptElementKind): CompletionItemKind { /* ... (as before) ... */
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
function displayPartsToString(displayParts: ts.SymbolDisplayPart[] | undefined): string { /* ... (as before) ... */
  if (!displayParts) return "";
  return displayParts.map(part => part.text).join("");
}

connection.onHover( async (textDocumentPosition: TextDocumentPositionParams): Promise<Hover | null> => { /* ... (updated to use getOrCompilePug and createVirtualTsxContent) ... */
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
        const { declarations: localDeclarations, parameterNames } = extractDeclarationsAndParamsFromScope(literal.enclosingScopeNode, documentText);
        const cursorPugPosition = Position.create(textDocumentPosition.position.line - literal.contentRange.start.line, textDocumentPosition.position.character - (textDocumentPosition.position.line === literal.contentRange.start.line ? literal.contentRange.start.character : 0));
        const babelInputFilename = `${document.uri}/literal-${currentLiteralIndex}.pug.virtual.js`;
        const virtualTsxFilename = `${document.uri}/literal-${currentLiteralIndex}.pug.virtual.tsx`;
        const compileResult = await getOrCompilePug(rawPugInLiteral, settings, babelInputFilename);
        if (compileResult.error || !compileResult.jsx || !compileResult.sourceMap) continue;
        const mapData = await parseSourceMap(compileResult.sourceMap, rawPugInLiteral, compileResult.jsx);
        if (!mapData) continue;
        const jsxPosition = mapPugPositionToJsxPosition(cursorPugPosition, mapData);
        if (!jsxPosition) { destroySourceMapData(mapData); continue; }
        const virtualTsxContent = createVirtualTsxContent(importStatements, parameterNames, localDeclarations, compileResult.jsx);
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
              hoverRange = Range.create(literal.contentRange.start.line + mappedPugRange.start.line, (mappedPugRange.start.line === 0 ? literal.contentRange.start.character : 0) + mappedPugRange.start.character, literal.contentRange.start.line + mappedPugRange.end.line, (mappedPugRange.end.line === 0 ? literal.contentRange.start.character : 0) + mappedPugRange.end.character);
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

connection.onDefinition( async (textDocumentPosition: TextDocumentPositionParams): Promise<Location[] | null> => { /* ... (updated to use getOrCompilePug and createVirtualTsxContent) ... */
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
        const { declarations: localDeclarations, parameterNames } = extractDeclarationsAndParamsFromScope(literal.enclosingScopeNode, documentText);
        const cursorPugPosition = Position.create(textDocumentPosition.position.line - literal.contentRange.start.line, textDocumentPosition.position.character - (textDocumentPosition.position.line === literal.contentRange.start.line ? literal.contentRange.start.character : 0));
        const babelInputFilename = `${document.uri}/literal-${currentLiteralIndex}.pug.virtual.js`;
        const virtualTsxFilename = `${document.uri}/literal-${currentLiteralIndex}.pug.virtual.tsx`;
        const compileResult = await getOrCompilePug(rawPugInLiteral, settings, babelInputFilename);
        if (compileResult.error || !compileResult.jsx || !compileResult.sourceMap) continue;
        const mapData = await parseSourceMap(compileResult.sourceMap, rawPugInLiteral, compileResult.jsx);
        if (!mapData) continue;
        const jsxPosition = mapPugPositionToJsxPosition(cursorPugPosition, mapData);
        if (!jsxPosition) { destroySourceMapData(mapData); continue; }
        const virtualTsxContent = createVirtualTsxContent(importStatements, parameterNames, localDeclarations, compileResult.jsx);
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
              locations.push({ uri: document.uri, range: Range.create(literal.contentRange.start.line + mappedPugRange.start.line, (mappedPugRange.start.line === 0 ? literal.contentRange.start.character : 0) + mappedPugRange.start.character, literal.contentRange.start.line + mappedPugRange.end.line, (mappedPugRange.end.line === 0 ? literal.contentRange.start.character : 0) + mappedPugRange.end.character )});
            }
          } else {
            try { locations.push({ uri: pathToFileURL(targetFileName).toString(), range: targetRange }); } catch (e) { /* console.error */ }
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
