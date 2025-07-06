import * as path from 'path';
import { workspace, ExtensionContext, commands, window } from 'vscode';

import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: ExtensionContext) {
  // The server is implemented in node
  const serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));

  // The debug options for the server
  // --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
  const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions
    }
  };

  // Options to control the language client
  const clientOptions: LanguageClientOptions = {
    // Register the server for JavaScript and TypeScript documents
    documentSelector: [
      { scheme: 'file', language: 'javascript' },
      { scheme: 'file', language: 'typescript' },
      { scheme: 'file', language: 'javascriptreact' },
      { scheme: 'file', language: 'typescriptreact' }
    ],
    synchronize: {
      // Notify the server about file changes to '.clientrc files contained in the workspace
      // We can adapt this later if we need to watch specific config files (e.g., babel.config.js)
      fileEvents: workspace.createFileSystemWatcher('**/.clientrc') // Example, can be removed if not needed
    },
    // Middleware can be added here if needed later
  };

  // Create the language client and start the client.
  client = new LanguageClient(
    'reactPugLanguageServer',
    'React Pug Language Server',
    serverOptions,
    clientOptions
  );

  // Start the client. This will also launch the server
  client.start().catch(error => {
    window.showErrorMessage(`Failed to start React Pug Language Server: ${error}`);
    console.error('Failed to start React Pug Language Server:', error);
  });

  context.subscriptions.push(
    commands.registerCommand('reactPug.showOutputChannel', () => {
      client.outputChannel.show();
    })
  );
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
