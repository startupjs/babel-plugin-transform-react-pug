// @ts-nocheck Disable type checking for this test file for simplicity with mocks

import { TextDocument } from 'vscode-languageserver-textdocument';
import { Position } from 'vscode-languageserver/node';
import * as acorn from 'acorn';

// --- Mocks Setup ---
// Mock critical dependencies that are called when caches are missed.
const mockCompilePugToJsxString = jest.fn();
jest.mock('../pugToJsxTransformer', () => ({
  compilePugToJsxString: mockCompilePugToJsxString,
}));

// We need to mock acorn.parse to check if it's called
const mockAcornParse = jest.spyOn(acorn, 'parse');


// Mock other dependencies used by the LSP handlers to allow them to run
jest.mock('../jsxPugMapping', () => ({
  parseSourceMap: jest.fn().mockResolvedValue({ consumer: { destroy: jest.fn() }, originalPugContent: '', generatedJsxContent: '' }),
  mapPugPositionToJsxPosition: jest.fn().mockReturnValue(Position.create(0,0)),
  mapJsxRangeToPugRange: jest.fn().mockReturnValue(Range.create(0,0,0,0)),
  destroySourceMapData: jest.fn(),
}));
jest.mock('../utils/textPositions', () => ({
  positionToOffset: jest.fn().mockReturnValue(0),
}));

const mockTsLangService = {
  getSyntacticDiagnostics: jest.fn().mockReturnValue([]),
  getSemanticDiagnostics: jest.fn().mockReturnValue([]),
  getCompletionsAtPosition: jest.fn().mockReturnValue({ entries: [] }),
  getCompletionEntryDetails: jest.fn().mockReturnValue({}),
  getQuickInfoAtPosition: jest.fn().mockReturnValue(null),
  getDefinitionAtPosition: jest.fn().mockReturnValue([]),
  getProgram: jest.fn().mockReturnValue({
    getSourceFile: jest.fn().mockReturnValue({ text: '', statements: [] }),
  }),
};
jest.mock('typescript', () => ({
  ...jest.requireActual('typescript'),
  createLanguageService: jest.fn(() => mockTsLangService),
  getLineAndCharacterOfPosition: jest.fn().mockReturnValue({ line: 0, character: 0 }),
  flattenDiagnosticMessageText: jest.fn((diag, _) => typeof diag === 'string' ? diag : diag.messageText),
}));

const mockConnection = {
  sendDiagnostics: jest.fn(),
  console: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  workspace: { getConfiguration: jest.fn().mockResolvedValue({ classAttribute: 'className' }) },
  onInitialize: jest.fn(),
  onInitialized: jest.fn(),
  onDidChangeConfiguration: jest.fn(),
  onCompletion: jest.fn(),
  onHover: jest.fn(),
  onDefinition: jest.fn(),
  listen: jest.fn(),
  client: {
    register: jest.fn()
  },
};
const mockTextDocuments = {
  listen: jest.fn(),
  get: jest.fn(),
  onDidClose: jest.fn(),
  onDidChangeContent: jest.fn(),
  all: jest.fn().mockReturnValue([]), // For onDidChangeConfiguration loop
};

jest.mock('vscode-languageserver/node', () => {
  const actualLsp = jest.requireActual('vscode-languageserver/node');
  return {
    ...actualLsp,
    createConnection: jest.fn(() => mockConnection),
    TextDocuments: jest.fn(() => mockTextDocuments),
  };
});
jest.mock('url', () => ({
    pathToFileURL: jest.fn(path => ({ toString: () => `file://${path}` })),
}));
// --- End Mocks Setup ---

// Import server parts AFTER mocks are set up
let serverModule;
let validateTextDocumentInternal;
let onCompletionInternal;
// We need to simulate document changes and LSP handler calls.

beforeAll(() => {
  // Reset Acorn's parse mock before all tests in this suite
  mockAcornParse.mockImplementation((input, options) => {
    // Call the actual acorn.parse but ensure it's tracked
    return jest.requireActual('acorn').parse(input, options);
  });

  serverModule = require('../server'); // This will execute server.ts
  // Capture handlers if possible (depends on server.ts structure or TEST_EXPORTS)
  // For simplicity in this example, we'll assume these handlers can be called/triggered
  // For `validateTextDocument`, it's often called by `documents.onDidChangeContent`
  // So we can capture the callback passed to `documents.onDidChangeContent`
  if (mockTextDocuments.onDidChangeContent.mock.calls.length > 0) {
    validateTextDocumentInternal = mockTextDocuments.onDidChangeContent.mock.calls[0][0];
  } else {
    // Fallback or ensure server module exports it for testing
    validateTextDocumentInternal = serverModule.TEST_EXPORTS?.validateTextDocument || (async () => {});
  }

  if (mockConnection.onCompletion.mock.calls.length > 0) {
    onCompletionInternal = mockConnection.onCompletion.mock.calls[0][0];
  } else {
    onCompletionInternal = serverModule.TEST_EXPORTS?.onCompletionHandler || (async () => null);
  }
});


describe('Server Caching Mechanisms', () => {
  const createDoc = (uri, version, content) => {
    const doc = TextDocument.create(uri, 'typescriptreact', version, content);
    mockTextDocuments.get.mockImplementation((docUri) => {
      if (docUri === uri) return doc;
      return undefined;
    });
    return doc;
  };

  beforeEach(() => {
    jest.clearAllMocks(); // Clears call counts etc.
    // Don't clear the cache itself here, tests will manage that or test across calls.
    serverModule.TEST_EXPORTS?.clearAstCache(); // Assuming a helper for tests
    serverModule.TEST_EXPORTS?.clearPugCompilationCache(); // Assuming a helper for tests

    mockConnection.workspace.getConfiguration.mockResolvedValue({ classAttribute: 'className' });
    mockCompilePugToJsxString.mockImplementation((rawPug, opts, fname) => ({
      jsx: `<p>${rawPug}</p>`, // Simple mock compilation
      sourceMap: { version: 3, sources: [fname], mappings: 'AAAA', sourcesContent: [`const P=pug\`${rawPug}\``] }
    }));
  });

  describe('AST Cache', () => {
    it('should parse AST only once for the same document version', async () => {
      const docUri = 'file:///astTest.tsx';
      const docContent = "const comp = pug`div`; function foo() { const c2 = pug`span`; }";
      const docV1 = createDoc(docUri, 1, docContent);

      // Simulate first call (e.g., diagnostics)
      await validateTextDocumentInternal(docV1);
      const initialParseCount = mockAcornParse.mock.calls.length;
      expect(initialParseCount).toBeGreaterThanOrEqual(1); // Acorn parse for findPugLiterals & extractImports

      // Simulate second call (e.g., completion on same doc version)
      // Need to set up mocks for findPugLiterals to return something for onCompletion to proceed
       serverModule.findPugLiterals = jest.fn().mockReturnValue([{
           content: 'div', contentRange: Range.create(0,18,0,21),
           enclosingScopeNode: {type: 'Program', body:[]} // Simplified scope
       }]);
      await onCompletionInternal({ textDocument: { uri: docUri }, position: Position.create(0, 19) });

      // Acorn.parse should NOT have been called again for findPugLiterals/extractImportStatements
      // because the document version hasn't changed and AST should be cached.
      expect(mockAcornParse.mock.calls.length).toBe(initialParseCount);
    });

    it('should re-parse AST if document version changes', async () => {
      const docUri = 'file:///astVersionTest.tsx';
      const docContent1 = "const comp = pug`div`;";
      const docV1 = createDoc(docUri, 1, docContent1);

      await validateTextDocumentInternal(docV1);
      const parseCountAfterV1 = mockAcornParse.mock.calls.length;
      expect(parseCountAfterV1).toBeGreaterThanOrEqual(1);

      const docContent2 = "const comp = pug`span`; // Changed content";
      const docV2 = createDoc(docUri, 2, docContent2); // Incremented version

      await validateTextDocumentInternal(docV2);
      // Acorn.parse should have been called again due to version change
      expect(mockAcornParse.mock.calls.length).toBeGreaterThan(parseCountAfterV1);
    });

    it('should evict AST from cache on document close', () => {
      const docUri = 'file:///astEvict.tsx';
      const doc = createDoc(docUri, 1, "pug`h1`");

      // Populate cache by calling something that uses it
      serverModule.extractImportStatements(doc); // This uses/populates astCache
      expect(serverModule.TEST_EXPORTS?.getAstCacheSize()).toBe(1); // Assuming a way to check cache size

      // Simulate document close
      const closeCallback = mockTextDocuments.onDidClose.mock.calls[0][0];
      closeCallback({ document: doc });

      expect(serverModule.TEST_EXPORTS?.getAstCacheSize()).toBe(0);
    });
  });

  describe('Pug Compilation Cache', () => {
    it('should compile Pug only once for the same content and settings', async () => {
      const docUri = 'file:///compileCache.tsx';
      const pugContent = "p #{msg}";
      const docContent = `const msg = "hi"; const comp = pug\`${pugContent}\`;`;
      const doc = createDoc(docUri, 1, docContent);

      // Mock findPugLiterals to return this specific literal
      serverModule.findPugLiterals = jest.fn().mockReturnValue([{
          content: pugContent, contentRange: Range.create(1,25,1,25+pugContent.length),
          enclosingScopeNode: {type: 'Program', body:[]}
      }]);
      serverModule.extractImportStatements = jest.fn().mockReturnValue([]);
      serverModule.extractDeclarationsAndParamsFromScope = jest.fn().mockReturnValue({declarations:[], paramTexts:[]});


      // First call (e.g. validate)
      await validateTextDocumentInternal(doc);
      expect(mockCompilePugToJsxString).toHaveBeenCalledTimes(1);

      // Second call with same literal (e.g. hover)
      // Ensure findPugLiterals returns the same info for the hover request
      await onCompletionInternal({ textDocument: { uri: docUri }, position: Position.create(1, 27) });
      expect(mockCompilePugToJsxString).toHaveBeenCalledTimes(1); // Should use cached result
    });

    it('should re-compile if classAttribute setting changes', async () => {
      const docUri = 'file:///compileSettingChange.tsx';
      const pugContent = "div.my-class";
      const docContent = `const comp = pug\`${pugContent}\`;`;
      const doc = createDoc(docUri, 1, docContent);

      serverModule.findPugLiterals = jest.fn().mockReturnValue([{
          content: pugContent, contentRange: Range.create(0,18,0,18+pugContent.length),
          enclosingScopeNode: {type: 'Program', body:[]}
      }]);
      serverModule.extractImportStatements = jest.fn().mockReturnValue([]);
      serverModule.extractDeclarationsAndParamsFromScope = jest.fn().mockReturnValue({declarations:[], paramTexts:[]});

      // Initial validation
      await validateTextDocumentInternal(doc);
      expect(mockCompilePugToJsxString).toHaveBeenCalledTimes(1);
      expect(mockCompilePugToJsxString).toHaveBeenLastCalledWith(pugContent, { classAttribute: 'className' }, expect.any(String));

      // Simulate settings change
      mockConnection.workspace.getConfiguration.mockResolvedValue({ classAttribute: 'class' });
      // Trigger onDidChangeConfiguration handler
      const configChangeCallback = mockConnection.onDidChangeConfiguration.mock.calls[0][0];
      await configChangeCallback({ settings: { reactPug: { classAttribute: 'class' } } });

      // validateTextDocument is called for all open docs by onDidChangeConfiguration
      // If doc was "open" (in mockTextDocuments.all()), it would be re-validated
      // For this test, let's directly call validate again to simulate this
      mockTextDocuments.get.mockReturnValue(doc); // Ensure doc is "found"
      await validateTextDocumentInternal(doc);

      expect(mockCompilePugToJsxString).toHaveBeenCalledTimes(2); // Should re-compile
      expect(mockCompilePugToJsxString).toHaveBeenLastCalledWith(pugContent, { classAttribute: 'class' }, expect.any(String));
    });
  });
});

// Assumption: server.ts will export cache instances or size getters for testing:
// export const TEST_EXPORTS = (process.env.NODE_ENV === 'test') ? {
//   astCache, // or getAstCacheSize: () => astCache.size,
//   pugCompilationCache, // or getPugCompilationCacheSize: () => pugCompilationCache.size,
//   clearAstCache: () => astCache.clear(),
//   clearPugCompilationCache: () => pugCompilationCache.clear(),
//   validateTextDocument, // if not testing via event trigger
//   onCompletionHandler, // etc. for other handlers
// } : undefined;
// And in server.ts, these would be:
// export const astCache = new Map... (if not already)
// export const pugCompilationCache = new Map...
// These TEST_EXPORTS would need to be added to server.ts
