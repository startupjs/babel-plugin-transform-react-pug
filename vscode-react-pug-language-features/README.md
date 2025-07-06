# React Pug Language Features for VS Code

Provides language support for [Pug](https://pugjs.org/) tagged template literals within React components in JavaScript and TypeScript files. This extension aims to offer an editing experience consistent with tools like [startupjs/babel-plugin-transform-react-pug](https://github.com/startupjs/babel-plugin-transform-react-pug).

## Features

*   **Pug Literal Detection:** Automatically identifies `pug\`...\`` template literals in your JavaScript (`.js`, `.jsx`) and TypeScript (`.ts`, `.tsx`) files.
*   **Diagnostics/Error Checking:**
    *   Displays syntax errors from the Pug parser (`@startupjs/pug-lexer`, `pug-parser`) directly in your editor with improved positional accuracy.
*   **Autocompletion (Context-Aware - Basic):**
    *   Suggests common HTML attributes when typing within a tag's parentheses `()`. Includes some input-specific attributes.
    *   Suggests common Pug tags and directive snippets when not in an attribute context.
    *   Insertion positions for completions are now more accurate due to refined position mapping.
*   **Hover Information (Enhanced - Basic):**
    *   Shows basic information when hovering over Pug tags and directives.
    *   Prioritizes displaying the original JavaScript expression when hovering over its corresponding placeholder.
    *   The highlighted range for hover information is now more accurate.
*   **Syntax Highlighting:** Relies on VS Code's built-in JavaScript/TypeScript syntax highlighting for the template literal content.

### Planned Features:
*   Advanced Context-aware autocompletions (e.g., attribute values based on type, Pug variables, mixins, filtering existing attributes).
*   AST-based detailed hover information (e.g., attribute details from known schemas, Pug variable types).
*   Go-to-definition (e.g., for mixins, if supported by the Pug variant).
*   Formatting of Pug code within the template literals.
*   Enhanced error recovery and diagnostics for complex cases.

## Installation

1.  Open Visual Studio Code.
2.  Go to the Extensions view (Ctrl+Shift+X or Cmd+Shift+X).
3.  Search for "React Pug Language Features".
4.  Click "Install".

Alternatively, if you are developing this extension locally or have a `.vsix` file:
*   Follow VS Code's instructions for [installing an extension from a VSIX file](https://code.visualstudio.com/docs/editor/extension-gallery#_install-from-a-vsix).

## Usage

Once installed, the extension will automatically activate when you open JavaScript (`.js`, `.jsx`) or TypeScript (`.ts`, `.tsx`) files.

Write your React components using Pug tagged template literals:

```javascript
// example.js
import React from 'react';

const MyComponent = ({ name, items, handleClick, dynamicClass, label }) => {
  return pug`
    div.container(className=${dynamicClass})
      h1 Hello, ${name}!

      if items && items.length
        ul
          each item, index in items
            li(key=index)= item
      else
        p No items to display.

      button(onClick=handleClick, type='button') ${label || 'Click Me'}
  `;
};

export default MyComponent;
```

```typescript
// example.tsx
import React, { FC } from 'react';

interface MyComponentProps {
  name: string;
  items?: string[];
  handleClick: () => void;
  dynamicClass?: string;
  label?: string;
}

const MyComponent: FC<MyComponentProps> = ({ name, items, handleClick, dynamicClass, label }) => {
  return pug`
    // Pug comments work here
    div.container(className=${dynamicClass})
      h1 Hello, ${name}!

      if items && items.length
        ul
          each item, index in items
            li(key=index)= item
      else
        p No items to display.

      button(onClick=${handleClick}, type='button') ${label || 'Click Me'}
  `;
};

export default MyComponent;
```

The language server will provide feedback (diagnostics, completions) as you type within the `pug\`...\`` blocks.

## Configuration

The following settings can be configured in your VS Code `settings.json` or User/Workspace settings:

*   `reactPug.trace.server`: (Default: `"off"`)
    *   Traces the communication between VS Code and the React Pug language server. Set to `"messages"` or `"verbose"` for debugging. The output will be visible in the "React Pug Language Server" output channel.
*   `reactPug.classAttribute`: (Default: `"className"`)
    *   Specifies the attribute name to be used for CSS class names when interpreting Pug class syntax (e.g., `.my-class`). This should align with the `classAttribute` option in `babel-plugin-transform-react-pug` if you use it. Common values are `"className"` (for React default) or `"styleName"` (for CSS Modules).

Example `settings.json`:
```json
{
  "reactPug.trace.server": "verbose",
  "reactPug.classAttribute": "styleName"
}
```

## How it Works

This extension includes a Language Server that:
1.  Activates for JavaScript and TypeScript files.
2.  Parses the content of these files to identify `pug\`...\`` tagged template literals.
3.  For the Pug code within these literals, it uses a Pug parser (specifically `@startupjs/pug-lexer` and `pug-parser`, the same used by `babel-plugin-transform-react-pug`) to understand the structure.
4.  It then provides language features like diagnostics and autocompletion by analyzing this Pug Abstract Syntax Tree (AST).
5.  It handles JavaScript interpolations (`${...}`) within the Pug code, aiming to provide a seamless experience.

## Development

If you'd like to contribute or build the extension locally:

1.  **Clone the repository** (assuming this project is in a Git repository).
    ```bash
    # git clone <repository-url>
    # cd vscode-react-pug-language-features
    ```
2.  **Install dependencies:**
    The root `package.json` includes a `postinstall` script that will install dependencies for the root, `client/`, and `server/` directories.
    ```bash
    npm install
    # or
    # yarn install
    # or
    # pnpm install
    ```
3.  **Compile the extension:**
    ```bash
    npm run compile
    # or
    # yarn compile
    ```
    This will compile the TypeScript code in `client/src` and `server/src` to their respective `out` directories.
4.  **Open in VS Code:**
    Open the `vscode-react-pug-language-features` directory in VS Code.
5.  **Launch the Extension (F5):**
    Press F5, or go to the "Run and Debug" view and select "Launch Client" and click the play button. This will open a new VS Code window (the "Extension Development Host") with the extension running.
6.  **Debugging the Server:**
    To debug the language server itself, after launching the client, select the "Attach to Server" launch configuration and press F5. You can then set breakpoints in the `server/src` code.

## Known Issues & Limitations (Current State)

*   **Position Mapping Edge Cases:** While significantly improved and unit-tested, very complex or unusual combinations of indentation and deeply nested/multi-line JavaScript interpolations might still reveal edge cases in position mapping. Continued testing and refinement will address these.
*   **Context-Awareness for Completions & Hover (Advanced):**
    *   Current attribute completion is primarily based on simple context detection (inside `()`) rather than deep AST analysis of the current tag or existing attributes.
    *   Hover information for specific Pug AST nodes (like detailed attribute type/value information) is basic.
*   **JavaScript Interpolation Features:** No specific language support (TS type checking, autocompletion) *within* the `${...}` expressions themselves.
*   **Interpolation Regex Robustness:** The regex for identifying JS interpolations, while functional for common cases, might not handle all complex JavaScript syntax within interpolations (e.g., strings containing escaped braces, deeply nested template literals within interpolations).
*   **Syntax Highlighting:** Relies on standard JS/TS string highlighting. No specific Pug syntax highlighting within the literals.
*   **Formatting:** Not yet implemented.
*   **Pug Parser Error Recovery:** The underlying Pug parser's error recovery capabilities might be limited, potentially affecting analysis after the first encountered syntax error in a block.

## Contributing

Contributions are welcome! (This section would typically include guidelines, how to open issues, PR process, etc.)

## License

MIT (Assuming MIT, update if different)
```
