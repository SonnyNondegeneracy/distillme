#!/usr/bin/env node
/**
 * session-manager.mjs
 *
 * Manages conversation state: memory injection, history tracking,
 * new memory extraction from AI responses, and training data logging.
 *
 * Usage:
 *   node session-manager.mjs compose <slug> "<user-message>" [--phase start|middle|deep]
 *   node session-manager.mjs extract <slug> "<ai-response>"        # Parse <new-memory> tags from response
 *   node session-manager.mjs save-memory <slug> "<category>" "<topic>" "<body>" [--importance 0.6] [--tags "t1,t2"]
 *   node session-manager.mjs log-feedback <slug> "<retrieved-ids>" "<used-ids>"
 *   node session-manager.mjs rebuild-index <slug>                   # Rebuild FAISS after new memories
 */

import { readFile, writeFile, appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { personaDir, memoriesDir } from '../lib/utils.mjs';
import { retrieveMemories } from './memory-retriever.mjs';
import { walkMemories, formatWalkedMemories, saveGraphCache } from './memory-walker.mjs';
import { createMemory } from './memory-writer.mjs';

const execFileAsync = promisify(execFile);
const EMBEDDER_PATH = new URL('../model/embedder.py', import.meta.url).pathname;
const COLD_START_PATH = new URL('../model/cold_start.py', import.meta.url).pathname;

/**
 * Compose the memory-injected prompt for a conversation turn.
 *
 * @param {string} slug - Persona slug
 * @param {string} userMessage - Current user message
 * @param {Object} options
 * @returns {Object} { memories_xml, retrieved_ids, walked_ids }
 */
export async function composeMemoryContext(slug, userMessage, options = {}) {
  const { phase = 'middle', topK = 8, walkMaxNodes = 5, walkTokenBudget = 800 } = options;

  // Step 1: Retrieve top memories
  const retrieved = await retrieveMemories(slug, userMessage, { topK, phase });

  // Step 2: Format retrieved memories as XML
  const retrievedXml = retrieved.map(m =>
    `<memory id="${m.id}" category="${(m.abs_path || '').split('/memories/')[1]?.split('/')[0] || m.type || 'semantic'}" importance="${m.importance || 0.5}" score="${m.final_score?.toFixed(3) || '0'}">\n${m.full_body || m.body_preview}\n</memory>`
  ).join('\n\n');

  // Step 3: Walk links from retrieved memories
  const seedIds = retrieved.map(m => m.id);
  const seedScores = new Map(retrieved.map(m => [m.id, m.final_score || 0.5]));
  const walked = await walkMemories(slug, seedIds, seedScores, {
    maxNodes: walkMaxNodes,
    tokenBudget: walkTokenBudget,
  });
  const walkedXml = formatWalkedMemories(walked);

  // Combine
  const allXml = [retrievedXml, walkedXml].filter(Boolean).join('\n\n');

  return {
    memories_xml: allXml,
    retrieved_ids: seedIds,
    walked_ids: walked.map(w => w.id),
    total_memories: retrieved.length + walked.length,
  };
}

/**
 * Save a new memory generated from conversation.
 */
export async function saveConversationMemory(slug, category, topic, body, options = {}) {
  const { importance = 0.6, tags = [] } = options;
  return createMemory(slug, {
    category: category || 'conversations',
    topic,
    body,
    type: 'episodic',
    importance,
    tags,
    source: 'conversation',
  });
}

/**
 * Log retrieval feedback for online training.
 */
export async function logFeedback(slug, retrievedIds, usedIds, context = '') {
  const pDir = personaDir(slug);
  const logPath = join(pDir, 'logs', 'training_log.jsonl');

  const entry = {
    timestamp: new Date().toISOString(),
    context_preview: context.slice(0, 200),
    retrieved_ids: retrievedIds,
    used_ids: usedIds,
    // Positive: retrieved AND used; Negative: retrieved but NOT used
    positive: usedIds,
    negative: retrievedIds.filter(id => !usedIds.includes(id)),
  };

  await mkdir(join(pDir, 'logs'), { recursive: true });
  await appendFile(logPath, JSON.stringify(entry) + '\n', 'utf-8');
  return entry;
}

/**
 * Parse <new-memory> tags from an AI response and save them.
 *
 * Expected format in AI response:
 *   <new-memory category="conversations" topic="topic-slug" importance="0.6" tags="tag1,tag2">
 *   Memory content here
 *   </new-memory>
 *
 * @param {string} slug - Persona slug
 * @param {string} responseText - Full AI response text
 * @returns {Object} { saved: [...], count: N }
 */
export async function extractMemoriesFromResponse(slug, responseText) {
  const memoryPattern = /<new-memory\s+([^>]+)>([\s\S]*?)<\/new-memory>/g;
  const saved = [];
  let match;

  while ((match = memoryPattern.exec(responseText)) !== null) {
    const attrsStr = match[1];
    const body = match[2].trim();
    if (!body) continue;

    // Parse attributes
    const attrs = {};
    const attrPattern = /(\w[\w-]*)="([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(attrsStr)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }

    const category = attrs.category || 'conversations';
    const topic = attrs.topic || `conv-${Date.now()}`;
    const importance = parseFloat(attrs.importance) || 0.6;
    const tags = attrs.tags ? attrs.tags.split(',').map(t => t.trim()) : [];

    try {
      const result = await saveConversationMemory(slug, category, topic, body, {
        importance,
        tags,
      });
      saved.push({ ...result, category, topic, importance });
    } catch (err) {
      console.error(`Failed to save memory "${topic}":`, err.message);
    }
  }

  return { saved, count: saved.length };
}

/**
 * Rebuild FAISS index and graph cache after new memories are added.
 * Should be called after extractMemoriesFromResponse or manual memory additions.
 *
 * @param {string} slug - Persona slug
 * @returns {Object} { index_status, links_status }
 */
export async function rebuildIndex(slug) {
  const pDir = personaDir(slug);
  const mDir = memoriesDir(slug);

  // Step 1: Rebuild FAISS index
  let indexResult;
  try {
    const { stdout } = await execFileAsync('python3', [
      EMBEDDER_PATH, 'build', mDir, pDir
    ], { timeout: 120000 });
    indexResult = JSON.parse(stdout);
  } catch (err) {
    indexResult = { error: err.message };
  }

  // Step 2: Regenerate links
  let linksResult;
  try {
    const { stdout } = await execFileAsync('python3', [
      COLD_START_PATH, 'generate-links', pDir
    ], { timeout: 60000 });
    linksResult = JSON.parse(stdout);
  } catch (err) {
    linksResult = { error: err.message };
  }

  // Step 3: Invalidate graph cache (force rebuild on next walk)
  try {
    const { unlink } = await import('fs/promises');
    await unlink(join(pDir, 'graph_cache.json'));
  } catch {
    // Cache didn't exist, fine
  }

  return { index: indexResult, links: linksResult };
}

// CLI mode
if (process.argv[1] && process.argv[1].endsWith('session-manager.mjs')) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log(`Usage:
  node session-manager.mjs compose <slug> "<message>" [--phase start|middle|deep]
  node session-manager.mjs extract <slug> "<ai-response>"
  node session-manager.mjs save-memory <slug> "<category>" "<topic>" "<body>" [--importance 0.6]
  node session-manager.mjs log-feedback <slug> "<retrieved>" "<used>"
  node session-manager.mjs rebuild-index <slug>`);
    process.exit(1);
  }

  const cmd = args[0];

  if (cmd === 'compose') {
    const slug = args[1];
    const message = args[2];
    let phase = 'middle';
    for (let i = 3; i < args.length; i++) {
      if (args[i] === '--phase' && args[i + 1]) phase = args[++i];
    }
    composeMemoryContext(slug, message, { phase }).then(r => {
      console.log(JSON.stringify(r, null, 2));
    }).catch(e => {
      console.error(e.message);
      process.exit(1);
    });

  } else if (cmd === 'save-memory') {
    const [, slug, category, topic, body] = args;
    let importance = 0.6;
    let tags = [];
    for (let i = 5; i < args.length; i++) {
      if (args[i] === '--importance' && args[i + 1]) importance = parseFloat(args[++i]);
      if (args[i] === '--tags' && args[i + 1]) tags = args[++i].split(',');
    }
    saveConversationMemory(slug, category, topic, body, { importance, tags }).then(r => {
      console.log(JSON.stringify(r, null, 2));
    }).catch(e => {
      console.error(e.message);
      process.exit(1);
    });

  } else if (cmd === 'log-feedback') {
    const [, slug, retrieved, used] = args;
    logFeedback(slug, retrieved.split(','), used.split(','), '').then(r => {
      console.log(JSON.stringify(r, null, 2));
    }).catch(e => {
      console.error(e.message);
      process.exit(1);
    });

  } else if (cmd === 'extract') {
    const slug = args[1];
    const responseText = args[2];
    if (!slug || !responseText) {
      console.error('Usage: node session-manager.mjs extract <slug> "<ai-response>"');
      process.exit(1);
    }
    extractMemoriesFromResponse(slug, responseText).then(r => {
      console.log(JSON.stringify(r, null, 2));
    }).catch(e => {
      console.error(e.message);
      process.exit(1);
    });

  } else if (cmd === 'rebuild-index') {
    const slug = args[1];
    if (!slug) {
      console.error('Usage: node session-manager.mjs rebuild-index <slug>');
      process.exit(1);
    }
    rebuildIndex(slug).then(r => {
      console.log(JSON.stringify(r, null, 2));
    }).catch(e => {
      console.error(e.message);
      process.exit(1);
    });
  }
}
