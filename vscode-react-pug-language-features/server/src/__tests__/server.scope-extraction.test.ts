// @ts-nocheck Disable type checking for this test file for simplicity with mocks

import { TextDocument } from 'vscode-languageserver-textdocument';
import * as acorn from 'acorn';
// Import functions to be tested - assuming they are exported or accessible for testing
// This might require adjusting server.ts to export them for test environment
let findPugLiterals;
let extractDeclarationsFromScope;
let serverModule;

// Acorn's Node type is not explicitly exported in its main typing,
// but it's the base for all nodes. We can use 'any' or define a minimal interface.
type AcornNode = acorn.Node;


beforeAll(() => {
  // This is a common way to handle modules that might have side effects or complex setups
  // We require it here after jest has set up its environment.
  serverModule = require('../server');
  if (serverModule.TEST_EXPORTS) {
    findPugLiterals = serverModule.TEST_EXPORTS.findPugLiterals;
    extractDeclarationsFromScope = serverModule.TEST_EXPORTS.extractDeclarationsFromScope;
  } else {
    // Fallback if not using TEST_EXPORTS, try to get them if they are module-level exports
    findPugLiterals = serverModule.findPugLiterals;
    extractDeclarationsFromScope = serverModule.extractDeclarationsFromScope;
  }

  if (!findPugLiterals || !extractDeclarationsFromScope) {
    throw new Error("findPugLiterals or extractDeclarationsFromScope not found. Ensure they are exported from server.ts for testing.");
  }
});

const createDoc = (content: string) => TextDocument.create('file:///test.tsx', 'typescriptreact', 1, content);

describe('findPugLiterals - Enclosing Scope Detection', () => {
  it('should identify Program as enclosing scope for top-level pug literal', () => {
    const doc = createDoc("const comp = pug`div`;");
    const literals = findPugLiterals(doc);
    expect(literals).toHaveLength(1);
    expect(literals[0].enclosingScopeNode).toBeDefined();
    expect(literals[0].enclosingScopeNode.type).toBe('Program');
  });

  it('should identify FunctionDeclaration as enclosing scope', () => {
    const doc = createDoc("function MyComponent() { const comp = pug`p`; }");
    const literals = findPugLiterals(doc);
    expect(literals).toHaveLength(1);
    expect(literals[0].enclosingScopeNode).toBeDefined();
    expect(literals[0].enclosingScopeNode.type).toBe('FunctionDeclaration');
  });

  it('should identify ArrowFunctionExpression as enclosing scope', () => {
    const doc = createDoc("const MyComponent = () => { const comp = pug`span`; };");
    const literals = findPugLiterals(doc);
    expect(literals).toHaveLength(1);
    expect(literals[0].enclosingScopeNode).toBeDefined();
    // ArrowFunctionExpression body can be a BlockStatement or an Expression.
    // The scope identified by current findPugLiterals logic will be the ArrowFunctionExpression itself.
    expect(literals[0].enclosingScopeNode.type).toBe('ArrowFunctionExpression');
  });

  it('should identify BlockStatement as enclosing scope if no function is closer', () => {
    const doc = createDoc("if (true) { const comp = pug`a`; }");
    const literals = findPugLiterals(doc);
    expect(literals).toHaveLength(1);
    expect(literals[0].enclosingScopeNode).toBeDefined();
    expect(literals[0].enclosingScopeNode.type).toBe('BlockStatement');
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
    expect(literals).toHaveLength(1);
    expect(literals[0].enclosingScopeNode).toBeDefined();
    expect(literals[0].enclosingScopeNode.type).toBe('FunctionDeclaration');
    // To be more precise, we'd check the name of the function node if Acorn provides it,
    // or its start/end positions to confirm it's InnerFunc.
    const funcNode = literals[0].enclosingScopeNode as any;
    expect(funcNode.id?.name).toBe('InnerFunc');
  });
});

describe('extractDeclarationsFromScope', () => {
  it('should return an empty array if scopeNode is undefined', () => {
    const declarations = extractDeclarationsFromScope(undefined, "const a = 1;");
    expect(declarations).toEqual([]);
  });

  it('should extract VariableDeclarations from a Program scope', () => {
    const docText = "const a = 10; let b = 'hello'; var c = true;";
    const ast = acorn.parse(docText, { ecmaVersion: 'latest', sourceType: 'module' }) as AcornNode;
    const declarations = extractDeclarationsFromScope(ast, docText); // ast is Program node
    expect(declarations).toHaveLength(3);
    expect(declarations).toContain("const a = 10;");
    expect(declarations).toContain("let b = 'hello';");
    expect(declarations).toContain("var c = true;");
  });

  it('should extract FunctionDeclarations from a Program scope', () => {
    const docText = "function foo() {}\nasync function bar() {}";
    const ast = acorn.parse(docText, { ecmaVersion: 'latest', sourceType: 'module' }) as AcornNode;
    const declarations = extractDeclarationsFromScope(ast, docText);
    expect(declarations).toHaveLength(2);
    expect(declarations[0]).toMatch(/^function foo\(\s*\)\s*\{\s*\}$/); // Regex to handle slight variations
    expect(declarations[1]).toMatch(/^async function bar\(\s*\)\s*\{\s*\}$/);
  });

  it('should extract declarations from a FunctionDeclaration scope body', () => {
    const docText = "function MyComponent() { const x = 1; function inner() {} let y = 2; }";
    const ast = acorn.parse(docText, { ecmaVersion: 'latest', sourceType: 'module' }) as AcornNode;
    const funcNode = (ast as any).body[0]; // Get the FunctionDeclaration node
    expect(funcNode.type).toBe('FunctionDeclaration');

    const declarations = extractDeclarationsFromScope(funcNode, docText);
    expect(declarations).toHaveLength(3);
    expect(declarations).toContain("const x = 1;");
    expect(declarations).toContain("function inner() {}");
    expect(declarations).toContain("let y = 2;");
  });

  it('should extract declarations from an ArrowFunctionExpression with BlockStatement body', () => {
    const docText = "const MyComponent = () => { const x = 'arrow'; function helper() {} };";
    const ast = acorn.parse(docText, { ecmaVersion: 'latest', sourceType: 'module' }) as AcornNode;
    // VariableDeclaration -> VariableDeclarator -> ArrowFunctionExpression
    const arrowFuncNode = (ast as any).body[0].declarations[0].init;
    expect(arrowFuncNode.type).toBe('ArrowFunctionExpression');

    const declarations = extractDeclarationsFromScope(arrowFuncNode, docText);
    expect(declarations).toHaveLength(2);
    expect(declarations).toContain("const x = 'arrow';");
    expect(declarations).toContain("function helper() {}");
  });

  it('should not extract declarations from nested scopes', () => {
    const docText = "function Outer() { const a = 1; if (true) { const b = 2; } function Inner() { const c = 3; } }";
    const ast = acorn.parse(docText, { ecmaVersion: 'latest', sourceType: 'module' }) as AcornNode;
    const outerFuncNode = (ast as any).body[0];
    expect(outerFuncNode.type).toBe('FunctionDeclaration');

    const declarations = extractDeclarationsFromScope(outerFuncNode, docText);
    // Should only get 'const a = 1;' and 'function Inner() { const c = 3; }' (the whole function)
    // NOT 'const b = 2;' or 'const c = 3;' separately.
    expect(declarations).toHaveLength(2);
    expect(declarations).toContain("const a = 1;");
    expect(declarations.some(d => d.startsWith("function Inner()"))).toBe(true);
    expect(declarations.some(d => d.includes("const b = 2;"))).toBe(false);
  });

  it('should return empty array for ArrowFunctionExpression with implicit return (no block)', () => {
    const docText = "const MyComponent = (props) => props.name;";
    const ast = acorn.parse(docText, { ecmaVersion: 'latest', sourceType: 'module' }) as AcornNode;
    const arrowFuncNode = (ast as any).body[0].declarations[0].init;
    expect(arrowFuncNode.type).toBe('ArrowFunctionExpression');
    expect(arrowFuncNode.body.type).not.toBe('BlockStatement'); // e.g. Identifier or MemberExpression

    const declarations = extractDeclarationsFromScope(arrowFuncNode, docText);
    expect(declarations).toEqual([]);
  });
});

// TODO: Add tests for LSP handlers (diagnostics, completions, hover, definition)
// to verify they correctly use the `enclosingScopeNode` and `extractDeclarationsFromScope`
// to provide context from local scopes.
// This would involve:
// 1. Setting up document content with local variables/functions used in pug literals.
// 2. Mocking `findPugLiterals` to return the correct `enclosingScopeNode`.
// 3. Mocking `extractDeclarationsFromScope` to return the text of these declarations.
// 4. Verifying that the `virtualTsxContent` passed to the (mocked) TS service includes these declarations.
// 5. Verifying that the (mocked) TS service, when returning (e.g.) completions, includes these local items.
// These tests would likely go into the existing server.{feature}.test.ts files or a combined one.
