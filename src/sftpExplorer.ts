import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client, SFTPWrapper } from 'ssh2';
import * as vscode from 'vscode';
import { HostEntry } from './storage';

interface RemoteFile {
  filename: string;
  longname: string;
  attrs: {
    size: number;
    mtime: number;
    mode: number;
    uid?: number;
    gid?: number;
  };
}

interface FileItem {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
  mode: number;
}

interface TransferTask {
  id: string;
  hostId: string;
  direction: 'upload' | 'download';
  src: string;
  dst: string;
  isDir?: boolean;
  size?: number;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'killed';
  progress?: number;
  error?: string;
}

const SFTP_QUEUE_KEY_PREFIX = 'vscodeConnect.sftpQueue';

export function openSftpExplorer(extensionUri: vscode.Uri, entry: HostEntry, context: vscode.ExtensionContext): void {
  const panel = vscode.window.createWebviewPanel(
    'vscodeConnect.sftpExplorer',
    `SFTP: ${entry.name}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
    }
  );

  const htmlPath = path.join(extensionUri.fsPath, 'media', 'sftpExplorer.html');
  let html = fs.readFileSync(htmlPath, 'utf8');

  // Inject nonce for security
  const nonce = getNonce();
  html = html.replace(/\{\{cspSource\}\}/g, panel.webview.cspSource);
  html = html.replace(/\{\{nonce\}\}/g, nonce);

  panel.webview.html = html;

  let client: Client | undefined;
  let sftp: SFTPWrapper | undefined;
  let currentRemotePath = '.';
  let currentLocalPath = os.homedir();

  const post = (msg: any) => panel.webview.postMessage(msg);

  async function connect(): Promise<void> {
    // Prompt for missing credentials (username and/or password) so SFTP works
    // even when the host entry was saved without a password.
    let effectiveUsername = entry.username;
    let effectivePassword: string | undefined = entry.password;
    let effectivePassphrase: string | undefined = entry.passphrase;

    if (!effectiveUsername) {
      const u = await vscode.window.showInputBox({
        prompt: `Username for ${entry.host}`,
        placeHolder: 'username',
        ignoreFocusOut: true,
      });
      if (!u) {
        post({ type: 'error', message: 'Username is required to connect.' });
        return Promise.reject(new Error('Username required'));
      }
      effectiveUsername = u;
    }

    const hasPrivateKey = !!entry.privateKey;
    if (!hasPrivateKey && !effectivePassword) {
      const p = await vscode.window.showInputBox({
        prompt: `Password for ${effectiveUsername}@${entry.host}`,
        password: true,
        ignoreFocusOut: true,
      });
      if (p === undefined) {
        post({ type: 'error', message: 'Password input was cancelled.' });
        return Promise.reject(new Error('Password required'));
      }
      effectivePassword = p;
    }

    // If a private key is configured without a stored passphrase, optionally prompt.
    if (hasPrivateKey && !effectivePassphrase) {
      const ph = await vscode.window.showInputBox({
        prompt: `Passphrase for private key (leave empty if none)`,
        password: true,
        ignoreFocusOut: true,
      });
      // ph may be '', which is valid (no passphrase). Only treat explicit cancel as undefined.
      if (ph !== undefined) {
        effectivePassphrase = ph || undefined;
      }
    }

    return new Promise((resolve, reject) => {
      client = new Client();

      client.on('ready', () => {
        client!.sftp((err, sftpSession) => {
          if (err) {
            post({ type: 'error', message: `SFTP error: ${err.message}` });
            reject(err);
            return;
          }
          sftp = sftpSession;
          post({ type: 'connected', host: `${effectiveUsername ? effectiveUsername + '@' : ''}${entry.host}:${entry.port}` });
          // Resolve to a full absolute path instead of "." so the UI shows proper location
          sftp!.realpath('.', (rpErr, absPath) => {
            if (!rpErr && absPath) {
              currentRemotePath = absPath;
            }
            void listRemote(currentRemotePath);
            void listLocal(currentLocalPath);
            // Load persisted transfer queue for this host and kick workers (5 concurrent)
            queue = loadPersistedQueue();
            normalizeQueue();
            saveQueue(queue);
            postQueueState();
            kickWorkers();
          });
          resolve();
        });
      });

      client.on('error', (err) => {
        post({ type: 'error', message: `Connection error: ${err.message}` });
        reject(err);
      });

      // Support keyboard-interactive auth (common when password auth is required)
      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        finish(prompts.map(() => effectivePassword ?? ''));
      });

      const connectOpts: any = {
        host: entry.host,
        port: entry.port,
        username: effectiveUsername,
        password: effectivePassword || undefined,
        tryKeyboard: true,
        agent: process.env.SSH_AUTH_SOCK,
        readyTimeout: 20000,
      };

      if (entry.keepAlive) {
        connectOpts.keepaliveInterval = 15000;
        connectOpts.keepaliveCountMax = 3;
      }

      if (entry.privateKey) {
        connectOpts.privateKey = entry.privateKey;
        if (effectivePassphrase) {
          connectOpts.passphrase = effectivePassphrase;
        }
      }

      try {
        client.connect(connectOpts);
      } catch (err: any) {
        post({ type: 'error', message: `Connect failed: ${err?.message || err}` });
        reject(err);
      }
    });
  }

  function disconnect(): void {
    try {
      sftp?.end();
    } catch {}
    try {
      client?.end();
    } catch {}
    sftp = undefined;
    client = undefined;
  }

  async function listRemote(remotePath: string): Promise<void> {
    if (!sftp) {
      post({ type: 'error', message: 'Not connected' });
      return;
    }
    try {
      const list = await new Promise<RemoteFile[]>((resolve, reject) => {
        sftp!.readdir(remotePath, (err, list) => {
          if (err) return reject(err);
          resolve(list as RemoteFile[]);
        });
      });

      const files: FileItem[] = list.map((f) => ({
        name: f.filename,
        isDir: (f.attrs.mode & 0o40000) !== 0, // S_IFDIR
        size: f.attrs.size,
        mtime: f.attrs.mtime * 1000,
        mode: f.attrs.mode,
      }));

      // Sort: dirs first, then alpha
      files.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      currentRemotePath = remotePath;
      post({ type: 'remoteList', path: remotePath, files });
    } catch (err: any) {
      post({ type: 'error', message: `Remote list failed: ${err?.message || err}` });
    }
  }

  async function listLocal(localPath: string): Promise<void> {
    try {
      const entries = await fs.promises.readdir(localPath, { withFileTypes: true });
      const files: FileItem[] = [];

      for (const ent of entries) {
        try {
          const full = path.join(localPath, ent.name);
          const stat = await fs.promises.stat(full);
          files.push({
            name: ent.name,
            isDir: ent.isDirectory(),
            size: stat.size,
            mtime: stat.mtime.getTime(),
            mode: stat.mode,
          });
        } catch {
          // ignore unreadable entries
        }
      }

      files.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      currentLocalPath = localPath;
      post({ type: 'localList', path: localPath, files });
    } catch (err: any) {
      post({ type: 'error', message: `Local list failed: ${err?.message || err}` });
    }
  }

  async function download(remoteFullPath: string): Promise<void> {
    if (!sftp) {
      post({ type: 'error', message: 'Not connected' });
      return;
    }
    const base = path.basename(remoteFullPath);
    const localTarget = path.join(currentLocalPath, base);

    try {
      await new Promise<void>((resolve, reject) => {
        sftp!.fastGet(remoteFullPath, localTarget, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      post({ type: 'info', message: `Downloaded: ${base}` });
      await listLocal(currentLocalPath);
    } catch (err: any) {
      post({ type: 'error', message: `Download failed: ${err?.message || err}` });
    }
  }

  async function upload(localPath: string, remoteDir: string): Promise<void> {
    if (!sftp) {
      post({ type: 'error', message: 'Not connected' });
      return;
    }

    const base = path.basename(localPath);
    const remoteTarget = remoteDir === '.' || remoteDir === '~' ? base : `${remoteDir.replace(/\/$/, '')}/${base}`;

    try {
      await new Promise<void>((resolve, reject) => {
        sftp!.fastPut(localPath, remoteTarget, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      post({ type: 'info', message: `Uploaded: ${base}` });
      await listRemote(currentRemotePath);
    } catch (err: any) {
      post({ type: 'error', message: `Upload failed: ${err?.message || err}` });
    }
  }

  async function deleteRemote(remotePath: string, isDir: boolean): Promise<void> {
    if (!sftp) return;
    try {
      if (isDir) {
        // Try rmdir; for non-empty we would need recursive delete (advanced)
        await new Promise<void>((resolve, reject) => {
          sftp!.rmdir(remotePath, (err) => (err ? reject(err) : resolve()));
        });
      } else {
        await new Promise<void>((resolve, reject) => {
          sftp!.unlink(remotePath, (err) => (err ? reject(err) : resolve()));
        });
      }
      post({ type: 'info', message: `Deleted: ${path.basename(remotePath)}` });
      await listRemote(currentRemotePath);
    } catch (err: any) {
      post({ type: 'error', message: `Delete failed: ${err?.message || err}` });
    }
  }

  async function deleteLocal(localFullPath: string, isDir: boolean): Promise<void> {
    try {
      if (isDir) {
        await fs.promises.rmdir(localFullPath);
      } else {
        await fs.promises.unlink(localFullPath);
      }
      post({ type: 'info', message: `Deleted: ${path.basename(localFullPath)}` });
      await listLocal(currentLocalPath);
    } catch (err: any) {
      post({ type: 'error', message: `Local delete failed: ${err?.message || err}` });
    }
  }

  async function mkdirRemote(remoteDir: string, name: string): Promise<void> {
    if (!sftp) return;
    const target = remoteDir === '.' || remoteDir === '~' ? name : `${remoteDir.replace(/\/$/, '')}/${name}`;
    try {
      await new Promise<void>((resolve, reject) => {
        sftp!.mkdir(target, (err) => (err ? reject(err) : resolve()));
      });
      post({ type: 'info', message: `Created folder: ${name}` });
      await listRemote(currentRemotePath);
    } catch (err: any) {
      post({ type: 'error', message: `Create folder failed: ${err?.message || err}` });
    }
  }

  async function mkdirLocal(localDir: string, name: string): Promise<void> {
    const target = path.join(localDir, name);
    try {
      await fs.promises.mkdir(target, { recursive: false });
      post({ type: 'info', message: `Created folder: ${name}` });
      await listLocal(currentLocalPath);
    } catch (err: any) {
      post({ type: 'error', message: `Create local folder failed: ${err?.message || err}` });
    }
  }

  async function openRemoteFile(remotePath: string): Promise<void> {
    if (!sftp) return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-connect-sftp-'));
    const localTmp = path.join(tmpDir, path.basename(remotePath));

    try {
      await new Promise<void>((resolve, reject) => {
        sftp!.fastGet(remotePath, localTmp, (err) => (err ? reject(err) : resolve()));
      });

      const doc = await vscode.workspace.openTextDocument(localTmp);
      await vscode.window.showTextDocument(doc, { preview: false });
      post({ type: 'info', message: `Opened: ${path.basename(remotePath)}` });
    } catch (err: any) {
      post({ type: 'error', message: `Open file failed: ${err?.message || err}` });
    }
  }

  // ---------------- Queue & Transfer (5 concurrent, persisted) ----------------
  const QUEUE_KEY = `${SFTP_QUEUE_KEY_PREFIX}:${entry.id}`;
  let queue: TransferTask[] = [];
  let paused = false;
  let activeWorkers = 0;
  const MAX_CONCURRENT = 5;

  function loadPersistedQueue(): TransferTask[] {
    try {
      const arr = context.globalState.get<TransferTask[]>(QUEUE_KEY, []);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function saveQueue(q: TransferTask[]) {
    void context.globalState.update(QUEUE_KEY, q);
  }
  function postQueueState() {
    post({ type: 'queueState', queue: queue.slice(0, 200), paused });
  }
  function normalizeQueue() {
    for (const t of queue) {
      if (t.status === 'running' || t.status === 'paused') t.status = 'queued';
    }
  }

  async function listLocalRecursive(root: string): Promise<Array<{ relPath: string; fullPath: string; isDir: boolean; size: number }>> {
    const out: Array<{ relPath: string; fullPath: string; isDir: boolean; size: number }> = [];
    async function walk(dir: string, relBase: string) {
      let ents: fs.Dirent[] = [];
      try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of ents) {
        const full = path.join(dir, ent.name);
        const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          out.push({ relPath: rel, fullPath: full, isDir: true, size: 0 });
          await walk(full, rel);
        } else {
          try {
            const st = await fs.promises.stat(full);
            out.push({ relPath: rel, fullPath: full, isDir: false, size: st.size });
          } catch {}
        }
      }
    }
    await walk(root, '');
    return out;
  }

  async function listRemoteRecursive(root: string): Promise<Array<{ relPath: string; fullPath: string; isDir: boolean; size: number }>> {
    const out: Array<{ relPath: string; fullPath: string; isDir: boolean; size: number }> = [];
    async function walk(dir: string, relBase: string): Promise<void> {
      try {
        const list = await new Promise<RemoteFile[]>((resolve, reject) => {
          sftp!.readdir(dir, (err, list) => (err ? reject(err) : resolve(list as RemoteFile[])));
        });
        for (const f of list) {
          const full = dir === '.' || dir === '~' ? f.filename : `${dir.replace(/\/$/, '')}/${f.filename}`;
          const rel = relBase ? `${relBase}/${f.filename}` : f.filename;
          const isDir = (f.attrs.mode & 0o40000) !== 0;
          if (isDir) {
            out.push({ relPath: rel, fullPath: full, isDir: true, size: 0 });
            await walk(full, rel);
          } else {
            out.push({ relPath: rel, fullPath: full, isDir: false, size: f.attrs.size });
          }
        }
      } catch {
        // ignore unreadable
      }
    }
    await walk(root, '');
    return out;
  }

  async function ensureRemoteDir(remoteDir: string): Promise<void> {
    if (!sftp) return;
    if (!remoteDir || remoteDir === '.' || remoteDir === '~' || remoteDir === '/') return;
    const parts = remoteDir.split('/').filter(Boolean);
    let cur = remoteDir.startsWith('/') ? '/' : '';
    for (const p of parts) {
      cur = cur ? (cur === '/' ? `/${p}` : `${cur}/${p}`) : p;
      if (!cur || cur === '.' || cur === '~') continue;
      await new Promise<void>((resolve) => {
        sftp!.mkdir(cur, (err) => resolve()); // ignore EEXIST etc.
      });
    }
  }

  async function remotePathExists(remoteFull: string): Promise<boolean> {
    if (!sftp) return false;
    return new Promise((resolve) => {
      sftp!.stat(remoteFull, (err) => resolve(!err));
    });
  }

  async function performUpload(localSrc: string, remoteDst: string): Promise<void> {
    if (!sftp) throw new Error('Not connected');
    await ensureRemoteDir(path.dirname(remoteDst));
    await new Promise<void>((resolve, reject) => {
      sftp!.fastPut(localSrc, remoteDst, (err) => (err ? reject(err) : resolve()));
    });
  }

  async function performDownload(remoteSrc: string, localDst: string): Promise<void> {
    if (!sftp) throw new Error('Not connected');
    await fs.promises.mkdir(path.dirname(localDst), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      sftp!.fastGet(remoteSrc, localDst, (err) => (err ? reject(err) : resolve()));
    });
  }

  async function doUploadTask(task: TransferTask): Promise<void> {
    // ensure parent on remote
    await ensureRemoteDir(path.dirname(task.dst));
    await new Promise<void>((resolve, reject) => {
      sftp!.fastPut(task.src, task.dst, {
        step: (_total: number, nb: number, fsize: number) => {
          if (fsize > 0) {
            task.progress = Math.floor((nb / fsize) * 100);
            if ((task.progress || 0) % 10 === 0) postQueueState();
          }
        }
      } as any, (err) => (err ? reject(err) : resolve()));
    });
  }

  async function doDownloadTask(task: TransferTask): Promise<void> {
    await fs.promises.mkdir(path.dirname(task.dst), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      sftp!.fastGet(task.src, task.dst, {
        step: (_total: number, nb: number, fsize: number) => {
          if (fsize > 0) {
            task.progress = Math.floor((nb / fsize) * 100);
            if ((task.progress || 0) % 10 === 0) postQueueState();
          }
        }
      } as any, (err) => (err ? reject(err) : resolve()));
    });
  }

  async function runTask(task: TransferTask): Promise<void> {
    try {
      if (task.direction === 'upload') {
        await doUploadTask(task);
      } else {
        await doDownloadTask(task);
      }
      task.status = 'completed';
      task.progress = 100;
      // Refresh side if still viewing the affected area.
      // Always refresh the target side after a transfer completes so the table updates (esp. after uploads).
      try {
        if (task.direction === 'upload' && currentRemotePath != null) {
          await listRemote(currentRemotePath);
        }
        if (task.direction === 'download' && currentLocalPath != null) {
          await listLocal(currentLocalPath);
        }
      } catch {}
    } catch (e: any) {
      task.status = 'failed';
      task.error = String(e?.message || e);
    }
  }

  function kickWorkers() {
    if (paused || !sftp) return;
    while (activeWorkers < MAX_CONCURRENT) {
      const idx = queue.findIndex((t) => t.status === 'queued');
      if (idx === -1) break;
      const task = queue[idx];
      activeWorkers++;
      task.status = 'running';
      task.progress = 0;
      saveQueue(queue);
      postQueueState();
      runTask(task).finally(() => {
        activeWorkers--;
        saveQueue(queue);
        postQueueState();
        kickWorkers();
      });
    }
  }

  async function enqueueTasks(tasks: TransferTask[]) {
    if (!tasks.length) return;
    queue.push(...tasks);
    saveQueue(queue);
    postQueueState();
    kickWorkers();
  }

  async function enqueueUploadFolder(localFolder: string) {
    if (!sftp) {
      post({ type: 'error', message: 'Not connected' });
      return;
    }
    const base = path.basename(localFolder);
    const remoteTargetDir = (currentRemotePath === '.' || currentRemotePath === '~' || !currentRemotePath)
      ? base
      : `${currentRemotePath.replace(/\/$/, '')}/${base}`;
    const items = await listLocalRecursive(localFolder);
    const tasks: TransferTask[] = [];
    for (const it of items) {
      if (it.isDir) continue;
      const dst = `${remoteTargetDir.replace(/\/$/, '')}/${it.relPath}`;
      tasks.push({
        id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
        hostId: entry.id,
        direction: 'upload',
        src: it.fullPath,
        dst,
        isDir: false,
        size: it.size,
        status: 'queued'
      });
    }
    if (tasks.length === 0) {
      // empty folder: ensure it exists remotely
      await ensureRemoteDir(remoteTargetDir);
      post({ type: 'info', message: `Created folder: ${base}` });
      await listRemote(currentRemotePath);
      return;
    }
    await enqueueTasks(tasks);
  }

  async function enqueueDownloadFolder(remoteFolder: string) {
    if (!sftp) {
      post({ type: 'error', message: 'Not connected' });
      return;
    }
    const base = path.basename(remoteFolder);
    const localTargetDir = path.join(currentLocalPath, base);
    const items = await listRemoteRecursive(remoteFolder);
    const tasks: TransferTask[] = [];
    for (const it of items) {
      if (it.isDir) continue;
      const dst = path.join(localTargetDir, it.relPath);
      tasks.push({
        id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
        hostId: entry.id,
        direction: 'download',
        src: it.fullPath,
        dst,
        isDir: false,
        size: it.size,
        status: 'queued'
      });
    }
    if (tasks.length === 0) {
      await fs.promises.mkdir(localTargetDir, { recursive: true });
      post({ type: 'info', message: `Created folder: ${base}` });
      await listLocal(currentLocalPath);
      return;
    }
    await enqueueTasks(tasks);
  }

  async function uploadWithConfirm(localFull: string) {
    const base = path.basename(localFull);
    const remoteTarget = (currentRemotePath === '.' || currentRemotePath === '~' || !currentRemotePath)
      ? base
      : `${currentRemotePath.replace(/\/$/, '')}/${base}`;
    const exists = await remotePathExists(remoteTarget);
    if (exists) {
      const choice = await vscode.window.showWarningMessage(
        `File "${base}" exists on remote. Overwrite?`,
        { modal: true },
        'Overwrite'
      );
      if (choice !== 'Overwrite') {
        post({ type: 'info', message: 'Upload cancelled' });
        return;
      }
    }
    try {
      await performUpload(localFull, remoteTarget);
      post({ type: 'info', message: `Uploaded: ${base}` });
      await listRemote(currentRemotePath);
    } catch (err: any) {
      post({ type: 'error', message: `Upload failed: ${err?.message || err}` });
    }
  }

  async function downloadWithConfirm(remoteFull: string) {
    const base = path.basename(remoteFull);
    const localTarget = path.join(currentLocalPath, base);
    const exists = fs.existsSync(localTarget);
    if (exists) {
      const choice = await vscode.window.showWarningMessage(
        `File "${base}" exists locally. Overwrite?`,
        { modal: true },
        'Overwrite'
      );
      if (choice !== 'Overwrite') {
        post({ type: 'info', message: 'Download cancelled' });
        return;
      }
    }
    try {
      await performDownload(remoteFull, localTarget);
      post({ type: 'info', message: `Downloaded: ${base}` });
      await listLocal(currentLocalPath);
    } catch (err: any) {
      post({ type: 'error', message: `Download failed: ${err?.message || err}` });
    }
  }

  // Message handling from webview
  panel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case 'ready':
        try {
          await connect();
        } catch {
          // error already posted
        }
        break;

      case 'listLocal':
        await listLocal(msg.path || currentLocalPath);
        break;

      case 'listRemote':
        await listRemote(msg.path || currentRemotePath);
        break;

      case 'cdLocal':
        await listLocal(msg.path);
        break;

      case 'cdRemote':
        await listRemote(msg.path);
        break;

      case 'download':
        if (Array.isArray(msg.items) && msg.items.length) {
          for (const it of msg.items) {
            if (it && it.path) {
              if (it.isDir) {
                await enqueueDownloadFolder(it.path);
              } else {
                await downloadWithConfirm(it.path);
              }
            }
          }
        } else if (msg.remotePath) {
          // backward compat single
          if (msg.isDir) {
            await enqueueDownloadFolder(msg.remotePath);
          } else {
            await downloadWithConfirm(msg.remotePath);
          }
        }
        break;

      case 'upload':
        if (Array.isArray(msg.items) && msg.items.length) {
          for (const it of msg.items) {
            if (it && it.path) {
              if (it.isDir) {
                await enqueueUploadFolder(it.path);
              } else {
                await uploadWithConfirm(it.path);
              }
            }
          }
        } else if (msg.localPath) {
          // backward compat single
          if (msg.isDir) {
            await enqueueUploadFolder(msg.localPath);
          } else {
            await uploadWithConfirm(msg.localPath);
          }
        } else {
          // Ask user to pick a file (fallback)
          const uris = await vscode.window.showOpenDialog({ canSelectMany: false });
          if (uris && uris.length > 0) {
            await uploadWithConfirm(uris[0].fsPath);
          }
        }
        break;

      case 'queuePause':
        paused = true;
        saveQueue(queue);
        postQueueState();
        break;

      case 'queueResume':
        paused = false;
        saveQueue(queue);
        postQueueState();
        kickWorkers();
        break;

      case 'queueKill':
        for (const t of queue) {
          if (t.status === 'queued' || t.status === 'paused') {
            t.status = 'killed';
          }
        }
        saveQueue(queue);
        postQueueState();
        break;

      case 'queueClear':
        // Remove finished, failed, and killed items. Keep active (queued/running/paused).
        queue = queue.filter(t => t.status === 'queued' || t.status === 'running' || t.status === 'paused');
        saveQueue(queue);
        postQueueState();
        break;

      case 'requestDeleteRemote':
        await handleRequestDeleteRemote(msg);
        break;

      case 'requestDeleteLocal':
        await handleRequestDeleteLocal(msg);
        break;

      case 'mkdirRemote':
        const folderName = await vscode.window.showInputBox({ prompt: 'New folder name', value: 'New Folder' });
        if (folderName) {
          await mkdirRemote(currentRemotePath, folderName);
        }
        break;

      case 'mkdirLocal':
        const localFolderName = await vscode.window.showInputBox({ prompt: 'New folder name', value: 'New Folder' });
        if (localFolderName) {
          await mkdirLocal(currentLocalPath, localFolderName);
        }
        break;

      case 'openRemoteFile':
        await openRemoteFile(msg.path);
        break;

      case 'refresh':
        await listRemote(currentRemotePath);
        await listLocal(currentLocalPath);
        break;
    }
  });

  panel.onDidDispose(() => {
    disconnect();
  });

  async function handleRequestDeleteRemote(msg: any): Promise<void> {
    const items: Array<{ path: string; name?: string; isDir?: boolean }> = Array.isArray(msg.items) && msg.items.length
      ? msg.items
      : (msg.path ? [{ path: msg.path, name: msg.name, isDir: msg.isDir }] : []);
    if (!items.length) return;
    const count = items.length;
    const choice = await vscode.window.showWarningMessage(
      `Delete ${count} remote item${count > 1 ? 's' : ''}?`,
      { modal: true },
      'Delete'
    );
    if (choice !== 'Delete') return;
    for (const it of items) {
      if (!it || !it.path) continue;
      await deleteRemote(it.path, !!it.isDir);
    }
  }

  async function handleRequestDeleteLocal(msg: any): Promise<void> {
    const items: Array<{ name: string; isDir?: boolean }> = Array.isArray(msg.items) && msg.items.length
      ? msg.items
      : (msg.name ? [{ name: msg.name, isDir: msg.isDir }] : []);
    if (!items.length) return;
    const count = items.length;
    const choice = await vscode.window.showWarningMessage(
      `Delete ${count} local item${count > 1 ? 's' : ''}? This cannot be undone.`,
      { modal: true },
      'Delete'
    );
    if (choice !== 'Delete') return;
    for (const it of items) {
      if (!it || !it.name) continue;
      const full = path.join(currentLocalPath, it.name);
      await deleteLocal(full, !!it.isDir);
    }
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
