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

import { IReactPugLanguageService, createReactPugLanguageService, PreprocessedPug } from './reactPugLanguageService'; // ReactPugSettings removed from direct import as ServiceReactPugSettings was unused
import { mapDocumentPositionToPurePug, mapPurePugRangeToDocument } from './positionMapping';
import { positionToOffset } from './utils/textPositions'; // Import positionToOffset

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
// let hasDiagnosticRelatedInformationCapability = false; // Not actively used for custom diags

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
    const rawPugInLiteral = textDocument.getText(literal.contentRange); // This is what preprocessPug expects
    const preprocessed: PreprocessedPug = languageService.preprocessPug(rawPugInLiteral, literal.indentation, textDocument.uri);
    const parsed = languageService.parsePug(preprocessed, textDocument.uri);
    const pugDiagnostics = languageService.doValidation(parsed);

    for (const diag of pugDiagnostics) {
      const mappedRange = mapPurePugRangeToDocument(diag.range, literal, preprocessed.mappingData, textDocument);
      if (mappedRange) {
        diagnostics.push({ ...diag, range: mappedRange });
      } else {
        connection.console.warn(`Could not map diagnostic range for: ${diag.message} in ${textDocument.uri}`);
        diagnostics.push({ ...diag, range: literal.contentRange, message: `(Unmapped) ${diag.message}` });
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
    if (!languageService || globalSettings.classAttribute !== settings.classAttribute) {
         languageService = createReactPugLanguageService(settings);
    }

    const pugLiterals = findPugLiterals(document);
    for (const literal of pugLiterals) {
      // Check if the documentPosition is within the literal's contentRange (where Pug code is)
      const docOffset = positionToOffset(document.getText(), textDocumentPosition.position);
      const literalContentStartOffset = positionToOffset(document.getText(), literal.contentRange.start);
      const literalContentEndOffset = positionToOffset(document.getText(), literal.contentRange.end);

      if (docOffset >= literalContentStartOffset && docOffset <= literalContentEndOffset) {
        const rawPugInLiteral = textDocument.getText(literal.contentRange);
        const preprocessed = languageService.preprocessPug(rawPugInLiteral, literal.indentation, document.uri);
        const parsed = languageService.parsePug(preprocessed, document.uri);

        const positionInPurePug = mapDocumentPositionToPurePug(textDocumentPosition.position, literal, preprocessed.mappingData, document);

        if (!positionInPurePug) {
          connection.console.log(`Could not map document position to purePug position for completion.`);
          return null;
        }

        const completionList = languageService.doComplete(parsed, positionInPurePug);
        if (completionList && completionList.items) {
          completionList.items.forEach(item => {
            if (item.textEdit && TextEdit.is(item.textEdit)) {
              const mappedRange = mapPurePugRangeToDocument(item.textEdit.range, literal, preprocessed.mappingData, document);
              if (mappedRange) {
                item.textEdit.range = mappedRange;
              } else {
                connection.console.warn(`Could not map TextEdit range for completion item '${item.label}'.`);
              }
            } else if (item.textEdit) { // InsertReplaceEdit
                const insertReplaceEdit = item.textEdit as {insert: Range, replace: Range, newText: string};
                const mappedInsert = mapPurePugRangeToDocument(insertReplaceEdit.insert, literal, preprocessed.mappingData, document);
                const mappedReplace = mapPurePugRangeToDocument(insertReplaceEdit.replace, literal, preprocessed.mappingData, document);
                if(mappedInsert && mappedReplace) {
                    item.textEdit = {newText: insertReplaceEdit.newText, insert: mappedInsert, replace: mappedReplace};
                } else {
                    connection.console.warn(`Could not map InsertReplaceEdit ranges for '${item.label}'.`);
                }
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
     if (!languageService || globalSettings.classAttribute !== settings.classAttribute) {
        languageService = createReactPugLanguageService(settings);
    }

    const pugLiterals = findPugLiterals(document);
    for (const literal of pugLiterals) {
      const docOffset = positionToOffset(document.getText(), textDocumentPosition.position);
      const literalContentStartOffset = positionToOffset(document.getText(), literal.contentRange.start);
      const literalContentEndOffset = positionToOffset(document.getText(), literal.contentRange.end);

      if (docOffset >= literalContentStartOffset && docOffset <= literalContentEndOffset) {
        const rawPugInLiteral = document.getText(literal.contentRange);
        const preprocessed = languageService.preprocessPug(rawPugInLiteral, literal.indentation, document.uri);
        const parsed = languageService.parsePug(preprocessed, document.uri);

        const positionInPurePug = mapDocumentPositionToPurePug(textDocumentPosition.position, literal, preprocessed.mappingData, document);

        if (!positionInPurePug) {
          connection.console.log(`Could not map document position to purePug position for hover.`);
          return null;
        }

        const hoverResult = languageService.doHover(parsed, positionInPurePug);
        if (hoverResult && hoverResult.range) {
          const mappedRange = mapPurePugRangeToDocument(hoverResult.range, literal, preprocessed.mappingData, document);
          if (mappedRange) {
            hoverResult.range = mappedRange;
          } else {
            connection.console.warn(`Could not map hover range. Falling back to literal content range.`);
            hoverResult.range = literal.contentRange;
          }
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
