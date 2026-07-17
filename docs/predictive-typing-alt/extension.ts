import * as vscode from 'vscode';
import { PredictiveTypingProvider } from './providers/predictiveTypingProvider';
import { MemoryStatsCommand } from './commands/memoryStats';
import { IndexCodebaseCommand } from './commands/indexCodebase';
import { BuildDBCommand } from './commands/buildDB';
import { RefreshCacheCommand } from './commands/refreshCache';
import { OpenIncidentCommand } from './commands/openIncident';

let provider: PredictiveTypingProvider;

export async function activate(context: vscode.ExtensionContext) {
  const projectRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

  console.log('[PlaneKey] Activating predictive typing...');

  // Initialize provider
  provider = new PredictiveTypingProvider(projectRoot);

  // Register inline completion provider
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      [
        { scheme: 'file', language: 'javascript' },
        { scheme: 'file', language: 'typescript' },
        { scheme: 'file', language: 'typescriptreact' },
        { scheme: 'file', language: 'html' },
        { scheme: 'file', language: 'json' }
      ],
      provider
    )
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('planekey.indexCodebase', () =>
      new IndexCodebaseCommand(projectRoot).execute()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('planekey.buildDB', () =>
      new BuildDBCommand(projectRoot).execute()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('planekey.refreshCache', () =>
      new RefreshCacheCommand().execute()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('planekey.openIncident', () =>
      new OpenIncidentCommand(projectRoot).execute()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('planekey.showMemoryStats', () =>
      new MemoryStatsCommand(projectRoot).execute()
    )
  );

  // Listen for incident changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.fileName.includes('.planekey/operator/incidents')) {
        provider.onIncidentChanged(e.document);
      }
    })
  );

  // Listen for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('planekey')) {
        provider.invalidateCache();
      }
    })
  );

  console.log('[PlaneKey] ✓ Predictive typing ready');
}

export function deactivate() {
  provider?.dispose();
}
