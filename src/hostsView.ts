import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { HostEntry, HostStore } from './storage';

/**
 * The single VSCode Connect panel view: a webview with a live search bar,
 * Add / Edit / Delete buttons, and the host list itself.
 * Single click selects a host, double click connects.
 */
export class HostsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'vscodeConnect.hosts';

  private view?: vscode.WebviewView;
  private filter = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: HostStore
  ) {
    store.onDidChange(() => this.refresh());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.renderHtml();

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          this.refresh();
          break;
        case 'search':
          this.setFilter(String(msg.value ?? ''), false);
          break;
        case 'add':
          vscode.commands.executeCommand('vscodeConnect.addHost');
          break;
        case 'edit':
        case 'delete':
        case 'connect':
          if (!msg.id) {
            vscode.window.showWarningMessage('Select an SSH host in the list first.');
            break;
          }
          vscode.commands.executeCommand(
            msg.type === 'edit'
              ? 'vscodeConnect.editHost'
              : msg.type === 'delete'
                ? 'vscodeConnect.deleteHost'
                : 'vscodeConnect.connect',
            String(msg.id)
          );
          break;
        case 'toggleGroup':
          if (typeof msg.group === 'string') {
            const current = this.store.getCollapsedGroups();
            const g = msg.group;
            const next = current.includes(g) ? current.filter((x) => x !== g) : [...current, g];
            await this.store.setCollapsedGroups(next);
            this.refresh();
          }
          break;
        case 'export':
          await this.exportConfig();
          break;
        case 'import':
          await this.importConfig();
          break;
      }
    });
  }

  getFilter(): string {
    return this.filter;
  }

  /** Updates the filter; optionally syncs the search input in the webview. */
  setFilter(value: string, updateInput = true): void {
    this.filter = value;
    vscode.commands.executeCommand(
      'setContext',
      'vscodeConnect.filtered',
      value.trim().length > 0
    );
    if (updateInput) {
      this.view?.webview.postMessage({ type: 'setSearch', value });
    }
    this.refresh();
  }

  private visibleHosts(): HostEntry[] {
    const needle = this.filter.trim().toLowerCase();
    let hosts = this.store.getAll();
    if (needle) {
      hosts = hosts.filter((h) =>
        [h.name, h.host, h.username, `${h.username}@${h.host}`]
          .join(' ')
          .toLowerCase()
          .includes(needle)
      );
    }
    return hosts;
  }

  private refresh(): void {
    const hosts = this.visibleHosts();
    const filterActive = !!this.filter.trim();
    const collapsed = filterActive ? [] : this.store.getCollapsedGroups();
    this.view?.webview.postMessage({
      type: 'hosts',
      hosts: hosts.map((h) => ({
        id: h.id,
        name: h.name,
        detail: `${h.username}@${h.host}:${h.port}`,
        group: h.group || '',
      })),
      collapsedGroups: collapsed,
      filterActive,
    });
  }

  private renderHtml(): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'hostsView.html');
    const template = fs.readFileSync(htmlPath, 'utf8');
    const esc = this.filter
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    return template.replace(/\{\{filter\}\}/g, esc);
  }

  /** Export all hosts (including secrets) to a user-chosen JSON file. */
  async exportConfig(): Promise<void> {
    try {
      const json = this.store.exportToJson();
      const count = this.store.getAll().length;
      const uri = await vscode.window.showSaveDialog({
        title: 'Export SSH Hosts',
        filters: { 'JSON': ['json'] },
        defaultUri: vscode.Uri.file('vscode-connect-hosts.json'),
      });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf8'));
        vscode.window.showInformationMessage(`Exported ${count} SSH host(s).`);
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`Export failed: ${e?.message || e}`);
    }
  }

  /** Import hosts from a JSON file chosen by the user. */
  async importConfig(): Promise<void> {
    try {
      const uris = await vscode.window.showOpenDialog({
        title: 'Import SSH Hosts',
        canSelectMany: false,
        filters: { 'JSON': ['json'] },
        openLabel: 'Import',
      });
      if (!uris || uris.length === 0) {
        return;
      }
      const data = await vscode.workspace.fs.readFile(uris[0]);
      const json = Buffer.from(data).toString('utf8');
      const res = await this.store.importFromJson(json);
      let msg = `Import complete: ${res.added} added, ${res.updated} updated.`;
      if (res.errors.length > 0) {
        msg += ` ${res.errors.length} skipped.`;
      }
      vscode.window.showInformationMessage(msg);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Import failed: ${e?.message || e}`);
    }
  }
}
