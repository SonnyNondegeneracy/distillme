#!/usr/bin/env node
/**
 * memory-walker.mjs
 *
 * Follows link chains from seed memories to retrieve related context.
 * Uses the in-memory graph to BFS-walk and return linked memories
 * within a token budget.
 *
 * Usage:
 *   node memory-walker.mjs <slug> --seeds "id1,id2,id3" [--max-nodes 5] [--min-strength 0.15] [--token-budget 2000]
 */

import { readdir, readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { readMemory } from '../lib/memory-format.mjs';
import { MemoryGraph } from '../lib/graph.mjs';
import { memoriesDir, personaDir, estimateTokens } from '../lib/utils.mjs';

/**
 * Softmax-weighted sampling without replacement.
 * Converts scores to probabilities via softmax(score/temperature),
 * then samples n items. This injects controlled randomness into
 * memory walks — like how human association is semi-logical.
 */
function weightedSample(candidates, n, temperature = 0.7) {
  if (candidates.length <= n) return candidates;

  // Softmax
  const scores = candidates.map(c => c.score / temperature);
  const maxScore = Math.max(...scores);
  const exps = scores.map(s => Math.exp(s - maxScore)); // numerically stable
  const sumExp = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map(e => e / sumExp);

  // Weighted sampling without replacement
  const sampled = [];
  const remaining = candidates.map((c, i) => ({ item: c, prob: probs[i] }));

  for (let k = 0; k < n && remaining.length > 0; k++) {
    const totalProb = remaining.reduce((s, r) => s + r.prob, 0);
    let r = Math.random() * totalProb;
    let idx = 0;
    for (let i = 0; i < remaining.length; i++) {
      r -= remaining[i].prob;
      if (r <= 0) { idx = i; break; }
    }
    sampled.push(remaining[idx].item);
    remaining.splice(idx, 1);
  }

  return sampled;
}

/**
 * Load graph from the pre-built cache (O(1) single file read).
 * Falls back to scanning all .md files only if cache is stale or missing.
 */
async function loadGraph(slug) {
  const pDir = personaDir(slug);
  const cachePath = join(pDir, 'graph_cache.json');
  const mDir = memoriesDir(slug);

  // Try loading from cache
  try {
    const cacheStat = await stat(cachePath);
    const cacheData = JSON.parse(await readFile(cachePath, 'utf-8'));
    // Cache is valid — rebuild graph from serialized data
    const graph = new MemoryGraph();
    for (const node of cacheData.nodes) {
      graph.addNode(node.id, node.meta, node.body, node.filePath);
    }
    for (const edge of cacheData.edges) {
      graph.addEdge(edge.source, edge.target, edge.relation, edge.strength);
    }
    return graph;
  } catch {
    // Cache miss — fall through to full scan
  }

  // Full scan (only on cache miss)
  const memories = [];
  async function walkDir(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(fullPath);
      } else if (entry.name.endsWith('.md')) {
        try {
          const mem = await readMemory(fullPath);
          mem.filePath = fullPath;
          memories.push(mem);
        } catch {
          // Skip
        }
      }
    }
  }
  await walkDir(mDir);

  const graph = MemoryGraph.fromMemories(memories);

  // Write cache for next time
  await saveGraphCache(slug, graph);

  return graph;
}

/**
 * Serialize and save graph cache (called after build/update operations).
 */
export async function saveGraphCache(slug, graph) {
  const pDir = personaDir(slug);
  const cachePath = join(pDir, 'graph_cache.json');

  const nodes = [];
  for (const [id, data] of graph.nodes) {
    nodes.push({
      id,
      meta: data.meta,
      body: data.body,
      filePath: data.filePath,
    });
  }

  const edges = [];
  for (const [sourceId, edgeList] of graph.edges) {
    for (const e of edgeList) {
      edges.push({
        source: sourceId,
        target: e.targetId,
        relation: e.relation,
        strength: e.strength,
      });
    }
  }

  await writeFile(cachePath, JSON.stringify({ nodes, edges }, null, 0), 'utf-8');
}

/**
 * Walk from seed memories along links, with depth and node count scaling as log(n).
 *
 * Walk depth = ceil(log2(n)), ensuring all memories are reachable in principle.
 * Max nodes returned = ceil(log2(n)), so total injected memories scale logarithmically.
 *
 * @param {string} slug - Persona slug
 * @param {string[]} seedIds - Starting memory IDs
 * @param {Map<string, number>} seedScores - Score for each seed
 * @param {Object} options
 * @param {number} [options.totalMemories] - Total memory count (for log scaling)
 * @param {number} [options.maxNodes] - Override max walked nodes (default: log2(n))
 * @param {number} [options.maxDepth] - Override walk depth (default: log2(n))
 * @param {number} [options.minStrength=0.15] - Minimum edge strength
 * @param {number} [options.tokenBudget=2000] - Token budget for walked memories
 * @returns {Array} Additional memories found via walking
 */
export async function walkMemories(slug, seedIds, seedScores, options = {}) {
  const graph = await loadGraph(slug);
  if (graph.size === 0) return [];

  // Scale with log2(n): depth and node count both ~ log(n)
  const n = options.totalMemories || graph.size;
  const logN = Math.max(3, Math.ceil(Math.log2(n)));  // floor at 3 for small n

  const {
    maxNodes = logN,
    maxDepth = logN,
    minStrength = 0.15,
    tokenBudget = 2000,
  } = options;

  const walked = graph.walk(seedIds, seedScores, { maxDepth, maxNodes: maxNodes * 3, minStrength });

  // Softmax-weighted sampling instead of deterministic top-N
  const sampled = weightedSample(walked, maxNodes * 2, 0.7);

  // Apply token budget
  let usedTokens = 0;
  const result = [];
  for (const node of sampled) {
    const tokens = estimateTokens(node.body);
    if (usedTokens + tokens > tokenBudget) break;
    usedTokens += tokens;
    result.push({
      id: node.id,
      score: node.score,
      from_id: node.fromId,
      relation: node.relation,
      depth: node.depth,
      category: node.meta.type || 'semantic',
      importance: node.meta.importance || 0.5,
      body: node.body,
      source: 'chain-walk',
    });
    if (result.length >= maxNodes) break;
  }

  return result;
}

/**
 * Format walked memories as XML for prompt injection.
 */
export function formatWalkedMemories(memories) {
  return memories.map(m =>
    `<memory id="${m.id}" category="${m.category}" importance="${m.importance}" type="walked" source="chain-walk" linked-from="${m.from_id}">\n${m.body}\n</memory>`
  ).join('\n\n');
}

// CLI mode
if (process.argv[1] && process.argv[1].endsWith('memory-walker.mjs')) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log('Usage: node memory-walker.mjs <slug> --seeds "id1,id2" [--max-nodes 5] [--min-strength 0.15] [--token-budget 2000]');
    process.exit(1);
  }

  const slug = args[0];
  let seedIds = [];
  let maxNodes = 5;
  let minStrength = 0.15;
  let tokenBudget = 2000;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--seeds' && args[i + 1]) seedIds = args[++i].split(',');
    if (args[i] === '--max-nodes' && args[i + 1]) maxNodes = parseInt(args[++i]);
    if (args[i] === '--min-strength' && args[i + 1]) minStrength = parseFloat(args[++i]);
    if (args[i] === '--token-budget' && args[i + 1]) tokenBudget = parseInt(args[++i]);
  }

  const seedScores = new Map(seedIds.map(id => [id, 0.8]));

  walkMemories(slug, seedIds, seedScores, { maxNodes, minStrength, tokenBudget }).then(results => {
    console.log(JSON.stringify(results, null, 2));
  }).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
