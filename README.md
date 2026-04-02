# DistillMe — 蒸馏你的数字分身

从个人数据中蒸馏出有记忆、有性格、会持续学习的数字分身。

## 这是什么

DistillMe 是一个运行在 [Claude Code](https://claude.ai/claude-code) 上的个人数字分身蒸馏系统。给它一个包含个人资料的文件夹（聊天记录、日记、笔记等），它会：

1. **蒸馏人格**：从文本中提取性格特征、交流风格、价值观、兴趣爱好
2. **构建记忆图谱**：将信息提取为离散记忆，按类别存储在分级文件夹中，通过链路互相关联
3. **生成可对话的数字分身**：产出一个 Claude Code Skill，可以像和真人一样聊天
4. **持续学习**：对话过程中选择性提取新记忆，在线训练小模型优化记忆检索

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

**方式一：从数据文件夹创建**

准备一个包含个人资料的文件夹，支持的格式：
- `.txt` `.md` `.log` `.rst` — 纯文本（聊天记录、笔记、日记）
- `.json` — 结构化数据（微信导出、App 数据）
- `.csv` — 表格数据

然后在 Claude Code 中运行：

```
/distill-me create "小明" --data-folder /path/to/data
```

系统会依次执行：扫描文件 → 蒸馏人格 → 提取记忆 → 建索引 → 生成链接 → 生成 Skill。

**方式二：手动创建（无数据文件夹）**

```bash
# 1. 初始化目录
node tools/ingest.mjs init xiaoming

# 2. 逐条写入记忆
node tools/memory-writer.mjs xiaoming identity core-values \
  --body "我是一个喜欢深度思考的人，追求把事情做到极致。" \
  --type semantic --importance 0.95 --tags "values,personality"

node tools/memory-writer.mjs xiaoming relationships best-friend \
  --body "和苗小蓝是朋友，毕业后一直保持联系，每周打一次游戏。" \
  --type emotional --importance 0.8 --tags "friendship"

node tools/memory-writer.mjs xiaoming experiences graduation \
  --body "2025年从北大物理系毕业，毕业典礼上妈妈哭了。" \
  --type episodic --importance 0.85 --tags "milestone,family"

# 3. 手写 profile.json（见下方格式说明）

# 4. 建索引
python3 model/embedder.py build \
  ~/.claude/distill_me/xiaoming/memories \
  ~/.claude/distill_me/xiaoming

# 5. 生成链接
python3 model/cold_start.py generate-links ~/.claude/distill_me/xiaoming

# 6. 生成 Skill
node tools/persona-generator.mjs xiaoming
```

### 与数字分身对话

创建完成后，在 Claude Code 中直接调用：

```
/xiaoming 你最近在忙什么？
```

---

## 核心概念

### 记忆系统

记忆存储在分级文件夹中，每条记忆是一个 Markdown 文件，用 YAML 前缀保存元数据：

```
memories/
├── identity/          # 核心身份：价值观、性格、自我描述
├── relationships/     # 人际关系（可嵌套子文件夹）
│   ├── family/
│   └── friends/
├── experiences/       # 经历（可按年份组织）
│   ├── 2023/
│   └── 2024/
├── knowledge/         # 领域知识和技能
├── opinions/          # 观点和偏好
├── habits/            # 行为模式
└── conversations/     # 对话中自动提取的记忆
```

每条记忆的格式：

```markdown
---
id: "exp-yunnan-trip-001"
type: episodic              # episodic | semantic | procedural | emotional
created: "2026-04-02T15:30:00Z"
importance: 0.8             # 0-1，影响检索优先级
tags: ["travel", "family", "yunnan"]
source: "chat_logs/2024-08.txt"
links:                      # 关联记忆 —— 形成可行走的图谱
  - id: "rel-family-mom-001"
    relation: "involves"    # involves | evokes | temporal-near | co-entity | related
    strength: 0.9
  - id: "emo-happiness-001"
    relation: "evokes"
    strength: 0.7
---

2024年夏天全家去了云南，在大理住了一周。洱海边的日落很美，妈妈拍了很多照片。
```

**关键设计**：每条记忆不是孤立的文件，而是通过 `links` 字段指向其他记忆，形成一张**记忆图谱**。检索时可以沿链路"行走"，找到语义相关但关键词不重叠的记忆。

### 记忆检索：四层管线

```
用户消息 "你还记得和妈妈去旅行吗？"
         │
         ▼
  ┌──────────────────────────────────────┐
  │ 第一层：FAISS 向量检索 O(log n)       │
  │ HNSW 索引，取 top-50 候选             │
  └──────────────┬───────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────┐
  │ 第二层：启发式评分                     │
  │ score = 0.40 × embedding_similarity  │
  │       + 0.20 × keyword_match         │
  │       + 0.15 × importance            │
  │       + 0.10 × recency               │
  │       + 0.15 × type_boost            │
  │ 取 top-8                              │
  └──────────────┬───────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────┐
  │ 第三层：模型重排（训练后生效）          │
  │ 410K MLP 对 top-50 重排               │
  │ 冷启动时退化为纯启发式                 │
  └──────────────┬───────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────┐
  │ 第四层：链路行走                       │
  │ 从 top-8 沿 links 扩展 3-5 条         │
  │ 关联记忆（token 预算 ~800）            │
  └──────────────┬───────────────────────┘
                 │
                 ▼
         注入到 <memory> 标签
         送入 Claude 生成回复
```

### 对话中的记忆写入

不是所有对话都会写入记忆。AI 被指示只在以下情况生成 `<new-memory>` 标签：

| 写入 | 不写入 |
|------|--------|
| 用户透露了**之前不知道的事实** | 闲聊、寒暄、打招呼 |
| **情感上有意义**的交互 | 重复已知信息 |
| 用户**纠正**了已有记忆 | 纯知识问答 |

写入的内容是**压缩后的 1-3 句摘要**，不是原始对话复制粘贴。

AI 回复中的标签格式：

```xml
<new-memory category="conversations" topic="mom-work-update" importance="0.6" tags="family,mom">
妈妈最近工作很忙，经常加班到很晚。她说虽然累但挺充实的。
</new-memory>
```

系统自动解析并存入 `memories/conversations/` 目录。

### 记忆生命周期管理

记忆不会无限增长。`memory-consolidator.mjs` 提供三种维护操作：

**1. 衰减淘汰（prune）**

记忆采用**长尾衰减**模型，而非指数衰减——重要记忆几乎不会遗忘：

```
floor        = importance²                    ← 重要性越高，地板越高
decay_factor = 1 / (1 + 天数 / halflife)      ← 幂律衰减，非指数
effective    = importance × (floor + (1 - floor) × decay_factor)
```

| importance | 第0天 | 1年后 | 10年后 | 说明 |
|------------|-------|-------|--------|------|
| 0.95 | 0.950 | 0.904 | 0.866 | 核心记忆，10年仍保留91% |
| 0.50 | 0.500 | 0.313 | 0.159 | 一般记忆，逐渐淡化 |
| 0.20 | 0.200 | 0.104 | 0.025 | 琐碎细节，几年后接近归零 |

identity 类记忆永不淘汰。当 effective importance 低于阈值（默认 0.1）时被清理。

```bash
# 查看哪些记忆会被淘汰（不实际删除）
node tools/memory-consolidator.mjs prune xiaoming --dry-run

# 执行淘汰
node tools/memory-consolidator.mjs prune xiaoming --min-importance 0.1
```

**2. 相似合并（merge）**

conversations/ 中的记忆可能存在重复。当两条记忆嵌入相似度 > 0.85 时，自动合并为一条（保留重要性更高的，内容合并）。

```bash
node tools/memory-consolidator.mjs merge xiaoming --similarity 0.85
```

**3. 统计报告（stats）**

```bash
node tools/memory-consolidator.mjs stats xiaoming
```

输出示例：
```json
{
  "total_memories": 47,
  "total_tokens": 3820,
  "by_category": {
    "identity": 3,
    "relationships": 8,
    "experiences": 15,
    "knowledge": 5,
    "opinions": 4,
    "habits": 3,
    "conversations": 9
  },
  "decayed_below_threshold": 2,
  "threshold": 0.1
}
```

### 在线学习模型

一个 ~410K 参数的 MLP，学习"什么样的记忆对当前对话最有用"：

```
对话上下文 → frozen MiniLM → 384维 ─┐
                                     ├─ [A; B; A*B; |A-B|] → MLP → score
候选记忆   → frozen MiniLM → 384维 ─┘
```

- **底座**：`paraphrase-multilingual-MiniLM-L12-v2`（冻结，中英双语）
- **可训练**：3 层 MLP (1536→256→64→1)，仅 410K 参数
- **训练信号**：对话中被检索且用户继续的记忆 = 正样本；被检索但对话转向的 = 负样本
- **冷启动**：权重初始化为等价于余弦相似度，不会比启发式更差
- **训练耗时**：< 5 秒/次，每次对话结束后异步训练

```bash
# 查看训练状态
python3 model/trainer.py status ~/.claude/distill_me/xiaoming

# 手动触发训练
python3 model/trainer.py train ~/.claude/distill_me/xiaoming
```

---

## 完整工具参考

### Node.js 工具 (`tools/`)

| 命令 | 说明 |
|------|------|
| `node tools/ingest.mjs scan <folder>` | 扫描数据文件夹，报告文件统计 |
| `node tools/ingest.mjs init <slug>` | 初始化 persona 目录结构 |
| `node tools/ingest.mjs read-chunk <file> [--offset N] [--limit N]` | 分块读取文件供 LLM 分析 |
| `node tools/memory-writer.mjs <slug> <category> <topic> --body "..." [--type T] [--importance N] [--tags "a,b"]` | 创建记忆文件 |
| `node tools/memory-retriever.mjs <slug> "<query>" [--top-k 8] [--phase start\|middle\|deep]` | 检索记忆 |
| `node tools/memory-walker.mjs <slug> --seeds "id1,id2" [--max-nodes 5] [--min-strength 0.15]` | 沿链路行走 |
| `node tools/persona-generator.mjs <slug>` | 生成 SKILL.md |
| `node tools/persona-generator.mjs <slug> --summary` | 输出人格摘要 |
| `node tools/session-manager.mjs compose <slug> "<msg>" [--phase P]` | 组装带记忆的 prompt |
| `node tools/session-manager.mjs extract <slug> "<response>"` | 从 AI 回复中提取 `<new-memory>` |
| `node tools/session-manager.mjs save-memory <slug> <cat> <topic> "<body>"` | 手动保存对话记忆 |
| `node tools/session-manager.mjs rebuild-index <slug>` | 重建 FAISS 索引和链接 |
| `node tools/session-manager.mjs log-feedback <slug> "<retrieved>" "<used>"` | 记录训练反馈 |
| `node tools/memory-consolidator.mjs stats <slug>` | 记忆统计 |
| `node tools/memory-consolidator.mjs prune <slug> [--min-importance 0.1] [--dry-run]` | 衰减淘汰 |
| `node tools/memory-consolidator.mjs merge <slug> [--similarity 0.85] [--dry-run]` | 相似合并 |

### Python 模型 (`model/`)

| 命令 | 说明 |
|------|------|
| `python3 model/embedder.py build <memories_dir> <output_dir>` | 构建 FAISS 向量索引 |
| `python3 model/embedder.py query <dir> "<query>" [--top-k 50]` | 查询向量索引 |
| `python3 model/linker.py info` | 打印模型参数信息 |
| `python3 model/linker.py rerank <persona_dir>` | 模型重排（stdin 传入 JSON） |
| `python3 model/trainer.py train <persona_dir> [--epochs 3]` | 在线训练 |
| `python3 model/trainer.py status <persona_dir>` | 查看训练状态 |
| `python3 model/cold_start.py init-weights` | 测试冷启动初始化 |
| `python3 model/cold_start.py generate-links <persona_dir>` | 生成启发式记忆链接 |

---

## 数据存储位置

所有数据存储在本地，不上传。

```
~/.claude/distill_me/{slug}/
├── profile.json           # 人格档案
├── config.json            # 运行配置（检索参数、模型参数）
├── index.faiss            # HNSW 向量索引（O(log n) 检索）
├── index_flat.faiss       # Flat 索引副本（供 reconstruct）
├── index_meta.json        # 向量 ID → 记忆文件路径映射
├── graph_cache.json       # 图缓存（O(1) 加载，避免逐文件扫描）
├── model/
│   └── linker_weights.pt  # 训练后的 MLP 权重
├── memories/              # 分级记忆文件夹
│   ├── identity/
│   ├── relationships/
│   ├── experiences/
│   ├── knowledge/
│   ├── opinions/
│   ├── habits/
│   └── conversations/
└── logs/
    └── training_log.jsonl # 训练反馈日志

~/.claude/skills/{slug}/
└── SKILL.md               # Claude Code 可发现的技能入口
```

## profile.json 格式

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
      "openness": 0.85,
      "conscientiousness": 0.7,
      "extraversion": 0.35,
      "agreeableness": 0.6,
      "neuroticism": 0.3
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
    "interests": ["量子场论", "咖啡", "阅读"],
    "strong_opinions": ["远程工作更适合深度思考"]
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

---

## 性能保证

| 操作 | 复杂度 | 说明 |
|------|--------|------|
| 向量检索 | **O(log n)** | HNSW 索引（n≥64 自动启用） |
| 图缓存加载 | **O(1)** | 单 JSON 文件，非逐文件扫描 |
| 链路行走 | **O(k)** | k = 邻居数，HashMap 查找 |
| 启发式评分 | **O(1)/条** | 固定 top-50，不随 n 增长 |
| 模型重排 | **O(50)** | 固定候选数，前向传播 ~1ms |

1万条记忆的典型检索延迟 < 200ms（含模型加载约 2-3s 首次）。

---

## 目录结构

```
distill-me/
├── SKILL.md                           # Claude Code 技能入口
├── README.md                          # 本文件
├── package.json                       # Node.js 依赖
├── requirements.txt                   # Python 依赖
├── .gitignore
├── prompts/
│   ├── intake.md                      # 用户信息采集模板
│   ├── distiller.md                   # 人格蒸馏 prompt
│   ├── memory-extractor.md            # 记忆提取 prompt
│   ├── persona-builder.md             # Skill 生成 prompt
│   └── conversation-system.md         # 运行时 system prompt 模板
├── tools/
│   ├── ingest.mjs                     # 数据扫描和初始化
│   ├── memory-writer.mjs              # 记忆文件创建
│   ├── memory-retriever.mjs           # 四层检索管线
│   ├── memory-walker.mjs              # 链路行走 + 图缓存
│   ├── memory-consolidator.mjs        # 记忆淘汰/合并/统计
│   ├── persona-generator.mjs          # 生成 profile + SKILL.md
│   └── session-manager.mjs            # 对话管理、记忆提取、索引重建
├── model/
│   ├── embedder.py                    # sentence-transformers + FAISS
│   ├── linker.py                      # 410K MLP 记忆评分器
│   ├── trainer.py                     # 在线训练
│   └── cold_start.py                  # 冷启动 + 启发式链接
├── lib/
│   ├── memory-format.mjs              # YAML+MD 解析
│   ├── graph.mjs                      # 图操作
│   └── utils.mjs                      # 工具函数
└── test/
    └── run-tests.mjs                  # 端到端测试套件
```

---

## 典型使用流程

```
                    ┌─────────────┐
                    │  个人数据    │  聊天记录、日记、笔记...
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  蒸馏阶段    │  ingest → distiller → memory-extractor
                    │  (一次性)    │  → embedder → cold_start → persona-generator
                    └──────┬──────┘
                           │
              ┌────────────▼────────────┐
              │  对话阶段 (持续)          │
              │                          │
              │  用户消息                  │
              │    → memory-retriever     │  O(log n) 检索
              │    → memory-walker        │  链路行走
              │    → session-manager      │  组装 <memory> prompt
              │    → Claude 回复          │
              │    → extract <new-memory> │  选择性提取（压缩摘要）
              │    → log-feedback         │  记录训练数据
              └────────────┬─────────────┘
                           │
              ┌────────────▼────────────┐
              │  维护阶段 (定期)          │
              │                          │
              │  consolidator stats      │  检查记忆健康
              │  consolidator prune      │  淘汰衰减记忆
              │  consolidator merge      │  合并相似记忆
              │  rebuild-index           │  重建索引
              │  trainer train           │  在线训练模型
              └─────────────────────────┘
```

---

## 测试

```bash
# 运行完整端到端测试（约 3-5 分钟，含模型加载）
node test/run-tests.mjs
```

测试会创建临时 persona，依次验证：

1. 目录初始化 → 7 个分类文件夹
2. 记忆写入 → YAML 前缀 + ID 生成 + 文件解析
3. FAISS 索引 → 构建 + 查询 top-K
4. 冷启动 → 启发式链接生成 + 权重初始化
5. 四层检索 → 嵌入 + 启发式评分 + 排序验证
6. 对话管线 → prompt 组装 + 记忆提取 + 反馈日志 + 索引重建
7. 生命周期 → 统计 + 衰减淘汰 + 长尾衰减数学验证

测试结束后自动清理临时数据。

## 限制

- 数字分身质量取决于输入数据的丰富程度，数据越多越立体
- 在线模型需要 3-5 次对话才产生有意义的改进
- 记忆提取依赖 LLM 分析，可能有遗漏或误读
- 首次加载 sentence-transformers 模型约需数秒
- 所有数据纯本地存储，不涉及网络传输

## 版本

- **v1.0.0** (2026-04-02)：初始版本
  - 分级文件夹记忆系统 + 链路图谱
  - FAISS HNSW O(log n) 向量检索 + 图缓存 O(1) 加载
  - 410K 参数在线学习 MLP
  - 长尾幂律衰减（重要记忆 10 年保留 86%+）
  - 选择性记忆写入（压缩摘要，非原文）
  - 记忆生命周期管理（衰减淘汰 + 相似合并）
  - Claude Code Skill 集成
