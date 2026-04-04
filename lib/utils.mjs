import { join, basename, extname } from 'path';
import { readdir, stat } from 'fs/promises';

/**
 * Generate a slug from a name string.
 * "张三" → "张三", "John Doe" → "john-doe"
 */
export function slugify(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fff-]/g, '');
}

/**
 * Generate a memory ID from category, topic, and optional index.
 * e.g., memoryId("experiences", "summer-trip", 1) → "exp-summer-trip-001"
 */
export function memoryId(category, topic, index = 1) {
  const prefixMap = {
    identity: 'id',
    relationships: 'rel',
    experiences: 'exp',
    knowledge: 'know',
    opinions: 'opin',
    habits: 'hab',
    conversations: 'conv',
  };
  const prefix = prefixMap[category] || category.slice(0, 4);
  const slug = topic.replace(/\s+/g, '-').toLowerCase();
  return `${prefix}-${slug}-${String(index).padStart(3, '0')}`;
}

/**
 * Recursively scan a directory, returning file paths grouped by extension.
 */
export async function scanDataFolder(dirPath) {
  const result = { text: [], json: [], csv: [], image: [], other: [] };
  const textExts = new Set(['.txt', '.md', '.log', '.rst', '.docx', '.pdf', '.doc', '.rtf']);
  const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const ext = extname(entry.name).toLowerCase();
        if (textExts.has(ext)) result.text.push(fullPath);
        else if (ext === '.json') result.json.push(fullPath);
        else if (ext === '.csv') result.csv.push(fullPath);
        else if (imageExts.has(ext)) result.image.push(fullPath);
        else result.other.push(fullPath);
      }
    }
  }

  await walk(dirPath);
  return result;
}

/**
 * Estimate token count for a string (rough: ~1.5 chars per token for Chinese, ~4 for English).
 */
export function estimateTokens(text) {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

/**
 * Truncate text to approximately maxTokens.
 */
export function truncateToTokens(text, maxTokens) {
  const estimated = estimateTokens(text);
  if (estimated <= maxTokens) return text;
  const ratio = maxTokens / estimated;
  const cutAt = Math.floor(text.length * ratio);
  return text.slice(0, cutAt) + '\n...[truncated]';
}

/**
 * Memory category folders.
 */
export const MEMORY_CATEGORIES = [
  'identity',
  'relationships',
  'experiences',
  'knowledge',
  'opinions',
  'habits',
  'conversations',
];

/**
 * Get the base directory for a persona's data.
 */
export function personaDir(slug) {
  const home = process.env.HOME || process.env.USERPROFILE;
  return join(home, '.claude', 'distill_me', slug);
}

/**
 * Get the memories directory for a persona.
 */
export function memoriesDir(slug) {
  return join(personaDir(slug), 'memories');
}
