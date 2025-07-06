import * as acorn from 'acorn';
// @ts-ignore - acorn-jsx types might not be perfectly aligned for default import
import jsxAcuornPlugin from 'acorn-jsx';

// Initialize Acorn parser with JSX plugin
const JsxParser = acorn.Parser.extend(jsxAcuornPlugin());

const HTML_VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function getJsxTagName(nameNode: any): string {
  if (!nameNode) return '';
  if (nameNode.type === 'JSXIdentifier') {
    return nameNode.name;
  } else if (nameNode.type === 'JSXMemberExpression') {
    // Recurse for object and property if they are JSXIdentifiers or further JSXMemberExpressions
    const objectName = getJsxTagName(nameNode.object);
    const propertyName = getJsxTagName(nameNode.property);
    if (objectName && propertyName) {
      return `${objectName}.${propertyName}`;
    }
  }
  return ''; // Fallback for other complex name types not handled
}

/**
 * Transforms simple, common JSX snippets into Pug-like syntax using AST parsing.
 * Returns null if no transformation is applied or if parsing/transformation fails.
 *
 * @param jsxSnippet The JSX string snippet.
 * @returns A Pug-like string or null.
 */
export function transformJsxSnippetToPug(jsxSnippet: string): string | null {
  jsxSnippet = jsxSnippet.trim();
  if (!jsxSnippet) return null;

  try {
    // Parse the snippet as a JSX expression.
    // `parseExpressionAt` is suitable for snippets that are valid expressions.
    const ast = JsxParser.parseExpressionAt(jsxSnippet, 0, { ecmaVersion: 'latest', locations: false }) as any;

    if (ast.type === 'JSXElement') {
      const openingElement = ast.openingElement;
      const tagName = getJsxTagName(openingElement.name);

      if (!tagName) return null; // Could not determine tag name

      let pugAttrs = "";
      if (openingElement.attributes && openingElement.attributes.length > 0) {
        const attrs: string[] = [];
        for (const attr of openingElement.attributes) {
          if (attr.type === 'JSXAttribute') {
            const attrNameNode = attr.name;
            let attrName = '';
            if (attrNameNode.type === 'JSXIdentifier') {
                attrName = attrNameNode.name;
            } else if (attrNameNode.type === 'JSXNamespacedName') { // e.g. namespace:attribute
                attrName = `${attrNameNode.namespace.name}:${attrNameNode.name.name}`;
            } else {
                continue; // Skip unknown attribute name types
            }

            if (attr.value === null) { // Boolean prop, e.g. <Comp checked />
              attrs.push(attrName);
            } else if (attr.value.type === 'StringLiteral') {
              // Prefer single quotes for Pug attributes if value doesn't contain them
              const value = attr.value.value;
              if (value.includes("'") && !value.includes('"')) {
                attrs.push(`${attrName}="${value.replace(/"/g, '\\"')}"`);
              } else {
                attrs.push(`${attrName}='${value.replace(/'/g, "\\'")}'`);
              }
            } else if (attr.value.type === 'JSXExpressionContainer') {
              // For expressions like prop={variable} or prop={123}
              // Acorn's AST for JSXExpressionContainer has `expression` property.
              // We need the raw text of this expression.
              // This requires having the original snippet and start/end offsets of the expression.
              // The `acorn.parseExpressionAt` doesn't give sub-string source easily.
              // This is a limitation for now. We'll return null if expression attributes are present.
              return null; // Limitation: Cannot reliably get expression text for attributes yet.
            }
          } else if (attr.type === 'JSXSpreadAttribute') {
            return null; // Limitation: Cannot handle spread attributes.
          }
        }
        if (attrs.length > 0) {
          pugAttrs = `(${attrs.join(', ')})`;
        }
      }

      const isSelfClosingTag = openingElement.selfClosing;
      const isHtmlVoidElement = HTML_VOID_ELEMENTS.has(tagName.toLowerCase());

      // Handle children (very simplified: only allow if NO children for now, or if it's an empty tag pair)
      const hasChildren = ast.children && ast.children.length > 0;
      const isClosedTagPair = ast.closingElement !== null && getJsxTagName(ast.closingElement.name) === tagName;

      if (hasChildren) {
        // For <div></div>, children array is empty.
        // If children array is not empty, it's too complex for this simple transformer.
        return null;
      }

      if (isSelfClosingTag) {
        return `${tagName}${pugAttrs}${isHtmlVoidElement ? '' : '/'}`;
      } else if (isClosedTagPair) { // e.g. <div></div> or <MyComponent></MyComponent>
         // If it's an empty pair like <div></div>, Pug is just 'div'
         // If it's <MyComponent></MyComponent>, Pug is `MyComponent` (attributes might make it `MyComponent(attr)`)
        return `${tagName}${pugAttrs}`;
      }
    }
  } catch (e) {
    // console.warn("JSX Snippet Parsing/Transformation Error:", (e as Error).message, "Snippet:", jsxSnippet);
    return null;
  }

  return null; // Fallback if no specific transformation rule matched or for unhandled cases
}
