// @ts-nocheck Disable type checking for this test file for simplicity with mocks
// Or use // @ts-ignore for specific lines if preferred

import { TextDocument } from 'vscode-languageserver-textdocument';
import { Diagnostic, DiagnosticSeverity, Range, Position } from 'vscode-languageserver/node';
import * as ts from 'typescript';

// Functions/objects to mock from server.ts and its imports
// We need to mock modules *before* they are imported by the module under test (server.ts)
// This often requires `jest.mock('module-path')`

// Mock dependencies of server.ts
jest.mock('../pugToJsxTransformer', () => ({
  compilePugToJsxString: jest.fn(),
}));
jest.mock('../jsxPugMapping', () => ({
  parseSourceMap: jest.fn(),
  mapJsxRangeToPugRange: jest.fn(),
  destroySourceMapData: jest.fn(),
}));

// Mock the 'typescript' module itself for the language service part
// We need to control what ts.createLanguageService and other ts utils return
const mockTsLangService = {
  getSyntacticDiagnostics: jest.fn(),
  getSemanticDiagnostics: jest.fn(),
  getProgram: jest.fn().mockReturnValue({
    getSourceFile: jest.fn(),
  }),
  // Add other methods if server.ts starts using them
};
const mockTs = {
  ...ts, // Spread actual ts to keep other utils, enums etc.
  createLanguageService: jest.fn(() => mockTsLangService),
  getLineAndCharacterOfPosition: jest.fn(),
  flattenDiagnosticMessageText: jest.fn((diag, newLine) => typeof diag === 'string' ? diag : diag.messageText), // Simplified mock
  // sys: ts.sys, // Keep system utilities if needed by host
};
jest.mock('typescript', () => mockTs);


// Mock parts of vscode-languageserver/node connection
const mockConnection = {
  sendDiagnostics: jest.fn(),
  console: {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  // Mock other connection methods if server.ts uses them directly in the tested path
  workspace: {
    getConfiguration: jest.fn().mockResolvedValue({}), // Default mock for getConfiguration
  }
};
jest.mock('vscode-languageserver/node', () => ({
  ...jest.requireActual('vscode-languageserver/node'), // Import actual to keep enums, types
  createConnection: jest.fn(() => mockConnection),
}));


// Now, import the parts of server.ts we want to test.
// This import must happen *after* jest.mock calls.
// We are particularly interested in `validateTextDocument` and `findPugLiterals` (or we mock findPugLiterals too)
// Due to how server.ts is structured (global side effects, connection.listen),
// directly importing and testing `validateTextDocument` can be tricky.
// A common pattern is to refactor server.ts to make `validateTextDocument` more testable,
// e.g., by making dependencies like `tsLangService` injectable.

// For this test, we'll assume `validateTextDocument` can be called.
// If server.ts immediately calls `connection.listen()`, tests might hang or fail.
// We might need to mock `documents.listen(connection)` and `connection.listen()` to no-ops.

let validateTextDocumentInternal; // To store the validateTextDocument function from server.ts
let findPugLiteralsInternal; // To store findPugLiterals

// Setup to grab validateTextDocument after mocks are in place
// This is a bit of a hack due to server.ts's typical structure.
// A better approach is refactoring server.ts for testability.
beforeAll(async () => {
  // Reset document store for text documents if server.ts manipulates it globally
  // require('vscode-languageserver/node').TextDocuments.mockClear();

  // Dynamically require server.ts to get its functions after mocks are set up
  // This way, server.ts gets the mocked dependencies.
  const serverModule = require('../server');
  validateTextDocumentInternal = serverModule.validateTextDocument; // Assuming it's exported or accessible
  findPugLiteralsInternal = serverModule.findPugLiterals; // Assuming exported

  // If not exported, this test structure would need significant changes or
  // direct manipulation of the server.ts module's internals (more complex).
  // For now, let's assume they are made available for testing.
  // If they are not exported, we would mock the `documents.onDidChangeContent` handler
  // and trigger it, then assert on `mockConnection.sendDiagnostics`.

  if (!validateTextDocumentInternal) {
    throw new Error("validateTextDocument function not found/exported from server.ts for testing. Please ensure it's exported or use an alternative test strategy.");
  }
});


describe('validateTextDocument - Diagnostics via JSX', () => {
  // Helper to create TextDocument instance
  const createDoc = (uri: string, content: string) => TextDocument.create(uri, 'typescriptreact', 1, content);

  // Mocks from imported modules that need to be reset
  const { compilePugToJsxString } = require('../pugToJsxTransformer');
  const { parseSourceMap, mapJsxRangeToPugRange, destroySourceMapData } = require('../jsxPugMapping');

  beforeEach(() => {
    // Reset mocks before each test
    jest.clearAllMocks();

    // Default behavior for mocks that usually succeed
    (compilePugToJsxString as jest.Mock).mockReturnValue({ jsx: '', sourceMap: {} });
    (parseSourceMap as jest.Mock).mockResolvedValue({ consumer: {} }); // Mock consumer needed by destroy
    (mapJsxRangeToPugRange as jest.Mock).mockReturnValue(Range.create(0,0,0,0)); // Default map success
    (destroySourceMapData as jest.Mock).mockImplementation(() => {});
    mockTsLangService.getSyntacticDiagnostics.mockReturnValue([]);
    mockTsLangService.getSemanticDiagnostics.mockReturnValue([]);
    mockTsLangService.getProgram().getSourceFile.mockReturnValue({ text: '' }); // Mock source file
    mockTs.getLineAndCharacterOfPosition.mockReturnValue({ line: 0, character: 0 });
    mockConnection.workspace.getConfiguration.mockResolvedValue({ classAttribute: 'className', maxNumberOfProblems: 10 }); // Mock settings
  });

  // Test Scenario 1: Successful Pug-to-JSX, TSX has errors, mapping successful
  it('should report mapped TSX diagnostics when compilation and mapping succeed', async () => {
    const docContent = "const comp = pug`div(class='error') Hello`;"; // Pug that might become <div class="error">Hello</div>
    const testDoc = createDoc('file:///test.tsx', docContent);

    // Mock findPugLiterals to return a specific literal info
    // Alternatively, let the real findPugLiterals run if docContent is simple enough
    const mockPugLiteralInfo = [{
      content: "div(class='error') Hello",
      range: Range.create(0, 15, 0, 39), // Range of pug`...`
      contentRange: Range.create(0, 18, 0, 38), // Range of content inside backticks
      indentation: ""
    }];
    // For this test, let's assume findPugLiterals is part of the system under test.
    // If findPugLiterals was also to be mocked:
    // jest.spyOn(require('../server'), 'findPugLiterals').mockReturnValue(mockPugLiteralInfo);


    const generatedJsx = "<div class=\"error\">Hello</div>";
    const mockRawSourceMap = { version: 3, sources: ['test.pug.virtual.js'], mappings: 'AAAA' };
    (compilePugToJsxString as jest.Mock).mockReturnValue({
      jsx: generatedJsx,
      sourceMap: mockRawSourceMap,
    });

    const mockTsDiagnostic: ts.Diagnostic = {
      file: undefined, // Will be the virtual file
      start: 5, // Offset in virtualTsxContent for "class"
      length: 5, // Length of "class"
      messageText: "JSX attribute 'class' is not supported. Did you mean 'className'?",
      category: ts.DiagnosticCategory.Error,
      code: 2769, // Example TS error code for class vs className
    };
    mockTsLangService.getSyntacticDiagnostics.mockReturnValue([mockTsDiagnostic]);

    // Mock getSourceFile to return a mock source file for the virtual TSX
    const mockVirtualSourceFile = { text: `const C = () => (<>${generatedJsx}</>);`, fileName: 'file:///test.tsx/literal-0.pug.virtual.tsx' };
    mockTsLangService.getProgram().getSourceFile.mockReturnValue(mockVirtualSourceFile);

    // Mock getLineAndCharacterOfPosition for the TS diagnostic range
    // JSX: <div class="error">Hello</div> (class is at char offset ~6 if simple wrapper)
    // Let's assume virtual content is `const Comp = () => (<><div class="error">Hello</div></>);`
    // And `class` starts at line 0, char 25 (example) in this virtual content.
    const jsxErrorStartOffset = generatedJsx.indexOf('class'); // simplified for test
    const jsxErrorEndOffset = jsxErrorStartOffset + 'class'.length;

    mockTs.getLineAndCharacterOfPosition
      .mockImplementation((sourceFile, offset) => {
        // Simplified: assume single line for this mock
        if (offset === jsxErrorStartOffset) return { line: 0, character: jsxErrorStartOffset }; // position of 'class'
        if (offset === jsxErrorEndOffset) return { line: 0, character: jsxErrorEndOffset };
        return { line: 0, character: offset };
      });

    const mappedPugRange = Range.create(0, 4, 0, 9); // e.g., maps to `class` in Pug `div(class='error')`
                                                    // Pug: div(class='error') -> class is at L0 C4-9
    (mapJsxRangeToPugRange as jest.Mock).mockReturnValue(mappedPugRange);
    (parseSourceMap as jest.Mock).mockResolvedValue({ consumer: {}, originalPugContent: mockPugLiteralInfo[0].content, generatedJsxContent: generatedJsx });


    await validateTextDocumentInternal(testDoc);

    expect(mockConnection.sendDiagnostics).toHaveBeenCalledTimes(1);
    const sentDiagnostics = mockConnection.sendDiagnostics.mock.calls[0][0].diagnostics;
    expect(sentDiagnostics).toHaveLength(1);
    const diag = sentDiagnostics[0] as Diagnostic;

    // Expected Pug range: line 0 (relative to literal start), char 4 to 9 for 'class'
    // Literal contentRange starts at L0 C18.
    // So, absolute doc range: L0 C(18+4) to L0 C(18+9) => L0 C22 to L0 C27
    expect(diag.range).toEqual(Range.create(0, 18 + 4, 0, 18 + 9));
    expect(diag.message).toBe("JSX attribute 'class' is not supported. Did you mean 'className'?");
    expect(diag.severity).toBe(DiagnosticSeverity.Error);
    expect(diag.source).toBe('React Pug (TS)');
  });

  // Test Scenario 2: Pug-to-JSX compilation fails
  it('should report a compilation failure diagnostic if compilePugToJsxString returns an error', async () => {
    const docContent = "const comp = pug`invalid pug syntax (`;";
    const testDoc = createDoc('file:///test-compile-fail.tsx', docContent);

    (compilePugToJsxString as jest.Mock).mockReturnValue({
      error: "Unexpected token '('",
    });

    // Mock findPugLiterals or ensure it runs
     const mockPugLiteralInfo = [{
      content: "invalid pug syntax (",
      range: Range.create(0, 15, 0, 37),
      contentRange: Range.create(0, 18, 0, 36),
      indentation: ""
    }];
    // This time, let's mock findPugLiterals for simplicity, assuming serverModule.findPugLiterals can be spied/mocked
    // If not, we rely on acorn parsing docContent, which is fine for simple cases.
    // For this example, let's assume the real findPugLiterals is used.

    await validateTextDocumentInternal(testDoc);

    expect(mockConnection.sendDiagnostics).toHaveBeenCalledTimes(1);
    const sentDiagnostics = mockConnection.sendDiagnostics.mock.calls[0][0].diagnostics;
    expect(sentDiagnostics).toHaveLength(1);
    const diag = sentDiagnostics[0] as Diagnostic;

    expect(diag.range).toEqual(Range.create(0, 18, 0, 36)); // Should cover the contentRange of the failing literal
    expect(diag.message).toContain("Pug to JSX compilation failed: Unexpected token '('");
    expect(diag.severity).toBe(DiagnosticSeverity.Error);
    expect(diag.source).toBe('React Pug (Compiler)');
  });


  // Test Scenario 3: Source map parsing fails
  it('should report unmapped TSX diagnostics if source map parsing fails', async () => {
    const docContent = "const comp = pug`div`;";
    const testDoc = createDoc('file:///test-map-fail.tsx', docContent);

    (compilePugToJsxString as jest.Mock).mockReturnValue({
      jsx: "<div></div>",
      sourceMap: { version: 3, sources: [], mappings: '' }, // Valid structure but parseSourceMap will fail it
    });
    (parseSourceMap as jest.Mock).mockResolvedValue(null); // Simulate parseSourceMap failure

    const mockTsDiagnostic: ts.Diagnostic = {
      file: undefined, start: 1, length: 3, // e.g. for 'div' in <div>
      messageText: "Some TSX error",
      category: ts.DiagnosticCategory.Warning, code: 1234,
    };
    mockTsLangService.getSyntacticDiagnostics.mockReturnValue([mockTsDiagnostic]);
    // Mock getSourceFile and getLineAndCharacterOfPosition as in the first test if they would be reached
    // However, if parseSourceMap fails, it should report unmapped diagnostics before trying to use mapJsxRangeToPugRange

    // Assume findPugLiterals works
    const literalContentRange = Range.create(0, 18, 0, 21); // for `div` inside pug`div`

    await validateTextDocumentInternal(testDoc);

    expect(mockConnection.sendDiagnostics).toHaveBeenCalledTimes(1);
    const sentDiagnostics = mockConnection.sendDiagnostics.mock.calls[0][0].diagnostics;
    expect(sentDiagnostics.length).toBeGreaterThanOrEqual(1); // Could be one per TS diag
    const diag = sentDiagnostics[0] as Diagnostic;

    expect(diag.range).toEqual(literalContentRange); // Fallback to whole literal
    expect(diag.message).toContain("(Unmapped TSX) Some TSX error");
    expect(diag.severity).toBe(DiagnosticSeverity.Warning);
    expect(diag.source).toBe('React Pug (TS)'); // Source indicates it's from TS, but unmapped.
                                                // The server.ts code has it as 'React Pug (TS)' for this path.
  });

  // TODO: Add more scenarios:
  // 4. mapJsxRangeToPugRange fails for a specific diagnostic
  // 5. No Pug literals
  // 6. Multiple Pug literals
  // 7. TSX has no errors

  it('should provide diagnostics for misuse of local scope variables in Pug', async () => {
    const localVariableSetup = "const localNum = 10;";
    // Using localNum as a function, which should be a type error
    const pugContent = "p #{localNum()}";
    const docContent = `
      function MyErrorComponent() {
        ${localVariableSetup}
        return pug\`${pugContent}\`;
      }
    `;
    const docUri = 'file:///test-local-diag.tsx';
    const doc = createDoc(docUri, docContent);
    const literalContentRange = Range.create(3, 20, 3, 20 + pugContent.length);

    const programAst = acorn.parse(docContent, { ecmaVersion: 'latest', sourceType: 'module', locations:true });
    const functionScopeNode = (programAst as any).body.find(n => n.type === 'FunctionDeclaration');

    serverModule.documents = { get: jest.fn().mockReturnValue(doc) };
    serverModule.findPugLiterals.mockReturnValue([{
      content: pugContent,
      contentRange: literalContentRange,
      indentation: "  ",
      enclosingScopeNode: functionScopeNode,
    }]);
    serverModule.extractImportStatements.mockReturnValue([]);
    jest.spyOn(serverModule, 'extractDeclarationsFromScope').mockReturnValue([localVariableSetup]);

    const generatedJsx = "<p>{localNum()}</p>";
    const mockSourceMap = { version: 3, sources:['virtual.js'], mappings:'AAAA' };
    (compilePugToJsxString as jest.Mock).mockReturnValue({ jsx: generatedJsx, sourceMap: mockSourceMap });

    const mockMapData = { consumer: {}, originalPugContent: pugContent, generatedJsxContent: generatedJsx };
    (parseSourceMap as jest.Mock).mockResolvedValue(mockMapData);

    // Mock TS to return a semantic error for localNum()
    const mockTsErrorDiagnostic: ts.Diagnostic = {
      file: undefined, // Will be the virtual file
      start: generatedJsx.indexOf("localNum()"),
      length: "localNum()".length,
      messageText: "This expression is not callable because type 'number' has no call signatures.",
      category: ts.DiagnosticCategory.Error,
      code: 2349, // Example TS error code
    };
    mockTsLangService.getSemanticDiagnostics.mockReturnValue([mockTsErrorDiagnostic]);
    mockTsLangService.getSyntacticDiagnostics.mockReturnValue([]); // No syntactic errors in the JSX itself

    const virtualTsxFilename = `${docUri}/literal-0.pug.virtual.tsx`;
    const virtualTsxContent = `${localVariableSetup}\nimport React from 'react';\nconst C = () => (<>${generatedJsx}</>);`;
    const mockJsxSourceFile = { text: virtualTsxContent, statements: [], fileName: virtualTsxFilename };
    mockTsLangService.getProgram().getSourceFile.mockReturnValue(mockJsxSourceFile);

    mockTs.getLineAndCharacterOfPosition.mockImplementation((sf, offset) => {
      // For 'localNum()' in <p>{localNum()}</p>
      const str = "localNum()";
      const idx = generatedJsx.indexOf(str);
      if (sf === mockJsxSourceFile && offset === idx) return { line: 0, character: idx + "{".length }; // Position of 'localNum()' inside {}
      if (sf === mockJsxSourceFile && offset === idx + str.length) return { line: 0, character: idx + "{".length + str.length };
      return { line: 0, character: 0 };
    });

    // mapJsxRangeToPugRange should map the JSX range of 'localNum()' back to Pug '#{localNum()}'
    const pugErrorRange = Range.create(
        0,
        pugContent.indexOf('localNum()'),
        0,
        pugContent.indexOf('localNum()') + 'localNum()'.length
    );
    (mapJsxRangeToPugRange as jest.Mock).mockReturnValue(pugErrorRange);

    await validateTextDocumentInternal(doc);

    expect(mockConnection.sendDiagnostics).toHaveBeenCalledTimes(1);
    const sentDiagnostics = mockConnection.sendDiagnostics.mock.calls[0][0].diagnostics;
    expect(sentDiagnostics).toHaveLength(1);
    const diag = sentDiagnostics[0] as Diagnostic;

    const expectedDocRelativePugErrorRange = Range.create(
      literalContentRange.start.line + pugErrorRange.start.line,
      (pugErrorRange.start.line === 0 ? literalContentRange.start.character : 0) + pugErrorRange.start.character,
      literalContentRange.start.line + pugErrorRange.end.line,
      (pugErrorRange.end.line === 0 ? literalContentRange.start.character : 0) + pugErrorRange.end.character
    );
    expect(diag.range).toEqual(expectedDocRelativePugErrorRange);
    expect(diag.message).toBe("This expression is not callable because type 'number' has no call signatures.");
    expect(diag.severity).toBe(DiagnosticSeverity.Error);
    expect(diag.source).toBe('React Pug (TS)');
    expect(serverModule.extractDeclarationsFromScope).toHaveBeenCalledWith(functionScopeNode, docContent);
  });
});

// Helper to make validateTextDocument accessible if not exported from server.ts
// This is a placeholder; actual mechanism depends on how server.ts is structured.
// If server.ts directly attaches to `documents.onDidChangeContent`, then testing involves
// triggering that event and spying on `connection.sendDiagnostics`.
// For example:
// documentsMock.onDidChangeContent((callback) => { validateTextDocumentInternal = callback; });
// And then in tests:
// documentsMock.triggerChangeContent(testDoc); // Assuming a way to trigger this.
// This is becoming very complex due to typical LSP server structure not being easily unit-testable for handlers.
// The ideal way is to export `validateTextDocument` or make it a class method.
// The `beforeAll` hack tries to get it, assuming it's exported or on the module.
