#!/usr/bin/env node
/**
 * session-manager.mjs
 *
 * Manages conversation state: memory injection, history tracking,
 * new memory extraction from AI responses, and training data logging.
 *
 * Usage:
 *   node session-manager.mjs compose <slug> "<user-message>" [--phase start|middle|deep]
 *   node session-manager.mjs follow-link <slug> "<memory-id>"          # LLMlink: follow a memory link
 *   node session-manager.mjs update-links <slug> "<memory-id>" --add/--remove  # LLMlink: edit links
 *   node session-manager.mjs extract <slug> "<ai-response>"            # Parse <new-memory> tags from response
 *   node session-manager.mjs save-memory <slug> "<category>" "<topic>" "<body>" [--importance 0.6] [--tags "t1,t2"]
 *   node session-manager.mjs log-feedback <slug> "<retrieved-ids>" "<used-ids>"
 *   node session-manager.mjs rebuild-index <slug>                       # Rebuild FAISS after new memories
 */

import { readFile, writeFile, appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { personaDir, memoriesDir } from '../lib/utils.mjs';
import { retrieveMemories } from './memory-retriever.mjs';
import { walkMemories, formatWalkedMemories, saveGraphCache } from './memory-walker.mjs';
import { createMemory } from './memory-writer.mjs';
import { readMemory, writeMemory, addLink, removeLink } from '../lib/memory-format.mjs';
import { queryIndex, invalidateCache } from '../model/embed-client.mjs';

const execFileAsync = promisify(execFile);
const EMBEDDER_PATH = new URL('../model/embedder.py', import.meta.url).pathname;
const COLD_START_PATH = new URL('../model/cold_start.py', import.meta.url).pathname;

const DEDUP_SIMILARITY_THRESHOLD = 0.75;

/**
 * Check if a similar memory already exists by querying FAISS index.
 * Returns { match: true, path, score, meta, body } or { match: false }.
 */
async function findDuplicate(slug, bodyText) {
  const pDir = personaDir(slug);
  try {
    const results = await queryIndex(pDir, bodyText, 1);
    if (results.length > 0 && results[0].embedding_score > DEDUP_SIMILARITY_THRESHOLD) {
      const hit = results[0];
      const existing = await readMemory(hit.abs_path || hit.path);
      return { match: true, path: hit.abs_path || hit.path, score: hit.embedding_score, ...existing };
    }
  } catch {
    // Index doesn't exist yet or query failed — no dedup, proceed with create
  }
  return { match: false };
}

/**
 * Merge new memory content into an existing memory file.
 * Combines body text, takes max importance, unions tags.
 */
async function mergeIntoExisting(existingPath, existingMeta, existingBody, newBody, newImportance, newTags) {
  // Combine body: keep existing + append new (deduplicated summary)
  const mergedBody = existingBody + '\n\n' + newBody;
  // Take the higher importance
  const mergedImportance = Math.max(existingMeta.importance || 0, newImportance);
  // Union tags
  const existingTags = existingMeta.tags || [];
  const mergedTags = [...new Set([...existingTags, ...newTags])];

  const updatedMeta = {
    ...existingMeta,
    importance: mergedImportance,
    tags: mergedTags,
    updated: new Date().toISOString(),
  };

  await writeMemory(existingPath, updatedMeta, mergedBody);
  return { id: existingMeta.id, filePath: existingPath, merged: true };
}

/**
 * Compose the memory-injected prompt for a conversation turn.
 *
 * @param {string} slug - Persona slug
 * @param {string} userMessage - Current user message
 * @param {Object} options
 * @returns {Object} { memories_xml, retrieved_ids, walked_ids }
 */
export async function composeMemoryContext(slug, userMessage, options = {}) {
  const { phase = 'middle' } = options;
  let user = options.user || 'user';

  // Resolve user: explicit --user > config.default_user > "user"
  if (user === 'user') {
    try {
      const config = JSON.parse(await readFile(join(personaDir(slug), 'config.json'), 'utf-8'));
      if (config.default_user) user = config.default_user;
    } catch { /* no config */ }
  }

  // Load user profile if available
  let userContext = '';
  if (user !== 'user') {
    try {
      const config = JSON.parse(await readFile(join(personaDir(slug), 'config.json'), 'utf-8'));
      const userInfo = (config.users || []).find(u => u.id === user);
      if (userInfo) {
        userContext = `<user id="${user}" name="${userInfo.name || user}"${userInfo.relation ? ` relation="${userInfo.relation}"` : ''}${userInfo.notes ? ` notes="${userInfo.notes}"` : ''} />`;
      }
    } catch { /* no config or no users */ }
  }

  // Step 1: Retrieve seed memories (top similarity)
  // If user is known, prepend their name to query for better relationship memory retrieval
  const queryText = user !== 'user' ? `[${user}] ${userMessage}` : userMessage;
  const retrieved = await retrieveMemories(slug, queryText, { phase });
  const totalMemories = retrieved._totalMemories || retrieved.length;

  // Step 2: Format retrieved memories as XML
  const seedIds = retrieved.map(m => m.id);

  // Format seed memories as XML (body already contains [[id]] cross-refs)
  const retrievedXml = retrieved.map(m => {
    const category = (m.abs_path || '').split('/memories/')[1]?.split('/')[0] || m.type || 'semantic';
    return `<memory id="${m.id}" category="${category}" importance="${m.importance || 0.5}" score="${m.final_score?.toFixed(3) || '0'}">\n${m.full_body || m.body_preview}\n</memory>`;
  }).join('\n\n');

  // Step 3: LLMlink priority — count [[id]] refs in seed bodies.
  // If seeds have enough cross-refs for the LLM to explore, skip heuristic walk.
  // Otherwise, BFS fills the gap up to the expected walked count.
  const n = totalMemories || seedIds.length;
  const expectedWalked = Math.max(3, Math.ceil(Math.log2(n)));

  // Count unique [[id]] refs across all seed bodies (excluding self-refs)
  const refPattern = /\[\[([^\]]+)\]\]/g;
  const seedIdSet = new Set(seedIds);
  const refIds = new Set();
  for (const m of retrieved) {
    const body = m.full_body || m.body_preview || '';
    for (const match of body.matchAll(refPattern)) {
      const refId = match[1];
      if (!seedIdSet.has(refId)) refIds.add(refId);
    }
  }

  let walkedXml = '';
  let walkedIds = [];

  if (refIds.size < expectedWalked) {
    // Not enough links for LLM to explore — heuristic BFS supplements the gap
    const deficit = expectedWalked - refIds.size;
    const seedScores = new Map(retrieved.map(m => [m.id, m.final_score || 0.5]));
    const walked = await walkMemories(slug, seedIds, seedScores, {
      totalMemories,
      maxNodes: deficit,
    });
    walkedXml = formatWalkedMemories(walked);
    walkedIds = walked.map(w => w.id);
  }

  // Combine
  const allXml = [userContext, retrievedXml, walkedXml].filter(Boolean).join('\n\n');

  return {
    memories_xml: allXml,
    retrieved_ids: seedIds,
    walked_ids: walkedIds,
    total_memories: retrieved.length + walkedIds.length,
    available_refs: refIds.size,
    user,
  };
}

/**
 * Save a new memory generated from conversation.
 * Automatically deduplicates: if a similar memory exists (cosine > 0.85),
 * merges into the existing one instead of creating a new file.
 */
export async function saveConversationMemory(slug, category, topic, body, options = {}) {
  const { importance = 0.6, tags = [] } = options;

  // Dedup: check across ALL categories via FAISS index
  const dup = await findDuplicate(slug, body);
  if (dup.match) {
    const result = await mergeIntoExisting(
      dup.path, dup.meta, dup.body,
      body, importance, tags
    );
    return { ...result, dedup_score: dup.score };
  }

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

  // Step 3: Invalidate graph cache and daemon cache
  try {
    const { unlink } = await import('fs/promises');
    await unlink(join(pDir, 'graph_cache.json'));
  } catch {
    // Cache didn't exist, fine
  }
  await invalidateCache(pDir);

  return { index: indexResult, links: linksResult };
}

/**
 * LLMlink: Follow a memory link by ID — returns the memory's content + its outgoing links.
 * Used by the LLM during conversation to traverse the memory graph interactively.
 */
export async function followMemoryLink(slug, memoryId) {
  const metaPath = join(personaDir(slug), 'index_meta.json');
  let metas;
  try {
    metas = JSON.parse(await readFile(metaPath, 'utf-8'));
  } catch {
    return { error: 'No index_meta.json found. Run rebuild-index first.' };
  }

  const entry = metas.find(m => m.id === memoryId);
  if (!entry) {
    return { error: `Memory "${memoryId}" not found` };
  }

  try {
    const { meta, body } = await readMemory(entry.abs_path);
    const category = entry.path?.split('/')[0] || meta.type || 'unknown';
    return {
      id: memoryId,
      category,
      importance: meta.importance ?? 0.5,
      body,
    };
  } catch (err) {
    return { error: `Failed to read memory: ${err.message}` };
  }
}

/**
 * LLMlink: Update links on a memory — add or remove up to 3 links per call.
 * Adds support two modes:
 *   - Endnote (default): appends "note [[id]]" to the <!-- refs --> block
 *   - Inline: inserts "[[id]]" after a specified anchor text in the body
 *
 * @param {string} slug - Persona slug
 * @param {string} memoryId - Source memory ID
 * @param {Array} adds - Links to add: [{id, relation, strength, note?, anchor?}]
 *   - note: endnote context (e.g. "也喜欢甜食"), appended to refs block
 *   - anchor: text to insert [[id]] after (inline mode)
 *   - if neither, bare [[id]] appended to refs block
 * @param {Array} removes - Link IDs to remove: [id, ...]
 */
export async function updateMemoryLinks(slug, memoryId, adds = [], removes = []) {
  // Enforce max 3 operations per call
  const totalOps = adds.length + removes.length;
  if (totalOps > 3) {
    return { error: `Max 3 link operations per call (got ${totalOps})` };
  }

  const metaPath = join(personaDir(slug), 'index_meta.json');
  let metas;
  try {
    metas = JSON.parse(await readFile(metaPath, 'utf-8'));
  } catch {
    return { error: 'No index_meta.json found' };
  }

  const entry = metas.find(m => m.id === memoryId);
  if (!entry) return { error: `Memory "${memoryId}" not found` };

  // Build id→path map for resolving paths of added links
  const idToPath = {};
  for (const m of metas) {
    if (m.id && m.path) idToPath[m.id] = m.path;
  }

  try {
    const { meta, body } = await readMemory(entry.abs_path);
    let updatedBody = body;
    const marker = '<!-- refs -->';

    // Remove links (from meta and from body — strip entire line containing [[id]])
    const removed = [];
    for (const rid of removes) {
      if (removeLink(meta, rid)) {
        removed.push(rid);
        const escaped = rid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Remove line containing [[id]] in refs block, or inline [[id]]
        updatedBody = updatedBody
          .replace(new RegExp(`^.*\\[\\[${escaped}\\]\\].*$`, 'gm'), '')
          .replace(/\n{3,}/g, '\n\n');
      }
    }

    // Add links
    const added = [];
    for (const add of adds) {
      if (!add.id) continue;
      const path = add.path || idToPath[add.id] || null;
      addLink(meta, add.id, add.relation || 'related', add.strength ?? 0.5, path);
      added.push(add.id);

      // Skip if ref already in body
      if (updatedBody.includes(`[[${add.id}]]`)) continue;

      if (add.anchor) {
        // Inline mode: insert [[id]] after anchor text
        const anchorIdx = updatedBody.indexOf(add.anchor);
        if (anchorIdx >= 0) {
          const insertAt = anchorIdx + add.anchor.length;
          updatedBody = updatedBody.slice(0, insertAt) + `[[${add.id}]]` + updatedBody.slice(insertAt);
        }
      } else {
        // Endnote mode: append to refs block
        const note = add.note || '';
        const refLine = note ? `${note} [[${add.id}]]` : `另见 [[${add.id}]]`;
        if (updatedBody.includes(marker)) {
          updatedBody = updatedBody.trimEnd() + '\n' + refLine;
        } else {
          updatedBody = updatedBody.trimEnd() + `\n\n${marker}\n${refLine}`;
        }
      }
    }

    meta.updated = new Date().toISOString();
    await writeMemory(entry.abs_path, meta, updatedBody);

    return { ok: true, added, removed, total_links: (meta.links || []).length };
  } catch (err) {
    return { error: `Failed to update links: ${err.message}` };
  }
}

// CLI mode
if (process.argv[1] && process.argv[1].endsWith('session-manager.mjs')) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log(`Usage:
  node session-manager.mjs compose <slug> "<message>" [--phase start|middle|deep] [--user <id>]
  node session-manager.mjs follow-link <slug> "<memory-id>"
  node session-manager.mjs update-links <slug> "<memory-id>" --add '[...]' --remove '[...]'
  node session-manager.mjs extract <slug> "<ai-response>"
  node session-manager.mjs save-memory <slug> "<category>" "<topic>" "<body>" [--importance 0.6]
  node session-manager.mjs rebuild-index <slug>`);
    process.exit(1);
  }

  const cmd = args[0];

  if (cmd === 'compose') {
    const slug = args[1];
    const message = args[2];
    let phase = 'middle';
    let user = 'user';
    for (let i = 3; i < args.length; i++) {
      if (args[i] === '--phase' && args[i + 1]) phase = args[++i];
      if (args[i] === '--user' && args[i + 1]) user = args[++i];
    }
    composeMemoryContext(slug, message, { phase, user }).then(r => {
      console.log(JSON.stringify(r, null, 2));
    }).catch(e => {
      console.error(e.message);
      process.exit(1);
    });

  } else if (cmd === 'follow-link') {
    const slug = args[1];
    const memoryId = args[2];
    if (!slug || !memoryId) {
      console.error('Usage: node session-manager.mjs follow-link <slug> "<memory-id>"');
      process.exit(1);
    }
    followMemoryLink(slug, memoryId).then(r => {
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

  } else if (cmd === 'update-links') {
    const slug = args[1];
    const memoryId = args[2];
    if (!slug || !memoryId) {
      console.error('Usage: node session-manager.mjs update-links <slug> "<memory-id>" --add \'[{"id":"x","relation":"y","strength":0.5,"description":"..."}]\' --remove \'["id1"]\' ');
      process.exit(1);
    }
    let adds = [], removes = [];
    for (let i = 3; i < args.length; i++) {
      if (args[i] === '--add' && args[i + 1]) adds = JSON.parse(args[++i]);
      if (args[i] === '--remove' && args[i + 1]) removes = JSON.parse(args[++i]);
    }
    updateMemoryLinks(slug, memoryId, adds, removes).then(r => {
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
