#!/usr/bin/env node
/**
 * ingest.mjs
 *
 * Main ingestion pipeline: scans a data folder, extracts persona profile and memories.
 * This tool is called by Claude during the /distill-me create workflow.
 * It handles file scanning and outputs a summary — the actual LLM analysis
 * (persona extraction, memory extraction) is done by Claude using the prompt templates.
 *
 * Usage:
 *   node ingest.mjs scan <data-folder>              # Scan and report contents
 *   node ingest.mjs init <slug>                      # Initialize persona directory structure
 *   node ingest.mjs read-chunk <file> [--offset 0] [--limit 4000]  # Read a chunk of a file
 *   node ingest.mjs diff <slug> <data-folder>        # Find new/changed files since last ingest
 *   node ingest.mjs mark-done <slug> <data-folder>   # Record current file state as processed
 */

import { readFile, readdir, stat, mkdir, writeFile } from 'fs/promises';
import { join, extname, relative, resolve } from 'path';
import { createHash } from 'crypto';
import { scanDataFolder, personaDir, memoriesDir, MEMORY_CATEGORIES } from '../lib/utils.mjs';

/**
 * Scan a data folder and report its contents.
 */
async function scan(dataFolder) {
  const files = await scanDataFolder(dataFolder);

  const summary = {
    data_folder: dataFolder,
    total_files: Object.values(files).reduce((sum, arr) => sum + arr.length, 0),
    breakdown: {
      text: files.text.length,
      json: files.json.length,
      csv: files.csv.length,
      image: files.image.length,
      other: files.other.length,
    },
    files: {},
  };

  // Get file sizes and previews for text files
  for (const category of ['text', 'json', 'csv']) {
    summary.files[category] = [];
    for (const filePath of files[category]) {
      const fstat = await stat(filePath);
      const entry = {
        path: relative(dataFolder, filePath),
        size_bytes: fstat.size,
        size_kb: Math.round(fstat.size / 1024),
      };
      // Preview first 200 chars of text files
      if (category === 'text' && fstat.size > 0) {
        const content = await readFile(filePath, 'utf-8');
        entry.preview = content.slice(0, 200).replace(/\n/g, ' ');
      }
      summary.files[category].push(entry);
    }
  }

  // Just list image files
  summary.files.image = files.image.map(f => relative(dataFolder, f));
  summary.files.other = files.other.map(f => relative(dataFolder, f));

  return summary;
}

/**
 * Initialize the persona directory structure.
 */
async function init(slug) {
  const pDir = personaDir(slug);
  const mDir = memoriesDir(slug);

  // Create all category directories
  for (const cat of MEMORY_CATEGORIES) {
    await mkdir(join(mDir, cat), { recursive: true });
  }

  // Create model and logs directories
  await mkdir(join(pDir, 'model'), { recursive: true });
  await mkdir(join(pDir, 'logs'), { recursive: true });

  // Create default config.json
  const config = {
    slug,
    created: new Date().toISOString(),
    retrieval: {
      top_k: 8,
      faiss_candidates: 50,
      walk_max_nodes: 5,
      walk_min_strength: 0.3,
      token_budget: 2000,
    },
    model: {
      embedder: 'paraphrase-multilingual-MiniLM-L12-v2',
      linker_blend: 0.6,
    },
  };

  const { writeFile } = await import('fs/promises');
  await writeFile(join(pDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');

  return {
    persona_dir: pDir,
    memories_dir: mDir,
    config_path: join(pDir, 'config.json'),
    categories: MEMORY_CATEGORIES,
  };
}

/**
 * Read a chunk of a file for LLM processing.
 */
async function readChunk(filePath, offset = 0, limit = 4000) {
  const content = await readFile(filePath, 'utf-8');
  const chunk = content.slice(offset, offset + limit);
  return {
    file: filePath,
    offset,
    limit,
    total_length: content.length,
    chunk_length: chunk.length,
    has_more: offset + limit < content.length,
    content: chunk,
  };
}

/**
 * Compute a fast hash of file content for change detection.
 */
function fileHash(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Load the ingest log (records which files have been processed).
 */
async function loadIngestLog(slug) {
  const logPath = join(personaDir(slug), 'ingest_log.json');
  try {
    return JSON.parse(await readFile(logPath, 'utf-8'));
  } catch {
    return { files: {}, last_ingest: null };
  }
}

/**
 * Save the ingest log.
 */
async function saveIngestLog(slug, log) {
  const logPath = join(personaDir(slug), 'ingest_log.json');
  await writeFile(logPath, JSON.stringify(log, null, 2) + '\n', 'utf-8');
}

/**
 * Find new or changed files since the last ingest.
 * Compares file hashes to detect changes, not just timestamps.
 *
 * Returns { new_files: [...], changed_files: [...], unchanged: N, total: N }
 */
async function diff(slug, dataFolder) {
  const log = await loadIngestLog(slug);
  const files = await scanDataFolder(dataFolder);
  const allFiles = [...files.text, ...files.json, ...files.csv];

  const newFiles = [];
  const changedFiles = [];
  let unchanged = 0;

  for (const filePath of allFiles) {
    const relPath = relative(resolve(dataFolder), resolve(filePath));
    const content = await readFile(filePath, 'utf-8');
    const hash = fileHash(content);
    const fstat = await stat(filePath);

    const prev = log.files[relPath];
    if (!prev) {
      newFiles.push({ path: filePath, rel_path: relPath, size_kb: Math.round(fstat.size / 1024), hash });
    } else if (prev.hash !== hash) {
      changedFiles.push({ path: filePath, rel_path: relPath, size_kb: Math.round(fstat.size / 1024), hash, prev_hash: prev.hash });
    } else {
      unchanged++;
    }
  }

  return {
    data_folder: dataFolder,
    new_files: newFiles,
    changed_files: changedFiles,
    unchanged,
    total: allFiles.length,
    to_process: newFiles.length + changedFiles.length,
    last_ingest: log.last_ingest,
  };
}

/**
 * Mark all current files in data folder as processed.
 * Call this after a successful ingest to update the baseline.
 */
async function markDone(slug, dataFolder) {
  const log = await loadIngestLog(slug);
  const files = await scanDataFolder(dataFolder);
  const allFiles = [...files.text, ...files.json, ...files.csv];

  for (const filePath of allFiles) {
    const relPath = relative(resolve(dataFolder), resolve(filePath));
    const content = await readFile(filePath, 'utf-8');
    const hash = fileHash(content);
    const fstat = await stat(filePath);
    log.files[relPath] = {
      hash,
      size: fstat.size,
      processed_at: new Date().toISOString(),
    };
  }

  log.last_ingest = new Date().toISOString();
  await saveIngestLog(slug, log);

  return {
    status: 'ok',
    files_recorded: allFiles.length,
    last_ingest: log.last_ingest,
  };
}

// CLI mode
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log(`Usage:
  node ingest.mjs scan <data-folder>
  node ingest.mjs init <slug>
  node ingest.mjs read-chunk <file> [--offset 0] [--limit 4000]
  node ingest.mjs diff <slug> <data-folder>
  node ingest.mjs mark-done <slug> <data-folder>`);
  process.exit(1);
}

const cmd = args[0];

if (cmd === 'scan') {
  scan(args[1]).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
} else if (cmd === 'init') {
  init(args[1]).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
} else if (cmd === 'read-chunk') {
  let offset = 0, limit = 4000;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--offset' && args[i + 1]) offset = parseInt(args[++i]);
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i]);
  }
  readChunk(args[1], offset, limit).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
} else if (cmd === 'diff') {
  const slug = args[1];
  const dataFolder = args[2];
  if (!slug || !dataFolder) { console.error('Usage: node ingest.mjs diff <slug> <data-folder>'); process.exit(1); }
  diff(slug, dataFolder).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
} else if (cmd === 'mark-done') {
  const slug = args[1];
  const dataFolder = args[2];
  if (!slug || !dataFolder) { console.error('Usage: node ingest.mjs mark-done <slug> <data-folder>'); process.exit(1); }
  markDone(slug, dataFolder).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}
