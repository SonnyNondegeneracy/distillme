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

import { mkdir, readdir } from 'fs/promises';
import { join } from 'path';
import { writeMemory } from '../lib/memory-format.mjs';
import { memoryId, memoriesDir, MEMORY_CATEGORIES } from '../lib/utils.mjs';

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
