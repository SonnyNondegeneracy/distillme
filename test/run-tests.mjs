#!/usr/bin/env node
/**
 * run-tests.mjs
 *
 * End-to-end test suite for DistillMe.
 * Creates a temp persona, tests all components, then cleans up.
 *
 * Usage:
 *   node test/run-tests.mjs
 */

import { execFile } from 'child_process';
import { readFile, rm, access, readdir } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { createMemory } from '../tools/memory-writer.mjs';
import { readMemory } from '../lib/memory-format.mjs';
import { personaDir, memoriesDir, MEMORY_CATEGORIES } from '../lib/utils.mjs';
import { effectiveImportance } from '../tools/memory-consolidator.mjs';

const execFileAsync = promisify(execFile);
const SLUG = '_test_distill_me_' + Date.now();
const TOOLS = new URL('../tools/', import.meta.url).pathname;
const MODEL = new URL('../model/', import.meta.url).pathname;

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, name) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \u2717 ${name}`);
  }
}

async function runNode(script, args, timeout = 120000) {
  const { stdout } = await execFileAsync('node', [join(TOOLS, script), ...args], { timeout });
  return JSON.parse(stdout);
}

async function runPython(script, args, timeout = 120000) {
  const { stdout } = await execFileAsync('python3', [join(MODEL, script), ...args], {
    timeout,
    env: { ...process.env, CUDA_VISIBLE_DEVICES: '' },
  });
  return JSON.parse(stdout);
}

async function cleanup() {
  try {
    const pDir = personaDir(SLUG);
    await rm(pDir, { recursive: true, force: true });
  } catch { /* ok */ }
}

// ─────────────── Tests ───────────────

async function testInit() {
  console.log('\n[1/8] Init directory structure');
  const result = await runNode('ingest.mjs', ['init', SLUG]);
  assert(result.persona_dir !== undefined, 'ingest init returns persona_dir');

  const mDir = memoriesDir(SLUG);
  for (const cat of MEMORY_CATEGORIES) {
    try {
      await access(join(mDir, cat));
      assert(true, `category dir exists: ${cat}`);
    } catch {
      assert(false, `category dir exists: ${cat}`);
    }
  }
}

async function testMemoryWriter() {
  console.log('\n[2/8] Memory writer');
  const m1 = await createMemory(SLUG, {
    category: 'identity',
    topic: 'core-values',
    body: '我最看重真诚和创造力。做事情追求深度而非广度。',
    type: 'semantic',
    importance: 0.95,
    tags: ['values', 'personality'],
  });
  assert(m1.id === 'id-core-values-001', `correct ID: ${m1.id}`);

  const m2 = await createMemory(SLUG, {
    category: 'relationships',
    topic: 'mom',
    body: '妈妈是小学老师，特别关心我的健康。每次打电话都会问我有没有好好吃饭。',
    type: 'emotional',
    importance: 0.85,
    tags: ['family', 'mom'],
  });
  assert(m2.id.startsWith('rel-'), `relationship ID prefix: ${m2.id}`);

  const m3 = await createMemory(SLUG, {
    category: 'experiences',
    topic: 'yunnan-trip',
    body: '2024年夏天全家去了云南旅行，在大理住了一周。洱海边的日落特别美。',
    type: 'episodic',
    importance: 0.8,
    tags: ['travel', 'family', 'yunnan'],
  });
  assert(m3.id.startsWith('exp-'), `experience ID prefix: ${m3.id}`);

  const m4 = await createMemory(SLUG, {
    category: 'knowledge',
    topic: 'physics',
    body: '我的研究方向是量子场论中的重整化群方法。',
    type: 'semantic',
    importance: 0.7,
    tags: ['physics', 'research'],
  });

  const m5 = await createMemory(SLUG, {
    category: 'opinions',
    topic: 'remote-work',
    body: '远程工作对需要深度思考的人特别好，可以避免被频繁打断。',
    type: 'semantic',
    importance: 0.5,
    tags: ['work', 'opinion'],
  });

  const m6 = await createMemory(SLUG, {
    category: 'habits',
    topic: 'morning-routine',
    body: '每天早上先泡一杯咖啡，然后看半小时arXiv新论文。',
    type: 'procedural',
    importance: 0.6,
    tags: ['routine', 'coffee'],
  });

  // Verify file can be parsed back
  const parsed = await readMemory(m1.filePath);
  assert(parsed.meta.importance === 0.95, 'parsed importance matches');
  assert(parsed.body.includes('真诚'), 'parsed body matches');

  return [m1, m2, m3, m4, m5, m6];
}

async function testMemoryFormat() {
  console.log('\n[3/8] Memory format (YAML frontmatter)');
  const mDir = memoriesDir(SLUG);
  const idPath = join(mDir, 'identity', 'core-values.md');
  const raw = await readFile(idPath, 'utf-8');
  assert(raw.startsWith('---'), 'starts with YAML delimiter');
  assert(raw.includes('importance: 0.95'), 'contains importance field');
  assert(raw.includes('tags:'), 'contains tags field');

  const parsed = await readMemory(idPath);
  assert(parsed.meta.type === 'semantic', 'type is semantic');
  assert(Array.isArray(parsed.meta.tags), 'tags is array');
}

async function testEmbedder() {
  console.log('\n[4/8] Embedder (FAISS index build + query)');
  const pDir = personaDir(SLUG);
  const mDir = memoriesDir(SLUG);

  const buildResult = await runPython('embedder.py', ['build', mDir, pDir]);
  assert(buildResult.status === 'ok', 'index build ok');
  assert(buildResult.count === 6, `indexed ${buildResult.count} memories`);
  assert(buildResult.dimension === 384, 'dimension is 384');

  // Query
  const queryResult = await runPython('embedder.py', ['query', pDir, '家人旅行', '--top-k', '3']);
  assert(Array.isArray(queryResult), 'query returns array');
  assert(queryResult.length > 0, 'query returns results');
  assert(queryResult[0].id === 'exp-yunnan-trip-001', `top result is yunnan trip: ${queryResult[0].id}`);
}

async function testColdStart() {
  console.log('\n[5/8] Cold start (links + weights)');
  const pDir = personaDir(SLUG);

  // Generate links
  const linkResult = await runPython('cold_start.py', ['generate-links', pDir]);
  assert(linkResult.status === 'ok', 'generate-links ok');
  assert(linkResult.links_added > 0, `links added: ${linkResult.links_added}`);

  // Verify links in memory files
  const mDir = memoriesDir(SLUG);
  const tripPath = join(mDir, 'experiences', 'yunnan-trip.md');
  const tripMem = await readMemory(tripPath);
  assert(Array.isArray(tripMem.meta.links), 'trip memory has links');

  // Cold start weights
  const initResult = await runPython('cold_start.py', ['init-weights']);
  assert(initResult.status === 'ok', 'init-weights ok');
  assert(initResult.total_params > 400000, `params: ${initResult.total_params}`);
}

async function testRetriever() {
  console.log('\n[6/8] Retriever (three-layer pipeline)');
  const result = await runNode('memory-retriever.mjs', [SLUG, 'family travel', '--top-k', '3']);
  assert(Array.isArray(result), 'returns array');
  assert(result.length > 0, 'returns results');
  assert(result[0].final_score !== undefined, 'has final_score');
  assert(result[0].full_body !== undefined, 'has full_body');
  assert(result[0].links !== undefined, 'has links');

  // Scores should be sorted descending
  for (let i = 1; i < result.length; i++) {
    assert(result[i].final_score <= result[i - 1].final_score, `score[${i}] <= score[${i - 1}]`);
  }
}

async function testSessionManager() {
  console.log('\n[7/8] Session manager (compose + extract + rebuild)');

  // Compose
  const composed = await runNode('session-manager.mjs', [
    'compose', SLUG, '你还记得云南之旅吗？', '--phase', 'middle',
  ]);
  assert(composed.memories_xml.includes('<memory'), 'compose produces <memory> XML');
  assert(composed.retrieved_ids.length > 0, 'has retrieved IDs');

  // Extract
  const extracted = await runNode('session-manager.mjs', [
    'extract', SLUG,
    '当然记得！<new-memory category="conversations" topic="recall-test" importance="0.55" tags="test">测试提取的记忆内容。</new-memory>',
  ]);
  assert(extracted.count === 1, 'extracted 1 memory');
  assert(extracted.saved[0].category === 'conversations', 'saved to conversations');

  // Log feedback
  const feedback = await runNode('session-manager.mjs', [
    'log-feedback', SLUG, 'exp-yunnan-trip-001,rel-mom-001', 'exp-yunnan-trip-001',
  ]);
  assert(feedback.positive.includes('exp-yunnan-trip-001'), 'positive feedback logged');
  assert(feedback.negative.includes('rel-mom-001'), 'negative feedback logged');

  // Rebuild index (includes new conversation memory)
  const rebuilt = await runNode('session-manager.mjs', ['rebuild-index', SLUG]);
  assert(rebuilt.index.count === 7, `rebuilt index has ${rebuilt.index.count} memories`);
}

async function testConsolidator() {
  console.log('\n[8/8] Consolidator (stats + prune + decay model)');

  // Stats
  const s = await runNode('memory-consolidator.mjs', ['stats', SLUG]);
  assert(s.total_memories >= 7, `total memories: ${s.total_memories}`);
  assert(s.by_category.identity === 1, 'identity count correct');

  // Prune dry-run (nothing should be pruned — all memories are fresh)
  const p = await runNode('memory-consolidator.mjs', ['prune', SLUG, '--dry-run']);
  assert(p.action === 'dry-run', 'prune dry-run');
  assert(p.count === 0, 'no fresh memories pruned');

  // Verify decay model: important memories retain value
  const highImp = effectiveImportance({ importance: 0.95, created: new Date(Date.now() - 365 * 86400000).toISOString() });
  assert(highImp > 0.88, `imp=0.95 after 1yr: ${highImp.toFixed(3)} > 0.88`);

  const lowImp = effectiveImportance({ importance: 0.2, created: new Date(Date.now() - 365 * 86400000).toISOString() });
  assert(lowImp < 0.12, `imp=0.2 after 1yr: ${lowImp.toFixed(3)} < 0.12`);

  // Identity memories: floor = 0.95^2 = 0.9025, so even after 10 years should be ~0.86+
  const longTerm = effectiveImportance({ importance: 0.95, created: new Date(Date.now() - 3650 * 86400000).toISOString() });
  assert(longTerm > 0.85, `imp=0.95 after 10yr: ${longTerm.toFixed(3)} > 0.85`);
}

// ─────────────── Runner ───────────────

async function main() {
  console.log(`\n=== DistillMe Test Suite ===`);
  console.log(`Test persona: ${SLUG}\n`);

  try {
    await testInit();
    await testMemoryWriter();
    await testMemoryFormat();
    await testEmbedder();
    await testColdStart();
    await testRetriever();
    await testSessionManager();
    await testConsolidator();
  } catch (err) {
    console.error('\nFATAL ERROR:', err.message);
    console.error(err.stack);
    failed++;
    failures.push(`FATAL: ${err.message}`);
  } finally {
    await cleanup();
  }

  console.log(`\n─────────────────────────────`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log(`Failures:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log(`─────────────────────────────\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main();
