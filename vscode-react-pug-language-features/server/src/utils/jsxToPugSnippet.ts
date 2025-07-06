// Initial simple JSX to Pug snippet transformer

/**
 * Transforms simple, common JSX snippets into Pug-like syntax.
 * This is a very basic transformer and only handles a few patterns.
 * Returns null if no transformation is applied.
 *
 * @param jsxSnippet The JSX string snippet.
 * @returns A Pug-like string or null.
 */
export function transformJsxSnippetToPug(jsxSnippet: string): string | null {
  jsxSnippet = jsxSnippet.trim();

  // Pattern 1: Self-closing component <Comp />
  // e.g., <MyComponent /> -> MyComponent/
  // e.g., <namespace.MyComponent /> -> namespace.MyComponent/
  let match = jsxSnippet.match(/^<([A-Za-z0-9_.]+)\s*\/>$/);
  if (match) {
    return `${match[1]}/`;
  }

  // Pattern 2: Self-closing component with simple string props <Comp prop="value" prop2="value2" />
  // e.g., <MyComponent foo="bar" /> -> MyComponent(foo="bar")/
  // e.g., <MyComponent foo="bar" baz="qux" /> -> MyComponent(foo="bar", baz="qux")/
  match = jsxSnippet.match(/^<([A-Za-z0-9_.]+)\s+((?:[A-Za-z0-9_]+="[^"]*"\s*)+)\/>$/);
  if (match) {
    const componentName = match[1];
    const propsString = match[2].trim();
    // Convert props string "foo="bar" baz="qux"" to "foo="bar", baz="qux""
    const pugProps = propsString.replace(/\s+(?=[A-Za-z0-9_]+=)/g, ', ');
    if (pugProps) {
      return `${componentName}(${pugProps})/`;
    }
  }

  // Pattern 3: Simple empty HTML tag <div></div> (case-insensitive for common HTML tags)
  // e.g., <div></div> -> div
  // e.g., <span></span> -> span
  match = jsxSnippet.match(/^<([a-z][a-z0-9]*)\s*><\/\1\s*>$/i);
  if (match) {
    return match[1].toLowerCase();
  }

  // Pattern 4: Self-closing simple HTML tag <div /> (case-insensitive)
  // e.g., <div /> -> div/ (Pug doesn't strictly need / for HTML5 void tags, but commonly used for components)
  // This is less common for TS completions for HTML tags but good to have.
  match = jsxSnippet.match(/^<([a-z][a-z0-9]*)\s*\/>$/i);
  if (match) {
      // For known HTML void elements, Pug doesn't use '/'
      const voidElements = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'];
      const tagName = match[1].toLowerCase();
      if (voidElements.includes(tagName)) {
          return tagName;
      }
      return `${tagName}/`;
  }


  // Add more patterns here as needed.
  // For example, handling JSX expressions as attribute values: <Comp name={myVar} /> -> Comp(name=myVar)/

  // If no specific transformation, return null to indicate original text should be used or TextEdit omitted.
  return null;
}
