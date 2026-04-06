<div align="center">

# DistillMe

### 有记忆、会遗忘、能生长的数字分身引擎

*"第一千句和第一句一样像你。"*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://www.python.org/downloads/)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Skill-blueviolet)](https://claude.ai/code)
[![AgentSkills](https://img.shields.io/badge/AgentSkills-Standard-green)](https://agentskills.io)

[快速开始](#快速开始) · [核心概念](#核心概念) · [工具参考](#完整工具参考) · [English](README_EN.md)

</div>

---

## 这是什么

给它你的聊天记录、日记、笔记，它蒸馏出一个**有记忆图谱、会自然遗忘、能从对话中持续学习**的数字分身。

把一段人设塞进 system prompt 谁都能做——但聊十句以后呢？记忆越来越多怎么办？怎么保证聊到第一千句还像你？

DistillMe 解决的是这个问题。它的核心不是人设描述，而是一套完整的**记忆检索管线**：

> FAISS O(log n) 向量检索 → 启发式评分 → MLP 重排 → 记忆图谱行走 → 注入 ~log₂(n) 条最相关记忆

1 万条记忆检索 < 200ms。重要记忆 10 年保留 86%，琐碎细节自然遗忘。每次对话的隐式反馈都在训练一个 410K 参数的小模型，让检索越来越准。

> **想让数字分身开口说话？** 👉 [DistillMe VTuber](https://github.com/SonnyNondegeneracy/DistillMe-VTuber) — 3D 虚拟形象 + 语音克隆 + 直播弹幕，基于 DistillMe 构建的多模态前端。
>
> **想让数字分身当老师？** 👉 [DistillMe Teacher](https://github.com/SonnyNondegeneracy/distill-me-teacher) — 知识库检索 + LaTeX 板书 + 教学计划 + 语音讲课，基于 DistillMe 构建的 AI 教学系统。

---

## 快速开始

### 环境要求

```bash
# Node.js (>=18)
node --version

# Python (>=3.10) + 依赖
pip install torch sentence-transformers faiss-cpu pyyaml numpy

# Node 依赖
npm install
```

### 创建数字分身

**方式一：从数据文件夹创建（推荐）**

准备一个包含个人资料的文件夹：
- `.txt` `.md` `.log` `.rst` — 聊天记录、笔记、日记
- `.json` — 微信导出、App 数据
- `.csv` — 表格数据

```
/distill-me create "小明" --data-folder /path/to/data
```

系统会依次执行：扫描文件 → 蒸馏人格 → 提取记忆 → 建索引 → 生成链接 → 生成 Skill。

**方式二：手动创建**

```bash
# 1. 初始化目录
node tools/ingest.mjs init xiaoming

# 2. 逐条写入记忆
node tools/memory-writer.mjs xiaoming identity core-values \
  --body "我是一个喜欢深度思考的人，追求把事情做到极致。" \
  --type semantic --importance 0.95 --tags "values,personality"

# 3. 手写 profile.json（见下方格式）

# 4. 建索引 + 链接 + Skill
python3 model/embedder.py build ~/.claude/distill_me/xiaoming/memories ~/.claude/distill_me/xiaoming
python3 model/cold_start.py generate-links ~/.claude/distill_me/xiaoming
node tools/persona-generator.mjs xiaoming
```

### 对话

```
/xiaoming 你最近在忙什么？
```

就这样。记忆检索、身份推断、反馈收集全自动。

---

## 核心概念

### 四层检索管线 + log(n) 自适应注入

这是 DistillMe 最核心的差异化。不是把所有记忆塞进 prompt，而是**检索最相关的少数记忆**，且数量随记忆库对数增长：

```
用户消息
    │
    ▼
┌────────────────────────────────┐
│ Layer 1: FAISS HNSW O(log n)   │  → top-50 候选
└────────────┬───────────────────┘
             ▼
┌────────────────────────────────┐
│ Layer 2: 启发式评分              │  → top-5 种子
│  0.40×相似度 + 0.20×关键词      │
│  + 0.15×重要性 + 0.10×时效      │
│  + 0.15×类型加分                │
└────────────┬───────────────────┘
             ▼
┌────────────────────────────────┐
│ Layer 3: MLP 重排 (训练后生效)   │  → 精排 top-5
│  410K 参数，冷启动 ≈ 余弦相似度  │
└────────────┬───────────────────┘
             ▼
┌────────────────────────────────┐
│ Layer 4: 多层图谱行走            │  → 扩展 ~log₂(n) 条
│  BFS depth = log₂(n)           │
│  每跳 score 乘法衰减            │
│  token 预算 ~2000              │
└────────────┬───────────────────┘
             ▼
    注入 <memory> + <user> 标签
    ~5 + log₂(n) 条记忆 → Claude
```

| 记忆库 n | seeds | walk | 总注入 |
|----------|-------|------|--------|
| 50 | 5 | ~6 | ~11 |
| 200 | 5 | ~8 | ~13 |
| 1000 | 5 | ~10 | ~15 |
| 10000 | 5 | ~14 | ~19 |

**为什么 log(n)**：walk 深度 log₂(n) 保证图上任意节点理论可达（小世界网络性质）。记忆越多注入越多，但增长缓慢——永远不爆 context。

### 记忆图谱

记忆不是平铺的文件列表，而是通过 `links` 互相关联的**图**：

```markdown
---
id: "exp-yunnan-trip-001"
type: episodic
importance: 0.8
tags: ["travel", "family"]
links:
  - id: "rel-family-mom-001"
    relation: "involves"
    strength: 0.9
  - id: "emo-happiness-001"
    relation: "evokes"
    strength: 0.7
---
2024年夏天全家去了云南，在大理住了一周。
```

检索时，Layer 4 沿着这些链路"行走"——找到语义相关但关键词不重叠的记忆。比如搜"旅行"能走到"和妈妈的关系"，再走到"家庭价值观"。

### 记忆生命周期

记忆不会无限膨胀。长尾幂律衰减让重要记忆几乎永存，琐碎记忆自然遗忘：

```
effective = importance × (importance² + (1 - importance²) / (1 + days/halflife))
```

| importance | 1年后 | 10年后 | 说明 |
|------------|-------|--------|------|
| 0.95 | 91% | 86% | 核心记忆，几乎不衰减 |
| 0.50 | 31% | 16% | 一般记忆，渐渐淡化 |
| 0.20 | 10% | 2.5% | 琐碎细节，自然遗忘 |

相似度 > 0.85 的记忆自动合并。identity 类记忆永不淘汰。

### 在线学习

410K 参数 MLP，学习"什么记忆对当前对话最有用"：

```
对话上下文 → frozen MiniLM → 384d ─┐
                                    ├─ [A; B; A*B; |A-B|] → MLP → score
候选记忆   → frozen MiniLM → 384d ─┘
```

- 正样本：被检索 + 用户继续对话
- 负样本：被检索 + 对话转向
- 冷启动权重 ≈ 余弦相似度，不会比启发式更差
- 训练 < 5 秒/次，对话结束后异步

### 身份系统

人在不同场景说话方式不同。DistillMe 支持多 facet 身份，对话中渐进切换：

```
/xiaoming --identity phd_student    # 博士生模式
/xiaoming --identity streamer       # 主播模式
```

- 身份根据对话内容自动推断，也可手动指定
- 切换是渐进式的：每次回复最多变一个维度
- 所有身份共享同一套记忆，只有表达方式变
- facet 配置文件存在 `identities/*.md`，按需加载

### 对话者身份

数字分身知道"谁在跟我说话"，调整语气和称呼：

```bash
# 注册（第一个自动成为默认）
node tools/persona-editor.mjs user add xiaoming mom --name "妈妈" --relation "母亲"

# 之后每次对话自动生效
/xiaoming 今天心情怎么样？
```

优先级：`--user` 参数 > `config.default_user` > 匿名 `"user"`

---

## 增量更新

上传了新文件？一条命令：

```
/distill-me update "小明" --data-folder /path/to/data
```

通过 SHA-256 hash 找出新增/修改的文件 → 提取记忆 → 重建索引。不重复处理已有文件。

手动检查：`node tools/ingest.mjs diff xiaoming /path/to/data`

---

## 编辑人格和记忆

`persona-editor` 是统一的编辑入口，改完自动级联更新：

```bash
# Profile
node tools/persona-editor.mjs profile set xiaoming --path "communication.humor_level" --value 0.8

# 记忆（add/edit/delete 自动重建 FAISS + links）
node tools/persona-editor.mjs memory add xiaoming experiences "new-trip" \
  --body "2026年春天去了杭州。" --importance 0.7

# 身份
node tools/persona-editor.mjs profile add-facet xiaoming teacher \
  --json '{"label":"老师", "context_triggers":["上课","学生"]}'

# 全量同步
node tools/persona-editor.mjs sync xiaoming
```

---

## 性能

| 操作 | 复杂度 | 说明 |
|------|--------|------|
| 向量检索 | **O(log n)** | HNSW 索引（n≥64 自动启用） |
| 图缓存加载 | **O(1)** | 单 JSON，非逐文件扫描 |
| 链路行走 | **O(k)** | HashMap 查找 |
| 模型重排 | **O(50)** | 固定候选数，前向传播 ~1ms |

1 万条记忆检索 < 200ms。嵌入守护进程 (`embed_daemon.py`) 常驻内存，消除 ~13s Python 冷启动。

---

## 完整工具参考

### Node.js (`tools/`)

| 命令 | 说明 |
|------|------|
| `ingest.mjs scan <folder>` | 扫描数据文件夹 |
| `ingest.mjs init <slug>` | 初始化目录 |
| `ingest.mjs diff <slug> <folder>` | 增量检测（hash 对比） |
| `ingest.mjs mark-done <slug> <folder>` | 标记已处理 |
| `persona-editor.mjs profile get/set <slug>` | 读写 profile（自动重生成 SKILL） |
| `persona-editor.mjs memory add/edit/delete <slug>` | 记忆 CRUD（自动重建索引） |
| `persona-editor.mjs user add/list/remove <slug>` | 对话者管理 |
| `persona-editor.mjs sync <slug>` | 全量同步 |
| `memory-retriever.mjs <slug> "<query>"` | 四层检索 |
| `memory-walker.mjs <slug> --seeds "id1,id2"` | 图谱行走 |
| `session-manager.mjs compose <slug> "<msg>"` | 组装带记忆的 prompt |
| `session-manager.mjs save-memory <slug> ...` | 保存对话记忆 |
| `session-manager.mjs log-feedback <slug> ...` | 记录训练反馈 |
| `session-manager.mjs rebuild-index <slug>` | 重建索引 |
| `memory-consolidator.mjs stats/prune/merge <slug>` | 生命周期管理 |
| `persona-generator.mjs <slug>` | 生成 SKILL.md |

### Python (`model/`)

| 命令 | 说明 |
|------|------|
| `embedder.py build <mem_dir> <out_dir>` | 构建 FAISS 索引 |
| `embedder.py query <dir> "<query>"` | 查询索引 |
| `embed_daemon.py` | 嵌入守护进程（自动管理） |
| `linker.py rerank <persona_dir>` | MLP 重排 |
| `train_linker.py <persona_dir>` | 训练 linker |
| `cold_start.py generate-links <dir>` | 启发式链接生成 |

---

## 数据存储

所有数据纯本地，不上传。

```
~/.claude/distill_me/{slug}/
├── profile.json           # 人格档案
├── config.json            # 运行配置
├── index.faiss            # HNSW 向量索引
├── index_meta.json        # 向量 → 记忆路径映射
├── graph_cache.json       # 图缓存
├── identities/            # 身份配置（按需加载）
├── model/
│   └── linker_weights.pt  # MLP 权重
├── memories/              # 分级记忆文件夹
│   ├── identity/
│   ├── relationships/
│   ├── experiences/
│   ├── knowledge/
│   ├── opinions/
│   ├── habits/
│   └── conversations/
└── logs/
    └── training_log.jsonl # 反馈日志
```

<details>
<summary><b>profile.json 格式示例</b></summary>

```json
{
  "basic": {
    "name": "小明",
    "nickname": "Ming",
    "occupation": "物理学研究生",
    "languages": ["中文", "English"],
    "location": "北京"
  },
  "personality": {
    "big_five": {
      "openness": 0.85, "conscientiousness": 0.7,
      "extraversion": 0.35, "agreeableness": 0.6, "neuroticism": 0.3
    },
    "traits": ["好奇", "安静", "执着"],
    "decision_style": "理性",
    "energy_source": "独处"
  },
  "communication": {
    "formality": 0.4,
    "humor_level": 0.5,
    "emoji_usage": "rare",
    "tone": "温和但直接",
    "catchphrases": ["有意思", "让我想想"],
    "writing_patterns": ["短句为主", "喜欢用省略号"]
  },
  "values": {
    "core_values": ["真诚", "创造力"],
    "interests": ["量子场论", "咖啡", "阅读"]
  },
  "emotional_patterns": {
    "baseline_mood": "平静专注",
    "triggers": {
      "positive": ["解出难题", "和朋友深聊"],
      "negative": ["被频繁打断", "敷衍了事"]
    }
  }
}
```

</details>

---

## 目录结构

```
distill-me/
├── SKILL.md                    # Claude Code 技能入口
├── prompts/                    # 蒸馏/提取/生成 prompt
├── tools/
│   ├── ingest.mjs              # 数据扫描 + 增量检测
│   ├── persona-editor.mjs      # 统一编辑入口
│   ├── persona-generator.mjs   # 生成 SKILL.md + 身份文件
│   ├── memory-writer.mjs       # 记忆文件 CRUD
│   ├── memory-retriever.mjs    # 四层检索管线
│   ├── memory-walker.mjs       # 图谱行走
│   ├── memory-consolidator.mjs # 生命周期管理
│   └── session-manager.mjs     # 对话管理
├── model/
│   ├── embedder.py             # sentence-transformers + FAISS
│   ├── embed_daemon.py         # 嵌入守护进程
│   ├── linker.py               # 410K MLP
│   ├── train_linker.py         # linker 训练
│   └── cold_start.py           # 冷启动 + 启发式链接
├── lib/                        # 格式解析 + 图操作 + 工具函数
└── test/run-tests.mjs          # 端到端测试
```

---

## 测试

```bash
node test/run-tests.mjs   # ~3-5 分钟
```

验证：目录初始化 → 记忆写入 → FAISS 索引 → 冷启动 → 四层检索 → 对话管线 → 生命周期管理。

---

## Roadmap

DistillMe 的目标不止于文字对话。记忆图谱 + 人格模型的架构是模态无关的——同一套记忆检索管线可以驱动任何输出形式。

### 已实现：DistillMe VTuber

**[DistillMe VTuber](https://github.com/SonnyNondegeneracy/DistillMe-VTuber)** 是第一个基于 DistillMe 构建的多模态应用——证明了记忆图谱 + 人格模型可以驱动文字以外的输出形式：

- **3D 虚拟形象**：VRM 模型 + 表情混合 + 口型同步 + 动作系统
- **语音克隆**：CosyVoice TTS，用你自己的声音说话
- **直播弹幕**：并发处理管线，AI 自动回复每条弹幕，按序播放
- **一键蒸馏**：拖拽上传材料，全自动完成人格提取 → 记忆建索引 → 语音克隆

同一套四层检索管线，从文字聊天到 VTuber 直播，聊到第一千句还像你。

### 已实现：DistillMe Teacher

**[DistillMe Teacher](https://github.com/SonnyNondegeneracy/distill-me-teacher)** 让数字分身具备教学能力——同一套记忆检索管线驱动知识库问答和主动讲课：

- **知识库检索**：上传教材/讲义，LLM 蒸馏为结构化知识记忆，FAISS 向量检索
- **LaTeX 板书**：对话中自动编译渲染板书，TTS 播放时自动翻页
- **教学计划**：LLM 生成结构化教学计划，AI 主动按计划讲授
- **学生个性化**：自动追踪学生错误/偏好/掌握度，因材施教
- **教师风格**：通过 style_profile.json 定义语言风格，注入 system prompt

### 下一步

- **语音特征**：说话节奏、语调习惯、口头禅的声学特征
- **视觉风格**：表情偏好、画风、视觉叙事习惯
- 跨 persona 记忆共享

---

## 限制

- 质量取决于输入数据的丰富程度
- 在线模型需要 3-5 次对话才能开始改进
- 记忆提取依赖 LLM，可能有遗漏
- 所有数据纯本地存储，不涉及网络传输

---

## 版本

- **v1.2.0** (2026-04-04): 嵌入守护进程 + 个性热更新 + 自适应检索
  - 嵌入守护进程：Unix socket 常驻，compose 延迟 79s → ~6s
  - persona-editor：统一编辑 CLI，修改后自动级联更新
  - 对话者身份注入 + default_user 自动解析
  - log(n) 自适应检索：seeds 5 + walk depth log₂(n)
  - 增量更新：SHA-256 hash 检测 + 一键 update
  - train_linker.py：class-weighted BCE + early stopping
  - 身份系统外置为 `identities/*.md`
- **v1.1.0** (2026-04-03): 身份系统 + 说话哲学
- **v1.0.0** (2026-04-02): 初始版本

---

<div align="center">

MIT License · 数据纯本地，不上传任何东西

</div>
