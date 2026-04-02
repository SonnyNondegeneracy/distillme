#!/usr/bin/env node
/**
 * memory-consolidator.mjs
 *
 * Memory lifecycle management:
 *   - Prune: remove decayed memories below importance threshold
 *   - Merge: combine similar conversation memories into single entries
 *   - Stats: report memory counts, size, and health
 *
 * Analogous to human memory consolidation during sleep —
 * should be run periodically (e.g., after each session or daily).
 *
 * Usage:
 *   node memory-consolidator.mjs stats <slug>
 *   node memory-consolidator.mjs prune <slug> [--min-importance 0.1] [--dry-run]
 *   node memory-consolidator.mjs merge <slug> [--similarity 0.85] [--dry-run]
 */

import { readdir, unlink, stat } from 'fs/promises';
import { join, relative } from 'path';
import { readMemory, writeMemory } from '../lib/memory-format.mjs';
import { memoriesDir, personaDir, estimateTokens } from '../lib/utils.mjs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const EMBEDDER_PATH = new URL('../model/embedder.py', import.meta.url).pathname;

/**
 * Recursively collect all memory files.
 */
async function collectMemories(mDir) {
  const memories = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.endsWith('.md')) {
        try {
          const mem = await readMemory(fullPath);
          mem.filePath = fullPath;
          mem.relPath = relative(mDir, fullPath);
          memories.push(mem);
        } catch { /* skip */ }
      }
    }
  }
  await walk(mDir);
  return memories;
}

/**
 * Compute effective importance with long-tail decay.
 *
 * Design: important memories keep most of their weight forever (power-law tail);
 * unimportant memories can decay to near zero.
 *
 * Formula:
 *   floor       = importance²          (high importance → high floor)
 *   decay_factor = 1 / (1 + days / halflife)   (power-law, not exponential)
 *   effective   = importance × (floor + (1 - floor) × decay_factor)
 *
 * Examples (halflife = 365 days):
 *   importance=0.95, day 0   → 0.950    day 365 → 0.904    day 3650 → 0.866
 *   importance=0.50, day 0   → 0.500    day 365 → 0.313    day 3650 → 0.159
 *   importance=0.20, day 0   → 0.200    day 365 → 0.104    day 3650 → 0.025
 *
 * The key insight: importance=0.95 memory retains 91% after a year and 86% after
 * 10 years (long tail). importance=0.20 memory drops to half in a year (expendable).
 */
function effectiveImportance(meta) {
  const importance = meta.importance || 0.5;
  if (!meta.created) return importance;

  const daysSince = (Date.now() - new Date(meta.created).getTime()) / (1000 * 60 * 60 * 24);
  const halflife = meta.halflife || 365; // configurable per-memory, default 1 year
  const floor = importance * importance;  // importance² → asymptotic floor
  const decayFactor = 1 / (1 + daysSince / halflife);

  return importance * (floor + (1 - floor) * decayFactor);
}

/**
 * Stats: report memory health.
 */
async function stats(slug) {
  const mDir = memoriesDir(slug);
  const memories = await collectMemories(mDir);

  const byCategory = {};
  let totalTokens = 0;
  let belowThreshold = 0;
  const threshold = 0.1;

  for (const mem of memories) {
    const cat = mem.relPath.split('/')[0] || 'unknown';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    totalTokens += estimateTokens(mem.body);
    if (effectiveImportance(mem.meta) < threshold) {
      belowThreshold++;
    }
  }

  return {
    total_memories: memories.length,
    total_tokens: totalTokens,
    by_category: byCategory,
    decayed_below_threshold: belowThreshold,
    threshold,
  };
}

/**
 * Prune: remove memories whose effective importance has decayed below threshold.
 */
async function prune(slug, { minImportance = 0.1, dryRun = false } = {}) {
  const mDir = memoriesDir(slug);
  const memories = await collectMemories(mDir);
  const toPrune = [];

  for (const mem of memories) {
    // Never prune identity memories
    if (mem.relPath.startsWith('identity/')) continue;
    const eff = effectiveImportance(mem.meta);
    if (eff < minImportance) {
      toPrune.push({
        id: mem.meta.id,
        path: mem.relPath,
        effective_importance: Math.round(eff * 1000) / 1000,
        original_importance: mem.meta.importance,
        age_days: Math.round((Date.now() - new Date(mem.meta.created).getTime()) / (1000 * 60 * 60 * 24)),
      });
    }
  }

  if (!dryRun) {
    for (const item of toPrune) {
      const fullPath = join(mDir, item.path);
      await unlink(fullPath);
    }
  }

  return {
    action: dryRun ? 'dry-run' : 'pruned',
    count: toPrune.length,
    items: toPrune,
  };
}

/**
 * Merge: find near-duplicate conversation memories and combine them.
 * Uses FAISS embeddings to find pairs above similarity threshold,
 * then keeps the higher-importance one and appends info from the other.
 */
async function merge(slug, { similarity = 0.85, dryRun = false } = {}) {
  const mDir = memoriesDir(slug);
  const pDir = personaDir(slug);
  const memories = await collectMemories(mDir);

  // Only merge within conversations/ category (user-generated ephemeral memories)
  const convMemories = memories.filter(m => m.relPath.startsWith('conversations/'));
  if (convMemories.length < 2) {
    return { action: 'skip', reason: 'fewer than 2 conversation memories', count: 0 };
  }

  // Use FAISS to find similar pairs
  let pairScores;
  try {
    const flatPath = join(pDir, 'index_flat.faiss');
    const metaPath = join(pDir, 'index_meta.json');
    const { readFile } = await import('fs/promises');
    const metas = JSON.parse(await readFile(metaPath, 'utf-8'));

    // Build id → index map
    const idToIdx = {};
    for (let i = 0; i < metas.length; i++) {
      idToIdx[metas[i].id] = i;
    }

    // Get all pairwise similarities for conversation memories using Python
    const convIds = convMemories.map(m => m.meta.id).filter(id => id in idToIdx);
    if (convIds.length < 2) {
      return { action: 'skip', reason: 'not enough indexed conversation memories', count: 0 };
    }

    const { stdout } = await execFileAsync('python3', ['-c', `
import faiss, json, numpy as np, sys
index = faiss.read_index("${flatPath}")
metas = json.load(open("${metaPath}"))
id_to_idx = {m["id"]: i for i, m in enumerate(metas)}
conv_ids = json.loads('${JSON.stringify(convIds)}')
idxs = [id_to_idx[cid] for cid in conv_ids if cid in id_to_idx]
embs = np.array([index.reconstruct(i) for i in idxs], dtype="float32")
sims = embs @ embs.T
pairs = []
for i in range(len(idxs)):
    for j in range(i+1, len(idxs)):
        if sims[i][j] >= ${similarity}:
            pairs.append({"a": conv_ids[i], "b": conv_ids[j], "sim": float(sims[i][j])})
print(json.dumps(pairs))
`], { timeout: 30000 });
    pairScores = JSON.parse(stdout);
  } catch (err) {
    return { action: 'error', reason: err.message, count: 0 };
  }

  if (!pairScores.length) {
    return { action: 'none', reason: 'no similar pairs found', count: 0, threshold: similarity };
  }

  // Merge pairs: keep higher-importance, append summary from lower
  const merged = [];
  const deleted = new Set();

  const memById = {};
  for (const m of convMemories) memById[m.meta.id] = m;

  for (const pair of pairScores) {
    if (deleted.has(pair.a) || deleted.has(pair.b)) continue;
    const memA = memById[pair.a];
    const memB = memById[pair.b];
    if (!memA || !memB) continue;

    const impA = memA.meta.importance || 0.5;
    const impB = memB.meta.importance || 0.5;
    const [keep, drop] = impA >= impB ? [memA, memB] : [memB, memA];

    if (!dryRun) {
      // Append dropped memory's content to kept memory
      const mergedBody = keep.body + '\n\n（合并自相似记忆）' + drop.body;
      // Boost importance slightly for merged memories
      keep.meta.importance = Math.min((keep.meta.importance || 0.5) + 0.05, 1.0);
      keep.meta.updated = new Date().toISOString();
      // Merge tags
      const allTags = new Set([...(keep.meta.tags || []), ...(drop.meta.tags || [])]);
      keep.meta.tags = [...allTags];
      await writeMemory(keep.filePath, keep.meta, mergedBody);
      await unlink(drop.filePath);
    }

    deleted.add(drop.meta.id);
    merged.push({
      kept: keep.meta.id,
      dropped: drop.meta.id,
      similarity: Math.round(pair.sim * 1000) / 1000,
    });
  }

  return {
    action: dryRun ? 'dry-run' : 'merged',
    count: merged.length,
    pairs: merged,
  };
}

export { stats, prune, merge, effectiveImportance };

// CLI
if (process.argv[1] && process.argv[1].endsWith('memory-consolidator.mjs')) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log(`Usage:
  node memory-consolidator.mjs stats <slug>
  node memory-consolidator.mjs prune <slug> [--min-importance 0.1] [--dry-run]
  node memory-consolidator.mjs merge <slug> [--similarity 0.85] [--dry-run]`);
    process.exit(1);
  }

  const cmd = args[0];
  const slug = args[1];
  const dryRun = args.includes('--dry-run');

  let minImportance = 0.1;
  let similarityThreshold = 0.85;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--min-importance' && args[i + 1]) minImportance = parseFloat(args[++i]);
    if (args[i] === '--similarity' && args[i + 1]) similarityThreshold = parseFloat(args[++i]);
  }

  const run = async () => {
    if (cmd === 'stats') return stats(slug);
    if (cmd === 'prune') return prune(slug, { minImportance, dryRun });
    if (cmd === 'merge') return merge(slug, { similarity: similarityThreshold, dryRun });
    throw new Error(`Unknown command: ${cmd}`);
  };

  run().then(r => console.log(JSON.stringify(r, null, 2))).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}
