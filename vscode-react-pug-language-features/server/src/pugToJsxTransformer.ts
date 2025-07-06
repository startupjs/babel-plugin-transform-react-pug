import * as babel from '@babel/core';
import transformReactPug from 'babel-plugin-transform-react-pug';
import generate from '@babel/generator';
import { RawSourceMap } from 'source-map'; // Added for type

export interface PugToJsxResult {
  jsx?: string;
  error?: string;
  babelAst?: babel.types.Node; // The top-level Babel AST of the fake JS code
  jsxAstNode?: babel.types.Node; // The specific JSX node extracted
  sourceMap?: RawSourceMap;
}

export function compilePugToJsxString(
    pugString: string,
    pluginOptions: any = {},
    // Filename for Babel source map context; important for `sources` field in map
    // Should ideally represent the original file containing the Pug + a unique key for the literal
    filename: string = 'source.pug.virtual.js'
): PugToJsxResult {

  const fakeJsCode = `const __PugToJsxOutput__ = pug\`${pugString.replace(/([`\\])/g, '\\$1')}\`;`;
  // Escape backticks and backslashes in pugString for template literal
  // No dummy import needed if plugin doesn't rely on `import pug from 'pug'` for identification

  try {
    const transformResult = babel.transformSync(fakeJsCode, {
      filename: filename,
      plugins: [[transformReactPug, pluginOptions]],
      // No presets needed if we only want to parse up to the point the plugin runs
      // and then extract its output. We need AST to find the plugin's output.
      ast: true,
      sourceMaps: true, // Request a source map object
      configFile: false,
      babelrc: false,
      // sourceFileName: filename // Should be picked up from filename option for the map
    });

    if (!transformResult || !transformResult.ast) {
      return { error: 'Babel transformation failed to produce AST.' };
    }

    let jsxNode: babel.types.Node | null = null;
    // Traverse the AST of the *transformed* fakeJsCode
    babel.traverse(transformResult.ast, {
      VariableDeclarator(path) {
        if (path.node.id.type === 'Identifier' && path.node.id.name === '__PugToJsxOutput__') {
          if (path.node.init && (path.node.init.type === 'JSXElement' || path.node.init.type === 'JSXFragment')) {
            jsxNode = path.node.init;
            path.stop();
          }
        }
      }
    });

    if (!jsxNode) {
      // This can happen if the pugString is empty or only comments,
      // the plugin might return `null` or `undefined` which becomes `null` or `undefinedLiteral`
      // Try to find what it became:
       babel.traverse(transformResult.ast, {
        VariableDeclarator(path) {
          if (path.node.id.type === 'Identifier' && path.node.id.name === '__PugToJsxOutput__') {
            if (path.node.init) { // If it's anything, capture it for debugging
                if(path.node.init.type === 'NullLiteral') {
                     return { jsx: 'null', jsxAstNode: path.node.init, sourceMap: transformResult.map as RawSourceMap | undefined };
                }
                 // console.warn('Pug transform did not result in JSXElement/Fragment, got: ' + path.node.init.type);
            }
            path.stop();
          }
        }
      });
      if (!jsxNode) return { error: 'Could not find transformed JSXElement/JSXFragment in Babel AST.' };
    }

    // Generate JSX string from the extracted JSX AST node
    // The source map from `transformResult.map` should be the one mapping
    // from `filename` (containing `fakeJsCode` which contains `pugString`) to the final output of `fakeJsCode`.
    // If `babel-plugin-transform-react-pug` correctly sets `originalLocation` on the JSX nodes it creates,
    // referencing locations within `pugString` (via the template literal structure), then `transformResult.map`
    // should be what we need.
    const generateResult = generate(jsxNode, { sourceMaps: true, sourceFileName: filename /* or a name for the Pug source? */ });

    return {
      jsx: generateResult.code,
      babelAst: transformResult.ast, // AST of the fakeJsCode
      jsxAstNode: jsxNode, // The specific JSX part
      sourceMap: transformResult.map as RawSourceMap // This is the map from fakeJsCode to its transformed version
                                                     // We hope this contains chained map to original Pug parts.
    };

  } catch (e: any) {
    // console.error("Error during Pug-to-JSX transformation:", e);
    return { error: e.message };
  }
}
