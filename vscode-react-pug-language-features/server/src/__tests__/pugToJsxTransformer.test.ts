import { compilePugToJsxString } from '../pugToJsxTransformer';

describe('pugToJsxTransformer', () => {
  it('should compile a simple Pug div to JSX string', () => {
    const pugString = 'div Hello';
    const { jsx, error } = compilePugToJsxString(pugString);

    expect(error).toBeUndefined();
    // Expected JSX might be <div className="index__div_randomHash">Hello</div> or similar if it adds hashes
    // Or just <div>Hello</div> if options prevent className hashing.
    // The plugin by default might add classNames for styling.
    // For now, let's check for basic structure.
    // The actual output of babel-plugin-transform-react-pug is <div className="div">Hello</div> by default
    // if pugString is 'div Hello'. If it's '.myClass Hello', it's <div className="myClass">Hello</div>
    // Let's test a more specific case.
    expect(jsx).toContain('div');
    expect(jsx).toContain('Hello');
    // A more precise test would be: expect(jsx).toBe('<div>Hello</div>'); if no className modifications.
    // From actual plugin behavior: pug`div Hello` -> `<div>Hello</div>` (if no options like pugClassLiterals)
    // pug`.foo` -> `<div className="foo"></div>`
  });

  it('should compile Pug with a class to JSX with className', () => {
    const pugString = '.myClass Test';
    const { jsx, error } = compilePugToJsxString(pugString);
    expect(error).toBeUndefined();
    // Default behavior of the plugin might be to transform .myClass to <div className="myClass">
    // Let's assume default options for now.
    // The plugin actually produces <div className="myClass">Test</div>
    expect(jsx).toBe('<div className="myClass">Test</div>');
  });

  it('should handle basic interpolation (becomes JS expression in JSX)', () => {
    const pugString = 'p Hello ${name}';
    // compilePugToJsxString currently wraps this in `pug\`...\`` which the plugin handles
    const { jsx, error } = compilePugToJsxString(pugString);
    expect(error).toBeUndefined();
    // Expected: <p>Hello {name}</p>
    expect(jsx).toBe('<p>Hello {name}</p>');
  });

  it('should return an error for invalid Pug syntax that plugin cannot handle', () => {
    const pugString = 'div(invalid-'; // Invalid Pug
    const { jsx, error } = compilePugToJsxString(pugString);
    // The babel plugin itself might throw, or return an error structure.
    // Our wrapper returns an error string.
    expect(error).toBeDefined();
    expect(jsx).toBeUndefined();
  });

  // TODO: Add tests for source map generation/retrieval once that part is investigated.
});
