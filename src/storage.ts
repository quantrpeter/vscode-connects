import * as crypto from 'crypto';
import * as vscode from 'vscode';

export interface HostEntry {
  id: string;
  name: string;
  host: string;
  port: number;
  /** Optional; when omitted the system `ssh` client will prompt inside the terminal. */
  username?: string;
  password?: string;
  /** PEM-encoded private key content (for key-based auth). */
  privateKey?: string;
  /** Passphrase to decrypt the private key (if the key is encrypted). */
  passphrase?: string;
  /** If true, the SSH client will send keep-alive packets to prevent idle timeouts. */
  keepAlive?: boolean;
  /** Optional group name used to organize hosts in the list (supports collapse/expand). */
  group?: string;
  /**
   * Timestamp (epoch ms) of the last modification to this entry.
   * Used to merge records across devices when using Settings Sync.
   * Deletes use a separate tombstone map that wins over older updates.
   */
  updatedAt?: number;
}

const HOSTS_KEY = 'vscodeConnect.hosts';
const TOMBSTONES_KEY = 'vscodeConnect.hostTombstones';
const LOCAL_KNOWLEDGE_KEY = 'vscodeConnect.hostsLocal';
const SEEN_SYNC_HINT_KEY = 'vscodeConnect.hasSeenSyncHint';
const COLLAPSED_GROUPS_KEY = 'vscodeConnect.collapsedGroups';

/**
 * Hosts are stored in globalState and registered with setKeysForSync, so they
 * roam to any machine where the user is signed in with Settings Sync enabled.
 */
export class HostStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private _syncTimer?: NodeJS.Timeout;

  constructor(private readonly context: vscode.ExtensionContext) {
    context.globalState.setKeysForSync([HOSTS_KEY, TOMBSTONES_KEY]);

    // Seed local (non-synced) knowledge so that on first load we don't treat
    // already-present synced hosts as "new from another device".
    this._seedLocalKnowledgeFromRaw();

    // Periodically reconcile against the synced globalState so that hosts added
    // or deleted on other devices appear without requiring a manual refresh.
    this._startSyncWatcher();
  }

  private _seedLocalKnowledgeFromRaw(): void {
    const lk = this.getLocalKnowledge();
    const raw = this.getRawHosts();
    const tombs = this.getTombstones();
    let changed = false;

    for (const h of raw) {
      const tomb = tombs[h.id];
      const entryTs = h.updatedAt ?? 0;
      if (tomb && entryTs <= tomb) {
        // This id is deleted; ensure it's not in local knowledge
        if (lk.has(h.id)) {
          lk.delete(h.id);
          changed = true;
        }
        continue;
      }
      const local = lk.get(h.id);
      if (!local || entryTs > (local.updatedAt ?? 0)) {
        lk.set(h.id, h);
        changed = true;
      }
    }
    if (changed) {
      void this.saveLocalKnowledge(lk);
    }
  }

  private _startSyncWatcher(): void {
    // Poll every ~2.5s. Settings Sync is not instantaneous; this keeps UI fresh
    // when another device adds/updates/deletes a host.
    this._syncTimer = setInterval(() => {
      void this._reconcileWithRemote();
    }, 2500);
  }

  private async _reconcileWithRemote(): Promise<void> {
    const raw = this.getRawHosts();
    const tombs = this.getTombstones();
    const lk = this.getLocalKnowledge();

    let changed = false;

    // Bring in any records that are newer on the remote (synced) side
    for (const h of raw) {
      const tomb = tombs[h.id];
      const entryTs = h.updatedAt ?? 0;
      if (tomb && entryTs <= tomb) {
        if (lk.has(h.id)) {
          lk.delete(h.id);
          changed = true;
        }
        continue;
      }
      const local = lk.get(h.id);
      if (!local || entryTs > (local.updatedAt ?? 0)) {
        lk.set(h.id, h);
        changed = true;
      }
    }

    // Apply tombstones that arrived from other devices
    for (const [id, tombTs] of Object.entries(tombs)) {
      const local = lk.get(id);
      if (local && (local.updatedAt ?? 0) <= tombTs) {
        lk.delete(id);
        changed = true;
      }
    }

    if (changed) {
      await this.saveLocalKnowledge(lk);
      this._onDidChange.fire();
    }
  }

  private getRawHosts(): HostEntry[] {
    return this.context.globalState.get<HostEntry[]>(HOSTS_KEY, []);
  }

  getAll(): HostEntry[] {
    const raw = this.getRawHosts();
    const tombstones = this.getTombstones();

    // Deduplicate by id, keeping the entry with the highest updatedAt (defensive against sync artifacts)
    const byId = new Map<string, HostEntry>();
    for (const h of raw) {
      const prev = byId.get(h.id);
      const hTs = h.updatedAt ?? 0;
      if (!prev || hTs > (prev.updatedAt ?? 0)) {
        byId.set(h.id, h);
      }
    }

    // Apply tombstones: a tombstone wins over updates with equal or older timestamp
    const filtered: HostEntry[] = [];
    for (const [id, h] of byId) {
      const tomb = tombstones[id];
      const entryTs = h.updatedAt ?? 0;
      if (tomb && entryTs <= tomb) {
        continue;
      }
      filtered.push(h);
    }
    return filtered.sort((a, b) => a.name.localeCompare(b.name));
  }

  private getTombstones(): Record<string, number> {
    return this.context.globalState.get<Record<string, number>>(TOMBSTONES_KEY, {});
  }

  private async saveTombstones(map: Record<string, number>): Promise<void> {
    await this.context.globalState.update(TOMBSTONES_KEY, map);
  }

  private getLocalKnowledge(): Map<string, HostEntry> {
    const obj = this.context.globalState.get<Record<string, HostEntry>>(LOCAL_KNOWLEDGE_KEY, {});
    const m = new Map<string, HostEntry>();
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') m.set(k, v as HostEntry);
    }
    return m;
  }

  private async saveLocalKnowledge(map: Map<string, HostEntry>): Promise<void> {
    const obj: Record<string, HostEntry> = {};
    for (const [k, v] of map) obj[k] = v;
    await this.context.globalState.update(LOCAL_KNOWLEDGE_KEY, obj);
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
    const now = Date.now();
    const e: HostEntry = { ...entry, updatedAt: now };

    // Read the raw current state (may contain records synced from other devices)
    const raw = this.getRawHosts();
    let tombstones = this.getTombstones();

    // Clear any tombstone for this id — the user is explicitly saving/updating it now.
    if (tombstones[e.id]) {
      tombstones = { ...tombstones };
      delete tombstones[e.id];
    }

    // Build best-known version per id from the current raw (keep highest timestamp on duplicates)
    const byId = new Map<string, HostEntry>();
    for (const h of raw) {
      const prev = byId.get(h.id);
      const hTs = h.updatedAt ?? 0;
      if (!prev || hTs > (prev.updatedAt ?? 0)) {
        byId.set(h.id, h);
      }
    }

    // Our change wins for this id (fresh timestamp)
    byId.set(e.id, e);

    // Write merged list (remote records we didn't touch are preserved)
    const merged = Array.from(byId.values());
    merged.sort((a, b) => a.name.localeCompare(b.name));

    await this.context.globalState.update(HOSTS_KEY, merged);
    if (Object.keys(tombstones).length !== Object.keys(this.getTombstones()).length) {
      await this.saveTombstones(tombstones);
    }

    // Record what this device last wrote for this id (used to detect external merges)
    const lk = this.getLocalKnowledge();
    lk.set(e.id, e);
    await this.saveLocalKnowledge(lk);

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
    const now = Date.now();

    // Record a tombstone so the delete wins across devices even if older copies arrive via sync later.
    const tombstones = { ...this.getTombstones(), [id]: now };
    await this.saveTombstones(tombstones);

    // Prune the id from the raw hosts array so we don't carry deleted data in the synced value.
    // (The tombstone is what provides cross-device durability.)
    const raw = this.getRawHosts().filter((h) => h.id !== id);
    await this.context.globalState.update(HOSTS_KEY, raw);

    // Remove from our local knowledge as well.
    const lk = this.getLocalKnowledge();
    lk.delete(id);
    await this.saveLocalKnowledge(lk);

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
   * - Missing required fields (name, host) cause the entry to be skipped. Username is optional.
   * - Uses merge semantics (timestamps + tombstones) so imports do not overwrite hosts added on other devices.
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

    const now = Date.now();
    const raw = this.getRawHosts();
    let tombstones = this.getTombstones();

    // Build best-known per id from raw (highest timestamp wins on duplicates)
    const byId = new Map<string, HostEntry>();
    for (const h of raw) {
      const prev = byId.get(h.id);
      const hTs = h.updatedAt ?? 0;
      if (!prev || hTs > (prev.updatedAt ?? 0)) {
        byId.set(h.id, h);
      }
    }

    let added = 0;
    let updated = 0;

    for (const r of parsed) {
      if (!r || typeof r !== 'object') {
        errors.push('Skipped non-object entry');
        continue;
      }
      const name = String(r.name || '').trim();
      const host = String(r.host || '').trim();
      const username = r.username != null ? String(r.username).trim() || undefined : undefined;
      if (!name || !host) {
        errors.push('Skipped entry missing required name/host');
        continue;
      }

      const id = (typeof r.id === 'string' && r.id) ? r.id : crypto.randomUUID();

      // Prefer an explicit updatedAt from the import if present and numeric; otherwise use now.
      const importedTs = typeof r.updatedAt === 'number' ? r.updatedAt : undefined;
      const ts = importedTs && importedTs > 0 ? importedTs : now;

      const entry: HostEntry = {
        id,
        name,
        host,
        port: Number(r.port) || 22,
        username,
        password: r.password ? String(r.password) : undefined,
        privateKey: r.privateKey ? String(r.privateKey) : undefined,
        passphrase: r.passphrase ? String(r.passphrase) : undefined,
        keepAlive: !!r.keepAlive,
        group: r.group != null ? String(r.group).trim() || undefined : undefined,
        updatedAt: ts,
      };

      const prev = byId.get(id);
      const prevTs = prev?.updatedAt ?? 0;

      // Clear tombstone for this id (import is an explicit keep/update)
      if (tombstones[id]) {
        tombstones = { ...tombstones };
        delete tombstones[id];
      }

      if (prev) {
        // Only count as "updated" if we are taking a newer or equal-timestamp import
        if (ts >= prevTs) {
          byId.set(id, entry);
          updated++;
        }
        // else: imported older copy; keep the one we already have
      } else {
        byId.set(id, entry);
        added++;
      }
    }

    const merged = Array.from(byId.values());
    merged.sort((a, b) => a.name.localeCompare(b.name));

    await this.context.globalState.update(HOSTS_KEY, merged);
    await this.saveTombstones(tombstones);

    // Update local knowledge for ids present in the import (so we don't treat them as "external" later)
    const lk = this.getLocalKnowledge();
    for (const r of parsed) {
      if (!r || typeof r !== 'object') continue;
      const id = (typeof r.id === 'string' && r.id) ? r.id : undefined;
      if (id && byId.has(id)) {
        lk.set(id, byId.get(id)!);
      }
    }
    await this.saveLocalKnowledge(lk);

    this._onDidChange.fire();

    return { added, updated, errors };
  }
}
