import * as crypto from 'crypto';
import * as vscode from 'vscode';

export interface HostEntry {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  /** PEM-encoded private key content (for key-based auth). */
  privateKey?: string;
  /** Passphrase to decrypt the private key (if the key is encrypted). */
  passphrase?: string;
  /** If true, the SSH client will send keep-alive packets to prevent idle timeouts. */
  keepAlive?: boolean;
  /** Optional group name used to organize hosts in the list (supports collapse/expand). */
  group?: string;
}

const HOSTS_KEY = 'vscodeConnect.hosts';
const SEEN_SYNC_HINT_KEY = 'vscodeConnect.hasSeenSyncHint';
const COLLAPSED_GROUPS_KEY = 'vscodeConnect.collapsedGroups';

/**
 * Hosts are stored in globalState and registered with setKeysForSync, so they
 * roam to any machine where the user is signed in with Settings Sync enabled.
 */
export class HostStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    context.globalState.setKeysForSync([HOSTS_KEY]);
  }

  getAll(): HostEntry[] {
    return this.context.globalState.get<HostEntry[]>(HOSTS_KEY, []);
  }

  /** Returns true if the user has never been shown the Settings Sync hint on this machine. */
  hasSeenSyncHint(): boolean {
    return !!this.context.globalState.get<boolean>(SEEN_SYNC_HINT_KEY);
  }

  /** Mark that we've shown the one-time Settings Sync hint (stored locally, not synced). */
  async markSeenSyncHint(): Promise<void> {
    await this.context.globalState.update(SEEN_SYNC_HINT_KEY, true);
  }

  get(id: string): HostEntry | undefined {
    return this.getAll().find((h) => h.id === id);
  }

  async upsert(entry: HostEntry): Promise<void> {
    const hosts = this.getAll();
    const idx = hosts.findIndex((h) => h.id === entry.id);
    if (idx >= 0) {
      hosts[idx] = entry;
    } else {
      hosts.push(entry);
    }
    hosts.sort((a, b) => a.name.localeCompare(b.name));
    await this.context.globalState.update(HOSTS_KEY, hosts);
    this._onDidChange.fire();

    // One-time hint: remind users they need Settings Sync enabled for cross-machine roaming.
    if (!this.hasSeenSyncHint()) {
      await this.markSeenSyncHint();
      // Fire-and-forget; do not await the message so we don't block the caller.
      void vscode.window
        .showInformationMessage(
          'SSH hosts are saved to your VS Code profile. To see them on other computers, sign in with GitHub (or Microsoft) and turn on Settings Sync (select "Extensions" or "All").',
          'Open Settings Sync'
        )
        .then((choice) => {
          if (choice === 'Open Settings Sync') {
            void vscode.commands.executeCommand('workbench.userDataSync.actions.turnOn');
          }
        });
    }
  }

  async delete(id: string): Promise<void> {
    const hosts = this.getAll().filter((h) => h.id !== id);
    await this.context.globalState.update(HOSTS_KEY, hosts);
    this._onDidChange.fire();
  }

  /** Returns the list of group names that should be shown collapsed in the UI. */
  getCollapsedGroups(): string[] {
    return this.context.globalState.get<string[]>(COLLAPSED_GROUPS_KEY, []);
  }

  /** Persists which groups are collapsed (by exact group name, empty string means "Ungrouped"). */
  async setCollapsedGroups(groups: string[]): Promise<void> {
    const unique = Array.from(new Set((groups || []).map((g) => (g || '').trim())));
    await this.context.globalState.update(COLLAPSED_GROUPS_KEY, unique);
    // Do not fire onDidChange for pure UI state to avoid unnecessary host list refresh.
  }

  /** Returns a JSON string containing all hosts (includes secrets such as passwords and private keys). */
  exportToJson(): string {
    return JSON.stringify(this.getAll(), null, 2);
  }

  /**
   * Imports hosts from a JSON string (array of host objects).
   * - If an entry has an id that already exists, it updates that host.
   * - Otherwise a new id is generated (or the provided id is used if present).
   * - Missing required fields (name, host, username) cause the entry to be skipped.
   * Returns counts and any non-fatal errors encountered.
   */
  async importFromJson(json: string): Promise<{ added: number; updated: number; errors: string[] }> {
    let parsed: any;
    const errors: string[] = [];
    try {
      parsed = JSON.parse(json);
    } catch {
      return { added: 0, updated: 0, errors: ['Invalid JSON'] };
    }
    if (!Array.isArray(parsed)) {
      return { added: 0, updated: 0, errors: ['Expected a JSON array of host objects'] };
    }

    const current = this.getAll();
    const byId = new Map(current.map((h) => [h.id, h] as const));

    let added = 0;
    let updated = 0;

    for (const raw of parsed) {
      if (!raw || typeof raw !== 'object') {
        errors.push('Skipped non-object entry');
        continue;
      }
      const name = String(raw.name || '').trim();
      const host = String(raw.host || '').trim();
      const username = String(raw.username || '').trim();
      if (!name || !host || !username) {
        errors.push('Skipped entry missing required name/host/username');
        continue;
      }

      const id = (typeof raw.id === 'string' && raw.id) ? raw.id : crypto.randomUUID();

      const entry: HostEntry = {
        id,
        name,
        host,
        port: Number(raw.port) || 22,
        username,
        password: raw.password ? String(raw.password) : undefined,
        privateKey: raw.privateKey ? String(raw.privateKey) : undefined,
        passphrase: raw.passphrase ? String(raw.passphrase) : undefined,
        keepAlive: !!raw.keepAlive,
        group: raw.group != null ? String(raw.group).trim() || undefined : undefined,
      };

      if (byId.has(id)) {
        const idx = current.findIndex((h) => h.id === id);
        if (idx >= 0) {
          current[idx] = entry;
          updated++;
        }
      } else {
        current.push(entry);
        added++;
      }
    }

    current.sort((a, b) => a.name.localeCompare(b.name));
    await this.context.globalState.update(HOSTS_KEY, current);
    this._onDidChange.fire();

    return { added, updated, errors };
  }
}
