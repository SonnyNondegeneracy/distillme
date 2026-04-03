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
 */

import { readFile, readdir, stat, mkdir } from 'fs/promises';
import { join, extname, relative } from 'path';
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

// CLI mode
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log(`Usage:
  node ingest.mjs scan <data-folder>
  node ingest.mjs init <slug>
  node ingest.mjs read-chunk <file> [--offset 0] [--limit 4000]`);
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
} else {
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}
