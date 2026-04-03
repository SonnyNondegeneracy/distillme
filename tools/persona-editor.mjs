#!/usr/bin/env node
/**
 * persona-editor.mjs
 *
 * Unified CLI for editing persona data (profile + memories) with automatic
 * cascade updates (FAISS rebuild, SKILL.md regeneration, daemon cache invalidation).
 *
 * Usage:
 *   node persona-editor.mjs profile get <slug> [--path "field.path"]
 *   node persona-editor.mjs profile set <slug> --path "field.path" --value <value>
 *   node persona-editor.mjs profile set <slug> --json '{"deep": "merge"}'
 *   node persona-editor.mjs profile add-facet <slug> <key> --json '{"label":"...", ...}'
 *   node persona-editor.mjs profile remove-facet <slug> <key>
 *
 *   node persona-editor.mjs memory add <slug> <category> <topic> --body "..." [--importance 0.7] [--tags "t1,t2"] [--type episodic]
 *   node persona-editor.mjs memory edit <slug> <memory-id> [--body "..."] [--importance 0.8] [--tags "t1,t2"]
 *   node persona-editor.mjs memory delete <slug> <memory-id>
 *   node persona-editor.mjs memory list <slug> [--category identity] [--sort importance|created]
 *   node persona-editor.mjs memory show <slug> <memory-id>
 *
 *   node persona-editor.mjs sync <slug>
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { personaDir } from '../lib/utils.mjs';
import { readMemory } from '../lib/memory-format.mjs';
import { createMemory, editMemory, deleteMemory, resolveMemoryPath } from './memory-writer.mjs';
import { rebuildIndex } from './session-manager.mjs';

const execFileAsync = promisify(execFile);
const GENERATOR_PATH = new URL('./persona-generator.mjs', import.meta.url).pathname;

// ─── Helpers ───

function getByPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

function setByPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] === undefined) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
        && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

function parseValue(str) {
  // Try JSON parse for numbers, booleans, arrays, objects
  try { return JSON.parse(str); } catch { return str; }
}

async function readProfile(slug) {
  const path = join(personaDir(slug), 'profile.json');
  return JSON.parse(await readFile(path, 'utf-8'));
}

async function writeProfile(slug, profile) {
  const path = join(personaDir(slug), 'profile.json');
  await writeFile(path, JSON.stringify(profile, null, 2) + '\n', 'utf-8');
}

// ─── Profile Commands ───

async function profileGet(slug, fieldPath) {
  const profile = await readProfile(slug);
  const result = fieldPath ? getByPath(profile, fieldPath) : profile;
  if (result === undefined) {
    console.error(`Field not found: ${fieldPath}`);
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}

async function profileSet(slug, { path: fieldPath, value, json: jsonStr }) {
  const profile = await readProfile(slug);

  if (jsonStr) {
    const patch = JSON.parse(jsonStr);
    deepMerge(profile, patch);
  } else if (fieldPath && value !== undefined) {
    setByPath(profile, fieldPath, parseValue(value));
  } else {
    console.error('Must provide --path + --value, or --json');
    process.exit(1);
  }

  await writeProfile(slug, profile);
  await syncProfile(slug);
  console.log(JSON.stringify({ status: 'ok', action: 'profile-set' }));
}

async function profileAddFacet(slug, key, jsonStr) {
  if (!jsonStr) { console.error('Must provide --json with facet definition'); process.exit(1); }
  const profile = await readProfile(slug);
  if (!profile.facets) profile.facets = {};
  profile.facets[key] = JSON.parse(jsonStr);
  await writeProfile(slug, profile);
  await syncProfile(slug);
  console.log(JSON.stringify({ status: 'ok', action: 'add-facet', key }));
}

async function profileRemoveFacet(slug, key) {
  const profile = await readProfile(slug);
  if (!profile.facets?.[key]) { console.error(`Facet not found: ${key}`); process.exit(1); }
  delete profile.facets[key];
  await writeProfile(slug, profile);
  await syncProfile(slug);
  console.log(JSON.stringify({ status: 'ok', action: 'remove-facet', key }));
}

// ─── Memory Commands ───

async function memoryAdd(slug, category, topic, opts) {
  const result = await createMemory(slug, {
    category,
    topic,
    body: opts.body || '',
    type: opts.type || 'semantic',
    importance: opts.importance ?? 0.5,
    tags: opts.tags || [],
  });
  await syncMemories(slug);
  console.log(JSON.stringify({ ...result, status: 'ok', action: 'memory-add' }));
}

async function memoryEdit(slug, memoryId, opts) {
  const updates = {};
  if (opts.body !== undefined) updates.body = opts.body;
  if (opts.importance !== undefined) updates.importance = opts.importance;
  if (opts.tags !== undefined) updates.tags = opts.tags;
  if (opts.type !== undefined) updates.type = opts.type;

  const result = await editMemory(slug, memoryId, updates);
  await syncMemories(slug);
  console.log(JSON.stringify({ ...result, status: 'ok', action: 'memory-edit' }));
}

async function memoryDelete(slug, memoryId) {
  const result = await deleteMemory(slug, memoryId);
  await syncMemories(slug);
  console.log(JSON.stringify({ ...result, status: 'ok', action: 'memory-delete' }));
}

async function memoryList(slug, { category, sort = 'importance' }) {
  const pDir = personaDir(slug);
  const metaPath = join(pDir, 'index_meta.json');
  let metas;
  try {
    metas = JSON.parse(await readFile(metaPath, 'utf-8'));
  } catch {
    console.error('No index found. Run: node persona-editor.mjs sync ' + slug);
    process.exit(1);
  }

  if (category) {
    metas = metas.filter(m => {
      const cat = (m.abs_path || m.path || '').split('/memories/')[1]?.split('/')[0];
      return cat === category;
    });
  }

  if (sort === 'importance') {
    metas.sort((a, b) => (b.importance || 0) - (a.importance || 0));
  } else if (sort === 'created') {
    metas.sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
  }

  const listing = metas.map(m => ({
    id: m.id,
    importance: m.importance,
    tags: m.tags || [],
    preview: (m.body_preview || '').slice(0, 80),
    created: m.created,
  }));

  console.log(JSON.stringify({ count: listing.length, memories: listing }, null, 2));
}

async function memoryShow(slug, memoryId) {
  const filePath = await resolveMemoryPath(slug, memoryId);
  if (!filePath) { console.error(`Memory not found: ${memoryId}`); process.exit(1); }
  const { meta, body } = await readMemory(filePath);
  console.log(JSON.stringify({ id: meta.id, ...meta, body, filePath }, null, 2));
}

// ─── User Commands ───

async function loadConfig(slug) {
  const path = join(personaDir(slug), 'config.json');
  return JSON.parse(await readFile(path, 'utf-8'));
}

async function saveConfig(slug, config) {
  const path = join(personaDir(slug), 'config.json');
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

async function userAdd(slug, id, opts) {
  const config = await loadConfig(slug);
  if (!config.users) config.users = [];
  const existing = config.users.find(u => u.id === id);
  if (existing) {
    // Update
    if (opts.name !== undefined) existing.name = opts.name;
    if (opts.relation !== undefined) existing.relation = opts.relation;
    if (opts.notes !== undefined) existing.notes = opts.notes;
  } else {
    config.users.push({
      id,
      name: opts.name || id,
      relation: opts.relation || '',
      notes: opts.notes || '',
      added: new Date().toISOString(),
    });
  }
  // First registered user becomes default if none set
  if (!config.default_user) config.default_user = id;
  await saveConfig(slug, config);
  console.log(JSON.stringify({ status: 'ok', action: 'user-add', id, is_default: config.default_user === id }));
}

async function userList(slug) {
  const config = await loadConfig(slug);
  const users = config.users || [];
  console.log(JSON.stringify({ count: users.length, default_user: config.default_user || 'user', users }, null, 2));
}

async function userRemove(slug, id) {
  const config = await loadConfig(slug);
  if (!config.users) config.users = [];
  const idx = config.users.findIndex(u => u.id === id);
  if (idx < 0) { console.error(`User not found: ${id}`); process.exit(1); }
  config.users.splice(idx, 1);
  if (config.default_user === id) delete config.default_user;
  await saveConfig(slug, config);
  console.log(JSON.stringify({ status: 'ok', action: 'user-remove', id }));
}

async function userSetDefault(slug, id) {
  const config = await loadConfig(slug);
  if (id === 'none') {
    delete config.default_user;
  } else {
    const exists = (config.users || []).find(u => u.id === id);
    if (!exists) { console.error(`User not found: ${id}. Add it first.`); process.exit(1); }
    config.default_user = id;
  }
  await saveConfig(slug, config);
  console.log(JSON.stringify({ status: 'ok', action: 'user-set-default', default_user: config.default_user || 'user' }));
}

// ─── Sync (Cascade Updates) ───

async function syncMemories(slug) {
  console.error('[sync] Rebuilding FAISS index + links + invalidating cache...');
  try {
    const result = await rebuildIndex(slug);
    const idxMsg = result.index?.count || result.index?.error || 'done';
    const linkMsg = result.links?.links_written != null ? result.links.links_written : (result.links?.error || 'done');
    console.error(`[sync] Index: ${idxMsg}, Links: ${linkMsg}`);
  } catch (err) {
    console.error(`[sync] Warning: ${err.message}`);
  }
}

async function syncProfile(slug) {
  console.error('[sync] Regenerating SKILL.md + identity files...');
  try {
    const { stdout } = await execFileAsync('node', [GENERATOR_PATH, slug], { timeout: 30000 });
    const result = JSON.parse(stdout);
    console.error(`[sync] SKILL.md written: ${result.skill_path}`);
    if (result.identity_files?.length) {
      console.error(`[sync] Identity files: ${result.identity_files.length}`);
    }
  } catch (err) {
    console.error(`[sync] Warning: ${err.message}`);
  }
}

async function syncAll(slug) {
  await syncMemories(slug);
  await syncProfile(slug);
  console.log(JSON.stringify({ status: 'ok', action: 'sync' }));
}

// ─── CLI Parser ───

const args = process.argv.slice(2);
if (args.length < 1) {
  console.log(`Usage:
  node persona-editor.mjs profile get <slug> [--path "field.path"]
  node persona-editor.mjs profile set <slug> --path "field" --value <val>
  node persona-editor.mjs profile set <slug> --json '{"key": "val"}'
  node persona-editor.mjs profile add-facet <slug> <key> --json '{...}'
  node persona-editor.mjs profile remove-facet <slug> <key>

  node persona-editor.mjs memory add <slug> <category> <topic> --body "..." [--importance 0.7] [--tags "t1,t2"] [--type episodic]
  node persona-editor.mjs memory edit <slug> <memory-id> [--body "..."] [--importance 0.8] [--tags "t1,t2"]
  node persona-editor.mjs memory delete <slug> <memory-id>
  node persona-editor.mjs memory list <slug> [--category identity] [--sort importance|created]
  node persona-editor.mjs memory show <slug> <memory-id>

  node persona-editor.mjs user add <slug> <id> [--name "显示名"] [--relation "关系"] [--notes "备注"]
  node persona-editor.mjs user list <slug>
  node persona-editor.mjs user remove <slug> <id>
  node persona-editor.mjs user set-default <slug> <id|none>

  node persona-editor.mjs sync <slug>`);
  process.exit(1);
}

function getFlag(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
}

const cmd = args[0];

try {
  if (cmd === 'profile') {
    const sub = args[1];
    const slug = args[2];
    if (!slug) { console.error('Missing slug'); process.exit(1); }

    if (sub === 'get') {
      await profileGet(slug, getFlag('--path'));
    } else if (sub === 'set') {
      await profileSet(slug, { path: getFlag('--path'), value: getFlag('--value'), json: getFlag('--json') });
    } else if (sub === 'add-facet') {
      await profileAddFacet(slug, args[3], getFlag('--json'));
    } else if (sub === 'remove-facet') {
      await profileRemoveFacet(slug, args[3]);
    } else {
      console.error(`Unknown profile subcommand: ${sub}`);
      process.exit(1);
    }

  } else if (cmd === 'memory') {
    const sub = args[1];
    const slug = args[2];
    if (!slug) { console.error('Missing slug'); process.exit(1); }

    if (sub === 'add') {
      const category = args[3];
      const topic = args[4];
      if (!category || !topic) { console.error('Missing category or topic'); process.exit(1); }
      await memoryAdd(slug, category, topic, {
        body: getFlag('--body'),
        type: getFlag('--type'),
        importance: getFlag('--importance') ? parseFloat(getFlag('--importance')) : undefined,
        tags: getFlag('--tags')?.split(',').map(t => t.trim()),
      });
    } else if (sub === 'edit') {
      const memId = args[3];
      if (!memId) { console.error('Missing memory-id'); process.exit(1); }
      await memoryEdit(slug, memId, {
        body: getFlag('--body'),
        type: getFlag('--type'),
        importance: getFlag('--importance') ? parseFloat(getFlag('--importance')) : undefined,
        tags: getFlag('--tags')?.split(',').map(t => t.trim()),
      });
    } else if (sub === 'delete') {
      const memId = args[3];
      if (!memId) { console.error('Missing memory-id'); process.exit(1); }
      await memoryDelete(slug, memId);
    } else if (sub === 'list') {
      await memoryList(slug, { category: getFlag('--category'), sort: getFlag('--sort') });
    } else if (sub === 'show') {
      const memId = args[3];
      if (!memId) { console.error('Missing memory-id'); process.exit(1); }
      await memoryShow(slug, memId);
    } else {
      console.error(`Unknown memory subcommand: ${sub}`);
      process.exit(1);
    }

  } else if (cmd === 'user') {
    const sub = args[1];
    const slug = args[2];
    if (!slug) { console.error('Missing slug'); process.exit(1); }

    if (sub === 'add') {
      const id = args[3];
      if (!id) { console.error('Missing user id'); process.exit(1); }
      await userAdd(slug, id, {
        name: getFlag('--name'),
        relation: getFlag('--relation'),
        notes: getFlag('--notes'),
      });
    } else if (sub === 'list') {
      await userList(slug);
    } else if (sub === 'remove') {
      const id = args[3];
      if (!id) { console.error('Missing user id'); process.exit(1); }
      await userRemove(slug, id);
    } else if (sub === 'set-default') {
      const id = args[3];
      if (!id) { console.error('Missing user id (or "none")'); process.exit(1); }
      await userSetDefault(slug, id);
    } else {
      console.error(`Unknown user subcommand: ${sub}`);
      process.exit(1);
    }

  } else if (cmd === 'sync') {
    const slug = args[1];
    if (!slug) { console.error('Missing slug'); process.exit(1); }
    await syncAll(slug);

  } else {
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
