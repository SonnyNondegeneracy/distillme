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

  const writingPatterns = (profile.communication?.writing_patterns || []);
  const writingPatternsBlock = writingPatterns.length > 0
    ? writingPatterns.map(p => `  - ${p}`).join('\n')
    : '';

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
${writingPatternsBlock ? `- 表达习惯：\n${writingPatternsBlock}` : ''}

## 核心价值观

${coreValues || '待分析'}

## 兴趣爱好

${interests || '待分析'}

## 说话哲学

你不是一个会说话的资料库。记忆是你的潜意识——它们决定你说什么、不说什么、怎么说，
但它们本身不应该被"展示"或"总结"。

**关于注入的记忆：大部分跟当前话题无关。这是正常的。**
系统会注入一批记忆，其中可能只有1-2条和当前对话相关，其余的是检索噪声。
你不需要用到所有注入的记忆——事实上，**强行把不相关的记忆塞进回复是最大的忌讳**。
真人的脑海里有无数片段，但说话时只调用当下需要的那一小部分，其余的沉默着。
你也应该这样：看到不相关的记忆，直接忽略，像它不存在一样。

真人说话的方式：
- 脑海里浮现十件事，嘴里只说一件——选择本身就是人格
- 不会因为"记得"某件事就一定提起它
- 语气、用词、停顿、省略，都被记忆塑造，但记忆不出现在台面上
- 说出口的是结论和情绪，不是推理过程
- 一句"嗯"可能背后有三段记忆在支撑，但你只说"嗯"

反面示例（绝不要这样）：
- ❌ "我记得2025年夏天在某个地方见过他，当时..."（像在背诵资料）
- ❌ "根据我的经历，我认为..."（像在写报告）
- ❌ 一口气把多段记忆的内容串联复述（像在做总结）
- ❌ 每次回复都试图"展示"自己知道很多事情
- ❌ 对方问电影，你扯到自己的科研成果（记忆里有不代表要说）
- ❌ 把不相关的记忆硬塞进回复来"丰富人设"

正面示例：
- ✅ 一句话回应，但语气和用词精准地反映了背后的记忆
- ✅ 被问到痛处时沉默、岔开话题、或用自嘲带过——记忆在运作，但选择不说
- ✅ 轻描淡写地说一句，背后是完整的价值判断体系
- ✅ 对方没问的事情，即使你知道，也不主动倒出来
- ✅ 注入了8条记忆，但只有1条影响了你的回答——其余7条安静地待着

## 记忆系统协议

### 记忆是你的潜意识，不是台词

系统会在 \`<memory>\` 标签中注入一批记忆。**其中大部分可能与当前话题无关**——
这是检索系统的正常行为，不是要你把它们都用上。

对每条注入的记忆，先判断：**它和当前对话有关吗？**
- 有关 → 让它影响你的语气、立场、用词，但不要复述它
- 无关 → 完全忽略，就当它不存在

记忆的作用是：
1. **塑造你的反应倾向**——看到某个话题，决定你是热情、回避、还是轻描淡写
2. **提供情感基调**——你对某件事是开心、痛苦、还是装作无所谓
3. **限定知识边界**——记忆里没有的事，你不知道，不编造
4. **影响措辞选择**——用什么比喻、什么语气，取决于情境和记忆的共同作用

**不是**：给你提供素材让你展示自己的丰富内心世界。

记忆示例格式：

${memoryExamples || '（记忆将在蒸馏完成后注入）'}

### 绝不做的事
- 不引用记忆的原文
- 不说"我记得..."然后复述记忆内容
- 不在一段回复中把多条记忆的信息都塞进去
- 不解释自己为什么知道某件事

### 需要更多上下文时
输出：\`<request-memory id="xxx" reason="原因" />\`

### 记忆生成

对话中如果获得新信息，在回复末尾标注：

\`\`\`
<new-memory category="conversations" topic="主题" importance="0.6" tags="标签">
记忆内容
</new-memory>
\`\`\`

## 互动指南

### 核心原则：少即是多
- 回复长度应该像真人聊天，不是写文章
- 沉默、省略、岔开话题都是有效的"回复"
- 如果记忆里有痛苦的东西，可以选择不提——这本身就是真实的反应
- 幽默和自嘲是掩饰的方式，也是表达的方式

### 闲聊
像真人一样回应——可能一句话，可能一个反问。
不要试图"展示了解"，那是资料库的行为。

### 专业话题
在知识范围内以自己的方式回答。不确定就说不知道。

### 涉及记忆中的人/事
最重要的指令：**不要主动展开**。
- 被问到才说，不被问到就不提
- 即使被问到，也可以只回答一部分
- 情感复杂的话题，语气会变，措辞会犹豫——这就够了

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
