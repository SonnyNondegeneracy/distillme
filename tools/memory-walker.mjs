#!/usr/bin/env node
/**
 * memory-walker.mjs
 *
 * Follows link chains from seed memories to retrieve related context.
 * Uses the in-memory graph to BFS-walk and return linked memories
 * within a token budget.
 *
 * Usage:
 *   node memory-walker.mjs <slug> --seeds "id1,id2,id3" [--max-nodes 5] [--min-strength 0.3] [--token-budget 800]
 */

import { readdir, readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { readMemory } from '../lib/memory-format.mjs';
import { MemoryGraph } from '../lib/graph.mjs';
import { memoriesDir, personaDir, estimateTokens } from '../lib/utils.mjs';

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
 * Walk from seed memories along links, respecting token budget.
 *
 * @param {string} slug - Persona slug
 * @param {string[]} seedIds - Starting memory IDs
 * @param {Map<string, number>} seedScores - Score for each seed
 * @param {Object} options
 * @returns {Array} Additional memories found via walking
 */
export async function walkMemories(slug, seedIds, seedScores, options = {}) {
  const {
    maxNodes = 5,
    minStrength = 0.3,
    tokenBudget = 800,
  } = options;

  const graph = await loadGraph(slug);

  if (graph.size === 0) return [];

  const walked = graph.walk(seedIds, seedScores, { maxNodes: maxNodes * 2, minStrength });

  // Apply token budget
  let usedTokens = 0;
  const result = [];
  for (const node of walked) {
    const tokens = estimateTokens(node.body);
    if (usedTokens + tokens > tokenBudget) break;
    usedTokens += tokens;
    result.push({
      id: node.id,
      score: node.score,
      from_id: node.fromId,
      relation: node.relation,
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
    console.log('Usage: node memory-walker.mjs <slug> --seeds "id1,id2" [--max-nodes 5] [--min-strength 0.3] [--token-budget 800]');
    process.exit(1);
  }

  const slug = args[0];
  let seedIds = [];
  let maxNodes = 5;
  let minStrength = 0.3;
  let tokenBudget = 800;

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
