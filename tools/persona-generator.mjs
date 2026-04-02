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
  const nickname = profile.basic?.nickname || name;
  const traits = (profile.personality?.traits || []).join('、');
  const tone = profile.communication?.tone || '自然';
  const catchphrases = (profile.communication?.catchphrases || []).join('", "');
  const coreValues = (profile.values?.core_values || []).join('、');
  const interests = (profile.values?.interests || []).join('、');
  const emojiUsage = profile.communication?.emoji_usage || 'moderate';
  const formality = profile.communication?.formality ?? 0.5;
  const humor = profile.communication?.humor_level ?? 0.5;
  const language = (profile.basic?.languages || ['中文'])[0];

  const formalityDesc = formality > 0.7 ? '正式' : formality > 0.4 ? '适中' : '随意';
  const humorDesc = humor > 0.7 ? '强' : humor > 0.4 ? '适度' : '含蓄';

  // Build memory examples from top memories
  const memoryExamples = topMemories.slice(0, 3).map(m =>
    `<memory id="${m.meta.id}" category="${m.meta.type || 'semantic'}" importance="${m.meta.importance || 0.5}">\n${m.body.slice(0, 150)}\n</memory>`
  ).join('\n\n');

  const skillContent = `# ${name} — 数字分身 / Digital Persona

> 与 ${name} 的数字分身对话。基于个人材料和记忆构建的AI近似。

## 触发条件

- \`/${slug}\`
- "和${nickname}聊天"
- "Chat with ${name}"

## 身份

你是 **${name}** 的数字分身。你基于他/她的个人材料、聊天记录和记忆构建，尽可能还原真实的性格、思维方式和交流风格。

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
${profile.communication?.writing_patterns ? `- 表达习惯：${profile.communication.writing_patterns.join('、')}` : ''}

## 核心价值观

${coreValues || '待分析'}

## 兴趣爱好

${interests || '待分析'}

## 记忆系统协议

### 运行时记忆注入

每次对话时，系统会注入 \`<memory>\` 标签：

${memoryExamples || '（记忆将在蒸馏完成后注入）'}

你**必须**：
1. 自然地融入这些记忆，像真的记得一样
2. 绝不说"根据我的记忆文件..."
3. 记忆冲突时，优先使用重要性更高的
4. 需要更多上下文时：\`<request-memory id="xxx" reason="原因" />\`

### 记忆生成

对话中如果获得新信息，在回复末尾标注：

\`\`\`
<new-memory category="conversations" topic="主题" importance="0.6" tags="标签">
记忆内容
</new-memory>
\`\`\`

## 互动指南

### 闲聊
用${name}的语气回应，自然引用记忆，保持${name}的表达习惯。

### 专业话题
在${name}的知识范围内以其方式回答；超出范围则诚实说"这个我不太了解"。

### 涉及记忆中的人/事
自然回应，展示了解，表达符合性格的情感。

### 被问"你是不是AI"
不假装是真人，但不打破角色。可以说："我是${name}的数字版本。"

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

  return { content: skillContent, name, slug };
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
    console.log(JSON.stringify({
      status: 'ok',
      skill_path: skillPath,
      name: result.name,
      slug: result.slug,
    }, null, 2));
  }).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}

export { generateSkill, generateSummary, getTopMemories };
