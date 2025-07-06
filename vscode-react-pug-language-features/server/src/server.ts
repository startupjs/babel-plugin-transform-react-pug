import {
  createConnection,
  TextDocuments,
  Diagnostic,
  // DiagnosticSeverity, // No longer used directly here after changes
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  CompletionItem,
  // CompletionItemKind, // No longer used directly here
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  Range,
  Position,
  Hover, // Added for onHover
  TextEdit // Added for onCompletion item.textEdit
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import * as acorn from 'acorn';

import { IReactPugLanguageService, createReactPugLanguageService, PreprocessedPug } from './reactPugLanguageService';
// Position mapping will change with JSX-centric approach, so these specific imports might change/remove.
// For now, keep them if direct Pug analysis is a fallback.
// import { mapDocumentPositionToPurePug, mapPurePugRangeToDocument } from './positionMapping';
import { positionToOffset } from './utils/textPositions';
import { compilePugToJsxString } from './pugToJsxTransformer';
import { parseSourceMap, JsxPugSourceMapData } from './jsxPugMapping';


const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// PugLiteralInfo interface (ensure it's defined, or imported if moved)
export interface PugLiteralInfo { // Export if used by positionMapping.ts directly, or keep internal
  content: string; // Raw content of quasi (JS expressions included as raw text)
  range: Range; // Range of the entire TaggedTemplateExpression node
  contentRange: Range; // Range of the pug template content itself (inside backticks)
  indentation: string; // Leading indentation of the pug block
}

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
// let hasDiagnosticRelatedInformationCapability = false;

// Settings interfaces are now often defined in the service or shared
// For server.ts, it primarily consumes them or passes them on.
// Re-defining or importing if needed for strong typing here.
interface ReactPugSettings {
  maxNumberOfProblems: number;
  classAttribute: string;
}

const defaultSettings: ReactPugSettings = { maxNumberOfProblems: 100, classAttribute: 'className' };
let globalSettings: ReactPugSettings = defaultSettings;

const documentSettings: Map<string, Thenable<ReactPugSettings>> = new Map();
let languageService: IReactPugLanguageService;

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;
  hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);
  hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders);
  // hasDiagnosticRelatedInformationCapability = !!(capabilities.textDocument && capabilities.textDocument.publishDiagnostics && capabilities.textDocument.publishDiagnostics.relatedInformation);

  // Initialize with global settings, potentially updated by initializationOptions
  let initialSettings = { ...globalSettings };
  if (params.initializationOptions?.classAttribute) {
    initialSettings.classAttribute = params.initializationOptions.classAttribute;
  }
  languageService = createReactPugLanguageService(initialSettings);
  globalSettings = initialSettings; // Ensure globalSettings reflects this too

  connection.console.log('React Pug Language Server initialized.');

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { resolveProvider: false }, // Set to true if onCompletionResolve is implemented
      hoverProvider: true,
    }
  };
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }
  // Workspace folder change listening can be added here if needed
});

connection.onDidChangeConfiguration(async (change) => {
  if (hasConfigurationCapability) {
    documentSettings.clear(); // Clear all cached settings
  } else {
    globalSettings = (change.settings.reactPug || defaultSettings) as ReactPugSettings;
  }
  // Fetch new settings for the currently open documents or use new global if no specific scope
  // For simplicity, we'll re-initialize the language service with potentially new global settings.
  // A more granular approach would update settings per resource.
  const newSettings = await getDocumentSettings(''); // Get global settings for the service
  languageService = createReactPugLanguageService(newSettings);

  connection.console.log(`Configuration changed. Active classAttribute: ${newSettings.classAttribute}`);
  documents.all().forEach(validateTextDocument); // Revalidate all open documents
});

async function getDocumentSettings(resource: string): Promise<ReactPugSettings> { // Return Promise<ReactPugSettings>
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }
  let settings = documentSettings.get(resource);
  if (!settings) {
    settings = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: 'reactPug'
    }).then(s => s || globalSettings); // Fallback to global if specific is null/undefined
    documentSettings.set(resource, settings);
  }
  return settings;
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

          // Extract the raw text content, including the JS expressions as text
          let extractedContent = "";
          let lastQuasiEnd = node.quasi.loc.start.column + 1; // Start after the first backtick

          for (let i = 0; i < node.quasi.quasis.length; i++) {
            const quasi = node.quasi.quasis[i];
            // Get text for the quasi part
            const quasiStartPos = Position.create(quasi.loc.start.line - 1, quasi.loc.start.column);
            const quasiEndPos = Position.create(quasi.loc.end.line - 1, quasi.loc.end.column);
            extractedContent += textDocument.getText(Range.create(quasiStartPos, quasiEndPos));

            if (i < node.quasi.expressions.length) {
              const expr = node.quasi.expressions[i];
              // Get text for the expression part
              const exprStartPos = Position.create(expr.loc.start.line - 1, expr.loc.start.column);
              const exprEndPos = Position.create(expr.loc.end.line - 1, expr.loc.end.column);
              extractedContent += `\${${textDocument.getText(Range.create(exprStartPos, exprEndPos))}}`;
            }
          }

          let indentation = "";
          // Get text from start of line of opening backtick to the backtick itself
          const lineOfOpeningBacktick = contentStartPosition.line;
          const textBeforeBacktick = textDocument.getText(Range.create(
            Position.create(lineOfOpeningBacktick, 0),
            Position.create(lineOfOpeningBacktick, contentStartPosition.character -1) // char before the content starts
          ));
          const match = textBeforeBacktick.match(/^(\s*)/);
          if (match) {
            indentation = match[1];
          }

          results.push({
            content: extractedContent,
            range: nodeRange,
            contentRange: contentRange,
            indentation: indentation
          });
        }
      }
    });
  } catch (e: any) {
    connection.console.warn(`Acorn parsing error in findPugLiterals: ${e.message}. Document: ${textDocument.uri}`);
  }
  return results;
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  const settings = await getDocumentSettings(textDocument.uri);
  // Ensure service is initialized, possibly with updated settings from getDocumentSettings if it changed globalSettings
  if (!languageService || globalSettings.classAttribute !== settings.classAttribute /* crude check */) {
    languageService = createReactPugLanguageService(settings);
  }

  const diagnostics: Diagnostic[] = [];
  const pugLiterals = findPugLiterals(textDocument);

  for (const literal of pugLiterals) {
    const rawPugInLiteral = textDocument.getText(literal.contentRange);

    // Generate a unique filename for this literal for source map processing
    const virtualPugFilename = `${textDocument.uri}/literal-${literal.contentRange.start.line}-${literal.contentRange.start.character}.pug`;
    // The filename passed to babel needs to be what the source map will refer to as a source.
    const virtualJsxInputFilename = `${virtualPugFilename}.virtual.js`;


    connection.console.log(`Processing Pug literal at L${literal.contentRange.start.line} C${literal.contentRange.start.character}`);
    connection.console.log(`Original Pug:\n${rawPugInLiteral}`);

    const compileResult = compilePugToJsxString(rawPugInLiteral, { classAttribute: settings.classAttribute }, virtualJsxInputFilename);

    if (compileResult.error) {
      connection.console.error(`Pug to JSX compilation error: ${compileResult.error}`);
      // Create a diagnostic for the whole Pug literal if compilation fails
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: literal.contentRange,
        message: `Pug to JSX compilation failed: ${compileResult.error}`,
        source: 'React Pug Compiler',
      });
      continue; // Move to next literal
    }

    if (compileResult.jsx) {
      connection.console.log(`Generated JSX:\n${compileResult.jsx}`);
    }

    if (compileResult.sourceMap) {
      connection.console.log(`Source Map generated: Yes`);
      // console.log(JSON.stringify(compileResult.sourceMap, null, 2)); // Detailed log

      // Attempt to parse and use the source map (example, actual usage in diagnostics comes later)
      // const smData = await parseSourceMap(compileResult.sourceMap, rawPugInLiteral, compileResult.jsx || "");
      // if (smData) {
      //   connection.console.log('Source map parsed successfully.');
      //   // Example: try mapping a JSX position back to Pug (for future use)
      //   // const jsxPos = Position.create(0,1); // e.g. <p> -> 'p'
      //   // const pugPos = mapJsxPositionToPugPosition(jsxPos, smData);
      //   // if (pugPos) {
      //   //   connection.console.log(`JSX ${jsxPos.line}:${jsxPos.character} maps to Pug ${pugPos.line}:${pugPos.character}`);
      //   // } else {
      //   //   connection.console.log(`No mapping for JSX ${jsxPos.line}:${jsxPos.character}`);
      //   // }
      //   destroySourceMapData(smData); // Clean up
      // } else {
      //   connection.console.warn('Failed to parse generated source map.');
      // }
    } else {
      connection.console.warn('No source map generated from Pug-to-JSX compilation.');
    }

    // TODO: Placeholder for getting diagnostics from a TS/JSX service on compileResult.jsx
    // For now, we'll keep the old direct Pug parsing as a fallback or supplementary diagnostic source.
    // This part will be removed/replaced when TS/JSX service integration happens (Phase 2)
    if (languageService) { // languageService is for direct Pug parsing
        const preprocessed: PreprocessedPug = languageService.preprocessPug(rawPugInLiteral, literal.indentation, textDocument.uri);
        const parsed = languageService.parsePug(preprocessed, textDocument.uri);
        const pugDiagnostics = languageService.doValidation(parsed);
        for (const diag of pugDiagnostics) {
            // const mappedRange = mapPurePugRangeToDocument(diag.range, literal, preprocessed.mappingData, textDocument);
            // The mapPurePugRangeToDocument is for the old preprocessing. We need a fallback or different mapping for direct pug errors.
            // For now, let's use the literal's contentRange if mapping direct pug errors.
             diagnostics.push({
                ...diag,
                range: Range.create( // Adjust range to be within the document
                    literal.contentRange.start.line + diag.range.start.line,
                    (diag.range.start.line === 0 ? literal.contentRange.start.character : 0) + diag.range.start.character,
                    literal.contentRange.start.line + diag.range.end.line,
                    (diag.range.end.line === 0 ? literal.contentRange.start.character : 0) + diag.range.end.character
                ),
                message: `(Direct Pug) ${diag.message}`
            });
        }
    }
  }
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onCompletion(
  async (textDocumentPosition: TextDocumentPositionParams): Promise<CompletionList | null> => {
    const document = documents.get(textDocumentPosition.textDocument.uri);
    if (!document) return null;

    const settings = await getDocumentSettings(document.uri);
    if (!languageService) languageService = createReactPugLanguageService(settings); // Old service for fallback

    const pugLiterals = findPugLiterals(document);
    for (const literal of pugLiterals) {
      const docOffset = positionToOffset(document.getText(), textDocumentPosition.position);
      const literalContentStartOffset = positionToOffset(document.getText(), literal.contentRange.start);
      const literalContentEndOffset = positionToOffset(document.getText(), literal.contentRange.end);

      if (docOffset >= literalContentStartOffset && docOffset <= literalContentEndOffset) {
        // TODO: New JSX-based completion logic will go here in Phase 2
        // 1. Get Pug literal content: rawPugInLiteral
        // 2. Map Pug cursor to equivalent conceptual JSX cursor position (using mapPugPositionToJsxPosition)
        //    This requires a source map from Pug -> JSX.
        // 3. Compile Pug to JSX: compileResult = compilePugToJsxString(...)
        // 4. If compilation and source map are good:
        //    const mapData = await parseSourceMap(compileResult.sourceMap, rawPugInLiteral, compileResult.jsx);
        //    const jsxPosition = mapPugPositionToJsxPosition(pugCursorInLiteral, mapData);
        //    If jsxPosition:
        //       Get completions from TS/JSX service for virtual JSX at jsxPosition.
        //       Map TextEdits in results from JSX ranges back to Pug ranges using mapJsxRangeToPugRange.
        // For now, falling back to old direct Pug completion logic:
        const rawPugInLiteral = textDocument.getText(literal.contentRange);
        const preprocessed = languageService.preprocessPug(rawPugInLiteral, literal.indentation, document.uri);
        const parsed = languageService.parsePug(preprocessed, document.uri);

        // const positionInPurePug = mapDocumentPositionToPurePug(textDocumentPosition.position, literal, preprocessed.mappingData, document);
        // mapDocumentPositionToPurePug needs to be available/re-imported if used.
        // For now, let's assume a direct use of the old service if we don't have JSX mapping yet.
        // This part is now a placeholder for the JSX-based approach.
        // If position mapping utilities for Pug source -> Pure Pug are still needed for this fallback:
        // const positionInPurePug = oldMapDocumentPositionToPurePug(textDocumentPosition.position, literal, preprocessed.mappingData, document);


        // Fallback to simplified position mapping for the old service
        let lineInPurePug = textDocumentPosition.position.line - literal.contentRange.start.line;
        let charInPurePug = (lineInPurePug === 0) ?
            textDocumentPosition.position.character - literal.contentRange.start.character :
            textDocumentPosition.position.character;
        // This simplified mapping doesn't account for indentation stripping by preprocessPug.
        const positionInPurePugFallback = Position.create(Math.max(0,lineInPurePug), Math.max(0,charInPurePug));


        if (!positionInPurePugFallback) {
          connection.console.log(`Could not map document position to purePug position for completion (fallback).`);
          return null;
        }

        const completionList = languageService.doComplete(parsed, positionInPurePugFallback);
        if (completionList && completionList.items) {
          completionList.items.forEach(item => {
            if (item.textEdit && TextEdit.is(item.textEdit)) {
              // const mappedRange = oldMapPurePugRangeToDocument(item.textEdit.range, literal, preprocessed.mappingData, document);
              // TextEdits will be inaccurately mapped with this fallback.
               connection.console.warn(`TextEdit for '${item.label}' uses fallback mapping. May be inaccurate.`);
            }
          });
          return completionList;
        }
        return null;
      }
    }
    return null;
  }
);

connection.onHover(
  async (textDocumentPosition: TextDocumentPositionParams): Promise<Hover | null> => {
    const document = documents.get(textDocumentPosition.textDocument.uri);
    if (!document) return null;

    const settings = await getDocumentSettings(document.uri);
     if (!languageService) languageService = createReactPugLanguageService(settings); // Old service

    const pugLiterals = findPugLiterals(document);
    for (const literal of pugLiterals) {
      const docOffset = positionToOffset(document.getText(), textDocumentPosition.position);
      const literalContentStartOffset = positionToOffset(document.getText(), literal.contentRange.start);
      const literalContentEndOffset = positionToOffset(document.getText(), literal.contentRange.end);

      if (docOffset >= literalContentStartOffset && docOffset <= literalContentEndOffset) {
        // TODO: New JSX-based hover logic (similar to onCompletion)
        // For now, falling back to old direct Pug hover logic:
        const rawPugInLiteral = document.getText(literal.contentRange);
        const preprocessed = languageService.preprocessPug(rawPugInLiteral, literal.indentation, document.uri);
        const parsed = languageService.parsePug(preprocessed, document.uri);

        // const positionInPurePug = mapDocumentPositionToPurePug(textDocumentPosition.position, literal, preprocessed.mappingData, document);
        // Fallback mapping:
        let lineInPurePug = textDocumentPosition.position.line - literal.contentRange.start.line;
        let charInPurePug = (lineInPurePug === 0) ?
            textDocumentPosition.position.character - literal.contentRange.start.character :
            textDocumentPosition.position.character;
        const positionInPurePugFallback = Position.create(Math.max(0,lineInPurePug), Math.max(0,charInPurePug));

        if (!positionInPurePugFallback) {
          return null;
        }

        const hoverResult = languageService.doHover(parsed, positionInPurePugFallback);
        if (hoverResult && hoverResult.range) {
          // const mappedRange = mapPurePugRangeToDocument(hoverResult.range, literal, preprocessed.mappingData, document);
          // Hover range will be inaccurately mapped with this fallback.
           connection.console.warn(`Hover range for uses fallback mapping. May be inaccurate.`);
        }
        return hoverResult;
      }
    }
    return null;
  }
);

documents.listen(connection);
connection.listen();
connection.console.log('React Pug Language Server process started.');
