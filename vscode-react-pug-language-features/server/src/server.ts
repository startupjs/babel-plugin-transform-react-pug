import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  Range,
  Position
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

import * as acorn from 'acorn';
// import jsx from 'acorn-jsx'; // If JSX support is needed and confirmed compatible
// const AcornParser = acorn.Parser.extend(jsx());

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

interface PugLiteralInfo {
  content: string;
  range: Range; // Range of the entire TaggedTemplateExpression node
  contentRange: Range; // Range of the pug template content itself (inside backticks)
  indentation: string; // Leading indentation of the pug block
}

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

// React Pug specific settings
interface ReactPugSettings {
  maxNumberOfProblems: number; // Example, can be removed if not used
  classAttribute: string;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
const defaultSettings: ReactPugSettings = { maxNumberOfProblems: 100, classAttribute: 'className' };
let globalSettings: ReactPugSettings = defaultSettings;

import { IReactPugLanguageService, createReactPugLanguageService, ReactPugSettings as ServiceReactPugSettings } from './reactPugLanguageService'; // Assuming interfaces are exported

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ReactPugSettings>> = new Map(); // Uses server's ReactPugSettings
let languageService: IReactPugLanguageService; // To be initialized

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;

  // Does the client support the `workspace/configuration` request?
  // If not, we fall back using global settings.
  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );
  hasDiagnosticRelatedInformationCapability = !!(
    capabilities.textDocument &&
    capabilities.textDocument.publishDiagnostics &&
    capabilities.textDocument.publishDiagnostics.relatedInformation
  );

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // Tell the client that this server supports code completion.
      completionProvider: {
        resolveProvider: false
      },
      hoverProvider: true, // Add hover capability
      // definitionProvider: true, // For future
    }
  };
  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true
      }
    };
  }

  // Initialize the language service with default or initial settings
  // The actual settings might be refined once the client connects and sends configuration
  languageService = createReactPugLanguageService(globalSettings);

  connection.console.log('React Pug Language Server initialized.');
  if (params.initializationOptions) {
    connection.console.log(`Initialization options: ${JSON.stringify(params.initializationOptions)}`);
    if (params.initializationOptions.classAttribute) {
      globalSettings.classAttribute = params.initializationOptions.classAttribute;
      // Re-initialize or update language service settings if they can change post-init based on this
      languageService = createReactPugLanguageService(globalSettings);
    }
  }
  return result;
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders(_event => {
      connection.console.log('Workspace folder change event received.');
    });
  }
});


connection.onDidChangeConfiguration(change => {
  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear();
  } else {
    globalSettings = (change.settings.reactPug || defaultSettings) as ReactPugSettings;
  }
  connection.console.log(`Configuration changed. New classAttribute: ${globalSettings.classAttribute}`);
  // Revalidate all open text documents with new settings
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
      section: 'reactPug' // Matches the configuration section in root package.json
    });
    documentSettings.set(resource, result);
  }
  return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
  documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
  validateTextDocument(change.document);
});

// Helper function to find pug`` tagged template literals
function findPugLiterals(textDocument: TextDocument): PugLiteralInfo[] {
  const results: PugLiteralInfo[] = [];
  const text = textDocument.getText();
  try {
    // Acorn parsing options - make it tolerant to common JS features and TS/JSX syntax if possible
    // For strict TS/JSX, a more advanced parser (like Babel's) or TS compiler API might be needed,
    // but Acorn is good for finding specific structures in JS-like code.
    const ast = acorn.parse(text, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true, // Essential for getting start/end positions
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      allowSuperOutsideMethod: true,
      allowHashBang: true,
      // For more tolerance, consider acorn-loose or custom error handling
    });

    // Simple walk function (can be replaced with a more robust AST walker like acorn-walk)
    // For now, a basic recursive walk to find TaggedTemplateExpression
    function walk(node: any, callback: (node: any) => void) {
      callback(node);
      for (const key in node) {
        if (node[key] && typeof node[key] === 'object') {
          if (Array.isArray(node[key])) {
            node[key].forEach((child: any) => walk(child, callback));
          } else if (node[key].type) { // Check if it's an AST node
            walk(node[key], callback);
          }
        }
      }
    }

    walk(ast, (node: any) => {
      if (node.type === 'TaggedTemplateExpression' && node.tag.type === 'Identifier' && node.tag.name === 'pug') {
        if (node.quasi && node.quasi.quasis && node.quasi.quasis.length > 0) {
          // node.loc gives start/end with line/column, convert to LSP Position/Range
          // Acorn locations are 1-based for lines, 0-based for columns. LSP is 0-based for both.
          const startPosition = Position.create(node.loc.start.line - 1, node.loc.start.column);
          const endPosition = Position.create(node.loc.end.line - 1, node.loc.end.column);
          const nodeRange = Range.create(startPosition, endPosition);

          // Content range (inside the backticks)
          // The quasi node itself spans from the first backtick to the last.
          // node.quasi.loc is for the TemplateLiteral part.
          const contentStartPosition = Position.create(node.quasi.loc.start.line - 1, node.quasi.loc.start.column + 1); // +1 to skip the opening backtick
          const contentEndPosition = Position.create(node.quasi.loc.end.line - 1, node.quasi.loc.end.column -1); // -1 to skip the closing backtick
          const contentRange = Range.create(contentStartPosition, contentEndPosition);

          // Extract raw text content of the template
          // Acorn's quasi.quasis gives cooked and raw strings. We need raw to preserve escapes.
          // This simple concatenation assumes no complex interpolations affecting raw structure significantly for now.
          // A more robust approach would iterate through quasis and expressions.
          let rawContent = "";
          for (let i = 0; i < node.quasi.quasis.length; i++) {
            rawContent += node.quasi.quasis[i].value.raw;
            if (i < node.quasi.expressions.length) {
              // For now, just put a placeholder for expressions.
              // Later, we'll need to handle these properly for mapping.
              // The length of the placeholder should ideally match the expression's source length
              // or use a fixed-length placeholder and adjust mapping.
              const exprNode = node.quasi.expressions[i];
              const exprLength = exprNode.loc.end.column - exprNode.loc.start.column; // simplified length
              rawContent += '${' + '#'.repeat(Math.max(0, exprLength-2)) + '}'; // Placeholder for expression part
            }
          }

          // Calculate indentation (simple version: indentation of the line with the opening backtick)
          let indentation = "";
          const openingBacktickLine = node.quasi.loc.start.line -1;
          const lineText = textDocument.getText(Range.create(openingBacktickLine, 0, openingBacktickLine, node.quasi.loc.start.column));
          const match = lineText.match(/^(\s*)/);
          if (match) {
            indentation = match[1];
          }

          results.push({
            content: rawContent, // This is the raw string from the template literal parts
            range: nodeRange,
            contentRange: contentRange,
            indentation: indentation
          });
        }
      }
    });

  } catch (e) {
    connection.console.warn(`Acorn parsing error: ${e.message}. Document: ${textDocument.uri}`);
    // For TS/JSX, Acorn might throw errors. Consider using a more tolerant parser or TS compiler API for full fidelity.
  }
  return results;
}


async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  const settings = await getDocumentSettings(textDocument.uri);
  const diagnostics: Diagnostic[] = [];

  connection.console.log(`Validating ${textDocument.uri} with classAttribute: ${settings.classAttribute}`);
  // Ensure languageService is initialized
  if (!languageService) {
    languageService = createReactPugLanguageService(settings);
  } else {
    // TODO: Consider if/how to update languageService if settings changed and it holds state related to settings
    // For now, we re-create it if settings change, or rely on `onDidChangeConfiguration` to create a new one.
    // This simple service doesn't hold much state based on settings yet.
  }

  const pugLiterals = findPugLiterals(textDocument);

  for (const literal of pugLiterals) {
    // literal.content is currently the raw content from Acorn, including original interpolations.
    // literal.indentation is the leading whitespace of the pug`` line.
    // The `preprocessPug` function expects the raw content of the pug block
    // and the indentation that applies *to the block itself*.

    // The `literal.content` from `findPugLiterals` is already the content *within* the backticks.
    // The `literal.indentation` is the indentation of the line where `pug`` starts.
    // We need to pass the content within the backticks to the service.
    const rawPugInLiteral = textDocument.getText(literal.contentRange);

    const preprocessed = languageService.preprocessPug(rawPugInLiteral, literal.indentation, textDocument.uri);
    const parsed = languageService.parsePug(preprocessed, textDocument.uri);
    const pugDiagnostics = languageService.doValidation(parsed);

    for (const diag of pugDiagnostics) {
      // **IMPORTANT: Position Mapping **
      // diag.range is relative to `purePugContent`.
      // We need to map it back to the original document.
      // This requires careful offset calculation considering:
      // 1. Start of the Pug literal's content in the document (`literal.contentRange.start`).
      // 2. Indentation changes (leading whitespace removed by `preprocessPug`).
      // 3. Changes due to interpolation placeholders replacing original JS expressions.

      // Simplified mapping for now:
      // Assumes line numbers are mostly preserved and adds column offset from literal start + initial indent.
      // THIS IS A MAJOR TODO FOR ACCURACY.
      const mappedStartLine = literal.contentRange.start.line + diag.range.start.line;
      let mappedStartChar = diag.range.start.character;
      if (diag.range.start.line === 0) { // First line of pug block
        mappedStartChar += literal.contentRange.start.character;
        // This doesn't account for indentation *within* the block that preprocessPug strips.
      } else {
        // For subsequent lines, the character is relative to the start of that line *after*
        // common block indentation was stripped by preprocessPug.
        // The `literal.indentation` (from `findPugLiterals`) + `contentIndent` (from `preprocessPug`)
        // would be the total stripped leading space.
        // This part is complex without more info from preprocessPug.
      }

      const mappedEndLine = literal.contentRange.start.line + diag.range.end.line;
      let mappedEndChar = diag.range.end.character;
      if (diag.range.end.line === 0) {
         mappedEndChar += literal.contentRange.start.character;
      } else {
        // Similar complexity as mappedStartChar for subsequent lines.
      }

      // Fallback / very rough approximation:
      // Add the start character of the literal content for all lines.
      // This will be off for multi-line content and after interpolations.
      if (diag.range.start.line > 0) mappedStartChar += literal.indentation.length; // Very rough guess
      if (diag.range.end.line > 0) mappedEndChar += literal.indentation.length; // Very rough guess

      // A more direct way if lines are preserved by preprocessPug (excluding interpolations):
      // Line `l` in purePug becomes line `literal.contentRange.start.line + l` in document.
      // Column `c` in purePug line `l` needs to account for:
      //   - `literal.contentRange.start.character` (if `l` is 0)
      //   - `literal.indentation.length` (indent of overall block)
      //   - `contentIndent.length` (common indent within the block, stripped by preprocessPug)
      //   - The difference in length between original JS interpolations and their placeholders.

      // Placeholder mapping - THIS WILL BE INACCURATE
      const mappedRange = Range.create(
        Position.create(mappedStartLine, mappedStartChar),
        Position.create(mappedEndLine, mappedEndChar)
      );

      // A slightly more robust (but still incomplete without full mapping data) approach for line 0:
      const startPos = Position.create(
        literal.contentRange.start.line + diag.range.start.line,
        (diag.range.start.line === 0 ? literal.contentRange.start.character : 0) + diag.range.start.character
      );
      const endPos = Position.create(
        literal.contentRange.start.line + diag.range.end.line,
        (diag.range.end.line === 0 ? literal.contentRange.start.character : 0) + diag.range.end.character
      );


      diagnostics.push({
        ...diag,
        range: Range.create(startPos, endPos), // Use this slightly better mapped range
        // message: `(L:${diag.range.start.line} C:${diag.range.start.character}) ${diag.message}` // For debugging mapping
      });
    }
  }

  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles(_change => {
  // Monitored files have change in VS Code
  connection.console.log('We received a file change event');
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
  (textDocumentPosition: TextDocumentPositionParams): CompletionItem[] | null => {
    const document = documents.get(textDocumentPosition.textDocument.uri);
    if (!document) {
      return null;
    }

    connection.console.log(`Completion requested at ${textDocumentPosition.textDocument.uri} L${textDocumentPosition.position.line} C${textDocumentPosition.position.character}`);
    const pugLiterals = findPugLiterals(document);

    for (const literal of pugLiterals) {
      const contentStartOffset = document.offsetAt(literal.contentRange.start);
      // For offset checks, end should typically be exclusive if checking a point vs a range.
      // However, for checking if a position is *within*, inclusive end is fine.
      const contentEndOffset = document.offsetAt(literal.contentRange.end);
      const requestOffset = document.offsetAt(textDocumentPosition.position);

      if (requestOffset >= contentStartOffset && requestOffset <= contentEndOffset) {
        connection.console.log(`Completion request inside pug literal: ${literal.contentRange.start.line}:${literal.contentRange.start.character}`);

        const rawPugInLiteral = document.getText(literal.contentRange);

        if (!languageService) {
            languageService = createReactPugLanguageService(globalSettings);
            connection.console.warn("Language service was not initialized prior to onCompletion. Using global/default settings.");
        }

        const preprocessed = languageService.preprocessPug(rawPugInLiteral, literal.indentation, document.uri);
        const parsed = languageService.parsePug(preprocessed, document.uri);

        // --- Simplified Position Mapping (Document to purePugContent) ---
        // This is a placeholder for the accurate mapping logic that needs to be developed in Step 6.
        // It makes broad assumptions and will be inaccurate, especially with interpolations.
        let lineInPurePug = textDocumentPosition.position.line - literal.contentRange.start.line;
        let charInPurePug = textDocumentPosition.position.character;

        if (lineInPurePug === 0) { // First line of the literal
            charInPurePug -= literal.contentRange.start.character;
        } else { // Subsequent lines
            // Very rough: assume character is relative to start of line after base indent,
            // but doesn't account for internal indent stripped by preprocessPug or interpolations.
            charInPurePug -= literal.indentation.length;
        }
        lineInPurePug = Math.max(0, lineInPurePug);
        charInPurePug = Math.max(0, charInPurePug);
        // --- End of Simplified Position Mapping ---

        const positionInPurePug = Position.create(lineInPurePug, charInPurePug);
        connection.console.log(`Position mapped to purePug approx L:${positionInPurePug.line} C:${positionInPurePug.character}`);

        const completionList = languageService.doComplete(parsed, positionInPurePug);

        if (completionList) {
          // TODO: Map TextEdit ranges in completionList.items if they exist, from purePugContent back to original document.
          // This involves the inverse of the above mapping and needs to be accurate.
          // For now, we are not modifying TextEdit ranges, so they will be relative to purePugContent.
          // This means if a completion item *uses* a TextEdit, it will likely be applied incorrectly.
          // Many simple keyword completions might work if VS Code just inserts the label/insertText at the (mapped) cursor.
          completionList.items.forEach(item => {
            if (item.textEdit) {
              connection.console.warn(`Completion item '${item.label}' has a TextEdit with ranges relative to purePugContent. These need mapping.`);
              // A proper solution would be:
              // item.textEdit.range = mapRangeFromPurePugToDocument(item.textEdit.range, literal, preprocessed.interpolations, document);
              // item.textEdit.newText might also need adjustment if it contains placeholders that should be original JS.
            }
          });
          connection.console.log(`Returning ${completionList.items.length} completion items.`);
          return completionList;
        }
        return null; // Service returned no completions
      }
    }
    return null;
  }
);

connection.onHover(
  async (textDocumentPosition: TextDocumentPositionParams): Promise<Hover | null> => {
    const document = documents.get(textDocumentPosition.textDocument.uri);
    if (!document) {
      return null;
    }

    connection.console.log(`Hover request at ${textDocumentPosition.textDocument.uri} L${textDocumentPosition.position.line} C${textDocumentPosition.position.character}`);
    const pugLiterals = findPugLiterals(document);

    for (const literal of pugLiterals) {
      const contentStartOffset = document.offsetAt(literal.contentRange.start);
      const contentEndOffset = document.offsetAt(literal.contentRange.end);
      const requestOffset = document.offsetAt(textDocumentPosition.position);

      if (requestOffset >= contentStartOffset && requestOffset <= contentEndOffset) {
        connection.console.log(`Hover request inside pug literal: ${literal.contentRange.start.line}:${literal.contentRange.start.character}`);

        const rawPugInLiteral = document.getText(literal.contentRange);
        if (!languageService) {
          languageService = createReactPugLanguageService(globalSettings);
          connection.console.warn("Language service was not initialized prior to onHover. Using global/default settings.");
        }

        const preprocessed = languageService.preprocessPug(rawPugInLiteral, literal.indentation, document.uri);
        const parsed = languageService.parsePug(preprocessed, document.uri);

        // --- Simplified Position Mapping (Document to purePugContent) ---
        // Placeholder - same simplified mapping as in onCompletion
        let lineInPurePug = textDocumentPosition.position.line - literal.contentRange.start.line;
        let charInPurePug = textDocumentPosition.position.character;
        if (lineInPurePug === 0) {
            charInPurePug -= literal.contentRange.start.character;
        } else {
            charInPurePug -= literal.indentation.length;
        }
        lineInPurePug = Math.max(0, lineInPurePug);
        charInPurePug = Math.max(0, charInPurePug);
        const positionInPurePug = Position.create(lineInPurePug, charInPurePug);
        // --- End of Simplified Position Mapping ---
        connection.console.log(`Hover position mapped to purePug approx L:${positionInPurePug.line} C:${positionInPurePug.character}`);

        const hoverResult = languageService.doHover(parsed, positionInPurePug);

        if (hoverResult) {
          // TODO: Map hoverResult.range if it exists, from purePugContent back to original document.
          // This uses the same complex mapping logic required for diagnostics and completion edits.
          if (hoverResult.range) {
            connection.console.warn(`Hover result has a range relative to purePugContent. This needs mapping.`);
            // Placeholder: For now, we'll try to map it very simply,
            // knowing it will be inaccurate.
            const mappedStartLine = literal.contentRange.start.line + hoverResult.range.start.line;
            let mappedStartChar = hoverResult.range.start.character + (hoverResult.range.start.line === 0 ? literal.contentRange.start.character : literal.indentation.length);

            const mappedEndLine = literal.contentRange.start.line + hoverResult.range.end.line;
            let mappedEndChar = hoverResult.range.end.character + (hoverResult.range.end.line === 0 ? literal.contentRange.start.character : literal.indentation.length);

            hoverResult.range = Range.create(
                Math.max(0, mappedStartLine), Math.max(0, mappedStartChar),
                Math.max(0, mappedEndLine), Math.max(0, mappedEndChar)
            );
          }
          return hoverResult;
        }
        return null; // Service returned no hover
      }
    }
    return null;
  }
);


// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

connection.console.log('React Pug Language Server process started.');
                kind: CompletionItemKind.Keyword,
                data: 'pug.div',
                detail: 'Pug div tag'
            },
            {
                label: 'p',
                kind: CompletionItemKind.Keyword,
                data: 'pug.p',
                detail: 'Pug p tag'
            }
        ];
    }
    return null;
  }
);

// This handler resolves additional information for the item selected in
// the completion list. (Only if resolveProvider is true in capabilities)
// connection.onCompletionResolve(
//   (item: CompletionItem): CompletionItem => {
//     if (item.data === 'pug.div') {
//       item.detail = 'Pug div tag details';
//       item.documentation = 'Documentation for Pug div tag';
//     } else if (item.data === 'pug.p') {
//       item.detail = 'Pug p tag details';
//       item.documentation = 'Documentation for Pug p tag';
//     }
//     return item;
//   }
// );

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

connection.console.log('React Pug Language Server process started.');
