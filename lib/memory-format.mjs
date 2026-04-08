import { readFile, writeFile } from 'fs/promises';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const parseYaml = yaml.load;
const stringifyYaml = yaml.dump;

/**
 * Parse a memory file (YAML frontmatter + Markdown body).
 * Returns { meta: {...}, body: string }
 */
export function parseMemoryFile(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    return { meta: {}, body: content.trim() };
  }
  const meta = parseYaml(fmMatch[1]);
  const body = fmMatch[2].trim();
  return { meta, body };
}

/**
 * Serialize a memory object back to file content.
 */
export function serializeMemoryFile(meta, body) {
  const yamlStr = stringifyYaml(meta, { lineWidth: -1 }).trim();
  return `---\n${yamlStr}\n---\n\n${body}\n`;
}

/**
 * Read and parse a memory file from disk.
 */
export async function readMemory(filePath) {
  const content = await readFile(filePath, 'utf-8');
  const { meta, body } = parseMemoryFile(content);
  meta._filePath = filePath;
  return { meta, body };
}

/**
 * Write a memory file to disk.
 */
export async function writeMemory(filePath, meta, body) {
  const { _filePath, ...cleanMeta } = meta;
  const content = serializeMemoryFile(cleanMeta, body);
  await writeFile(filePath, content, 'utf-8');
}

/**
 * Extract all link IDs from a memory's meta.
 */
export function getLinkedIds(meta) {
  if (!meta.links || !Array.isArray(meta.links)) return [];
  return meta.links.map(l => ({
    id: l.id, relation: l.relation, strength: l.strength ?? 0.5,
    path: l.path || null,
  }));
}

/**
 * Add a link to a memory's meta (deduplicates by id).
 */
export function addLink(meta, targetId, relation, strength = 0.5, path = null) {
  if (!meta.links) meta.links = [];
  const existing = meta.links.find(l => l.id === targetId);
  if (existing) {
    existing.relation = relation;
    existing.strength = strength;
    if (path) existing.path = path;
  } else {
    const link = { id: targetId, relation, strength };
    if (path) link.path = path;
    meta.links.push(link);
  }
}

/**
 * Remove a link from a memory's meta by target ID.
 */
export function removeLink(meta, targetId) {
  if (!meta.links) return false;
  const idx = meta.links.findIndex(l => l.id === targetId);
  if (idx >= 0) {
    meta.links.splice(idx, 1);
    return true;
  }
  return false;
}
