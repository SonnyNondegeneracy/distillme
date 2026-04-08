#!/usr/bin/env node
/**
 * generate-titles.mjs
 *
 * Batch-generate short titles for memories that lack a `title` field.
 * Uses Claude API to summarize each memory body into a ≤15 char Chinese title.
 *
 * Usage:
 *   node tools/generate-titles.mjs <slug> [--dry-run] [--limit N]
 */

import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { memoriesDir } from '../lib/utils.mjs';
import { readMemory, writeMemory } from '../lib/memory-format.mjs';

const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;

async function callClaude(bodies) {
  // Batch: send multiple memories in one call for efficiency
  const prompt = bodies.map((b, i) =>
    `[${i}] ${b.slice(0, 300)}`
  ).join('\n\n');

  const resp = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `为以下每条记忆生成一个简短标题（≤15个中文字符），用于记忆图谱的交叉引用。标题要概括核心内容，像文章标题一样。

格式：每行一个，[序号] 标题

${prompt}`
      }],
    }),
  });

  if (!resp.ok) {
    throw new Error(`API error: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json();
  const text = data.content[0].text;

  // Parse "[0] title" lines
  const titles = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\[(\d+)\]\s*(.+)/);
    if (m) {
      titles[parseInt(m[1])] = m[2].trim();
    }
  }
  return titles;
}

async function walkDir(dir) {
  const files = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...await walkDir(p));
    } else if (e.name.endsWith('.md')) {
      files.push(p);
    }
  }
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log('Usage: node tools/generate-titles.mjs <slug> [--dry-run] [--limit N]');
    process.exit(1);
  }

  const slug = args[0];
  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : Infinity;

  if (!ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  const mDir = memoriesDir(slug);
  const files = await walkDir(mDir);

  // Find memories without titles
  const needsTitle = [];
  for (const f of files) {
    try {
      const { meta, body } = await readMemory(f);
      if (!meta.title && meta.id && body.trim()) {
        // Strip refs block from body for cleaner summarization
        let cleanBody = body;
        const refsIdx = cleanBody.indexOf('<!-- refs -->');
        if (refsIdx >= 0) cleanBody = cleanBody.slice(0, refsIdx).trim();
        needsTitle.push({ path: f, meta, body: cleanBody, fullBody: body });
      }
    } catch { /* skip */ }
  }

  console.log(`Found ${needsTitle.length} memories without titles (limit: ${limit === Infinity ? 'none' : limit})`);
  const toProcess = needsTitle.slice(0, limit);

  // Process in batches of 20
  const BATCH = 20;
  let generated = 0;

  for (let i = 0; i < toProcess.length; i += BATCH) {
    const batch = toProcess.slice(i, i + BATCH);
    const bodies = batch.map(m => m.body);

    try {
      const titles = await callClaude(bodies);

      for (let j = 0; j < batch.length; j++) {
        const title = titles[j];
        if (!title) continue;

        const mem = batch[j];
        if (dryRun) {
          console.log(`  ${mem.meta.id}: "${title}"`);
        } else {
          mem.meta.title = title;
          await writeMemory(mem.path, mem.meta, mem.fullBody);
          console.log(`  ${mem.meta.id}: "${title}"`);
        }
        generated++;
      }
    } catch (err) {
      console.error(`Batch ${i}-${i + BATCH} failed:`, err.message);
    }

    // Rate limit
    if (i + BATCH < toProcess.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\n${dryRun ? 'Would generate' : 'Generated'} ${generated} titles`);
  if (!dryRun && generated > 0) {
    console.log('Run `python3 model/embedder.py build` and `python3 model/cold_start.py generate-links` to update index');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
