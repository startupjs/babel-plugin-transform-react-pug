// @ts-nocheck Disable type checking for this test file for simplicity with mocks

import { TextDocument } from 'vscode-languageserver-textdocument';
import { Position, Range, Hover } from 'vscode-languageserver/node';
import * as ts from 'typescript';

// Mock dependencies
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
  positionToOffset: jest.fn((text, pos) => {
    const lines = text.split('\\n');
    let offset = 0;
    for (let i = 0; i < pos.line; i++) {
      offset += lines[i].length + 1;
    }
    offset += pos.character;
    return offset;
  }),
}));

const mockTsLangService = {
  getQuickInfoAtPosition: jest.fn(),
  getProgram: jest.fn().mockReturnValue({
    getSourceFile: jest.fn(),
  }),
};
const mockTs = {
  ...ts,
  createLanguageService: jest.fn(() => mockTsLangService),
  getLineAndCharacterOfPosition: jest.fn(),
  displayPartsToString: jest.fn(parts => parts ? parts.map(p => p.text).join('') : ''), // Simplified mock like in server
  ScriptElementKind: ts.ScriptElementKind,
};
jest.mock('typescript', () => mockTs);

const mockConnection = {
  console: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  workspace: { getConfiguration: jest.fn().mockResolvedValue({}) },
};
jest.mock('vscode-languageserver/node', () => {
  const actualLsp = jest.requireActual('vscode-languageserver/node');
  return {
    ...actualLsp,
    createConnection: jest.fn(() => mockConnection),
  };
});

let onHoverHandler;
let serverModule;

beforeAll(() => {
  serverModule = require('../server');
  // Attempt to get onHoverHandler (similar strategy to onCompletion tests)
  const actualLspNode = jest.requireActual('vscode-languageserver/node');
  const tempConnection = actualLspNode.createConnection();
  const onHoverSpy = jest.spyOn(tempConnection, 'onHover');
  require('../server'); // Initialize server
  if (onHoverSpy.mock.calls.length > 0) {
    onHoverHandler = onHoverSpy.mock.calls[0][0];
  }
  onHoverSpy.mockRestore();
  if(!onHoverHandler) {
      console.warn("Could not get onHoverHandler for testing.");
      onHoverHandler = async () => null;
  }
});

describe('onHover Handler', () => {
  const createDoc = (uri, content) => TextDocument.create(uri, 'typescriptreact', 1, content);
  const { compilePugToJsxString } = require('../pugToJsxTransformer');
  const { parseSourceMap, mapPugPositionToJsxPosition, mapJsxRangeToPugRange, destroySourceMapData } = require('../jsxPugMapping');
  // const { positionToOffset } = require('../utils/textPositions'); // Already mocked

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnection.workspace.getConfiguration.mockResolvedValue({ classAttribute: 'className' });
    (compilePugToJsxString as jest.Mock).mockReturnValue({ jsx: "<p></p>", sourceMap: { version: 3, sources:['virtual.js'], mappings:'AAAA' } });
    (parseSourceMap as jest.Mock).mockResolvedValue({ consumer: {}, originalPugContent: '', generatedJsxContent: '' });
    (mapPugPositionToJsxPosition as jest.Mock).mockReturnValue(Position.create(1, 5));
    (mapJsxRangeToPugRange as jest.Mock).mockReturnValue(Range.create(0, 1, 0, 6)); // e.g., maps 'Hello' in Pug
    mockTsLangService.getQuickInfoAtPosition.mockReturnValue(null); // Default to no info
    mockTsLangService.getProgram().getSourceFile.mockReturnValue({ text: '', statements: [] });
    mockTs.getLineAndCharacterOfPosition.mockReturnValue({ line: 0, character: 0 });

    serverModule.findPugLiterals = jest.fn();
    serverModule.extractImportStatements = jest.fn().mockReturnValue([]);
  });

  it('should return null if cursor is outside any Pug literal', async () => {
    const doc = createDoc('file:///test.tsx', 'const x = 10;');
    serverModule.documents = { get: jest.fn().mockReturnValue(doc) };
    serverModule.findPugLiterals.mockReturnValue([]);

    const result = await onHoverHandler({ textDocument: { uri: doc.uri }, position: Position.create(0, 0) });
    expect(result).toBeNull();
  });

  it('should provide hover information with mapped range if all steps succeed', async () => {
    const pugContent = "p Hello";
    const docContent = `const comp = pug\`${pugContent}\`;`;
    const doc = createDoc('file:///test.tsx', docContent);
    const literalContentRange = Range.create(0, 18, 0, 18 + pugContent.length);

    serverModule.documents = { get: jest.fn().mockReturnValue(doc) };
    serverModule.findPugLiterals.mockReturnValue([{
      content: pugContent,
      contentRange: literalContentRange,
    }]);
    serverModule.extractImportStatements.mockReturnValue(["import React from 'react';"]);

    const generatedJsx = "<p>Hello</p>";
    const mockSourceMap = { version: 3, sources: ['virtual.js'], mappings: 'AAAA' };
    (compilePugToJsxString as jest.Mock).mockReturnValue({ jsx: generatedJsx, sourceMap: mockSourceMap });

    const mockMapData = { consumer: {}, originalPugContent: pugContent, generatedJsxContent: generatedJsx };
    (parseSourceMap as jest.Mock).mockResolvedValue(mockMapData);

    const cursorPugPosition = Position.create(0, 3); // Cursor in `p H|ello`
    const mappedJsxPosition = Position.create(1, 7); // Mocked: cursor in virtual JSX for 'H' in Hello
    (mapPugPositionToJsxPosition as jest.Mock).mockReturnValue(mappedJsxPosition);

    const virtualTsxContent = `import React from 'react';\nconst PugComponent = () => (<>${generatedJsx}</>);\nexport default PugComponent;`;
    // const jsxOffset = positionToOffset(virtualTsxContent, mappedJsxPosition);

    const mockQuickInfo: ts.QuickInfo = {
      kind: ts.ScriptElementKind.stringContentElement,
      kindModifiers: '',
      textSpan: { start: 10, length: 5 }, // Mocked: span for 'Hello' in virtual JSX
      displayParts: [{ text: 'string', kind: 'text' }],
      documentation: [{ text: 'Some documentation', kind: 'text' }],
    };
    mockTsLangService.getQuickInfoAtPosition.mockReturnValue(mockQuickInfo);

    const mockJsxSourceFile = { text: virtualTsxContent, statements: [], fileName: `${doc.uri}/literal-0.pug.virtual.tsx` };
    mockTsLangService.getProgram().getSourceFile.mockReturnValue(mockJsxSourceFile);

    // Mock getLineAndCharacterOfPosition for the QuickInfo textSpan
    // Assuming 'Hello' in <p>Hello</p> starts at char 10, length 5 in virtualTsxContent
    mockTs.getLineAndCharacterOfPosition.mockImplementation((sf, offset) => {
      if (sf === mockJsxSourceFile && offset === 10) return { line: 1, character: 10 }; // Start of 'Hello'
      if (sf === mockJsxSourceFile && offset === 15) return { line: 1, character: 15 }; // End of 'Hello'
      return { line: 0, character: offset };
    });

    // mapJsxRangeToPugRange is already mocked to return Range.create(0, 1, 0, 6)
    // This corresponds to "Hello" in "p Hello" (char 2 to 7, if 'p ' is 2 chars)
    // Let's adjust for clarity: `p Hello` -> H is at (0,2), o is at (0,6). Range is (0,2) to (0,7) for "Hello"
    const mappedPugHoverRange = Range.create(0, 2, 0, 7);
    (mapJsxRangeToPugRange as jest.Mock).mockReturnValue(mappedPugHoverRange);


    const result = await onHoverHandler({ textDocument: { uri: doc.uri }, position: Position.create(0, 18 + 3) });

    expect(result).not.toBeNull();
    expect(result.contents).toEqual({
      kind: 'markdown',
      value: 'string\n\n---\nSome documentation'
    });

    const expectedDocRelativeHoverRange = Range.create(
      literalContentRange.start.line + mappedPugHoverRange.start.line,
      (mappedPugHoverRange.start.line === 0 ? literalContentRange.start.character : 0) + mappedPugHoverRange.start.character,
      literalContentRange.start.line + mappedPugHoverRange.end.line,
      (mappedPugHoverRange.end.line === 0 ? literalContentRange.start.character : 0) + mappedPugHoverRange.end.character
    ); // Expected: L0 C(18+2) to L0 C(18+7) => L0 C20 to L0 C25
    expect(result.range).toEqual(expectedDocRelativeHoverRange);
  });

  it('should return hover info without range if textSpan mapping fails', async () => {
    const doc = createDoc('file:///test.tsx', 'pug`div`');
    serverModule.documents = { get: jest.fn().mockReturnValue(doc) };
    serverModule.findPugLiterals.mockReturnValue([{ content: 'div', contentRange: Range.create(0,4,0,7) }]);

    const mockQuickInfoNoSpanMap: ts.QuickInfo = {
      kind: ts.ScriptElementKind.stringContentElement, kindModifiers: '',
      textSpan: { start: 0, length: 3 }, displayParts: [{text: 'Hover text', kind: 'text'}]
    };
    mockTsLangService.getQuickInfoAtPosition.mockReturnValue(mockQuickInfoNoSpanMap);
    (mapJsxRangeToPugRange as jest.Mock).mockReturnValue(null); // Simulate range mapping failure

    const result = await onHoverHandler({ textDocument: { uri: doc.uri }, position: Position.create(0, 5) });
    expect(result.contents).toEqual({ kind: 'markdown', value: 'Hover text' });
    expect(result.range).toBeUndefined();
  });

  it('should return null if getQuickInfoAtPosition returns null', async () => {
    const doc = createDoc('file:///test.tsx', 'pug`div`');
    serverModule.documents = { get: jest.fn().mockReturnValue(doc) };
    serverModule.findPugLiterals.mockReturnValue([{ content: 'div', contentRange: Range.create(0,4,0,7) }]);
    mockTsLangService.getQuickInfoAtPosition.mockReturnValue(null);

    const result = await onHoverHandler({ textDocument: { uri: doc.uri }, position: Position.create(0, 5) });
    expect(result).toBeNull();
  });

   it('should handle compilePugToJsxString failure gracefully', async () => {
    const doc = createDoc('file:///test.tsx', 'pug`invalid`');
    serverModule.documents = { get: jest.fn().mockReturnValue(doc) };
    serverModule.findPugLiterals.mockReturnValue([{ content: 'invalid', contentRange: Range.create(0,4,0,11) }]);
    (compilePugToJsxString as jest.Mock).mockReturnValue({ error: 'Compilation error' });

    const result = await onHoverHandler({ textDocument: { uri: doc.uri }, position: Position.create(0, 5) });
    expect(result).toBeNull();
  });

  it('should provide hover information for local scope variables', async () => {
    const localConst = "const myLocalString = 'Local Value';";
    const pugContent = "p #{myLocalStr}"; // Hovering over myLocalStr
    const docContent = `
      function TestHoverComponent() {
        ${localConst}
        return pug\`${pugContent}\`;
      }
    `;
    const doc = createDoc('file:///test-local-hover.tsx', docContent);
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
    jest.spyOn(serverModule, 'extractDeclarationsFromScope').mockReturnValue([localConst]);

    const generatedJsx = "<p>{myLocalStr}</p>"; // Simplified
    (compilePugToJsxString as jest.Mock).mockReturnValue({ jsx: generatedJsx, sourceMap: { version: 3, sources:[], mappings:'' } });

    const mockMapData = { consumer: {}, originalPugContent: pugContent, generatedJsxContent: generatedJsx };
    (parseSourceMap as jest.Mock).mockResolvedValue(mockMapData);

    // Cursor in Pug: p #{myLocalStr|}
    const cursorPugPosition = Position.create(0, pugContent.indexOf('myLocalStr') + 'myLocalStr'.length);
    // Corresponding position in JSX: <p>{myLocalStr|}</p>
    const mappedJsxPosition = Position.create(0, generatedJsx.indexOf('myLocalStr') + 'myLocalStr'.length);
    (mapPugPositionToJsxPosition as jest.Mock).mockReturnValue(mappedJsxPosition);

    const virtualTsxContent = `${localConst}\nimport React from 'react';\nconst C = () => (<>${generatedJsx}</>);`;
    const jsxOffset = 100; // Dummy offset
    (positionToOffset as jest.Mock).mockReturnValue(jsxOffset);

    const mockQuickInfoResult: ts.QuickInfo = {
      kind: ts.ScriptElementKind.variableElement,
      kindModifiers: ts.ScriptElementKindModifier.constModifier,
      textSpan: { start: jsxOffset - 'myLocalStr'.length, length: 'myLocalStr'.length }, // Span of 'myLocalStr' in JSX
      displayParts: [{ text: '(const) myLocalString: "Local Value"', kind: 'text' }],
      documentation: [{text: 'A local string variable.', kind: 'text'}]
    };
    mockTsLangService.getQuickInfoAtPosition.mockReturnValue(mockQuickInfoResult);

    const mockJsxSourceFile = { text: virtualTsxContent, statements: [], fileName: `${doc.uri}/literal-0.pug.virtual.tsx` };
    mockTsLangService.getProgram().getSourceFile.mockReturnValue(mockJsxSourceFile);

    mockTs.getLineAndCharacterOfPosition.mockImplementation((sf, offset) => {
      // Simplified for the 'myLocalStr' part in JSX
      if (offset === jsxOffset - 'myLocalStr'.length) return { line: 0, character: mappedJsxPosition.character - 'myLocalStr'.length };
      if (offset === jsxOffset) return { line: 0, character: mappedJsxPosition.character };
      return { line:0, character:0};
    });

    // mapJsxRangeToPugRange should map the JSX span of 'myLocalStr' to Pug span of 'myLocalStr'
    const pugHoverRange = Range.create(
        cursorPugPosition.line,
        cursorPugPosition.character - 'myLocalStr'.length,
        cursorPugPosition.line,
        cursorPugPosition.character
    );
    (mapJsxRangeToPugRange as jest.Mock).mockReturnValue(pugHoverRange);

    // Actual cursor position in document for the request
    const requestPosition = Position.create(3, 20 + cursorPugPosition.character);
    const result = await onHoverHandler({ textDocument: { uri: doc.uri }, position: requestPosition });

    expect(result).not.toBeNull();
    expect(result.contents).toEqual({
      kind: 'markdown',
      value: '(const) myLocalString: "Local Value"\n\n---\nA local string variable.'
    });
    const expectedDocRelativeRange = Range.create(
        literalContentRange.start.line + pugHoverRange.start.line,
        (pugHoverRange.start.line === 0 ? literalContentRange.start.character : 0) + pugHoverRange.start.character,
        literalContentRange.start.line + pugHoverRange.end.line,
        (pugHoverRange.end.line === 0 ? literalContentRange.start.character : 0) + pugHoverRange.end.character
    );
    expect(result.range).toEqual(expectedDocRelativeRange);
    expect(serverModule.extractDeclarationsFromScope).toHaveBeenCalledWith(functionScopeNode, docContent);
  });

  it('should provide hover information for enclosing function parameters', async () => {
    const pugContent = "p #{hoverParam}"; // Hovering over hoverParam
    const docContent = `
      function TestHoverParams(hoverParam, anotherParam) {
        return pug\`${pugContent}\`;
      }
    `;
    const doc = createDoc('file:///test-func-params-hover.tsx', docContent);
    const literalContentRange = Range.create(2, 20, 2, 20 + pugContent.length);

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
    // Mock extractDeclarationsAndParamsFromScope to return dummy param declarations
    jest.spyOn(serverModule, 'extractDeclarationsAndParamsFromScope').mockReturnValue({
        declarations: [],
        paramTexts: ["let hoverParam: any;", "let anotherParam: any;"]
    });

    const generatedJsx = "<p>{hoverParam}</p>";
    (compilePugToJsxString as jest.Mock).mockReturnValue({ jsx: generatedJsx, sourceMap: { version: 3, sources:[], mappings:'' } });

    const mockMapData = { consumer: {}, originalPugContent: pugContent, generatedJsxContent: generatedJsx };
    (parseSourceMap as jest.Mock).mockResolvedValue(mockMapData);

    const cursorPugPosition = Position.create(0, pugContent.indexOf('hoverParam') + 'hoverParam'.length);
    const mappedJsxPosition = Position.create(0, generatedJsx.indexOf('hoverParam') + 'hoverParam'.length);
    (mapPugPositionToJsxPosition as jest.Mock).mockReturnValue(mappedJsxPosition);

    const virtualTsxContent = `let hoverParam: any;\nlet anotherParam: any;\nimport React from 'react';\nconst C = () => (<>${generatedJsx}</>);`;
    const jsxOffset = 100; // Dummy offset
    (positionToOffset as jest.Mock).mockReturnValue(jsxOffset);

    const mockQuickInfoResult: ts.QuickInfo = {
      kind: ts.ScriptElementKind.parameterElement,
      kindModifiers: '',
      textSpan: { start: jsxOffset - 'hoverParam'.length, length: 'hoverParam'.length },
      displayParts: [{ text: '(parameter) hoverParam: any', kind: 'text' }],
      documentation: [{text: 'A function parameter.', kind: 'text'}]
    };
    mockTsLangService.getQuickInfoAtPosition.mockReturnValue(mockQuickInfoResult);

    const mockJsxSourceFile = { text: virtualTsxContent, statements: [], fileName: `${doc.uri}/literal-0.pug.virtual.tsx` };
    mockTsLangService.getProgram().getSourceFile.mockReturnValue(mockJsxSourceFile);

    mockTs.getLineAndCharacterOfPosition.mockImplementation((sf, offset) => {
      if (offset === jsxOffset - 'hoverParam'.length) return { line: 0, character: mappedJsxPosition.character - 'hoverParam'.length };
      if (offset === jsxOffset) return { line: 0, character: mappedJsxPosition.character };
      return { line:0, character:0};
    });

    const pugHoverRange = Range.create(
        cursorPugPosition.line,
        cursorPugPosition.character - 'hoverParam'.length,
        cursorPugPosition.line,
        cursorPugPosition.character
    );
    (mapJsxRangeToPugRange as jest.Mock).mockReturnValue(pugHoverRange);

    const requestPosition = Position.create(2, 20 + cursorPugPosition.character);
    const result = await onHoverHandler({ textDocument: { uri: doc.uri }, position: requestPosition });

    expect(result).not.toBeNull();
    expect(result.contents).toEqual({
      kind: 'markdown',
      value: '(parameter) hoverParam: any\n\n---\nA function parameter.'
    });
    const expectedDocRelativeRange = Range.create(
        literalContentRange.start.line + pugHoverRange.start.line,
        (pugHoverRange.start.line === 0 ? literalContentRange.start.character : 0) + pugHoverRange.start.character,
        literalContentRange.start.line + pugHoverRange.end.line,
        (pugHoverRange.end.line === 0 ? literalContentRange.start.character : 0) + pugHoverRange.end.character
    );
    expect(result.range).toEqual(expectedDocRelativeRange);
    expect(serverModule.extractDeclarationsAndParamsFromScope).toHaveBeenCalledWith(functionScopeNode, docContent);
  });
});
