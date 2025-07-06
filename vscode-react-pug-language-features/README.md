# React Pug Language Features for VS Code

Provides language support for [Pug](https://pugjs.org/) tagged template literals within React components in JavaScript and TypeScript files. This extension aims to offer an editing experience consistent with tools like [startupjs/babel-plugin-transform-react-pug](https://github.com/startupjs/babel-plugin-transform-react-pug).

## Features

*   **Pug Literal Detection:** Automatically identifies `pug\`...\`` template literals in your JavaScript (`.js`, `.jsx`) and TypeScript (`.ts`, `.tsx`) files.
*   **Diagnostics/Error Checking:**
    *   Displays syntax errors from the Pug parser (`@startupjs/pug-lexer`, `pug-parser`) directly in your editor.
    *   Position mapping for error highlighting has been implemented and is undergoing refinement for complex cases.
*   **Autocompletion (Context-Aware - Basic):**
    *   Suggests common HTML attributes when typing within a tag's parentheses `()`. Includes some input-specific attributes.
    *   Suggests common Pug tags and directive snippets when not in an attribute context.
    *   Precise insertion positions are actively being refined through position mapping improvements.
*   **Hover Information (Enhanced - Basic):**
    *   Shows basic information when hovering over Pug tags and directives.
    *   Prioritizes displaying the original JavaScript expression when hovering over its corresponding placeholder.
    *   The highlighted range for hover information is actively being refined through position mapping improvements.
*   **Syntax Highlighting:** Relies on VS Code's built-in JavaScript/TypeScript syntax highlighting for the template literal content.

### Planned Features:
*   **Continued Refinement of Position Mapping:** Ensuring pixel-perfect accuracy for all features across complex Pug structures, indentations, and interpolations.
*   Advanced Context-aware autocompletions (e.g., attribute values based on type, Pug variables, mixins).
*   AST-based detailed hover information (e.g., attribute details from known schemas).
*   Go-to-definition (e.g., for mixins, if supported by the Pug variant).
*   Formatting of Pug code within the template literals.

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

*   **Position Mapping Precision:** While the core position mapping utilities (`mapDocumentPositionToPurePug` and `mapPurePugRangeToDocument`) have been implemented, achieving perfect accuracy across all complex indentation scenarios and nested/multi-line interpolations is an ongoing process of refinement and rigorous unit testing. Users may still encounter slight inaccuracies in diagnostic highlighting, completion placement, or hover ranges in very complex cases until these utilities are fully battle-tested.
*   **Context-Awareness for Completions & Hover:**
    *   Attribute completion is based on a simple regex for context; it doesn't yet filter already present attributes or use the AST exhaustively for context.
    *   Hover information for specific AST nodes (like detailed attribute info) is not yet implemented.
*   **JavaScript Interpolation Features:** No specific language support (TS type checking, autocompletion) *within* the `${...}` expressions.
*   **Interpolation Regex:** The regex for identifying JS interpolations is basic and might not handle all edge cases (e.g., nested braces in JS strings within interpolations).
*   **Syntax Highlighting:** Relies on standard JS/TS string highlighting.
*   **Formatting:** Not yet implemented.
*   **Error Recovery:** The Pug parser's error recovery capabilities might be limited.

## Contributing

Contributions are welcome! (This section would typically include guidelines, how to open issues, PR process, etc.)

## License

MIT (Assuming MIT, update if different)
```
