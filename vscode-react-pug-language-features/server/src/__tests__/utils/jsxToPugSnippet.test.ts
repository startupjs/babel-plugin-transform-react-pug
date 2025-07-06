import { transformJsxSnippetToPug } from '../../utils/jsxToPugSnippet';

describe('transformJsxSnippetToPug (AST-based)', () => {
  // Valid transformations
  it('should transform self-closing components', () => {
    expect(transformJsxSnippetToPug('<MyComponent />')).toBe('MyComponent/');
    expect(transformJsxSnippetToPug('<MyComponent/>')).toBe('MyComponent/');
    expect(transformJsxSnippetToPug('<mycomponent />')).toBe('mycomponent/');
    expect(transformJsxSnippetToPug('<Namespace.Component />')).toBe('Namespace.Component/');
    expect(transformJsxSnippetToPug('<_Comp123 />')).toBe('_Comp123/');
  });

  it('should transform self-closing components with simple string props', () => {
    expect(transformJsxSnippetToPug('<MyComponent foo="bar" />')).toBe("MyComponent(foo='bar')/");
    expect(transformJsxSnippetToPug("<MyComponent foo='bar' />")).toBe("MyComponent(foo='bar')/");
    expect(transformJsxSnippetToPug('<MyComponent foo="bar" baz="qux" />')).toBe("MyComponent(foo='bar', baz='qux')/");
    expect(transformJsxSnippetToPug("<MyComponent foo='bar' baz='qux' />")).toBe("MyComponent(foo='bar', baz='qux')/");
    expect(transformJsxSnippetToPug("<MyComponent data-test='value with spaces' />")).toBe("MyComponent(data-test='value with spaces')/");
    expect(transformJsxSnippetToPug("<MyComponent title='\"Quoted\"' />")).toBe("MyComponent(title='\"Quoted\"')/");
  });

  it('should transform self-closing components with boolean props', () => {
    expect(transformJsxSnippetToPug('<MyComponent checked />')).toBe('MyComponent(checked)/');
    expect(transformJsxSnippetToPug('<MyComponent disabled foo="bar" />')).toBe('MyComponent(disabled, foo=\'bar\')/');
  });

  it('should transform simple empty HTML tags', () => {
    expect(transformJsxSnippetToPug('<div></div>')).toBe('div');
    expect(transformJsxSnippetToPug('<span></span>')).toBe('span');
    expect(transformJsxSnippetToPug('<p></p>')).toBe('p');
    expect(transformJsxSnippetToPug('<DIV></DIV>')).toBe('div'); // Case-insensitive for HTML
  });

  it('should transform empty HTML tags with simple string props', () => {
    expect(transformJsxSnippetToPug('<div class="foo"></div>')).toBe("div(class='foo')");
    expect(transformJsxSnippetToPug("<div id='main' class='test'></div>")).toBe("div(id='main', class='test')");
  });

  it('should transform self-closing simple HTML tags', () => {
    expect(transformJsxSnippetToPug('<div />')).toBe('div/'); // Non-void becomes self-closing in Pug style
    expect(transformJsxSnippetToPug('<span />')).toBe('span/');
    expect(transformJsxSnippetToPug('<DIV />')).toBe('div/');
  });

  it('should transform self-closing void HTML tags correctly (no trailing slash)', () => {
    expect(transformJsxSnippetToPug('<img />')).toBe('img');
    expect(transformJsxSnippetToPug('<input type="text" />')).toBe("input(type='text')");
    expect(transformJsxSnippetToPug('<br />')).toBe('br');
    expect(transformJsxSnippetToPug('<hr />')).toBe('hr');
  });

  // Cases that should currently return null (due to limitations)
  it('should return null for JSX expression props', () => {
    expect(transformJsxSnippetToPug('<MyComponent name={userName} />')).toBeNull();
    expect(transformJsxSnippetToPug('<MyComponent value={123} />')).toBeNull();
  });

  it('should return null for spread attributes', () => {
    expect(transformJsxSnippetToPug('<MyComponent {...props} />')).toBeNull();
  });

  it('should return null for tags with children (for now)', () => {
    expect(transformJsxSnippetToPug('<div>Hello</div>')).toBeNull();
    expect(transformJsxSnippetToPug('<MyComponent><Child /></MyComponent>')).toBeNull();
  });

  it('should return null for namespaced attributes (not standard JSX, but good to check)', () => {
    expect(transformJsxSnippetToPug('<MyComponent ns:foo="bar" />')).toBeNull(); // AST parser might handle this, but our code doesn't
  });

  // Invalid or non-transformable inputs
  it('should return null for non-JSX or invalid JSX snippets', () => {
    expect(transformJsxSnippetToPug('Just some text')).toBeNull();
    expect(transformJsxSnippetToPug('myVar')).toBeNull();
    expect(transformJsxSnippetToPug('')).toBeNull();
    expect(transformJsxSnippetToPug('< />')).toBeNull(); // Invalid JSX
    expect(transformJsxSnippetToPug('<foo bar />')).toBeNull(); // Attribute without value (unless boolean)
    expect(transformJsxSnippetToPug('<div>')).toBeNull(); // Incomplete
  });

  it('should handle namespaced components correctly', () => {
    expect(transformJsxSnippetToPug('<Namespace.Component />')).toBe('Namespace.Component/');
    expect(transformJsxSnippetToPug('<My.Namespace.Deep.Component prop="val" />')).toBe("My.Namespace.Deep.Component(prop='val')/");
  });
});
