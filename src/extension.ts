import * as vscode from 'vscode';
import { openHostForm } from './hostForm';
import { HostsViewProvider } from './hostsView';
import { openSshTerminal } from './sshTerminal';
import { openSftpExplorer } from './sftpExplorer';
import { HostStore } from './storage';

export function activate(context: vscode.ExtensionContext): void {
  const store = new HostStore(context);
  const view = new HostsViewProvider(context.extensionUri, store);

  const resolveEntry = (arg: unknown) =>
    typeof arg === 'string' ? store.get(arg) : undefined;

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(HostsViewProvider.viewId, view),

    vscode.commands.registerCommand('vscodeConnect.addHost', () => {
      openHostForm(context.extensionUri, store);
    }),

    vscode.commands.registerCommand('vscodeConnect.editHost', (arg: unknown) => {
      const entry = resolveEntry(arg);
      if (entry) {
        openHostForm(context.extensionUri, store, entry);
      }
    }),

    vscode.commands.registerCommand('vscodeConnect.deleteHost', async (arg: unknown) => {
      const entry = resolveEntry(arg);
      if (!entry) {
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Delete SSH host "${entry.name}"?`,
        { modal: true },
        'Delete'
      );
      if (choice === 'Delete') {
        await store.delete(entry.id);
      }
    }),

    vscode.commands.registerCommand('vscodeConnect.connect', (arg: unknown) => {
      const entry = resolveEntry(arg);
      if (entry) {
        openSshTerminal(entry);
      }
    }),

    vscode.commands.registerCommand('vscodeConnect.search', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'Filter hosts by name, address, or username',
        placeHolder: 'Search SSH hosts...',
        value: view.getFilter(),
      });
      if (value !== undefined) {
        view.setFilter(value);
      }
    }),

    vscode.commands.registerCommand('vscodeConnect.clearSearch', () => {
      view.setFilter('');
    }),

    vscode.commands.registerCommand('vscodeConnect.exportConfig', () => {
      void view.exportConfig();
    }),

    vscode.commands.registerCommand('vscodeConnect.importConfig', () => {
      void view.importConfig();
    }),

    vscode.commands.registerCommand('vscodeConnect.importSshConfig', () => {
      void view.importFromSshConfig();
    }),

    vscode.commands.registerCommand('vscodeConnect.openSftpExplorer', (arg: unknown) => {
      const entry = resolveEntry(arg);
      if (entry) {
        openSftpExplorer(context.extensionUri, entry, context);
      }
    })
  );
}

export function deactivate(): void {}
