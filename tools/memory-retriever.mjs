#!/usr/bin/env node
/**
 * memory-retriever.mjs
 *
 * Retrieval pipeline: FAISS embedding search + heuristic scoring + optional model re-ranking.
 * Returns top-K memories for a given query.
 *
 * Usage (CLI):
 *   node memory-retriever.mjs <persona-slug> "<query>" [--top-k 5] [--phase start|middle|deep]
 */

import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { readMemory } from '../lib/memory-format.mjs';
import { personaDir } from '../lib/utils.mjs';
import { queryIndex, rerankCandidates } from '../model/embed-client.mjs';

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
 * Try model re-ranking via daemon.
 * Returns null if model not available.
 */
async function modelRerank(personaPath, query, candidateIds) {
  const weightsPath = join(personaPath, 'model', 'linker_weights.pt');
  try {
    await access(weightsPath);
  } catch {
    return null; // No trained model yet
  }

  try {
    const scores = await rerankCandidates(personaPath, query, candidateIds);
    return scores && Object.keys(scores).length > 0 ? scores : null;
  } catch {
    return null; // Model failed, fall back to heuristic
  }
}

/**
 * Main retrieval function.
 *
 * Retrieval scales with memory count:
 *   - Seeds (FAISS top similarity): fixed 3-5
 *   - Walk depth: ceil(log2(n))
 *   - Total returned: ~ceil(log2(n)) + seeds
 *
 * @param {string} slug - Persona slug
 * @param {string} query - User query
 * @param {Object} options
 * @param {number} [options.seedK=5] - Number of seed memories (FAISS top similarity)
 * @param {string} [options.phase='middle'] - Conversation phase
 * @returns {Array} Memories with scores, count scales as ~log(n)
 */
export async function retrieveMemories(slug, query, { seedK = 5, topK, phase = 'middle' } = {}) {
  const pDir = personaDir(slug);
  const faissK = 50; // Fetch more for heuristic re-scoring

  // Support legacy topK parameter (treat as seedK for backwards compat)
  if (topK && !arguments[2]?.seedK) seedK = Math.min(topK, 5);

  // Step 1: FAISS query + keyword search in parallel
  let faissResults = [];
  let kwResults = [];

  const [faissOutcome, kwOutcome] = await Promise.allSettled([
    queryIndex(pDir, query, faissK),
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

  // Total memory count for log-scaling
  const totalMemories = candidates.length > 0 ? Math.max(candidates.length, faissResults.length) : 0;

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

  // Step 4: Select seeds — deterministic top by similarity
  // Seeds are the anchor points for graph walk; keep them small and high-quality
  candidates.sort((a, b) => b.final_score - a.final_score);
  const actualSeedK = Math.min(seedK, candidates.length);
  const seeds = candidates.slice(0, actualSeedK);

  // Step 5: Load full memory content for seeds
  for (const result of seeds) {
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

  // Attach totalMemories for downstream walk scaling
  seeds._totalMemories = totalMemories;

  return seeds;
}

// CLI mode
if (process.argv[1] && process.argv[1].endsWith('memory-retriever.mjs')) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('Usage: node memory-retriever.mjs <slug> "<query>" [--top-k 5] [--phase start|middle|deep]');
    process.exit(1);
  }

  const slug = args[0];
  const query = args[1];
  let topK = 5;
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
