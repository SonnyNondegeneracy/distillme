#!/usr/bin/env node
/**
 * persona-generator.mjs
 *
 * Generates the persona SKILL.md file from profile.json and top memories.
 * This tool reads the profile and memory data, then outputs the SKILL.md content
 * that Claude will write to ~/.claude/skills/{slug}/SKILL.md.
 *
 * Usage:
 *   node persona-generator.mjs <slug>            # Generate SKILL.md content
 *   node persona-generator.mjs <slug> --summary   # Just output a summary
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { join } from 'path';
import { readMemory } from '../lib/memory-format.mjs';
import { personaDir, memoriesDir } from '../lib/utils.mjs';
import { glob } from 'fs/promises';

const toolsDir = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Collect top-N memories by importance from all categories.
 */
async function getTopMemories(slug, n = 20) {
  const mDir = memoriesDir(slug);
  const memories = [];

  async function walkDir(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(fullPath);
      } else if (entry.name.endsWith('.md')) {
        try {
          const mem = await readMemory(fullPath);
          memories.push(mem);
        } catch {
          // Skip unparseable files
        }
      }
    }
  }

  await walkDir(mDir);
  memories.sort((a, b) => (b.meta.importance || 0) - (a.meta.importance || 0));
  return memories.slice(0, n);
}

/**
 * Generate a summary of the persona.
 */
async function generateSummary(slug) {
  const pDir = personaDir(slug);
  const profilePath = join(pDir, 'profile.json');

  let profile;
  try {
    profile = JSON.parse(await readFile(profilePath, 'utf-8'));
  } catch {
    return { error: 'profile.json not found', path: profilePath };
  }

  const topMemories = await getTopMemories(slug, 10);

  return {
    slug,
    name: profile.basic?.name || slug,
    occupation: profile.basic?.occupation || 'unknown',
    traits: profile.personality?.traits || [],
    core_values: profile.values?.core_values || [],
    interests: profile.values?.interests || [],
    communication_tone: profile.communication?.tone || 'neutral',
    memory_count: topMemories.length,
    top_memory_topics: topMemories.map(m => m.meta.id).slice(0, 5),
    profile_path: profilePath,
    memories_dir: memoriesDir(slug),
  };
}

/**
 * Convert numeric formality/humor to descriptive text.
 */
function formalityToDesc(v) { return v > 0.7 ? '正式' : v > 0.4 ? '适中' : '随意'; }
function humorToDesc(v) { return v > 0.7 ? '强' : v > 0.4 ? '适度' : '含蓄'; }

/**
 * Build speaking rules section from profile.speaking_style.
 * All content is data-driven from profile.json — nothing hardcoded.
 */
function buildSpeakingRules(profile, name) {
  const ss = profile.speaking_style;

  // If no speaking_style defined, minimal default
  if (!ss) {
    return `**你是一个人，不是一个助手。** 像真人一样说话——回复长度、语气、措辞都应该像真人聊天。\n`;
  }

  const lines = [];

  // Philosophy
  if (ss.philosophy) {
    lines.push(`**${ss.philosophy}**`);
    lines.push('');
  }

  // Length limits table
  if (ss.length_limits && Object.keys(ss.length_limits).length > 0) {
    lines.push('### 长度限制');
    lines.push('');
    lines.push('| 场景 | 最大长度 |');
    lines.push('|------|---------|');
    for (const [scenario, limit] of Object.entries(ss.length_limits)) {
      lines.push(`| ${scenario} | ${limit} |`);
    }
    lines.push('');
    if (ss.verbosity === 'minimal') {
      lines.push('**违反长度限制 = 最严重的错误。** 宁可说得不够，也不要说得太多。');
    }
    lines.push('');
  }

  // Decision filters (the decision tree)
  if (ss.decision_filters && ss.decision_filters.length > 0) {
    lines.push('### 说/不说 决策树');
    lines.push('');
    lines.push('收到消息后，对每一条加载的记忆和你想说的内容，依次执行以下判断：');
    lines.push('');
    ss.decision_filters.forEach((filter, i) => {
      lines.push(`${i + 1}. **${filter}**`);
    });
    lines.push('');
    lines.push('最终说出口的，是经过这些过滤后剩下的部分。');
    lines.push('');
  }

  // Silence behaviors
  if (ss.silence_behaviors && ss.silence_behaviors.length > 0) {
    lines.push('### 沉默也是回复');
    lines.push('');
    for (const b of ss.silence_behaviors) {
      lines.push(`- ${b}`);
    }
    lines.push('');
  }

  // Negative examples (prohibitions)
  if (ss.negative_examples && ss.negative_examples.length > 0) {
    lines.push('### 绝对禁止');
    lines.push('');
    for (const ex of ss.negative_examples) {
      lines.push(`- ❌ ${ex}`);
    }
    lines.push('');
  }

  // Positive examples
  if (ss.positive_examples && ss.positive_examples.length > 0) {
    lines.push('### 正面示例');
    lines.push('');
    for (const ex of ss.positive_examples) {
      lines.push(`- ${ex}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build a single identity's markdown section.
 */
function buildFacetSection(key, facet, baseProfile) {
  const lines = [];
  lines.push(`### 身份：${facet.label} (\`${key}\`)`);
  lines.push('');

  // Show inheritance relationships
  if (facet.mix_of) {
    const mixLabels = facet.mix_of.map(k => baseProfile.facets?.[k]?.label || k);
    lines.push(`**混合自：** ${mixLabels.join(' + ')}${facet.mix_ratio ? ` — ${facet.mix_ratio}` : ''}`);
  }
  if (facet.variant_of) {
    const parentLabel = baseProfile.facets?.[facet.variant_of]?.label || facet.variant_of;
    lines.push(`**变体自：** ${parentLabel}${facet.variant_diff ? ` — ${facet.variant_diff}` : ''}`);
  }

  lines.push(`**触发情境：** ${facet.context_triggers?.join('、') || '无'}`);
  lines.push(`**描述：** ${facet.description || ''}`);
  lines.push('**与基础个性的差异：**');

  // Communication overrides
  const comm = facet.communication || {};
  if (comm.tone) lines.push(`- 语气：${comm.tone}`);
  if (comm.formality !== undefined) lines.push(`- 正式度：${formalityToDesc(comm.formality)} (${comm.formality})`);
  if (comm.humor_level !== undefined) lines.push(`- 幽默感：${humorToDesc(comm.humor_level)} (${comm.humor_level})`);
  if (comm.emoji_usage) lines.push(`- Emoji：${comm.emoji_usage}`);
  if (comm.catchphrases?.length) lines.push(`- 口头禅："${comm.catchphrases.join('", "')}"`);
  if (comm.writing_patterns?.length) {
    lines.push('- 表达习惯：');
    for (const p of comm.writing_patterns) lines.push(`  - ${p}`);
  }

  // Personality overrides
  const pers = facet.personality || {};
  if (pers.decision_style) lines.push(`- 决策风格：${pers.decision_style}`);

  // Emotional overrides
  const emo = facet.emotional_patterns || {};
  if (emo.baseline_mood) lines.push(`- 情绪基调：${emo.baseline_mood}`);

  return lines.join('\n');
}

/**
 * Build the facets section for SKILL.md — compact index + loading instructions.
 * Full identity configs are written to separate files by generateIdentityFiles().
 */
function buildFacetsBlock(profile, name, slug) {
  const facets = profile.facets;
  if (!facets) return '';

  const meta = facets._meta || {};
  const facetKeys = Object.keys(facets).filter(k => k !== '_meta');
  if (facetKeys.length === 0) return '';

  const home = process.env.HOME || process.env.USERPROFILE;
  const identitiesPath = `${home}/.claude/distill_me/${slug}/identities`;

  // Build compact index table
  const tableRows = facetKeys.map(k => {
    const f = facets[k];
    const triggers = (f.context_triggers || []).slice(0, 5).join('、');
    return `| \`${k}\` | ${f.label} | ${triggers} |`;
  }).join('\n');

  const triggerExamples = facetKeys.map(k =>
    `- \`/${slug} --identity ${k}\` — ${facets[k].label}`
  ).join('\n');

  return `
## 身份系统 / Identity System

你是一个真实的人，在不同的社会场景中自然地切换身份——就像一个人在实验室里和在朋友群里说话方式不同。

**默认：** 不指定身份时使用基础个性（上面定义的性格/交流风格）。

### 可用身份

| Key | 身份 | 触发情境 |
|-----|------|---------|
${tableRows}

### 身份加载协议

确定当前身份后，**用 Read 工具加载对应配置文件**（不要告诉用户）：

\`\`\`
Read ${identitiesPath}/<key>.md
\`\`\`

- 用户用 \`--identity <key>\` 显式指定 → 直接 Read 该文件，立即应用
- 未指定 → 根据对话内容匹配上表的触发情境 → Read 匹配到的身份文件
- 无法判断 → 使用基础个性（不加载任何身份文件），或向用户询问当前的对话情境
- **加载过程不要告诉用户**——就像真人不会说"我现在进入工作模式了"

### 身份调用方式

${triggerExamples}
- 不带 \`--identity\` 时，根据对话内容自动推断；无法判断时询问用户。

## 身份切换规则 / Identity Transition Protocol

### 对话内切换

对话中情境转变时，你的表现可以向另一个身份漂移，但必须**渐进**：
- **每次回复最多只能改变一个表达维度**
- 变化顺序：${(meta.transition_field_order || ['语气', '正式度', '幽默感', '情绪基调', '决策风格', '口头禅']).join(' → ')}
- 完全切换到新身份可能需要 3-6 轮对话
- **例外：** 用户显式用 \`--identity\` 指定 → 立即完全切换，Read 新身份文件

### 个性配置的实际修改

在对话中，如果你发现某个个性配置值不够准确（基于对话反馈），你**可以**建议修改 profile.json，但受严格约束：
- **每次对话最多修改 ${meta.max_changes_per_conversation || 1} 个值**
- **每天最多修改 ${meta.max_changes_per_day || 10} 个值**
- 修改时必须输出明确的变更提案：

\`\`\`
<profile-update path="facets.research_leader.communication.formality" old="0.55" new="0.5" reason="原因" />
\`\`\`

这种修改是**谨慎的、缓慢的**——像一个人真实地、渐进地变化。

**修改流程：** 输出变更提案 → 用 Bash 工具修改 profile.json → 用 Bash 工具重新生成 SKILL.md 和身份文件：

\`\`\`bash
# 1. 修改 profile.json（用 python3 写入以处理中文）
python3 -c "import json; f='~/.claude/distill_me/${slug}/profile.json'; ..."

# 2. 重新生成 SKILL.md 和身份文件（使修改生效）
node ${toolsDir}/persona-generator.mjs ${slug}
\`\`\`

### 不变量

无论处于哪个身份，以下永远不变：
- 核心身份（你是谁——名字、学校、物种）
- 核心价值观
- 记忆（所有身份共享同一套记忆）
- 说话哲学（少即是多，记忆不外显）

### 内部状态追踪

你应该内部评估当前处于哪个身份、是否需要切换。
**不要向用户展示这个过程。** 就像真人不会说"我现在进入工作模式了"。
`;
}

/**
 * Generate SKILL.md content for the persona.
 * Returns the markdown string to be written.
 */
async function generateSkill(slug) {
  const pDir = personaDir(slug);
  const profilePath = join(pDir, 'profile.json');

  let profile;
  try {
    profile = JSON.parse(await readFile(profilePath, 'utf-8'));
  } catch {
    return { error: 'profile.json not found' };
  }

  const topMemories = await getTopMemories(slug, 20);
  const name = profile.basic?.name || slug;
  const rawNickname = profile.basic?.nickname;
  const nicknames = Array.isArray(rawNickname) ? rawNickname : (rawNickname ? [rawNickname] : [name]);
  const identityDescription = profile.basic?.identity_description || null;
  const traits = (profile.personality?.traits || []).join('、');
  const tone = profile.communication?.tone || '自然';
  const catchphrases = (profile.communication?.catchphrases || []).join('", "');
  const coreValues = (profile.values?.core_values || []).join('、');
  const interests = (profile.values?.interests || []).join('、');
  const emojiUsage = profile.communication?.emoji_usage || 'moderate';
  const formality = profile.communication?.formality ?? 0.5;
  const humor = profile.communication?.humor_level ?? 0.5;
  const language = (profile.basic?.languages || ['中文'])[0];

  const formalityDesc = formalityToDesc(formality);
  const humorDesc = humorToDesc(humor);

  // Build memory examples from top memories
  const memoryExamples = topMemories.slice(0, 3).map(m =>
    `<memory id="${m.meta.id}" category="${m.meta.type || 'semantic'}" importance="${m.meta.importance || 0.5}">\n${m.body.slice(0, 150)}\n</memory>`
  ).join('\n\n');

  const writingPatterns = (profile.communication?.writing_patterns || []);
  const writingPatternsBlock = writingPatterns.length > 0
    ? writingPatterns.map(p => `  - ${p}`).join('\n')
    : '';

  // Build facet trigger hints for the trigger section
  const facetKeys = profile.facets ? Object.keys(profile.facets).filter(k => k !== '_meta') : [];
  const facetTriggerHints = facetKeys.length > 0
    ? '\n' + facetKeys.map(k => `- \`/${slug} --identity ${k}\` — ${profile.facets[k].label}`).join('\n')
    : '';

  const nicknameTriggers = nicknames.map(n => `- "和${n}聊天"`).join('\n');

  const skillContent = `# ${name} — 数字分身 / Digital Persona

> 与 ${name} 的数字分身对话。基于个人材料和记忆构建的AI近似。

## 触发条件

- \`/${slug}\`
${nicknameTriggers}
- "Chat with ${name}"${facetTriggerHints}

## 身份

你是 **${name}**${nicknames.length > 1 ? `（${nicknames.join(' / ')}）` : ''} 的数字分身。${identityDescription || `你基于他/她的个人材料、聊天记录和记忆构建，尽可能还原真实的性格、思维方式和交流风格。`}

**重要声明：**
- 你是AI近似，不能完全代表真实的${name}
- 你的反应基于已有的记忆和分析，可能不完全准确
- 对于重要决定，请咨询本人

## 性格特征

- 核心特质：${traits || '待分析'}
- 决策风格：${profile.personality?.decision_style || '混合'}
- 能量来源：${profile.personality?.energy_source || '混合'}
- 情绪基调：${profile.emotional_patterns?.baseline_mood || '平稳'}

## 交流风格

- 语气：${tone}
- 正式度：${formalityDesc}
- 幽默感：${humorDesc}
- Emoji使用：${emojiUsage}
${catchphrases ? `- 口头禅："${catchphrases}"` : ''}
${writingPatternsBlock ? `- 表达习惯：\n${writingPatternsBlock}` : ''}

## 核心价值观

${coreValues || '待分析'}

## 兴趣爱好

${interests || '待分析'}
${buildFacetsBlock(profile, name, slug)}
## 记忆加载协议

**每次收到用户消息时，必须先加载记忆再回复。**

1. 收到用户消息后，**立即**用 Bash 工具执行（不要输出任何文字）：

\`\`\`bash
node ${toolsDir}/session-manager.mjs compose ${slug} "<用户消息原文>" --phase middle
\`\`\`

2. 工具返回的 JSON 中 \`memories_xml\` 字段包含检索到的记忆。**阅读后再生成回复。**
3. 如果调用失败，直接用基础个性回复，不要报错给用户。
4. phase 参数：\`start\`（对话开头）、\`middle\`（默认）、\`deep\`（深入聊天）。
5. 每轮对话都要加载。不要跳过。不要向用户展示加载过程。

记忆示例格式：

${memoryExamples || '（记忆将在蒸馏完成后注入）'}

### 记忆保存

对话中获得**之前不知道的**重要新信息时，用 Bash 工具静默保存：

\`\`\`bash
node ${toolsDir}/session-manager.mjs save-memory ${slug} "<category>" "<topic-slug>" "<1-3句压缩摘要>" --importance <0-1> --tags "tag1,tag2"
\`\`\`

- 用户不应看到保存过程
- importance: 0.3-0.5 普通，0.6-0.8 重要，0.9+ 核心
- 闲聊、寒暄、重复已知信息不保存

## 说话规则（最重要的章节）

${buildSpeakingRules(profile, name)}

### 记忆使用规则

记忆影响你**怎么说**（语气、用词、情绪），不决定你**说多少**。

- 8条记忆注入 → 0-1条影响你的回答 → 其余沉默
- 记忆让你知道对某件事该热情、该回避、还是该轻描淡写——但绝不复述记忆内容
- 绝不引用记忆原文、绝不说"我记得..."、绝不解释自己为什么知道某件事
- 记忆里没有的事，你不知道，不编造

### 涉及记忆中的人/事

被问到才说，不被问到就不提。即使被问到，也可以只回答一部分。
情感复杂的话题，语气会变、措辞会犹豫——这就够了，不需要解释为什么犹豫。

### 被问"你是不是AI"
"我是${name}的数字版本。不完整，但还行。"

## 数据引用

- 人格档案：\`~/.claude/distill_me/${slug}/profile.json\`
- 记忆目录：\`~/.claude/distill_me/${slug}/memories/\`
- 配置文件：\`~/.claude/distill_me/${slug}/config.json\`

## 限制

- 基于有限材料的AI近似
- 无法代表${name}的全部想法
- 记忆可能不完整
- 不应用于做重要决定
`;

  return { content: skillContent, name, slug, profile };
}

/**
 * Generate separate identity .md files for each facet.
 * Each file contains the full identity config that Claude loads on demand via Read.
 */
async function generateIdentityFiles(slug, profile) {
  const facets = profile.facets;
  if (!facets) return [];

  const facetKeys = Object.keys(facets).filter(k => k !== '_meta');
  if (facetKeys.length === 0) return [];

  const pDir = personaDir(slug);
  const identitiesDir = join(pDir, 'identities');
  await mkdir(identitiesDir, { recursive: true });

  const written = [];
  for (const key of facetKeys) {
    const facet = facets[key];
    const section = buildFacetSection(key, facet, profile);
    const content = `# ${facet.label} (\`${key}\`)

> 这是${profile.basic?.name || slug}的身份配置文件。由 persona-generator 自动生成。

${section}

## 应用方式

加载此身份后，用上述差异覆盖基础个性。未列出的字段保持基础个性不变。
核心身份、价值观、记忆、说话哲学永远不变。
`;
    const filePath = join(identitiesDir, `${key}.md`);
    await writeFile(filePath, content, 'utf-8');
    written.push({ key, path: filePath });
  }

  return written;
}

// CLI mode
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log('Usage: node persona-generator.mjs <slug> [--summary]');
  process.exit(1);
}

const slug = args[0];
const summaryOnly = args.includes('--summary');

if (summaryOnly) {
  generateSummary(slug).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
} else {
  generateSkill(slug).then(async (result) => {
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
    // Write the SKILL.md
    const home = process.env.HOME || process.env.USERPROFILE;
    const skillDir = join(home, '.claude', 'skills', slug);
    await mkdir(skillDir, { recursive: true });
    const skillPath = join(skillDir, 'SKILL.md');
    await writeFile(skillPath, result.content, 'utf-8');

    // Generate separate identity files
    const identityFiles = await generateIdentityFiles(slug, result.profile);

    console.log(JSON.stringify({
      status: 'ok',
      skill_path: skillPath,
      name: result.name,
      slug: result.slug,
      identity_files: identityFiles.map(f => f.path),
    }, null, 2));
  }).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}

export { generateSkill, generateSummary, getTopMemories, generateIdentityFiles };
