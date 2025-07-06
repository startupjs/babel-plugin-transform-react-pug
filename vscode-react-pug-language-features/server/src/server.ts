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

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

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

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ReactPugSettings>> = new Map();

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
        resolveProvider: false // Set to true if you implement onCompletionResolve
      },
      // Add other capabilities like hoverProvider, definitionProvider later
      // hoverProvider: true,
      // definitionProvider: true,
    }
  };
  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true
      }
    };
  }
  connection.console.log('React Pug Language Server initialized.');
  if (params.initializationOptions) {
    connection.console.log(`Initialization options: ${JSON.stringify(params.initializationOptions)}`);
    // Example: set classAttribute from init options if provided by client
    // This is an alternative to workspace/configuration for initial settings
    if (params.initializationOptions.classAttribute) {
      globalSettings.classAttribute = params.initializationOptions.classAttribute;
    }
  }
  return result;
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
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

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  const settings = await getDocumentSettings(textDocument.uri);
  const diagnostics: Diagnostic[] = [];

  // This is where the core logic for finding Pug literals and validating them will go.
  // For now, a placeholder:
  connection.console.log(`Validating ${textDocument.uri} with classAttribute: ${settings.classAttribute}`);

  const text = textDocument.getText();

  // Example diagnostic: find 'PUG_TODO'
  const pattern = /PUG_TODO/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) && diagnostics.length < (settings.maxNumberOfProblems || defaultSettings.maxNumberOfProblems) ) {
    const diagnostic: Diagnostic = {
      severity: DiagnosticSeverity.Warning,
      range: {
        start: textDocument.positionAt(m.index),
        end: textDocument.positionAt(m.index + m[0].length)
      },
      message: `${m[0]} found. Implement Pug processing.`,
      source: 'React Pug LS'
    };
    diagnostics.push(diagnostic);
  }

  // Send the computed diagnostics to VS Code.
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
    // This is where logic for Pug completions will go.
    // For now, a placeholder:
    connection.console.log(`Completion requested at ${textDocumentPosition.textDocument.uri} L${textDocumentPosition.position.line} C${textDocumentPosition.position.character}`);

    // Example: Check if inside a pug`` literal (very naive check for now)
    const linePrefix = document.getText(Range.create(Position.create(textDocumentPosition.position.line, 0), textDocumentPosition.position));
    if (linePrefix.includes('pug`')) {
        return [
            {
                label: 'div',
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
