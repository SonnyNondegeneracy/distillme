---
name: distill-me
description: "DistillMe — 从个人数据中蒸馏出立体的、有记忆的、会持续学习的数字分身。/ Distill your digital persona from personal data with memory and continuous learning."
argument-hint: "create|chat|list|update \"<name>\" [--data-folder <path>]"
version: "1.0.0"
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent
---

# DistillMe — 蒸馏你的数字分身 / Distill Your Digital Persona

> 从个人数据中蒸馏出立体的、有记忆的、会持续学习的数字分身。

## 触发条件 / Trigger Conditions

- `/distill-me create "<name>" --data-folder <path>` — 从数据文件夹创建数字分身
- `/distill-me create "<name>"` — 无数据文件夹，通过问答创建
- `/distill-me chat "<name>"` — 与已有数字分身对话
- `/distill-me list` — 列出所有数字分身
- `/distill-me update "<name>" --data-folder <path>` — 追加数据更新记忆
- "创建数字分身" / "Create digital persona" / "Distill me"

## 语言 / Language

支持中英文。根据用户首条消息语言全程保持一致。

## 创建工作流 / Creation Workflow

### 命令格式

```
/distill-me create "小明" --data-folder /path/to/data
```

### Step 1: 数据扫描

```bash
node ${CLAUDE_SKILL_DIR}/tools/ingest.mjs scan "<data-folder>"
```

显示文件统计（文本、JSON、CSV、图片数量），预览文本文件内容。

### Step 2: 初始化目录

```bash
node ${CLAUDE_SKILL_DIR}/tools/ingest.mjs init "<slug>"
```

在 `~/.claude/distill_me/<slug>/` 下创建完整目录结构。

### Step 3: 人格提取

使用 `prompts/distiller.md` 提示词，将原始材料喂给 Claude 分析，输出 `profile.json`。

对每个文本文件：
```bash
node ${CLAUDE_SKILL_DIR}/tools/ingest.mjs read-chunk "<file>" --offset 0 --limit 4000
```

分块读取后使用 `prompts/distiller.md` 分析人格特征。

### Step 4: 记忆提取

使用 `prompts/memory-extractor.md` 提示词，从每段材料中提取离散记忆。

每条提取的记忆通过 memory-writer 写入：
```bash
node ${CLAUDE_SKILL_DIR}/tools/memory-writer.mjs "<slug>" "<category>" "<topic>" --body "..." --type episodic --importance 0.8 --tags "tag1,tag2"
```

### Step 5: 建立索引和链接

```bash
# 建立 FAISS 向量索引
python3 ${CLAUDE_SKILL_DIR}/model/embedder.py build \
  "~/.claude/distill_me/<slug>/memories" \
  "~/.claude/distill_me/<slug>"

# 冷启动链接生成（基于嵌入相似度 + 实体共现）
python3 ${CLAUDE_SKILL_DIR}/model/cold_start.py \
  "~/.claude/distill_me/<slug>"
```

### Step 6: 生成技能

```bash
node ${CLAUDE_SKILL_DIR}/tools/persona-generator.mjs "<slug>"
```

在 `~/.claude/skills/<slug>/SKILL.md` 生成可调用的数字分身技能。

### Step 7: 预览确认

显示摘要，用户确认/修改/取消。

### Step 8: 记录已处理文件

```bash
node ${CLAUDE_SKILL_DIR}/tools/ingest.mjs mark-done "<slug>" "<data-folder>"
```

将当前文件状态（hash）记录到 `ingest_log.json`，后续 update 时用于比对。

## 增量更新工作流 / Update Workflow

```
/distill-me update "小明" --data-folder /path/to/data
```

当用户上传了新文件或修改了已有文件，一键增量更新。

### Step 1: 检测变更

```bash
node ${CLAUDE_SKILL_DIR}/tools/ingest.mjs diff "<slug>" "<data-folder>"
```

输出新增和修改的文件列表（通过 SHA-256 hash 对比，不依赖时间戳）。
如果 `to_process` 为 0，提示"没有新内容"并结束。

### Step 2: 读取并提取新记忆

对每个新增/变更的文件，分块读取：

```bash
node ${CLAUDE_SKILL_DIR}/tools/ingest.mjs read-chunk "<file>" --offset 0 --limit 4000
```

使用 `prompts/memory-extractor.md` 提取记忆。每条记忆通过 persona-editor 写入（自动触发索引重建）：

```bash
node ${CLAUDE_SKILL_DIR}/tools/persona-editor.mjs memory add "<slug>" "<category>" "<topic>" \
  --body "..." --importance 0.8 --tags "tag1,tag2" --type episodic
```

### Step 3: 更新人格（可选）

如果新材料揭示了之前不知道的人格特征（新兴趣、新交流习惯、态度变化），用 persona-editor 更新 profile：

```bash
node ${CLAUDE_SKILL_DIR}/tools/persona-editor.mjs profile set "<slug>" --json '{"values": {"interests": [...]}}'
```

这会自动重新生成 SKILL.md。

**注意**：只在新材料确实包含新人格信息时才更新 profile。日常记忆不需要改 profile。

### Step 4: 记录已处理

```bash
node ${CLAUDE_SKILL_DIR}/tools/ingest.mjs mark-done "<slug>" "<data-folder>"
```

### Step 5: 报告

输出本次更新的摘要：新增了多少条记忆、是否更新了 profile、当前记忆总数。

## 对话工作流 / Chat Workflow

```
/distill-me chat "小明"
```

### 对话流程

1. **加载 SKILL.md** — 人格身份和交流风格
2. **记忆检索** — 根据用户消息检索相关记忆

```bash
node ${CLAUDE_SKILL_DIR}/tools/memory-retriever.mjs "<slug>" "<query>" --top-k 8 --phase middle
```

3. **链路行走** — 沿记忆链接扩展关联记忆

```bash
node ${CLAUDE_SKILL_DIR}/tools/memory-walker.mjs "<slug>" --seeds "id1,id2,id3" --max-nodes 5
```

4. **组装 prompt** — 注入 `<memory>` 标签
5. **生成回复** — Claude 以人格身份回复
6. **后处理** — 提取新记忆、记录训练数据、触发在线训练

### 记忆注入格式

```xml
<memory id="exp-summer-trip-001" category="experiences" importance="0.8" type="episodic">
2024年夏天去了云南旅行...
</memory>
```

### AI 主动请求记忆

AI 可输出：
```xml
<request-memory id="rel-family-mom-001" reason="用户提到了妈妈" />
```

系统自动检索并在下一轮注入。

### 新记忆生成

AI 在回复末尾输出：
```xml
<new-memory category="conversations" topic="topic-slug" importance="0.6" tags="tag1,tag2">
记忆内容
</new-memory>
```

session-manager 自动保存为新记忆文件。

## 记忆系统 / Memory System

### 分级文件夹结构

```
memories/
├── identity/          # 核心身份：价值观、性格、自我描述
├── relationships/     # 人际关系（可含子文件夹：family/, friends/）
├── experiences/       # 经历记忆（可按年份组织：2024/, 2025/）
├── knowledge/         # 领域知识和专业技能
├── opinions/          # 观点和偏好
├── habits/            # 行为模式和日常习惯
└── conversations/     # 对话中自动产生的新记忆
```

### 记忆文件格式

```markdown
---
id: "exp-summer-trip-001"
type: episodic
created: "2026-04-02T15:30:00Z"
importance: 0.8
tags: ["travel", "family"]
source: "chat_logs/2024-08.txt"
links:
  - id: "rel-family-mom-001"
    relation: "involves"
    strength: 0.9
  - id: "emo-happiness-travel-001"
    relation: "evokes"
    strength: 0.7
---

# 2024年夏天旅行

我们全家去了云南旅行，在大理住了一周...
```

### 检索管线

**第一层：FAISS 向量检索** — O(log n)，HNSW 索引

**第二层：启发式评分**（始终可用）
```
score = 0.40 * embedding_similarity
      + 0.20 * keyword_match
      + 0.15 * importance
      + 0.10 * recency
      + 0.15 * type_boost
```

**第三层：模型重排**（训练后可用）
- 410K 参数 MLP，冻结 sentence-transformer 底座
- 在线训练，对话隐式反馈

**第四层：链路行走**
- 从 top-8 记忆沿 links 扩展 3-5 条关联记忆

## 在线学习模型 / Online Learning Model

### 架构

```
对话上下文 → frozen encoder → 384维 ─┐
                                      ├─ concat [A; B; A*B; |A-B|] → MLP → score
候选记忆   → frozen encoder → 384维 ─┘

MLP: Linear(1536,256) → ReLU → Linear(256,64) → ReLU → Linear(64,1) → Sigmoid
底座: paraphrase-multilingual-MiniLM-L12-v2
可训练参数: ~410K
```

### 训练信号

- 正：被检索 + 用户继续对话
- 弱负：被检索 + 对话转向
- 强负：用户纠正"你记错了"

### 冷启动

初始权重 ≈ 余弦相似度输出。无训练时完全退化为启发式检索，不影响体验。

## 工具一览 / Tool Reference

| 工具 | 用途 |
|------|------|
| `tools/ingest.mjs` | 扫描数据文件夹、初始化目录、分块读取文件 |
| `tools/memory-writer.mjs` | 创建记忆文件 |
| `tools/memory-retriever.mjs` | 检索记忆（FAISS + 启发式 + 模型） |
| `tools/memory-walker.mjs` | 沿链路行走获取关联记忆 |
| `tools/persona-generator.mjs` | 生成 profile 和 SKILL.md |
| `tools/session-manager.mjs` | 管理对话状态、记忆注入、对话记忆提取、索引重建 |
| `tools/memory-consolidator.mjs` | 记忆生命周期管理：统计、衰减淘汰、相似合并 |
| `model/embedder.py` | 文本嵌入和 FAISS 索引 |
| `model/linker.py` | 记忆链接评分模型 |
| `model/trainer.py` | 在线训练 |
| `model/cold_start.py` | 冷启动初始化和启发式链接生成 |

## 数据存储 / Data Locations

| 内容 | 路径 |
|------|------|
| 人格档案 | `~/.claude/distill_me/{slug}/profile.json` |
| 运行配置 | `~/.claude/distill_me/{slug}/config.json` |
| 记忆文件 | `~/.claude/distill_me/{slug}/memories/` |
| 向量索引 | `~/.claude/distill_me/{slug}/index.faiss` |
| 模型权重 | `~/.claude/distill_me/{slug}/model/linker_weights.pt` |
| 技能文件 | `~/.claude/skills/{slug}/SKILL.md` |

## 管理命令 / Management

```bash
# 列出所有数字分身
ls ~/.claude/distill_me/

# 查看某个分身的记忆统计
find ~/.claude/distill_me/<slug>/memories -name "*.md" | wc -l

# 删除数字分身
rm -rf ~/.claude/distill_me/<slug> ~/.claude/skills/<slug>
```

## 限制 / Limitations

1. 数字分身的质量取决于输入数据的丰富程度
2. 在线模型需要 3-5 次对话才能开始产生有意义的改进
3. 记忆提取依赖 LLM 分析，可能有遗漏或误解
4. 首次加载 sentence-transformers 模型约需数秒
5. 隐私注意：所有数据存储在本地，不上传

## 版本 / Version

- **v1.0.0** (2026-04-02): 初始版本
  - 分级文件夹记忆系统
  - FAISS 向量检索 + 启发式评分
  - 在线训练 MLP 链接评分器
  - 记忆图谱链路行走
  - 长尾幂律衰减 + 记忆生命周期管理
  - Claude Code 技能集成
