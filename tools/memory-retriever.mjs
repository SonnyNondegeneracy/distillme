#!/usr/bin/env node
/**
 * memory-retriever.mjs
 *
 * Retrieval pipeline: FAISS embedding search + heuristic scoring + optional model re-ranking.
 * Returns top-K memories for a given query.
 *
 * Usage (CLI):
 *   node memory-retriever.mjs <persona-slug> "<query>" [--top-k 8] [--phase start|middle|deep]
 */

import { execFile } from 'child_process';
import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { readMemory } from '../lib/memory-format.mjs';
import { personaDir } from '../lib/utils.mjs';

const execFileAsync = promisify(execFile);
const EMBEDDER_PATH = new URL('../model/embedder.py', import.meta.url).pathname;
const LINKER_PATH = new URL('../model/linker.py', import.meta.url).pathname;

/**
 * Heuristic scoring function.
 *
 * @param {Object} candidate - From FAISS query result
 * @param {string} query - Original query text
 * @param {string} phase - Conversation phase: 'start' | 'middle' | 'deep'
 * @returns {number} Combined score
 */
function heuristicScore(candidate, query, phase = 'middle') {
  const embScore = candidate.embedding_score || 0;
  const importance = candidate.importance || 0.5;

  // BM25-like keyword overlap (simplified)
  const queryTokens = new Set(query.toLowerCase().split(/\s+/));
  const bodyTokens = (candidate.body_preview || '').toLowerCase().split(/\s+/);
  const tagTokens = (candidate.tags || []).map(t => t.toLowerCase());
  let keywordHits = 0;
  for (const token of queryTokens) {
    if (token.length < 2) continue;
    if (bodyTokens.some(bt => bt.includes(token))) keywordHits++;
    if (tagTokens.some(tt => tt.includes(token))) keywordHits += 0.5;
  }
  const bm25Score = Math.min(keywordHits / Math.max(queryTokens.size, 1), 1.0);

  // Recency score: power-law decay (long tail for old but important memories)
  let recencyScore = 0.5;
  if (candidate.created) {
    const daysSince = (Date.now() - new Date(candidate.created).getTime()) / (1000 * 60 * 60 * 24);
    recencyScore = 1 / (1 + daysSince / 365); // power-law, halflife 1 year
  }

  // Type boost based on conversation phase
  let typeBoost = 0.5;
  const memType = candidate.type || 'semantic';
  if (phase === 'start') {
    // Boost identity memories at conversation start
    typeBoost = memType === 'identity' || (candidate.path || '').startsWith('identity/') ? 1.0 : 0.3;
  } else if (phase === 'deep') {
    // Boost episodic memories when going deep
    typeBoost = memType === 'episodic' ? 0.8 : 0.5;
  }

  // Weighted combination
  return (
    0.40 * embScore +
    0.20 * bm25Score +
    0.15 * importance +
    0.10 * recencyScore +
    0.15 * typeBoost
  );
}

/**
 * Try model re-ranking via linker.py.
 * Returns null if model not available (cold start).
 */
async function modelRerank(personaPath, query, candidateIds) {
  const weightsPath = join(personaPath, 'model', 'linker_weights.pt');
  try {
    await access(weightsPath);
  } catch {
    return null; // No trained model yet
  }

  try {
    const input = JSON.stringify({ query, candidate_ids: candidateIds });
    const { stdout } = await execFileAsync('python3', [LINKER_PATH, 'rerank', personaPath], {
      input,
      timeout: 60000,
    });
    return JSON.parse(stdout);
  } catch {
    return null; // Model failed, fall back to heuristic
  }
}

/**
 * Main retrieval function.
 *
 * @param {string} slug - Persona slug
 * @param {string} query - User query
 * @param {Object} options
 * @param {number} [options.topK=8] - Number of results to return
 * @param {string} [options.phase='middle'] - Conversation phase
 * @returns {Array} Top-K memories with scores
 */
export async function retrieveMemories(slug, query, { topK = 8, phase = 'middle' } = {}) {
  const pDir = personaDir(slug);
  const faissK = 50; // Fetch more for heuristic re-scoring

  // Step 1: FAISS query
  let candidates;
  try {
    const { stdout } = await execFileAsync('python3', [
      EMBEDDER_PATH, 'query', pDir, query, '--top-k', String(faissK),
    ], { timeout: 60000 });
    candidates = JSON.parse(stdout);
  } catch (err) {
    console.error('FAISS query failed:', err.message);
    return [];
  }

  if (!candidates.length) return [];

  // Step 2: Heuristic scoring
  for (const c of candidates) {
    c.heuristic_score = heuristicScore(c, query, phase);
  }

  // Step 3: Try model re-ranking
  const modelScores = await modelRerank(pDir, query, candidates.map(c => c.id));
  if (modelScores) {
    for (const c of candidates) {
      const ms = modelScores[c.id];
      if (ms !== undefined) {
        // Blend: 60% model, 40% heuristic
        c.final_score = 0.6 * ms + 0.4 * c.heuristic_score;
      } else {
        c.final_score = c.heuristic_score;
      }
    }
  } else {
    for (const c of candidates) {
      c.final_score = c.heuristic_score;
    }
  }

  // Step 4: Sort and return top-K
  candidates.sort((a, b) => b.final_score - a.final_score);
  const topResults = candidates.slice(0, topK);

  // Step 5: Load full memory content for top results
  for (const result of topResults) {
    if (result.abs_path) {
      try {
        const mem = await readMemory(result.abs_path);
        result.full_body = mem.body;
        result.links = mem.meta.links || [];
      } catch {
        result.full_body = result.body_preview;
        result.links = [];
      }
    }
  }

  return topResults;
}

// CLI mode
if (process.argv[1] && process.argv[1].endsWith('memory-retriever.mjs')) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('Usage: node memory-retriever.mjs <slug> "<query>" [--top-k 8] [--phase start|middle|deep]');
    process.exit(1);
  }

  const slug = args[0];
  const query = args[1];
  let topK = 8;
  let phase = 'middle';
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--top-k' && args[i + 1]) topK = parseInt(args[++i]);
    if (args[i] === '--phase' && args[i + 1]) phase = args[++i];
  }

  retrieveMemories(slug, query, { topK, phase }).then(results => {
    console.log(JSON.stringify(results, null, 2));
  }).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
