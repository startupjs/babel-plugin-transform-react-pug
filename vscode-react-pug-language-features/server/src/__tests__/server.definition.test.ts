// @ts-nocheck Disable type checking for this test file for simplicity with mocks

import { TextDocument } from 'vscode-languageserver-textdocument';
import { Position, Range, Location } from 'vscode-languageserver/node';
import * as ts from 'typescript';
import { pathToFileURL as mockPathToFileURL } from 'url'; // Import to mock

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
jest.mock('url', () => ({ // Mock the 'url' module
    pathToFileURL: jest.fn(path => ({ toString: () => `file://${path}` })), // Simplified mock
}));


const mockTsLangService = {
  getDefinitionAtPosition: jest.fn(),
  getProgram: jest.fn().mockReturnValue({
    getSourceFile: jest.fn(),
  }),
};
const mockTs = {
  ...ts,
  createLanguageService: jest.fn(() => mockTsLangService),
  getLineAndCharacterOfPosition: jest.fn(),
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
    Location: actualLsp.Location, // Ensure real Location is used
  };
});

let onDefinitionHandler;
let serverModule;

beforeAll(() => {
  serverModule = require('../server');
  const actualLspNode = jest.requireActual('vscode-languageserver/node');
  const tempConnection = actualLspNode.createConnection();
  const onDefinitionSpy = jest.spyOn(tempConnection, 'onDefinition');
  require('../server'); // Initialize server
  if (onDefinitionSpy.mock.calls.length > 0) {
    onDefinitionHandler = onDefinitionSpy.mock.calls[0][0];
  }
  onDefinitionSpy.mockRestore();
  if(!onDefinitionHandler) {
      console.warn("Could not get onDefinitionHandler for testing.");
      onDefinitionHandler = async () => null;
  }
});

describe('onDefinition Handler', () => {
  const createDoc = (uri, content) => TextDocument.create(uri, 'typescriptreact', 1, content);
  const { compilePugToJsxString } = require('../pugToJsxTransformer');
  const { parseSourceMap, mapPugPositionToJsxPosition, mapJsxRangeToPugRange, destroySourceMapData } = require('../jsxPugMapping');

  beforeEach(() => {
    jest.clearAllMocks();
    (mockPathToFileURL as jest.Mock).mockImplementation(path => ({ toString: () => `file://${path}` })); // Reset mock impl
    mockConnection.workspace.getConfiguration.mockResolvedValue({ classAttribute: 'className' });
    (compilePugToJsxString as jest.Mock).mockReturnValue({ jsx: "<MyComponent />", sourceMap: { version: 3, sources:['virtual.js'], mappings:'AAAA' } });
    (parseSourceMap as jest.Mock).mockResolvedValue({ consumer: {}, originalPugContent: '', generatedJsxContent: '' });
    (mapPugPositionToJsxPosition as jest.Mock).mockReturnValue(Position.create(1, 5)); // Mocked JSX position
    (mapJsxRangeToPugRange as jest.Mock).mockReturnValue(Range.create(0, 0, 0, 10)); // Mocked Pug range for mapped definitions
    mockTsLangService.getDefinitionAtPosition.mockReturnValue([]); // Default to no definitions
    mockTsLangService.getProgram().getSourceFile.mockReturnValue({ text: '', statements: [] });
    mockTs.getLineAndCharacterOfPosition.mockReturnValue({ line: 0, character: 0 });

    serverModule.findPugLiterals = jest.fn();
    serverModule.extractImportStatements = jest.fn().mockReturnValue([]);
  });

  it('should return null if definition is requested outside a Pug literal', async () => {
    const doc = createDoc('file:///test.tsx', 'const x = 10;');
    serverModule.documents = { get: jest.fn().mockReturnValue(doc) };
    serverModule.findPugLiterals.mockReturnValue([]);

    const result = await onDefinitionHandler({ textDocument: { uri: doc.uri }, position: Position.create(0, 0) });
    expect(result).toBeNull();
  });

  it('should return mapped definition location if definition is within virtual JSX', async () => {
    const pugContent = "MyComponent";
    const docUri = 'file:///test.tsx';
    const doc = createDoc(docUri, `pug\`${pugContent}\``);
    const literalContentRange = Range.create(0, 4, 0, 4 + pugContent.length);
    const virtualTsxFilename = `${docUri}/literal-0.pug.virtual.tsx`; // Matches server logic

    serverModule.documents = { get: jest.fn().mockReturnValue(doc) };
    serverModule.findPugLiterals.mockReturnValue([{ content: pugContent, contentRange: literalContentRange }]);

    const generatedJsx = "<MyComponent />";
    (compilePugToJsxString as jest.Mock).mockReturnValue({ jsx: generatedJsx, sourceMap: { version: 3, sources: [], mappings: '' }});
    const mockMapData = { consumer: {}, originalPugContent: pugContent, generatedJsxContent: generatedJsx };
    (parseSourceMap as jest.Mock).mockResolvedValue(mockMapData);
    (mapPugPositionToJsxPosition as jest.Mock).mockReturnValue(Position.create(0, 1)); // Cursor on <MyComponent />

    const mockDefinitionInfo: ts.DefinitionInfo[] = [{
      fileName: virtualTsxFilename, // Definition is in the virtual file
      textSpan: { start: 1, length: 11 }, // Span of <MyComponent /> in virtual JSX
      kind: ts.ScriptElementKind.jsxOpenTagName, name: 'MyComponent',
      containerKind: ts.ScriptElementKind.unknown, containerName: ''
    }];
    mockTsLangService.getDefinitionAtPosition.mockReturnValue(mockDefinitionInfo);

    const mockJsxSourceFile = { text: `const Comp = () => (<>${generatedJsx}</>);`, fileName: virtualTsxFilename };
    mockTsLangService.getProgram().getSourceFile.mockImplementation(fname => fname === virtualTsxFilename ? mockJsxSourceFile : undefined);

    // Mock getLineAndCharacterOfPosition for the definition's textSpan
    mockTs.getLineAndCharacterOfPosition.mockImplementation((sf, offset) => {
      if (sf === mockJsxSourceFile && offset === 1) return { line: 0, character: 1 }; // Start of <MyComponent />
      if (sf === mockJsxSourceFile && offset === 12) return { line: 0, character: 12 };// End of <MyComponent />
      return { line: 0, character: 0 };
    });

    // mapJsxRangeToPugRange will map the JSX range of <MyComponent /> back to Pug "MyComponent"
    const mappedPugDefRange = Range.create(0, 0, 0, pugContent.length); // e.g. "MyComponent" in Pug
    (mapJsxRangeToPugRange as jest.Mock).mockReturnValue(mappedPugDefRange);

    const result = await onDefinitionHandler({ textDocument: { uri: docUri }, position: Position.create(0, 5) });

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result[0].uri).toBe(docUri);
    const expectedDocRelativePugDefRange = Range.create(
        literalContentRange.start.line + mappedPugDefRange.start.line,
        (mappedPugDefRange.start.line === 0 ? literalContentRange.start.character : 0) + mappedPugDefRange.start.character,
        literalContentRange.start.line + mappedPugDefRange.end.line,
        (mappedPugDefRange.end.line === 0 ? literalContentRange.start.character : 0) + mappedPugDefRange.end.character
    ); // L0 C4 to L0 C(4+11)
    expect(result[0].range).toEqual(expectedDocRelativePugDefRange);
  });

  it('should return external file location if definition is in an external file', async () => {
    const pugContent = "ImportedBtn";
    const docUri = 'file:///test.tsx';
    const doc = createDoc(docUri, `pug\`${pugContent}\``);
    serverModule.documents = { get: jest.fn().mockReturnValue(doc) };
    serverModule.findPugLiterals.mockReturnValue([{ content: pugContent, contentRange: Range.create(0,4,0,15) }]);

    const externalFilePath = '/path/to/components/button.tsx';
    const mockDefinitionInfo: ts.DefinitionInfo[] = [{
      fileName: externalFilePath, // Definition in external file
      textSpan: { start: 20, length: 10 }, // Span in external file
      kind: ts.ScriptElementKind.functionElement, name: 'ImportedBtn',
      containerKind: ts.ScriptElementKind.unknown, containerName: ''
    }];
    mockTsLangService.getDefinitionAtPosition.mockReturnValue(mockDefinitionInfo);

    const mockExternalSourceFile = { text: `export function ImportedBtn() {}`, fileName: externalFilePath };
    mockTsLangService.getProgram().getSourceFile.mockImplementation(fname => fname === externalFilePath ? mockExternalSourceFile : undefined);

    mockTs.getLineAndCharacterOfPosition.mockImplementation((sf, offset) => {
      if (sf === mockExternalSourceFile && offset === 20) return { line: 1, character: 17 }; // Example line/char
      if (sf === mockExternalSourceFile && offset === 30) return { line: 1, character: 27 };
      return { line: 0, character: 0 };
    });
    (mockPathToFileURL as jest.Mock).mockReturnValue({ toString: () => `file://${externalFilePath}` });


    const result = await onDefinitionHandler({ textDocument: { uri: docUri }, position: Position.create(0, 5) });
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result[0].uri).toBe(`file://${externalFilePath}`);
    expect(result[0].range).toEqual(Range.create(1, 17, 1, 27));
  });

  it('should return null if TS service returns no definition', async () => {
    const doc = createDoc('file:///test.tsx', 'pug`div`');
    serverModule.documents = { get: jest.fn().mockReturnValue(doc) };
    serverModule.findPugLiterals.mockReturnValue([{ content: 'div', contentRange: Range.create(0,4,0,7) }]);
    mockTsLangService.getDefinitionAtPosition.mockReturnValue([]); // No definition

    const result = await onDefinitionHandler({ textDocument: { uri: doc.uri }, position: Position.create(0, 5) });
    expect(result).toBeNull();
  });
});
