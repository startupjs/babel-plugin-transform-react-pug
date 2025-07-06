// @ts-nocheck Disable type checking for this test file for simplicity with mocks

import { TextDocument } from 'vscode-languageserver-textdocument';
import { Position, Range, CompletionItemKind, TextEdit } from 'vscode-languageserver/node';
import * as ts from 'typescript';

// Mock dependencies (must be done before importing the module under test)
jest.mock('../pugToJsxTransformer', () => ({
  compilePugToJsxString: jest.fn(),
}));
jest.mock('../jsxPugMapping', () => ({
  parseSourceMap: jest.fn(),
  mapPugPositionToJsxPosition: jest.fn(),
  mapJsxRangeToPugRange: jest.fn(),
  destroySourceMapData: jest.fn(),
}));
jest.mock('../utils/textPositions', () => ({
  positionToOffset: jest.fn((text, pos) => { // Simplified mock, real one is more complex
    const lines = text.split('\\n');
    let offset = 0;
    for (let i = 0; i < pos.line; i++) {
      offset += lines[i].length + 1; // +1 for newline
    }
    offset += pos.character;
    return offset;
  }),
  // offsetToPosition: jest.fn(), // Not directly used by onCompletion AFAIK, but good to have if needed
}));


const mockTsLangService = {
  getCompletionsAtPosition: jest.fn(),
  getCompletionEntryDetails: jest.fn(),
  getProgram: jest.fn().mockReturnValue({
    getSourceFile: jest.fn(),
  }),
};
const mockTs = {
  ...ts,
  createLanguageService: jest.fn(() => mockTsLangService),
  getLineAndCharacterOfPosition: jest.fn(),
  flattenDiagnosticMessageText: jest.fn((diag, _) => typeof diag === 'string' ? diag : diag.messageText),
  ScriptElementKind: ts.ScriptElementKind, // Use actual enum
};
jest.mock('typescript', () => mockTs);

const mockConnection = {
  sendDiagnostics: jest.fn(), // Though not primary for completion tests
  console: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  workspace: { getConfiguration: jest.fn().mockResolvedValue({}) },
};
jest.mock('vscode-languageserver/node', () => {
  const actualLsp = jest.requireActual('vscode-languageserver/node');
  return {
    ...actualLsp,
    createConnection: jest.fn(() => mockConnection),
    CompletionItemKind: actualLsp.CompletionItemKind, // Ensure enums are real
    TextEdit: actualLsp.TextEdit,
  };
});

// Import the server's onCompletion handler
// This is tricky because server.ts runs connection.listen() globally.
// We need to ensure server.ts is imported *after* all mocks are set up.
let onCompletionHandler;
let serverModule; // To access findPugLiterals and extractImportStatements if not mocked

beforeAll(() => {
  serverModule = require('../server');
  // Access the onCompletion handler. This depends on how it's registered.
  // If connection.onCompletion(handler) is used, we might need to spy on connection.onCompletion.
  // For now, assuming we can get a reference to the handler or test it via triggering events
  // This part is often the most difficult in testing LSP servers due to their event-driven nature.
  // A common pattern is to export the core logic functions from server.ts for easier testing.
  // Let's assume `connection.onCompletion` was spied on and we captured the handler.
  // Or, if server.ts exports its handlers map:
  if (serverModule.TEST_EXPORTS && serverModule.TEST_EXPORTS.onCompletion) {
    onCompletionHandler = serverModule.TEST_EXPORTS.onCompletion;
  } else {
    // Fallback: try to spy on connection.onCompletion if serverModule initializes connection
    // This is less ideal as it relies on import side effects.
    const actualLspNode = jest.requireActual('vscode-languageserver/node');
    const tempConnection = actualLspNode.createConnection(); // Temporary connection to spy on
    const onCompletionSpy = jest.spyOn(tempConnection, 'onCompletion');
    require('../server'); // Initialize server to register handlers
    if (onCompletionSpy.mock.calls.length > 0) {
      onCompletionHandler = onCompletionSpy.mock.calls[0][0];
    }
    onCompletionSpy.mockRestore(); // Clean up spy

    if(!onCompletionHandler) {
        console.warn("Could not get onCompletionHandler for testing. Tests may not run correctly.");
        // A dummy handler to prevent crashes, actual tests will likely fail or be skipped.
        onCompletionHandler = async () => null;
    }
  }
});


describe('onCompletion Handler', () => {
  const createDoc = (uri, content) => TextDocument.create(uri, 'typescriptreact', 1, content);
  const { compilePugToJsxString } = require('../pugToJsxTransformer');
  const { parseSourceMap, mapPugPositionToJsxPosition, mapJsxRangeToPugRange, destroySourceMapData } = require('../jsxPugMapping');
  const { positionToOffset } = require('../utils/textPositions');

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnection.workspace.getConfiguration.mockResolvedValue({ classAttribute: 'className' });
    // Default successful mocks
    (compilePugToJsxString as jest.Mock).mockReturnValue({ jsx: "<p></p>", sourceMap: { version: 3, sources:['virtual.js'], mappings:'AAAA' } });
    (parseSourceMap as jest.Mock).mockResolvedValue({ consumer: {}, originalPugContent: '', generatedJsxContent: '' });
    (mapPugPositionToJsxPosition as jest.Mock).mockReturnValue(Position.create(1, 5)); // Mocked JSX position
    (mapJsxRangeToPugRange as jest.Mock).mockReturnValue(Range.create(0, 0, 0, 5)); // Mocked Pug range for edits
    mockTsLangService.getCompletionsAtPosition.mockReturnValue({ entries: [] });
    mockTsLangService.getCompletionEntryDetails.mockReturnValue({});
    mockTsLangService.getProgram().getSourceFile.mockReturnValue({ text: '', statements: [] }); // Mock for ts.getLineAndCharacterOfPosition
    mockTs.getLineAndCharacterOfPosition.mockReturnValue({ line: 0, character: 0 });

    // Mock findPugLiterals and extractImportStatements from the server module
    // This is safer than relying on their real implementations during these unit tests.
    serverModule.findPugLiterals = jest.fn();
    serverModule.extractImportStatements = jest.fn().mockReturnValue([]);
  });

  it('should return null if document is not found', async () => {
    serverModule.documents = { get: jest.fn().mockReturnValue(null) }; // Mock documents.get
    const result = await onCompletionHandler({ textDocument: { uri: 'file:///test.tsx' }, position: Position.create(0, 0) });
    expect(result).toBeNull();
  });

  it('should return null if cursor is outside any Pug literal', async () => {
    const doc = createDoc('file:///test.tsx', 'const x = 10;');
    serverModule.documents = { get: jest.fn().mockReturnValue(doc) };
    serverModule.findPugLiterals.mockReturnValue([]); // No pug literals

    const result = await onCompletionHandler({ textDocument: { uri: doc.uri }, position: Position.create(0, 0) });
    expect(result).toBeNull();
    expect(compilePugToJsxString).not.toHaveBeenCalled();
  });

  it('should provide completions with mapped TextEdit ranges if all steps succeed', async () => {
    const pugContent = "p Hello";
    const docContent = `const comp = pug\`${pugContent}\`;`;
    const doc = createDoc('file:///test.tsx', docContent);
    const literalContentRange = Range.create(0, 18, 0, 18 + pugContent.length);

    serverModule.documents = { get: jest.fn().mockReturnValue(doc) };
    serverModule.findPugLiterals.mockReturnValue([{
      content: pugContent,
      range: Range.create(0, 15, 0, 19 + pugContent.length),
      contentRange: literalContentRange,
      indentation: "",
    }]);
    serverModule.extractImportStatements.mockReturnValue(["import React from 'react';"]);

    const generatedJsx = "<p>Hello</p>";
    const mockSourceMap = { version: 3, sources: ['virtual.js'], mappings: 'AAAA' };
    (compilePugToJsxString as jest.Mock).mockReturnValue({ jsx: generatedJsx, sourceMap: mockSourceMap });

    const mockMapData = { consumer: {}, originalPugContent: pugContent, generatedJsxContent: generatedJsx };
    (parseSourceMap as jest.Mock).mockResolvedValue(mockMapData);

    const cursorPugPosition = Position.create(0, 2); // Cursor in `p |Hello`
    const mappedJsxPosition = Position.create(1, 6); // Mocked: cursor in virtual JSX
    (mapPugPositionToJsxPosition as jest.Mock).mockReturnValue(mappedJsxPosition);

    const virtualTsxContent = `import React from 'react';\nconst PugComponent = () => (<>${generatedJsx}</>);\nexport default PugComponent;`;
    const jsxOffset = positionToOffset(virtualTsxContent, mappedJsxPosition); // Calculate offset

    mockTsLangService.getCompletionsAtPosition.mockReturnValue({
      entries: [{ name: 'React', kind: ts.ScriptElementKind.moduleElement }],
    });

    const mockCompletionDetails = {
      name: 'React',
      kind: ts.ScriptElementKind.moduleElement,
      displayParts: [{text: 'React', kind: 'text'}],
      codeActions: [{
        changes: [{
          fileName: `${doc.uri}/literal-0.pug.virtual.tsx`, // Matches virtualTsxFilename construction
          textChanges: [{ span: { start: jsxOffset, length: 0 }, newText: 'React' }]
        }]
      }]
    };
    mockTsLangService.getCompletionEntryDetails.mockReturnValue(mockCompletionDetails);

    const mockJsxSourceFile = { text: virtualTsxContent, statements: [], fileName: `${doc.uri}/literal-0.pug.virtual.tsx` };
    mockTsLangService.getProgram().getSourceFile.mockReturnValue(mockJsxSourceFile);

    // Mock getLineAndCharacterOfPosition for the TextEdit span
    mockTs.getLineAndCharacterOfPosition.mockImplementation((sf, offset) => {
      if (sf === mockJsxSourceFile && offset === jsxOffset) return mappedJsxPosition; // start of span
      if (sf === mockJsxSourceFile && offset === jsxOffset + 0) return mappedJsxPosition; // end of span (length 0)
      return { line: 0, character: 0 }; // fallback
    });

    const mappedPugEditRange = Range.create(0, 2, 0, 2); // Mapped from JSX span for 'React' insertion
    (mapJsxRangeToPugRange as jest.Mock).mockReturnValue(mappedPugEditRange);

    const result = await onCompletionHandler({ textDocument: { uri: doc.uri }, position: Position.create(0, 18 + 2) });

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('React');
    expect(result[0].kind).toBe(CompletionItemKind.Module);
    expect(result[0].textEdit).toBeDefined();

    const expectedDocRelativePugRange = Range.create(
      literalContentRange.start.line + mappedPugEditRange.start.line,
      (mappedPugEditRange.start.line === 0 ? literalContentRange.start.character : 0) + mappedPugEditRange.start.character,
      literalContentRange.start.line + mappedPugEditRange.end.line,
      (mappedPugEditRange.end.line === 0 ? literalContentRange.start.character : 0) + mappedPugEditRange.end.character
    );
    expect(result[0].textEdit).toEqual(TextEdit.replace(expectedDocRelativePugRange, 'React'));
  });

  it('should return completions without TextEdits if details/codeActions are missing', async () => {
    const pugContent = "p ";
    const doc = createDoc('file:///test.tsx', `pug\`${pugContent}\``);
     serverModule.documents = { get: jest.fn().mockReturnValue(doc) };
    serverModule.findPugLiterals.mockReturnValue([{ content: pugContent, contentRange: Range.create(0,4,0,6) }]);

    mockTsLangService.getCompletionsAtPosition.mockReturnValue({
      entries: [{ name: 'myVar', kind: ts.ScriptElementKind.variableElement }],
    });
    mockTsLangService.getCompletionEntryDetails.mockReturnValue({ // No codeActions
        name: 'myVar', kind: ts.ScriptElementKind.variableElement
    });

    const result = await onCompletionHandler({ textDocument: { uri: doc.uri }, position: Position.create(0, 6) });
    expect(result[0].label).toBe('myVar');
    expect(result[0].textEdit).toBeUndefined();
  });

  it('should handle compilePugToJsxString failure gracefully', async () => {
    const doc = createDoc('file:///test.tsx', 'pug`invalid`');
    serverModule.documents = { get: jest.fn().mockReturnValue(doc) };
    serverModule.findPugLiterals.mockReturnValue([{ content: 'invalid', contentRange: Range.create(0,4,0,11) }]);
    (compilePugToJsxString as jest.Mock).mockReturnValue({ error: 'Compilation error' });

    const result = await onCompletionHandler({ textDocument: { uri: doc.uri }, position: Position.create(0, 5) });
    // Depending on strictness, could be null or empty array. Current code has `continue` which means it would try next literal or return null.
    expect(result).toBeNull();
  });

  it('should handle mapPugPositionToJsxPosition failure gracefully', async () => {
    const doc = createDoc('file:///test.tsx', 'pug`valid`');
    serverModule.documents = { get: jest.fn().mockReturnValue(doc) };
    serverModule.findPugLiterals.mockReturnValue([{ content: 'valid', contentRange: Range.create(0,4,0,9) }]);
    (mapPugPositionToJsxPosition as jest.Mock).mockReturnValue(null); // Simulate mapping failure

    const result = await onCompletionHandler({ textDocument: { uri: doc.uri }, position: Position.create(0, 5) });
    expect(result).toBeNull();
  });

  it('should provide completions for local scope variables', async () => {
    const localFuncVar = "const myLocalValue = 123;";
    const pugContent = "p #{myLo}"; // User typing myLo...
    const docContent = `
      function TestComponent() {
        ${localFuncVar}
        return pug\`${pugContent}\`;
      }
    `;
    const doc = createDoc('file:///test-local-scope.tsx', docContent);
    const literalContentRange = Range.create(3, 20, 3, 20 + pugContent.length); // Approximate

    // Mock findPugLiterals to return the Pug literal *and* its enclosing scope node
    const programAst = acorn.parse(docContent, { ecmaVersion: 'latest', sourceType: 'module', locations:true });
    const functionScopeNode = (programAst as any).body.find(n => n.type === 'FunctionDeclaration'); // Get FunctionDeclaration node

    serverModule.documents = { get: jest.fn().mockReturnValue(doc) };
    serverModule.findPugLiterals.mockReturnValue([{
      content: pugContent,
      contentRange: literalContentRange,
      indentation: "  ",
      enclosingScopeNode: functionScopeNode, // Provide the scope node
    }]);

    // Mock extractImportStatements (likely empty for this self-contained example)
    serverModule.extractImportStatements.mockReturnValue([]);
    // Mock extractDeclarationsFromScope to return the local variable
    // Note: In a real scenario, extractDeclarationsFromScope would parse functionScopeNode.
    // Here, we are unit testing onCompletion's use of these, so we mock their direct output.
    jest.spyOn(serverModule, 'extractDeclarationsFromScope').mockReturnValue([localFuncVar]);


    const generatedJsx = "<p>{myLo}</p>"; // Simplified JSX for the typed portion
    (compilePugToJsxString as jest.Mock).mockReturnValue({ jsx: generatedJsx, sourceMap: { version: 3, sources:[], mappings:'' } });

    const mockMapData = { consumer: {}, originalPugContent: pugContent, generatedJsxContent: generatedJsx };
    (parseSourceMap as jest.Mock).mockResolvedValue(mockMapData);

    const cursorPugPosition = Position.create(0, pugContent.indexOf('myLo') + 'myLo'.length); // Cursor after "myLo" in "p #{myLo}"
    const mappedJsxPosition = Position.create(0, generatedJsx.indexOf('myLo') + 'myLo'.length); // Corresponding position in "<p>{myLo}</p>"
    (mapPugPositionToJsxPosition as jest.Mock).mockReturnValue(mappedJsxPosition);

    const virtualTsxContentExpectedToContain = `${localFuncVar}\nimport React from 'react';`;
    const jsxOffset = 100; // Dummy offset, real one calculated by positionToOffset
    (positionToOffset as jest.Mock).mockReturnValue(jsxOffset);


    mockTsLangService.getCompletionsAtPosition.mockImplementation((filename, offset, options) => {
      // Check if the virtual file content (not directly available here) would contain localFuncVar
      // For this test, we assume it does and TS service would find 'myLocalValue'
      return {
        entries: [{ name: 'myLocalValue', kind: ts.ScriptElementKind.variableElement }],
      };
    });
    mockTsLangService.getCompletionEntryDetails.mockReturnValue({
        name: 'myLocalValue', kind: ts.ScriptElementKind.variableElement, displayParts: [{text: 'myLocalValue', kind:'text'}]
    });

    // Position of `pug\`p #{myLo}\``, cursor at end of myLo
    // Line numbers are 0-indexed in Position.create
    const requestPosition = Position.create(3, 20 + pugContent.indexOf('myLo') + 'myLo'.length);
    const result = await onCompletionHandler({ textDocument: { uri: doc.uri }, position: requestPosition });

    expect(serverModule.extractDeclarationsFromScope).toHaveBeenCalledWith(functionScopeNode, docContent);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('myLocalValue');
    expect(result[0].kind).toBe(CompletionItemKind.Variable);

    // Verify that updateVirtualFile was called with content including the local var
    // This requires spying on updateVirtualFile or checking its effect on virtualFiles map
    // which are internal to server.ts. For now, the functional outcome (completion provided) is the main check.
  });

  it('should provide completions for enclosing function parameters', async () => {
    const pugContent = "p #{para}"; // User typing para...
    const docContent = `
      function TestComponentWithParams(paramA, paramB) {
        // const localToFunc = "test";
        return pug\`${pugContent}\`;
      }
    `;
    const doc = createDoc('file:///test-func-params.tsx', docContent);
    const literalContentRange = Range.create(3, 20, 3, 20 + pugContent.length); // Approximate

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
    jest.spyOn(serverModule, 'extractDeclarationsAndParamsFromScope').mockReturnValue({
        declarations: [/* "const localToFunc = \"test\";" */],
        parameterNames: ["paramA", "paramB"] // Now returns names, not full decls
    });

    // virtualTsxContent will be constructed by createVirtualTsxContent in server.ts
    // which will create "let paramA: any;", "let paramB: any;"

    const generatedJsx = "<p>{para}</p>";
    (compilePugToJsxString as jest.Mock).mockReturnValue({ jsx: generatedJsx, sourceMap: { version: 3, sources:[], mappings:'' } });

    const mockMapData = { consumer: {}, originalPugContent: pugContent, generatedJsxContent: generatedJsx };
    (parseSourceMap as jest.Mock).mockResolvedValue(mockMapData);

    const cursorPugPosition = Position.create(0, pugContent.indexOf('para') + 'para'.length);
    const mappedJsxPosition = Position.create(0, generatedJsx.indexOf('para') + 'para'.length);
    (mapPugPositionToJsxPosition as jest.Mock).mockReturnValue(mappedJsxPosition);

    const jsxOffset = 150; // Dummy offset
    (positionToOffset as jest.Mock).mockReturnValue(jsxOffset);

    mockTsLangService.getCompletionsAtPosition.mockImplementation((filename, offset, options) => {
      // Simulate TS service finding 'paramA' and 'paramB' due to their dummy declarations
      return {
        entries: [
          { name: 'paramA', kind: ts.ScriptElementKind.parameterElement },
          { name: 'paramB', kind: ts.ScriptElementKind.parameterElement },
        ],
      };
    });
    mockTsLangService.getCompletionEntryDetails.mockImplementation(({name, kind}) => ({ // Ensure destructuring of args
        name, kind, displayParts: [{text: name, kind:'parameterName'}]
    }));

    const requestPosition = Position.create(3, 20 + cursorPugPosition.character);
    const result = await onCompletionHandler({ textDocument: { uri: doc.uri }, position: requestPosition });

    expect(serverModule.extractDeclarationsAndParamsFromScope).toHaveBeenCalledWith(functionScopeNode, docContent);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result.find(item => item.label === 'paramA')).toBeDefined();
    expect(result.find(item => item.label === 'paramB')).toBeDefined();
    expect(result[0].kind).toBe(CompletionItemKind.Variable); // Parameters are often treated as variables by LSP kind
  });

  describe('TextEdit newText transformation', () => {
    // Re-mock transformJsxSnippetToPug for specific tests if needed, or rely on its actual import
    // For these tests, we'll assume the actual transformJsxSnippetToPug is imported and works as per its own unit tests.

    it('should use transformed Pug snippet for newText if transformation is successful', async () => {
      const pugContent = "My";
      const doc = createDoc('file:///test-transform.tsx', `pug\`${pugContent}\``);
      const literalContentRange = Range.create(0, 4, 0, 4 + pugContent.length);
      serverModule.documents = { get: jest.fn().mockReturnValue(doc) };
      serverModule.findPugLiterals.mockReturnValue([{ content: pugContent, contentRange: literalContentRange, enclosingScopeNode: {type: 'Program', body: []} }]);
      serverModule.extractImportStatements.mockReturnValue([]);
      serverModule.extractDeclarationsAndParamsFromScope.mockReturnValue({declarations:[], paramTexts:[]});


      const jsxToInsert = "<MyComponent />";
      const expectedPugInsert = "MyComponent/"; // From transformJsxSnippetToPug

      (compilePugToJsxString as jest.Mock).mockReturnValue({ jsx: "<My/>", sourceMap: { version: 3, sources:[], mappings:'' }});
      (mapPugPositionToJsxPosition as jest.Mock).mockReturnValue(Position.create(0,3)); // Cursor after <My|/>
      (positionToOffset as jest.Mock).mockReturnValue(3);

      mockTsLangService.getCompletionsAtPosition.mockReturnValue({ entries: [{ name: 'MyComponent', kind: ts.ScriptElementKind.classElement }] });
      mockTsLangService.getCompletionEntryDetails.mockReturnValue({
        name: 'MyComponent', kind: ts.ScriptElementKind.classElement, displayParts: [],
        codeActions: [{ changes: [{ fileName: `${doc.uri}/literal-0.pug.virtual.tsx`, textChanges: [{ span: { start: 3, length: 0 }, newText: jsxToInsert }] }] }]
      });
      mockTsLangService.getProgram().getSourceFile.mockReturnValue({ text: `() => <My/>`, fileName: `${doc.uri}/literal-0.pug.virtual.tsx` });
      mockTs.getLineAndCharacterOfPosition.mockReturnValue({line:0, character:3}); // For span start and end
      (mapJsxRangeToPugRange as jest.Mock).mockReturnValue(Range.create(0,2,0,2)); // Range in Pug for "My"

      const result = await onCompletionHandler({ textDocument: { uri: doc.uri }, position: Position.create(0, 4 + pugContent.length) });
      expect(result[0].textEdit.newText).toBe(expectedPugInsert);
    });

    it('should use original JSX newText if transformation returns null', async () => {
      const pugContent = "data={";
      const doc = createDoc('file:///test-no-transform.tsx', `pug\`${pugContent}\``);
      const literalContentRange = Range.create(0, 4, 0, 4 + pugContent.length);
      serverModule.documents = { get: jest.fn().mockReturnValue(doc) };
      serverModule.findPugLiterals.mockReturnValue([{ content: pugContent, contentRange: literalContentRange, enclosingScopeNode: {type: 'Program', body: []} }]);
      serverModule.extractImportStatements.mockReturnValue([]);
      serverModule.extractDeclarationsAndParamsFromScope.mockReturnValue({declarations:[], paramTexts:[]});

      const jsxToInsert = "{complexObject}"; // Assume transformJsxSnippetToPug returns null for this

      (compilePugToJsxString as jest.Mock).mockReturnValue({ jsx: "data={}", sourceMap: { version: 3, sources:[], mappings:'' }});
      (mapPugPositionToJsxPosition as jest.Mock).mockReturnValue(Position.create(0,6)); // Cursor after data={|}
      (positionToOffset as jest.Mock).mockReturnValue(6);

      mockTsLangService.getCompletionsAtPosition.mockReturnValue({ entries: [{ name: 'complexObject', kind: ts.ScriptElementKind.variableElement }] });
      mockTsLangService.getCompletionEntryDetails.mockReturnValue({
        name: 'complexObject', kind: ts.ScriptElementKind.variableElement, displayParts: [],
        codeActions: [{ changes: [{ fileName: `${doc.uri}/literal-0.pug.virtual.tsx`, textChanges: [{ span: { start: 6, length: 0 }, newText: jsxToInsert }] }] }]
      });
      mockTsLangService.getProgram().getSourceFile.mockReturnValue({ text: `() => data={}`, fileName: `${doc.uri}/literal-0.pug.virtual.tsx`});
      mockTs.getLineAndCharacterOfPosition.mockReturnValue({line:0, character:6});
      (mapJsxRangeToPugRange as jest.Mock).mockReturnValue(Range.create(0,6,0,6));

      const result = await onCompletionHandler({ textDocument: { uri: doc.uri }, position: Position.create(0, 4 + pugContent.length) });
      expect(result[0].textEdit.newText).toBe(jsxToInsert); // Falls back to original JSX
    });

    it('should use transformed Pug snippet with attributes for newText', async () => {
      const pugContent = "My";
      const doc = createDoc('file:///test-transform-attrs.tsx', `pug\`${pugContent}\``);
      const literalContentRange = Range.create(0, 4, 0, 4 + pugContent.length);
      serverModule.documents = { get: jest.fn().mockReturnValue(doc) };
      serverModule.findPugLiterals.mockReturnValue([{ content: pugContent, contentRange: literalContentRange, enclosingScopeNode: {type: 'Program', body: []} }]);
      serverModule.extractImportStatements.mockReturnValue([]);
      serverModule.extractDeclarationsAndParamsFromScope.mockReturnValue({declarations:[], parameterNames:[]});

      const jsxToInsert = '<MyComponent id="test1" active />';
      const expectedPugInsert = "MyComponent(id='test1', active)/";

      (compilePugToJsxString as jest.Mock).mockReturnValue({ jsx: "<My/>", sourceMap: { version: 3, sources:[], mappings:'' }});
      (mapPugPositionToJsxPosition as jest.Mock).mockReturnValue(Position.create(0,3));
      (positionToOffset as jest.Mock).mockReturnValue(3);

      mockTsLangService.getCompletionsAtPosition.mockReturnValue({ entries: [{ name: 'MyComponent', kind: ts.ScriptElementKind.classElement }] });
      mockTsLangService.getCompletionEntryDetails.mockReturnValue({
        name: 'MyComponent', kind: ts.ScriptElementKind.classElement, displayParts: [],
        codeActions: [{ changes: [{ fileName: `${doc.uri}/literal-0.pug.virtual.tsx`, textChanges: [{ span: { start: 3, length: 0 }, newText: jsxToInsert }] }] }]
      });
      mockTsLangService.getProgram().getSourceFile.mockReturnValue({ text: `() => <My/>`, fileName: `${doc.uri}/literal-0.pug.virtual.tsx` });
      mockTs.getLineAndCharacterOfPosition.mockReturnValue({line:0, character:3});
      (mapJsxRangeToPugRange as jest.Mock).mockReturnValue(Range.create(0,2,0,2)); // Range in Pug for "My"

      const result = await onCompletionHandler({ textDocument: { uri: doc.uri }, position: Position.create(0, 4 + pugContent.length) });
      expect(result[0].textEdit.newText).toBe(expectedPugInsert);
    });
  });
});
