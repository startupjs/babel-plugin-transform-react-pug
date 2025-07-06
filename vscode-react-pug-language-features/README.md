# React Pug Language Features for VS Code

Provides language support for [Pug](https://pugjs.org/) tagged template literals within React components in JavaScript and TypeScript files. This extension aims to offer an editing experience consistent with tools like [startupjs/babel-plugin-transform-react-pug](https://github.com/startupjs/babel-plugin-transform-react-pug).

## Features

*   **Pug Literal Detection:** Automatically identifies `pug\`...\`` template literals in your JavaScript (`.js`, `.jsx`) and TypeScript (`.ts`, `.tsx`) files.
*   **Diagnostics/Error Checking:**
    *   Displays syntax errors from the Pug parser (`@startupjs/pug-lexer`, `pug-parser`) directly in your editor.
    *   *(Limitation: Position mapping for error highlighting is currently approximate and will be refined).*
*   **Autocompletion (Basic):**
    *   Provides completions for common Pug tags (e.g., `div`, `p`, `span`).
    *   Offers snippets for Pug directives (e.g., `if`, `else`, `each`).
    *   *(Limitation: Context-awareness and attribute completions are planned. Position mapping for insertions is currently approximate).*
*   **Hover Information (Basic):**
    *   Shows basic information when hovering over Pug tags and directives.
    *   Displays the original JavaScript expression when hovering over its placeholder within the Pug structure.
    *   *(Limitation: The highlighted range for hover information is currently approximate).*
*   **Syntax Highlighting:** Relies on VS Code's built-in JavaScript/TypeScript syntax highlighting for the template literal content. True semantic highlighting for the embedded Pug syntax is a more advanced feature for future consideration.

### Planned Features:
*   Accurate position mapping for all features.
*   Context-aware autocompletions (e.g., attributes for specific tags).
*   More detailed hover information (e.g., attribute details, Pug variable information).
*   Go-to-definition (e.g., for mixins, if supported).
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

*   **Position Mapping Accuracy:** This is the most significant current limitation. The conversion of positions and ranges between the main JavaScript/TypeScript document and the internal "pure Pug" representation (used for parsing) is currently **approximate**. This means:
    *   Diagnostic squiggles might not perfectly align with the erroneous Pug code.
    *   Completion items might be offered based on a slightly incorrect cursor context, and text edits from completions (if they were used) could be misaligned.
    *   The highlighted range for hover information might be imprecise.
    *   **This is the highest priority for refinement in upcoming development.**
*   **Context-Awareness for Completions & Hover:** Current completions and hover information are basic (e.g., static list of tags, simple messages). They do not yet deeply analyze the Pug AST for context (e.g., offering specific attributes for a tag, or type information).
*   **JavaScript Interpolation Features:** While placeholders for JS interpolations (`${...}`) are recognized and can be hovered to see the original expression, there is no specific language support (like TS type checking or autocompletion) *within* these JS expressions themselves. This is a complex feature planned for later.
*   **Complex Pug Structures & Interpolations:** The current regex-based approach for identifying JS interpolations in `reactPugLanguageService.ts` might have issues with very complex or nested JS expressions, or with unusual string escaping within the Pug.
*   **Syntax Highlighting:** As mentioned in "Features", syntax highlighting for the Pug code within template literals relies on VS Code's default JavaScript/TypeScript string highlighting. True semantic highlighting for the embedded Pug requires more advanced integration.
*   **Formatting:** Not yet implemented.
*   **Limited Error Recovery in Parser:** The underlying Pug parser might not have extensive error recovery, so one syntax error could potentially impact the parsing of subsequent Pug code in the same literal.

## Contributing

Contributions are welcome! (This section would typically include guidelines, how to open issues, PR process, etc.)

## License

MIT (Assuming MIT, update if different)
```
