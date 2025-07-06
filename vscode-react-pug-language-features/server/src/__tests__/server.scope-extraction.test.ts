// @ts-nocheck Disable type checking for this test file for simplicity with mocks

import { TextDocument } from 'vscode-languageserver-textdocument';
import * as acorn from 'acorn';
// Import functions to be tested - assuming they are exported or accessible for testing
let findPugLiterals;
let extractDeclarationsAndParamsFromScope;
let serverModule;

type AcornNode = acorn.Node;

beforeAll(() => {
  serverModule = require('../server');
  if (serverModule.TEST_EXPORTS) {
    findPugLiterals = serverModule.TEST_EXPORTS.findPugLiterals;
    extractDeclarationsAndParamsFromScope = serverModule.TEST_EXPORTS.extractDeclarationsAndParamsFromScope;
  } else {
    findPugLiterals = serverModule.findPugLiterals;
    extractDeclarationsAndParamsFromScope = serverModule.extractDeclarationsAndParamsFromScope;
  }

  if (!findPugLiterals || !extractDeclarationsAndParamsFromScope) {
    throw new Error("findPugLiterals or extractDeclarationsAndParamsFromScope not found. Ensure they are exported from server.ts for testing.");
  }
});

const createDoc = (content: string) => TextDocument.create('file:///test.tsx', 'typescriptreact', 1, content);

describe('findPugLiterals - Enclosing Scope Detection', () => {
  it('should identify Program as enclosing scope for top-level pug literal', () => {
    const doc = createDoc("const comp = pug`div`;");
    const literals = findPugLiterals(doc);
    expect(literals[0]?.enclosingScopeNode?.type).toBe('Program');
  });

  it('should identify FunctionDeclaration as enclosing scope', () => {
    const doc = createDoc("function MyComponent() { const comp = pug`p`; }");
    const literals = findPugLiterals(doc);
    expect(literals[0]?.enclosingScopeNode?.type).toBe('FunctionDeclaration');
  });

  it('should identify ArrowFunctionExpression as enclosing scope', () => {
    const doc = createDoc("const MyComponent = () => { const comp = pug`span`; };");
    const literals = findPugLiterals(doc);
    expect(literals[0]?.enclosingScopeNode?.type).toBe('ArrowFunctionExpression');
  });

   it('should find the *immediate* enclosing function scope for nested structures', () => {
    const docContent = `
      function OuterFunc() {
        const outerVar = 1;
        function InnerFunc() {
          const innerVar = 2;
          const comp = pug\`div #{innerVar}\`;
        }
      }
    `;
    const doc = createDoc(docContent);
    const literals = findPugLiterals(doc);
    const funcNode = literals[0]?.enclosingScopeNode as any;
    expect(funcNode?.type).toBe('FunctionDeclaration');
    expect(funcNode?.id?.name).toBe('InnerFunc');
  });
});

describe('extractDeclarationsAndParamsFromScope', () => {
  it('should return empty results if scopeNode is undefined', () => {
    const result = extractDeclarationsAndParamsFromScope(undefined, "const a = 1;");
    expect(result.declarations).toEqual([]);
    expect(result.parameterNames).toEqual([]);
  });

  it('should extract VariableDeclarations and no params from a Program scope', () => {
    const docText = "const a = 10; let b = 'hello';";
    const ast = acorn.parse(docText, { ecmaVersion: 'latest', sourceType: 'module' }) as AcornNode;
    const result = extractDeclarationsAndParamsFromScope(ast, docText);
    expect(result.declarations).toEqual(["const a = 10;", "let b = 'hello';"]);
    expect(result.parameterNames).toEqual([]);
  });

  it('should extract declarations and simple parameters from a FunctionDeclaration', () => {
    const docText = "function MyComponent(param1, param2) { const x = 1; }";
    const ast = acorn.parse(docText, { ecmaVersion: 'latest', sourceType: 'module' }) as AcornNode;
    const funcNode = (ast as any).body[0];
    const result = extractDeclarationsAndParamsFromScope(funcNode, docText);
    expect(result.declarations).toEqual(["const x = 1;"]);
    expect(result.parameterNames).toEqual(["param1", "param2"]);
  });

  it('should extract parameters with default values (AssignmentPattern)', () => {
    const docText = "const MyComponent = (paramA, paramB = 'default') => { const y = 'arrow'; };";
    const ast = acorn.parse(docText, { ecmaVersion: 'latest', sourceType: 'module' }) as AcornNode;
    const arrowFuncNode = (ast as any).body[0].declarations[0].init;
    const result = extractDeclarationsAndParamsFromScope(arrowFuncNode, docText);
    expect(result.declarations).toEqual(["const y = 'arrow';"]);
    expect(result.parameterNames).toEqual(["paramA", "paramB"]);
  });

  it('should extract names from ObjectPattern parameters', () => {
    const docText = "function greet({ name, age }, { city = 'NY' }) { const msg = `Hello ${name}`;}";
    const ast = acorn.parse(docText, { ecmaVersion: 'latest', sourceType: 'module' }) as AcornNode;
    const funcNode = (ast as any).body[0];
    const result = extractDeclarationsAndParamsFromScope(funcNode, docText);
    expect(result.declarations).toEqual(["const msg = `Hello ${name}`;"]);
    expect(result.parameterNames).toEqual(expect.arrayContaining(["name", "age", "city"]));
    expect(result.parameterNames.length).toBe(3);
  });

  it('should extract names from ArrayPattern parameters', () => {
    const docText = "function process([item1, item2], [valA = 10]) { const res = item1 + item2; }";
    const ast = acorn.parse(docText, { ecmaVersion: 'latest', sourceType: 'module' }) as AcornNode;
    const funcNode = (ast as any).body[0];
    const result = extractDeclarationsAndParamsFromScope(funcNode, docText);
    expect(result.declarations).toEqual(["const res = item1 + item2;"]);
    expect(result.parameterNames).toEqual(expect.arrayContaining(["item1", "item2", "valA"]));
    expect(result.parameterNames.length).toBe(3);
  });

  it('should extract names from RestElement parameters', () => {
    const docText = "function sum(first, ...numbers) { return numbers.reduce((acc, n) => acc + n, first); }";
    const ast = acorn.parse(docText, { ecmaVersion: 'latest', sourceType: 'module' }) as AcornNode;
    const funcNode = (ast as any).body[0];
    const result = extractDeclarationsAndParamsFromScope(funcNode, docText);
    // The body of this function is a ReturnStatement, not declarations.
    expect(result.declarations).toEqual([]);
    expect(result.parameterNames).toEqual(["first", "numbers"]);
  });

  it('should handle mixed parameter types including nested destructuring', () => {
    const docText = "const mixedParams = (id, {user: {firstName, lastName}, type = 'default'}, ...restArgs) => { /* ... */ }";
    const ast = acorn.parse(docText, { ecmaVersion: 'latest', sourceType: 'module' }) as AcornNode;
    const arrowFuncNode = (ast as any).body[0].declarations[0].init;
    const result = extractDeclarationsAndParamsFromScope(arrowFuncNode, docText);
    expect(result.parameterNames).toEqual(expect.arrayContaining(["id", "firstName", "lastName", "type", "restArgs"]));
    expect(result.parameterNames.length).toBe(5);
  });
});
