/**
 * embed-client.mjs
 *
 * Node client for embed_daemon.py via Unix domain socket.
 * Auto-starts daemon on first call. Multiple Node processes share one daemon.
 * Falls back to one-shot execFileAsync if daemon fails.
 */

import { connect } from 'net';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { access } from 'fs/promises';
import { join } from 'path';

const execFileAsync = promisify(execFile);
const DAEMON_PATH = new URL('../model/embed_daemon.py', import.meta.url).pathname;
const EMBEDDER_PATH = new URL('../model/embedder.py', import.meta.url).pathname;
const LINKER_PATH = new URL('../model/linker.py', import.meta.url).pathname;
const SOCKET_PATH = process.env.DISTILLME_SOCKET || '/tmp/distillme_embed.sock';

let _startingDaemon = null;

/**
 * Start daemon if not already running.
 */
async function ensureDaemon() {
  // Check if socket exists and is connectable
  try {
    await new Promise((resolve, reject) => {
      const sock = connect(SOCKET_PATH);
      sock.on('connect', () => { sock.destroy(); resolve(); });
      sock.on('error', reject);
      setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 2000);
    });
    return; // Daemon is running
  } catch {
    // Need to start daemon
  }

  if (_startingDaemon) return _startingDaemon;

  _startingDaemon = new Promise((resolve, reject) => {
    const proc = spawn('python3', [DAEMON_PATH], {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
      env: { ...process.env, CUDA_VISIBLE_DEVICES: '', DISTILLME_SOCKET: SOCKET_PATH },
    });
    proc.unref();

    // Wait for socket to become available
    let attempts = 0;
    const maxAttempts = 40; // 40 * 500ms = 20s
    const check = () => {
      attempts++;
      const sock = connect(SOCKET_PATH);
      sock.on('connect', () => {
        sock.destroy();
        _startingDaemon = null;
        resolve();
      });
      sock.on('error', () => {
        sock.destroy();
        if (attempts >= maxAttempts) {
          _startingDaemon = null;
          reject(new Error('Daemon failed to start within 20s'));
        } else {
          setTimeout(check, 500);
        }
      });
    };
    setTimeout(check, 1000); // Give daemon 1s to bind
  });

  return _startingDaemon;
}

/**
 * Send a request to daemon and get response via Unix socket.
 */
function daemonCall(request, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCKET_PATH);
    let timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Daemon call timeout (${timeout}ms)`));
    }, timeout);

    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    sock.on('connect', () => {
      // Send length-prefixed message
      const data = Buffer.from(JSON.stringify(request), 'utf-8');
      const header = Buffer.alloc(4);
      header.writeUInt32BE(data.length, 0);
      sock.write(Buffer.concat([header, data]));

      // Read length-prefixed response
      let buf = Buffer.alloc(0);
      let expectedLen = null;

      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);

        if (expectedLen === null && buf.length >= 4) {
          expectedLen = buf.readUInt32BE(0);
          buf = buf.slice(4);
        }

        if (expectedLen !== null && buf.length >= expectedLen) {
          clearTimeout(timer);
          const responseStr = buf.slice(0, expectedLen).toString('utf-8');
          sock.destroy();
          try {
            resolve(JSON.parse(responseStr));
          } catch (e) {
            reject(new Error(`Invalid daemon response: ${responseStr.slice(0, 200)}`));
          }
        }
      });
    });
  });
}

/**
 * Call daemon with auto-start. Falls back to one-shot on failure.
 */
async function call(request, timeout = 30000) {
  try {
    await ensureDaemon();
    return await daemonCall(request, timeout);
  } catch {
    // Will fall back in caller
    throw new Error('Daemon unavailable');
  }
}

/**
 * Query FAISS index via daemon. Falls back to one-shot if daemon fails.
 */
export async function queryIndex(personaDir, queryText, topK = 50) {
  try {
    return await call({
      cmd: 'query',
      persona_dir: personaDir,
      text: queryText,
      top_k: topK,
    });
  } catch {
    const { stdout } = await execFileAsync('python3', [
      EMBEDDER_PATH, 'query', personaDir, queryText, '--top-k', String(topK),
    ], { timeout: 90000, env: { ...process.env, CUDA_VISIBLE_DEVICES: '' } });
    return JSON.parse(stdout);
  }
}

/**
 * Re-rank candidates via daemon. Falls back to one-shot if daemon fails.
 */
export async function rerankCandidates(personaDir, query, candidateIds) {
  try {
    return await call({
      cmd: 'rerank',
      persona_dir: personaDir,
      query,
      candidate_ids: candidateIds,
    });
  } catch {
    try {
      const input = JSON.stringify({ query, candidate_ids: candidateIds });
      const { stdout } = await execFileAsync('python3', [LINKER_PATH, 'rerank', personaDir], {
        input,
        timeout: 90000,
      });
      return JSON.parse(stdout);
    } catch {
      return null;
    }
  }
}

/**
 * Embed a single text via daemon.
 */
export async function embedText(text) {
  try {
    return await call({ cmd: 'embed', text });
  } catch {
    const { stdout } = await execFileAsync('python3', [
      EMBEDDER_PATH, 'embed', text,
    ], { timeout: 90000, env: { ...process.env, CUDA_VISIBLE_DEVICES: '' } });
    return JSON.parse(stdout);
  }
}

/**
 * Invalidate daemon's cache for a persona (after index rebuild).
 */
export async function invalidateCache(personaDir) {
  try {
    await call({ cmd: 'invalidate', persona_dir: personaDir }, 5000);
  } catch {
    // Daemon not running, nothing to invalidate
  }
}

/**
 * Shut down the daemon.
 */
export async function shutdownDaemon() {
  try {
    await daemonCall({ cmd: 'shutdown' }, 5000);
  } catch {
    // Already dead
  }
}
