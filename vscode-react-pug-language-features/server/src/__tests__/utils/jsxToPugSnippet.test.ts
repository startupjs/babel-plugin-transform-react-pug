import { transformJsxSnippetToPug } from '../../utils/jsxToPugSnippet';

describe('transformJsxSnippetToPug', () => {
  // Pattern 1: Self-closing component <Comp />
  it('should transform self-closing components', () => {
    expect(transformJsxSnippetToPug('<MyComponent />')).toBe('MyComponent/');
    expect(transformJsxSnippetToPug('<MyComponent/>')).toBe('MyComponent/'); // No space before /
    expect(transformJsxSnippetToPug('<mycomponent />')).toBe('mycomponent/');
    expect(transformJsxSnippetToPug('<Namespace.Component />')).toBe('Namespace.Component/');
    expect(transformJsxSnippetToPug('<_Comp123 />')).toBe('_Comp123/');
  });

  // Pattern 2: Self-closing component with simple string props
  it('should transform self-closing components with simple string props', () => {
    expect(transformJsxSnippetToPug('<MyComponent foo="bar" />')).toBe('MyComponent(foo="bar")/');
    expect(transformJsxSnippetToPug('<MyComponent foo="bar" baz="qux" />')).toBe('MyComponent(foo="bar", baz="qux")/');
    expect(transformJsxSnippetToPug('<MyComponent  foo="bar"  baz="qux"  />')).toBe('MyComponent(foo="bar", baz="qux")/'); // Extra spaces
    expect(transformJsxSnippetToPug('<my.comp foo="a" b="c" />')).toBe('my.comp(foo="a", b="c")/');
  });

  it('should NOT transform self-closing components with JSX expression props yet', () => {
    expect(transformJsxSnippetToPug('<MyComponent name={userName} />')).toBeNull();
    expect(transformJsxSnippetToPug('<MyComponent value={123} />')).toBeNull();
    expect(transformJsxSnippetToPug('<MyComponent isVisible />')).toBeNull(); // Boolean prop
  });

  // Pattern 3: Simple empty HTML tag <div></div>
  it('should transform simple empty HTML tags', () => {
    expect(transformJsxSnippetToPug('<div></div>')).toBe('div');
    expect(transformJsxSnippetToPug('<span></span>')).toBe('span');
    expect(transformJsxSnippetToPug('<p></p>')).toBe('p');
    expect(transformJsxSnippetToPug('<DIV></DIV>')).toBe('div'); // Case-insensitive
    expect(transformJsxSnippetToPug('<Div> </Div>')).toBe('div'); // Space inside
  });

  it('should NOT transform HTML tags with content or props yet for pattern 3', () => {
    expect(transformJsxSnippetToPug('<div>Hello</div>')).toBeNull();
    expect(transformJsxSnippetToPug('<div class="foo"></div>')).toBeNull();
  });

  // Pattern 4: Self-closing simple HTML tag <div />
  it('should transform self-closing simple HTML tags', () => {
    expect(transformJsxSnippetToPug('<div />')).toBe('div/');
    expect(transformJsxSnippetToPug('<span />')).toBe('span/');
    expect(transformJsxSnippetToPug('<DIV />')).toBe('div/'); // Case-insensitive
  });

  it('should transform self-closing void HTML tags correctly', () => {
    expect(transformJsxSnippetToPug('<img />')).toBe('img');
    expect(transformJsxSnippetToPug('<input />')).toBe('input');
    expect(transformJsxSnippetToPug('<br />')).toBe('br');
    expect(transformJsxSnippetToPug('<hr />')).toBe('hr');
    expect(transformJsxSnippetToPug('<meta />')).toBe('meta');
    expect(transformJsxSnippetToPug('<link />')).toBe('link');
    expect(transformJsxSnippetToPug('<embed />')).toBe('embed');
    expect(transformJsxSnippetToPug('<source />')).toBe('source');
    expect(transformJsxSnippetToPug('<track />')).toBe('track');
    expect(transformJsxSnippetToPug('<wbr />')).toBe('wbr');
    expect(transformJsxSnippetToPug('<col />')).toBe('col');
    expect(transformJsxSnippetToPug('<area />')).toBe('area');
    expect(transformJsxSnippetToPug('<base />')).toBe('base');
    expect(transformJsxSnippetToPug('<param />')).toBe('param');
  });


  // Cases that should not be transformed / return null
  it('should return null for non-matching or complex JSX', () => {
    expect(transformJsxSnippetToPug('Just some text')).toBeNull();
    expect(transformJsxSnippetToPug('<MyComponent>With children</MyComponent>')).toBeNull();
    expect(transformJsxSnippetToPug('myVar')).toBeNull(); // Simple identifier
    expect(transformJsxSnippetToPug('`template literal`')).toBeNull();
    expect(transformJsxSnippetToPug('')).toBeNull(); // Empty string
    expect(transformJsxSnippetToPug('   ')).toBeNull(); // Whitespace only (after trim)
    expect(transformJsxSnippetToPug('< />')).toBeNull(); // Invalid JSX
    expect(transformJsxSnippetToPug('<Comp foo={bar} />')).toBeNull(); // Prop with expression
  });
});
