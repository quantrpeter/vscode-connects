import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { HostEntry, HostStore } from './storage';

/**
 * Opens a host configuration form in the editor area for creating or
 * editing a host entry.
 */
export function openHostForm(
  extensionUri: vscode.Uri,
  store: HostStore,
  existing?: HostEntry
): void {
  const panel = vscode.window.createWebviewPanel(
    'vscodeConnect.hostForm',
    existing ? `Edit: ${existing.name}` : 'New SSH Host',
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );

  panel.webview.html = renderHtml(extensionUri, panel.webview, existing);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'cancel') {
      panel.dispose();
      return;
    }
    if (msg.type === 'save') {
      const rawPk = typeof msg.privateKey === 'string' ? msg.privateKey : undefined;
      let privateKey: string | undefined;
      let passphrase: string | undefined;

      if (rawPk === '__EXISTING__') {
        // User did not change the key on edit; preserve existing values
        privateKey = existing?.privateKey;
        passphrase = msg.passphrase ? String(msg.passphrase) : existing?.passphrase;
      } else if (rawPk && rawPk.trim().length > 0) {
        // New key content provided (uploaded/replaced)
        privateKey = rawPk;
        passphrase = msg.passphrase ? String(msg.passphrase) : undefined;
      } else {
        // Cleared or never had a key
        privateKey = undefined;
        passphrase = undefined;
      }

      const entry: HostEntry = {
        id: existing?.id ?? crypto.randomUUID(),
        name: String(msg.name).trim(),
        host: String(msg.host).trim(),
        port: Number(msg.port) || 22,
        username: String(msg.username).trim(),
        password: msg.password ? String(msg.password) : undefined,
        privateKey,
        passphrase,
        keepAlive: !!msg.keepAlive,
        group: msg.group ? String(msg.group).trim() || undefined : undefined,
      };
      await store.upsert(entry);
      panel.dispose();
      vscode.window.showInformationMessage(`Saved SSH host "${entry.name}".`);
      if (msg.connectAfterSave) {
        vscode.commands.executeCommand('vscodeConnect.connect', entry.id);
      }
    }
  });
}

function esc(value: string | undefined): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtml(
  extensionUri: vscode.Uri,
  webview: vscode.Webview,
  existing?: HostEntry
): string {
  const htmlPath = path.join(extensionUri.fsPath, 'media', 'hostForm.html');
  const template = fs.readFileSync(htmlPath, 'utf8');

  const bannerUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'resources', 'banner.png')
  );

  const values: Record<string, string> = {
    passphrase: esc(existing?.passphrase),
    keepAliveChecked: existing?.keepAlive ? 'checked' : '',
    hasPrivateKey: existing?.privateKey ? 'true' : '',
    bannerUri: bannerUri.toString(),
    title: existing ? 'Edit SSH Host' : 'New SSH Host',
    name: esc(existing?.name),
    host: esc(existing?.host),
    port: String(existing?.port ?? 22),
    username: esc(existing?.username),
    password: esc(existing?.password),
    group: esc(existing?.group),
    focusId: existing ? 'name' : 'host',
  };

  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');
}
