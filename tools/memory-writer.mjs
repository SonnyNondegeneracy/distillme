#!/usr/bin/env node
/**
 * memory-writer.mjs
 *
 * Creates memory files in the hierarchical folder structure.
 * Handles ID generation, deduplication, and directory creation.
 *
 * Usage (as module):
 *   import { createMemory, updateMemory } from './memory-writer.mjs';
 *
 * Usage (CLI):
 *   node memory-writer.mjs <persona-slug> <category> <topic> --body "..." [--type episodic] [--importance 0.8] [--tags tag1,tag2]
 */

import { mkdir, readdir, readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { readMemory, writeMemory } from '../lib/memory-format.mjs';
import { memoryId, memoriesDir, personaDir, MEMORY_CATEGORIES } from '../lib/utils.mjs';

/**
 * Create a new memory file.
 *
 * @param {string} slug - Persona slug
 * @param {Object} options
 * @param {string} options.category - One of MEMORY_CATEGORIES
 * @param {string} options.topic - Short topic slug (e.g., "summer-trip")
 * @param {string} options.body - Memory content (markdown)
 * @param {string} [options.type='semantic'] - episodic | semantic | procedural | emotional
 * @param {number} [options.importance=0.5] - 0-1
 * @param {number} [options.decay=0.95] - Daily decay factor
 * @param {string[]} [options.tags=[]] - Tags
 * @param {string} [options.source=''] - Source file path
 * @param {Array} [options.links=[]] - Array of { id, relation, strength }
 * @param {string} [options.subcategory=''] - Optional subfolder (e.g., "family" under relationships)
 * @returns {Object} { id, filePath }
 */
export async function createMemory(slug, options) {
  const {
    category,
    topic,
    body,
    type = 'semantic',
    importance = 0.5,
    halflife = null,   // optional: override default 365-day halflife
    tags = [],
    source = '',
    links = [],
    subcategory = '',
  } = options;

  if (!MEMORY_CATEGORIES.includes(category)) {
    throw new Error(`Invalid category: ${category}. Must be one of: ${MEMORY_CATEGORIES.join(', ')}`);
  }

  // Determine target directory
  let targetDir = join(memoriesDir(slug), category);
  if (subcategory) {
    targetDir = join(targetDir, subcategory);
  }
  await mkdir(targetDir, { recursive: true });

  // Find next available index for this topic
  let index = 1;
  try {
    const existing = await readdir(targetDir);
    const topicSlug = topic.replace(/\s+/g, '-').toLowerCase();
    const matching = existing.filter(f => f.includes(topicSlug));
    index = matching.length + 1;
  } catch {
    // Directory may not exist yet
  }

  const id = memoryId(category, topic, index);
  const fileName = `${topic.replace(/\s+/g, '-').toLowerCase()}.md`;
  const filePath = join(targetDir, fileName);

  const meta = {
    id,
    type,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    importance,
    ...(halflife && { halflife }),
    tags,
    ...(source && { source }),
    ...(links.length > 0 && { links }),
  };

  await writeMemory(filePath, meta, body);
  return { id, filePath };
}

/**
 * Batch create memories from an array of memory specs.
 */
export async function createMemories(slug, memorySpecs) {
  const results = [];
  for (const spec of memorySpecs) {
    const result = await createMemory(slug, spec);
    results.push(result);
  }
  return results;
}

/**
 * Resolve a memory ID to its file path using index_meta.json.
 * Falls back to scanning memory files if index doesn't exist.
 */
export async function resolveMemoryPath(slug, targetId) {
  const pDir = personaDir(slug);
  const metaPath = join(pDir, 'index_meta.json');
  try {
    const metas = JSON.parse(await readFile(metaPath, 'utf-8'));
    const entry = metas.find(m => m.id === targetId);
    if (entry && entry.abs_path) return entry.abs_path;
  } catch {
    // No index, fall through to scan
  }
  // Scan memory files
  return scanForMemory(memoriesDir(slug), targetId);
}

async function scanForMemory(dir, targetId) {
  const { readdir: rd } = await import('fs/promises');
  const entries = await rd(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await scanForMemory(fullPath, targetId);
      if (found) return found;
    } else if (entry.name.endsWith('.md')) {
      try {
        const { meta } = await readMemory(fullPath);
        if (meta.id === targetId) return fullPath;
      } catch { /* skip */ }
    }
  }
  return null;
}

/**
 * Edit an existing memory by ID.
 *
 * @param {string} slug - Persona slug
 * @param {string} targetId - Memory ID (e.g., "exp-summer-trip-001")
 * @param {Object} updates - Fields to update
 * @param {string} [updates.body] - New body text (replaces entirely)
 * @param {number} [updates.importance] - New importance
 * @param {string[]} [updates.tags] - New tags (replaces entirely)
 * @param {string} [updates.type] - New type
 * @returns {Object} { id, filePath, updated: true }
 */
export async function editMemory(slug, targetId, updates) {
  const filePath = await resolveMemoryPath(slug, targetId);
  if (!filePath) throw new Error(`Memory not found: ${targetId}`);

  const { meta, body } = await readMemory(filePath);
  const newBody = updates.body !== undefined ? updates.body : body;
  if (updates.importance !== undefined) meta.importance = updates.importance;
  if (updates.tags !== undefined) meta.tags = updates.tags;
  if (updates.type !== undefined) meta.type = updates.type;
  meta.updated = new Date().toISOString();

  await writeMemory(filePath, meta, newBody);
  return { id: targetId, filePath, updated: true };
}

/**
 * Delete a memory by ID.
 *
 * @param {string} slug - Persona slug
 * @param {string} targetId - Memory ID
 * @returns {Object} { id, filePath, deleted: true }
 */
export async function deleteMemory(slug, targetId) {
  const filePath = await resolveMemoryPath(slug, targetId);
  if (!filePath) throw new Error(`Memory not found: ${targetId}`);

  await unlink(filePath);
  return { id: targetId, filePath, deleted: true };
}

// CLI mode
if (process.argv[1] && process.argv[1].endsWith('memory-writer.mjs')) {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.log('Usage: node memory-writer.mjs <slug> <category> <topic> --body "..." [--type episodic] [--importance 0.8] [--tags tag1,tag2]');
    process.exit(1);
  }

  const slug = args[0];
  const category = args[1];
  const topic = args[2];

  const options = { category, topic, body: '' };
  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--body' && args[i + 1]) options.body = args[++i];
    if (args[i] === '--type' && args[i + 1]) options.type = args[++i];
    if (args[i] === '--importance' && args[i + 1]) options.importance = parseFloat(args[++i]);
    if (args[i] === '--tags' && args[i + 1]) options.tags = args[++i].split(',');
    if (args[i] === '--source' && args[i + 1]) options.source = args[++i];
  }

  createMemory(slug, options).then(result => {
    console.log(JSON.stringify(result, null, 2));
  }).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
