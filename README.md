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

### 增量更新（上传新文件后一键更新）

当你往数据文件夹添加了新文件或修改了已有文件，一条命令即可增量更新：

```
/distill-me update "小明" --data-folder /path/to/data
```

系统会：
1. **对比文件 hash**，找出新增和修改的文件（不会重复处理已有的）
2. **逐个分析**新文件，提取记忆
3. **自动重建索引**（FAISS + links + daemon cache）
4. 如果新材料揭示了新的人格信息，自动更新 profile + SKILL.md
5. **记录处理状态**，下次只处理新的增量

也可以手动检查哪些文件是新的：

```bash
node tools/ingest.mjs diff xiaoming /path/to/data
```

### 编辑人格和记忆

创建完成后，随时可以用 `persona-editor` 修改：

```bash
# 查看/修改 profile
node tools/persona-editor.mjs profile get xiaoming
node tools/persona-editor.mjs profile get xiaoming --path "communication.humor_level"
node tools/persona-editor.mjs profile set xiaoming --path "communication.humor_level" --value 0.8
node tools/persona-editor.mjs profile set xiaoming --json '{"speaking_style": {"verbosity": "moderate"}}'

# 增删改记忆（自动重建索引）
node tools/persona-editor.mjs memory add xiaoming experiences "new-trip" \
  --body "2026年春天去了杭州，西湖边散步很舒服。" --importance 0.7 --tags "travel,hangzhou"
node tools/persona-editor.mjs memory edit xiaoming exp-new-trip-001 --importance 0.8
node tools/persona-editor.mjs memory delete xiaoming exp-new-trip-001
node tools/persona-editor.mjs memory list xiaoming --category experiences --sort importance
node tools/persona-editor.mjs memory show xiaoming exp-new-trip-001

# 添加/删除身份
node tools/persona-editor.mjs profile add-facet xiaoming teacher \
  --json '{"label":"老师身份", "context_triggers":["上课","学生"], "communication":{"formality":0.7}}'
node tools/persona-editor.mjs profile remove-facet xiaoming teacher

# 手动全量同步（重建索引 + 重新生成 SKILL.md）
node tools/persona-editor.mjs sync xiaoming
```

每次 memory add/edit/delete 自动级联：rebuild FAISS → regenerate links → invalidate daemon cache。
每次 profile set 自动级联：regenerate SKILL.md + identity files。

### 设置对话者身份

数字分身需要知道"谁在跟我说话"，才能调整语气和称呼。

**注册对话者：**

```bash
# 注册（第一个注册的用户自动成为默认对话者）
node tools/persona-editor.mjs user add xiaoming mom --name "妈妈" --relation "母亲" --notes "经常打电话关心学习"
node tools/persona-editor.mjs user add xiaoming bestfriend --name "小李" --relation "大学室友"

# 查看已注册用户和默认用户
node tools/persona-editor.mjs user list xiaoming

# 切换默认对话者（之后 compose 自动使用）
node tools/persona-editor.mjs user set-default xiaoming mom

# 清除默认（退回匿名）
node tools/persona-editor.mjs user set-default xiaoming none

# 删除用户
node tools/persona-editor.mjs user remove xiaoming bestfriend
```

**在 Claude Code 中使用：**

设置好默认用户后，每次对话自动生效——不需要额外操作。`compose` 会自动从 `config.json` 读取 `default_user`，注入 `<user>` 标签到记忆上下文中。

如果需要临时切换身份，可以在 compose 命令中手动指定：

```bash
node tools/session-manager.mjs compose xiaoming "最近怎么样" --user bestfriend
```

**优先级：** `--user` 参数 > `config.default_user` > 匿名 `"user"`

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

### 记忆检索：四层管线 + log(n) 自适应

注入的记忆总量随记忆库大小**对数增长**：seeds (固定 5 条) + walk (~log₂(n) 条)。

| 记忆库大小 n | log₂(n) | seeds | walk | 总注入 |
|-------------|---------|-------|------|--------|
| 50 | 6 | 5 | ~6 | ~11 |
| 200 | 8 | 5 | ~8 | ~13 |
| 1000 | 10 | 5 | ~10 | ~15 |
| 10000 | 14 | 5 | ~14 | ~19 |

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
  │ 取 top-5 作为种子                     │
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
  │ 第四层：多层链路行走                   │
  │ 从 5 个种子出发，BFS 深度 = log₂(n)   │
  │ 每跳 score 乘法衰减（远端记忆得分低） │
  │ softmax 采样 ~log₂(n) 条              │
  │ token 预算 ~2000                      │
  └──────────────┬───────────────────────┘
                 │
                 ▼
         注入到 <memory> + <user> 标签
         送入 Claude 生成回复
```

**为什么 log(n)**：walk 深度 log₂(n) 保证图上任意节点在理论上都可达（类似小世界网络）。记忆越多，注入越多但增长缓慢，不会爆 context。

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
# 查看训练数据统计
python3 model/train_linker.py ~/.claude/distill_me/xiaoming --info

# 手动触发训练（需要至少 20 条 feedback 数据）
python3 model/train_linker.py ~/.claude/distill_me/xiaoming --epochs 20
```

---

## 完整工具参考

### Node.js 工具 (`tools/`)

| 命令 | 说明 |
|------|------|
| `node tools/ingest.mjs scan <folder>` | 扫描数据文件夹，报告文件统计 |
| `node tools/ingest.mjs init <slug>` | 初始化 persona 目录结构 |
| `node tools/ingest.mjs read-chunk <file> [--offset N] [--limit N]` | 分块读取文件供 LLM 分析 |
| `node tools/ingest.mjs diff <slug> <data-folder>` | 找出新增/修改的文件（hash 对比） |
| `node tools/ingest.mjs mark-done <slug> <data-folder>` | 记录当前文件为已处理 |
| `node tools/persona-editor.mjs profile get <slug> [--path "field"]` | 读取 profile（完整或指定字段） |
| `node tools/persona-editor.mjs profile set <slug> --path "field" --value V` | 修改 profile 字段 + 自动重新生成 SKILL.md |
| `node tools/persona-editor.mjs profile set <slug> --json '{...}'` | 深度合并 JSON 到 profile |
| `node tools/persona-editor.mjs profile add-facet <slug> <key> --json '{...}'` | 添加身份 facet |
| `node tools/persona-editor.mjs profile remove-facet <slug> <key>` | 删除身份 facet |
| `node tools/persona-editor.mjs memory add <slug> <cat> <topic> --body "..." [--importance N] [--tags "a,b"]` | 创建记忆 + 自动重建索引 |
| `node tools/persona-editor.mjs memory edit <slug> <id> [--body "..."] [--importance N]` | 编辑记忆 + 自动重建索引 |
| `node tools/persona-editor.mjs memory delete <slug> <id>` | 删除记忆 + 自动重建索引 |
| `node tools/persona-editor.mjs memory list <slug> [--category C] [--sort importance\|created]` | 列出记忆 |
| `node tools/persona-editor.mjs memory show <slug> <id>` | 查看记忆完整内容 |
| `node tools/persona-editor.mjs user add <slug> <id> [--name N] [--relation R] [--notes N]` | 注册对话者 |
| `node tools/persona-editor.mjs user list <slug>` | 列出已注册对话者 |
| `node tools/persona-editor.mjs user remove <slug> <id>` | 删除对话者 |
| `node tools/persona-editor.mjs sync <slug>` | 手动全量同步（索引+SKILL） |
| `node tools/memory-writer.mjs <slug> <category> <topic> --body "..." [--type T] [--importance N] [--tags "a,b"]` | 低层：创建记忆文件（不触发同步） |
| `node tools/memory-retriever.mjs <slug> "<query>" [--top-k 8] [--phase start\|middle\|deep]` | 检索记忆 |
| `node tools/memory-walker.mjs <slug> --seeds "id1,id2" [--max-nodes 5] [--min-strength 0.15]` | 沿链路行走 |
| `node tools/persona-generator.mjs <slug>` | 生成 SKILL.md + identity files |
| `node tools/persona-generator.mjs <slug> --summary` | 输出人格摘要 |
| `node tools/session-manager.mjs compose <slug> "<msg>" [--phase P] [--user <id>]` | 组装带记忆的 prompt（含用户身份） |
| `node tools/session-manager.mjs extract <slug> "<response>"` | 从 AI 回复中提取 `<new-memory>` |
| `node tools/session-manager.mjs save-memory <slug> <cat> <topic> "<body>"` | 保存对话记忆 |
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
| `python3 model/embed_daemon.py [--socket /tmp/distillme_embed.sock]` | 启动嵌入守护进程（自动管理，通常不需手动启动） |
| `python3 model/linker.py info` | 打印模型参数信息 |
| `python3 model/linker.py rerank <persona_dir>` | 模型重排（stdin 传入 JSON） |
| `python3 model/train_linker.py <persona_dir> [--epochs 20] [--lr 1e-3]` | 从 feedback 日志训练 linker |
| `python3 model/train_linker.py <persona_dir> --info` | 查看训练数据统计 |
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
├── identities/            # 身份配置文件（按需加载）
│   ├── phd_student.md
│   └── ...
├── model/
│   ├── linker_weights.pt  # 训练后的 MLP 权重
│   └── train_meta.json    # 最近一次训练的元数据
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

**嵌入守护进程**：首次调用自动启动 `embed_daemon.py`，通过 Unix socket 常驻内存，消除每次 Python 冷启动的 ~13s 开销。多个 Node 进程共享同一个守护进程。

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
│   ├── persona-editor.mjs             # 统一编辑入口（profile + 记忆 + 自动同步）
│   ├── persona-generator.mjs          # 生成 SKILL.md + 身份文件
│   ├── memory-writer.mjs              # 记忆文件创建/编辑/删除
│   ├── memory-retriever.mjs           # 四层检索管线
│   ├── memory-walker.mjs              # 链路行走 + 图缓存
│   ├── memory-consolidator.mjs        # 记忆淘汰/合并/统计
│   └── session-manager.mjs            # 对话管理、记忆提取、索引重建
├── model/
│   ├── embedder.py                    # sentence-transformers + FAISS
│   ├── embed_daemon.py                # 嵌入守护进程（消除冷启动）
│   ├── embed-client.mjs               # Node 端守护进程客户端
│   ├── linker.py                      # 410K MLP 记忆评分器
│   ├── train_linker.py                # linker 训练脚本
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
              │  用户消息 + 用户身份       │
              │    → memory-retriever     │  5 seeds (FAISS + 启发式)
              │    → memory-walker        │  log₂(n) 层 BFS 行走
              │    → session-manager      │  组装 <user> + <memory>
              │    → Claude 回复          │
              │    → extract <new-memory> │  选择性提取（压缩摘要）
              │    → log-feedback         │  记录训练数据
              └────────────┬─────────────┘
                           │
              ┌────────────▼────────────┐
              │  维护阶段 (按需)          │
              │                          │
              │  persona-editor          │  编辑 profile/记忆/用户
              │  ingest diff + update    │  增量导入新数据
              │  consolidator prune      │  淘汰衰减记忆
              │  consolidator merge      │  合并相似记忆
              │  train_linker.py         │  训练 linker 模型
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
- 首次加载 sentence-transformers 模型约需数秒（后续由守护进程常驻，毫秒级响应）
- 所有数据纯本地存储，不涉及网络传输

## 版本

- **v1.2.0** (2026-04-03/04)：嵌入守护进程 + 个性数据热更新 + 自适应检索
  - 嵌入守护进程 (`embed_daemon.py`)：Unix socket 常驻，消除 ~13s/次 Python 冷启动，compose 延迟从 79s 降至 ~6s
  - `persona-editor.mjs`：统一的 profile + 记忆 + 用户编辑 CLI，修改后自动级联更新
  - 对话者身份：`user add/list/remove` 注册对话者，compose 时 `--user <id>` 注入身份信息，影响语气和记忆检索
  - log(n) 自适应检索：seeds 固定 5 条 + 多层 BFS walk 深度 log₂(n)，总注入量随记忆库对数增长
  - 增量更新：`ingest.mjs diff/mark-done` 通过 SHA-256 hash 检测新增/修改文件，`/distill-me update` 一键更新
  - `train_linker.py`：从 feedback 日志训练 linker MLP（支持 class-weighted BCE、early stopping）
  - linker 兼容新增记忆：输入是 embedding 对而非固定 ID，新记忆无需 retrain 即可被评分
  - 说话风格参数化：`profile.speaking_style` 控制长度限制、决策树、沉默行为
  - 身份系统外置：facet 配置文件从 SKILL.md 内联改为 `identities/*.md` 按需加载
- **v1.1.0** (2026-04-03)：身份系统 + 说话哲学
  - 身份系统：每个 persona 可定义多个社会身份（博士生、主播、项目leader等），支持继承(`variant_of`)和混合(`mix_of`)
  - 说话哲学：记忆是潜意识而非台词——注入的记忆塑造行为但不被复述，大部分无关记忆应被忽略
  - 记忆检索随机性：softmax 加权采样替代确定性 top-K，保底前3条 + 随机采样其余
  - 链路行走随机性：BFS 结果经 softmax 采样，同一查询不同次返回不同组合
  - 身份配置可在对话中缓慢修改（每次对话最多1个值，每天最多10个值）
- **v1.0.0** (2026-04-02)：初始版本
  - 分级文件夹记忆系统 + 链路图谱
  - FAISS HNSW O(log n) 向量检索 + 图缓存 O(1) 加载
  - 410K 参数在线学习 MLP
  - 长尾幂律衰减（重要记忆 10 年保留 86%+）
  - 选择性记忆写入（压缩摘要，非原文）
  - 记忆生命周期管理（衰减淘汰 + 相似合并）
  - Claude Code Skill 集成
