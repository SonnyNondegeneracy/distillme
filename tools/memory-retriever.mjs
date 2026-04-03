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
 * Extract meaningful keywords from a query string.
 * For Chinese: extract 3+ char substrings from CJK runs (2-char is too noisy).
 * For non-Chinese: extract words of 3+ characters.
 * Returns an array of keyword strings, longest first.
 */
function extractKeywords(query) {
  const keywords = [];
  // CJK character runs of length >= 2
  const cjkRuns = query.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g) || [];
  for (const run of cjkRuns) {
    // Keep full run
    keywords.push(run);
    // Extract 3-char and 4-char subsequences (skip 2-char, too noisy)
    if (run.length > 4) {
      for (let len = 3; len <= Math.min(4, run.length); len++) {
        for (let i = 0; i <= run.length - len; i++) {
          keywords.push(run.slice(i, i + len));
        }
      }
    }
  }
  // Non-CJK words (English, etc.) — 3+ chars to avoid noise
  const words = query.toLowerCase().match(/[a-zA-Z]{3,}/g) || [];
  keywords.push(...words);
  // Deduplicate, longest first (longer = more specific = more valuable)
  return [...new Set(keywords)].sort((a, b) => b.length - a.length);
}

/**
 * Keyword search across all indexed memories via index_meta.json.
 * Runs in parallel with FAISS — ensures keyword-matching memories
 * are always in the candidate pool even if embedding similarity is low.
 *
 * @param {string} slug - Persona slug
 * @param {string} query - User query
 * @param {number} maxResults - Max keyword hits to return
 * @returns {Array} Memories with keyword_hits count
 */
async function keywordSearch(slug, query, maxResults = 20) {
  const pDir = personaDir(slug);
  const metaPath = join(pDir, 'index_meta.json');

  let metas;
  try {
    metas = JSON.parse(await readFile(metaPath, 'utf-8'));
  } catch {
    return [];
  }

  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  const scored = [];
  for (const m of metas) {
    const text = (m.body_preview || '') + ' ' + (m.tags || []).join(' ') + ' ' + (m.id || '');
    let hits = 0;
    let longestMatch = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) {
        hits++;
        longestMatch = Math.max(longestMatch, kw.length);
      }
    }
    if (hits > 0) {
      scored.push({ ...m, keyword_hits: hits, longest_keyword: longestMatch });
    }
  }

  // Sort by longest match first (prefer exact term hits), then by hit count
  scored.sort((a, b) => b.longest_keyword - a.longest_keyword || b.keyword_hits - a.keyword_hits);
  return scored.slice(0, maxResults);
}

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
  // Normalize importance: some memories use 0-10 scale, some use 0-1
  const rawImportance = candidate.importance || 0.5;
  const importance = rawImportance > 1 ? rawImportance / 10 : rawImportance;

  // Keyword overlap — works for both Chinese (substring) and English (word)
  // Longer keyword matches are weighted more (a 4-char match is worth more than a 3-char)
  const keywords = extractKeywords(query);
  const searchText = (candidate.body_preview || '') + ' ' + (candidate.tags || []).join(' ');
  let keywordScore = 0;
  let totalWeight = 0;
  for (const kw of keywords) {
    const weight = kw.length; // longer keywords matter more
    totalWeight += weight;
    if (searchText.includes(kw)) keywordScore += weight;
  }
  const bm25Score = totalWeight > 0 ? Math.min(keywordScore / totalWeight, 1.0) : 0;

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
 * Softmax-weighted sampling without replacement.
 * Used to inject controlled randomness into retrieval —
 * same query won't always return the exact same set.
 */
function weightedSample(candidates, n, temperature = 0.8) {
  if (candidates.length <= n) return candidates;
  const scores = candidates.map(c => c.final_score / temperature);
  const maxScore = Math.max(...scores);
  const exps = scores.map(s => Math.exp(s - maxScore));
  const sumExp = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map(e => e / sumExp);

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

  // Step 1: FAISS query + keyword search in parallel
  let faissResults = [];
  let kwResults = [];

  const [faissOutcome, kwOutcome] = await Promise.allSettled([
    execFileAsync('python3', [
      EMBEDDER_PATH, 'query', pDir, query, '--top-k', String(faissK),
    ], { timeout: 60000 }).then(r => JSON.parse(r.stdout)),
    keywordSearch(slug, query, 20),
  ]);

  if (faissOutcome.status === 'fulfilled') faissResults = faissOutcome.value;
  if (kwOutcome.status === 'fulfilled') kwResults = kwOutcome.value;

  if (!faissResults.length && !kwResults.length) return [];

  // Merge: FAISS results + keyword-only hits (avoid duplicates)
  const seenIds = new Set(faissResults.map(c => c.id));
  const candidates = [...faissResults];
  for (const kw of kwResults) {
    if (!seenIds.has(kw.id)) {
      // Keyword-matched but not in FAISS top-50 — inject with a baseline embedding score
      kw.embedding_score = kw.embedding_score || 0.3;
      candidates.push(kw);
      seenIds.add(kw.id);
    }
  }

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

  // Step 4: Deterministic top-3 + weighted random sampling for the rest
  // Ensures high-confidence memories always appear, while adding
  // associative randomness — like how human recall works.
  candidates.sort((a, b) => b.final_score - a.final_score);
  const guaranteed = candidates.slice(0, 3);
  const pool = candidates.slice(3, topK * 3); // wider pool for sampling
  const sampledRest = weightedSample(pool, topK - 3, 0.8);
  const topResults = [...guaranteed, ...sampledRest];

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
