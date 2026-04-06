<div align="center">

# DistillMe

### A digital persona engine with memory, forgetting, and growth

*"The thousandth message should sound just as much like you as the first."*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://www.python.org/downloads/)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Skill-blueviolet)](https://claude.ai/code)
[![AgentSkills](https://img.shields.io/badge/AgentSkills-Standard-green)](https://agentskills.io)

[Quick Start](#quick-start) · [Core Concepts](#core-concepts) · [Tool Reference](#full-tool-reference) · [中文](README.md)

</div>

---

## What Is This

Feed it your chat logs, diaries, and notes. It distills a digital persona with a **memory graph, natural forgetting, and continuous learning from conversations**.

Stuffing a persona description into the system prompt is trivial — but what happens after ten messages? What about when memories pile up? How do you stay in-character at message #1000?

That's the problem DistillMe solves. Its core isn't a persona description — it's a complete **memory retrieval pipeline**:

> FAISS O(log n) vector search → heuristic scoring → MLP re-ranking → memory graph walking → inject ~log₂(n) most relevant memories

10K memories, retrieval < 200ms. Important memories retain 86% after 10 years; trivial details naturally fade. Every conversation implicitly trains a 410K-parameter model to make retrieval better over time.

> **Want your digital twin to speak?** 👉 [DistillMe VTuber](https://github.com/SonnyNondegeneracy/DistillMe-VTuber) — 3D avatar + voice cloning + livestream chat, a multimodal frontend built on DistillMe.
>
> **Want your digital twin to teach?** 👉 [DistillMe Teacher](https://github.com/SonnyNondegeneracy/distill-me-teacher) — Knowledge retrieval + LaTeX blackboard + lesson plans + voice lectures, an AI teaching system built on DistillMe.

## Quick Start

### Prerequisites

```bash
# Node.js (>=18)
node --version

# Python (>=3.10) + dependencies
pip install torch sentence-transformers faiss-cpu pyyaml numpy

# Node dependencies
npm install
```

### Create a Persona

**Option 1: From a data folder**

Prepare a folder with personal materials. Supported formats:
- `.txt` `.md` `.log` `.rst` — Plain text (chat logs, notes, diaries)
- `.json` — Structured data (WeChat exports, app data)
- `.csv` — Tabular data

Then run in Claude Code:

```
/distill-me create "Alice" --data-folder /path/to/data
```

The system will: scan files → distill personality → extract memories → build index → generate links → generate Skill.

**Option 2: Manual creation (no data folder)**

```bash
# 1. Initialize directory
node tools/ingest.mjs init alice

# 2. Write memories one by one
node tools/memory-writer.mjs alice identity core-values \
  --body "I value authenticity and creativity. I prefer depth over breadth." \
  --type semantic --importance 0.95 --tags "values,personality"

node tools/memory-writer.mjs alice relationships best-friend \
  --body "Met Jamie in college. We still play games together every week." \
  --type emotional --importance 0.8 --tags "friendship"

node tools/memory-writer.mjs alice experiences graduation \
  --body "Graduated from MIT in 2023 with a physics degree. Mom cried at the ceremony." \
  --type episodic --importance 0.85 --tags "milestone,family"

# 3. Write profile.json manually (see format below)

# 4. Build index
python3 model/embedder.py build \
  ~/.claude/distill_me/alice/memories \
  ~/.claude/distill_me/alice

# 5. Generate links
python3 model/cold_start.py generate-links ~/.claude/distill_me/alice

# 6. Generate Skill
node tools/persona-generator.mjs alice
```

### Incremental Update (one-command update after uploading new files)

When you add new files or modify existing ones in the data folder, a single command handles the incremental update:

```
/distill-me update "Alice" --data-folder /path/to/data
```

The system will:
1. **Compare file hashes** to find new and changed files (won't reprocess existing ones)
2. **Analyze each new file** and extract memories
3. **Auto-rebuild indexes** (FAISS + links + daemon cache)
4. If new material reveals personality insights, auto-update profile + SKILL.md
5. **Record processing state** so next time only new increments are processed

You can also manually check which files are new:

```bash
node tools/ingest.mjs diff alice /path/to/data
```

### Edit Personality and Memories

After creation, use `persona-editor` to modify at any time:

```bash
# View/modify profile
node tools/persona-editor.mjs profile get alice
node tools/persona-editor.mjs profile get alice --path "communication.humor_level"
node tools/persona-editor.mjs profile set alice --path "communication.humor_level" --value 0.8
node tools/persona-editor.mjs profile set alice --json '{"speaking_style": {"verbosity": "moderate"}}'

# Add/edit/delete memories (auto-rebuilds index)
node tools/persona-editor.mjs memory add alice experiences "new-trip" \
  --body "Went to Kyoto in spring 2026. The cherry blossoms were stunning." --importance 0.7 --tags "travel,kyoto"
node tools/persona-editor.mjs memory edit alice exp-new-trip-001 --importance 0.8
node tools/persona-editor.mjs memory delete alice exp-new-trip-001
node tools/persona-editor.mjs memory list alice --category experiences --sort importance
node tools/persona-editor.mjs memory show alice exp-new-trip-001

# Add/remove identity facets
node tools/persona-editor.mjs profile add-facet alice teacher \
  --json '{"label":"Teacher", "context_triggers":["class","students"], "communication":{"formality":0.7}}'
node tools/persona-editor.mjs profile remove-facet alice teacher

# Manual full sync (rebuild index + regenerate SKILL.md)
node tools/persona-editor.mjs sync alice
```

Every memory add/edit/delete auto-cascades: rebuild FAISS → regenerate links → invalidate daemon cache.
Every profile set auto-cascades: regenerate SKILL.md + identity files.

### Set Up Conversation Partner Identity

The digital persona needs to know "who is talking to me" to adjust tone and address.

**Register a conversation partner:**

```bash
# Register (the first registered user automatically becomes the default)
node tools/persona-editor.mjs user add alice mom --name "Mom" --relation "mother" --notes "Always calls to check on studies"
node tools/persona-editor.mjs user add alice bestfriend --name "Jamie" --relation "college roommate"

# View registered users and default user
node tools/persona-editor.mjs user list alice

# Switch default conversation partner (compose auto-uses this)
node tools/persona-editor.mjs user set-default alice mom

# Clear default (revert to anonymous)
node tools/persona-editor.mjs user set-default alice none

# Delete a user
node tools/persona-editor.mjs user remove alice bestfriend
```

**Usage in Claude Code:**

After setting up the default user, every conversation automatically uses it — no extra steps needed. `compose` auto-reads `default_user` from `config.json` and injects a `<user>` tag into the memory context.

To temporarily switch identity, you can manually specify in the compose command:

```bash
node tools/session-manager.mjs compose alice "How have you been?" --user bestfriend
```

**Priority:** `--user` parameter > `config.default_user` > anonymous `"user"`

### Chat with Your Persona

Once created, invoke directly in Claude Code:

```
/alice What have you been up to lately?
```

---

## Core Concepts

### Memory System

Memories are stored in a hierarchical folder structure. Each memory is a Markdown file with YAML frontmatter for metadata:

```
memories/
├── identity/          # Core identity: values, personality, self-description
├── relationships/     # Interpersonal relationships (nestable subfolders)
│   ├── family/
│   └── friends/
├── experiences/       # Life experiences (organizable by year)
│   ├── 2023/
│   └── 2024/
├── knowledge/         # Domain knowledge and skills
├── opinions/          # Views and preferences
├── habits/            # Behavioral patterns
└── conversations/     # Auto-extracted memories from conversations
```

Each memory file:

```markdown
---
id: "exp-yunnan-trip-001"
type: episodic              # episodic | semantic | procedural | emotional
created: "2026-04-02T15:30:00Z"
importance: 0.8             # 0-1, affects retrieval priority
tags: ["travel", "family", "yunnan"]
source: "chat_logs/2024-08.txt"
links:                      # Related memories — forms a walkable graph
  - id: "rel-family-mom-001"
    relation: "involves"    # involves | evokes | temporal-near | co-entity | related
    strength: 0.9
  - id: "emo-happiness-001"
    relation: "evokes"
    strength: 0.7
---

Went to Yunnan with the whole family in summer 2024. Stayed a week in Dali.
The sunset over Erhai Lake was beautiful. Mom took so many photos.
```

**Key design**: Memories are not isolated files. The `links` field connects them into a **memory graph**. During retrieval, the system can "walk" along links to find semantically related memories that share no keywords.

### Memory Retrieval: Four-Layer Pipeline + log(n) Adaptive Scaling

The total number of injected memories scales **logarithmically** with memory store size: seeds (fixed 5) + walk (~log₂(n)).

| Memory store size n | log₂(n) | seeds | walk | total injected |
|---------------------|---------|-------|------|----------------|
| 50 | 6 | 5 | ~6 | ~11 |
| 200 | 8 | 5 | ~8 | ~13 |
| 1000 | 10 | 5 | ~10 | ~15 |
| 10000 | 14 | 5 | ~14 | ~19 |

```
User message: "Do you remember traveling with your mom?"
         │
         ▼
  ┌──────────────────────────────────────┐
  │ Layer 1: FAISS Vector Search O(log n) │
  │ HNSW index, retrieve top-50 candidates│
  └──────────────┬───────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────┐
  │ Layer 2: Heuristic Scoring            │
  │ score = 0.40 × embedding_similarity   │
  │       + 0.20 × keyword_match          │
  │       + 0.15 × importance             │
  │       + 0.10 × recency                │
  │       + 0.15 × type_boost             │
  │ Select top-5 as seeds                 │
  └──────────────┬───────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────┐
  │ Layer 3: Model Re-ranking (post-train)│
  │ 410K MLP re-ranks top-50              │
  │ Falls back to heuristic on cold start │
  └──────────────┬───────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────┐
  │ Layer 4: Multi-Level Link Walking     │
  │ From 5 seeds, BFS depth = log₂(n)    │
  │ Score decays multiplicatively per hop │
  │ Softmax sampling ~log₂(n) memories   │
  │ Token budget ~2000                    │
  └──────────────┬───────────────────────┘
                 │
                 ▼
         Injected as <memory> + <user> tags
         Fed to Claude for response generation
```

**Why log(n)**: Walk depth log₂(n) ensures any node in the graph is theoretically reachable (like a small-world network). More memories means more injection, but growth is slow — context never explodes.

### Conversational Memory Writing

Not all conversations become memories. The AI is instructed to generate `<new-memory>` tags only when:

| Write | Don't Write |
|-------|-------------|
| User reveals a **previously unknown fact** | Small talk, greetings |
| **Emotionally meaningful** interaction | Repeating known information |
| User **corrects** an existing memory | Pure knowledge Q&A |

Written content is a **compressed 1-3 sentence summary**, never raw conversation copy-paste.

Tag format in AI responses:

```xml
<new-memory category="conversations" topic="mom-health-update" importance="0.6" tags="family,mom">
Mom's recent health checkup didn't go well. User is worried, planning to visit next week.
</new-memory>
```

The system automatically parses and saves to `memories/conversations/`.

### Memory Lifecycle Management

Memories don't grow unbounded. `memory-consolidator.mjs` provides three maintenance operations:

**1. Decay Pruning**

Memories use a **long-tail decay** model instead of exponential decay — important memories are nearly unforgettable:

```
floor        = importance²                    ← higher importance = higher floor
decay_factor = 1 / (1 + days / halflife)      ← power-law decay, not exponential
effective    = importance × (floor + (1 - floor) × decay_factor)
```

| importance | Day 0 | 1 Year | 10 Years | Note |
|------------|-------|--------|----------|------|
| 0.95 | 0.950 | 0.904 | 0.866 | Core memory, retains 91% after 10 years |
| 0.50 | 0.500 | 0.313 | 0.159 | Ordinary memory, gradually fades |
| 0.20 | 0.200 | 0.104 | 0.025 | Trivial detail, near zero after years |

Identity memories are never pruned. Memories are removed when effective importance drops below threshold (default 0.1).

```bash
# Preview what would be pruned (no actual deletion)
node tools/memory-consolidator.mjs prune alice --dry-run

# Execute pruning
node tools/memory-consolidator.mjs prune alice --min-importance 0.1
```

**2. Similarity Merging**

Conversation memories may accumulate duplicates. When two memories have embedding similarity > 0.85, they are merged into one (keeping the higher-importance entry, combining content).

```bash
node tools/memory-consolidator.mjs merge alice --similarity 0.85
```

**3. Stats Report**

```bash
node tools/memory-consolidator.mjs stats alice
```

Example output:
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

### Online Learning Model

A ~410K parameter MLP that learns "which memories are most useful for the current conversation":

```
Conversation context → frozen MiniLM → 384d ─┐
                                               ├─ [A; B; A*B; |A-B|] → MLP → score
Candidate memory     → frozen MiniLM → 384d ─┘
```

- **Backbone**: `paraphrase-multilingual-MiniLM-L12-v2` (frozen, bilingual EN/ZH)
- **Trainable**: 3-layer MLP (1536→256→64→1), only 410K parameters
- **Training signal**: Retrieved memories the user engaged with = positive; retrieved but conversation pivoted away = negative
- **Cold start**: Weights initialized to approximate cosine similarity — never worse than heuristic
- **Training time**: < 5 seconds per session, runs async after each conversation

```bash
# Check training data statistics
python3 model/train_linker.py ~/.claude/distill_me/alice --info

# Manually trigger training (requires at least 20 feedback entries)
python3 model/train_linker.py ~/.claude/distill_me/alice --epochs 20
```

---

## Full Tool Reference

### Node.js Tools (`tools/`)

| Command | Description |
|---------|-------------|
| `node tools/ingest.mjs scan <folder>` | Scan data folder, report file statistics |
| `node tools/ingest.mjs init <slug>` | Initialize persona directory structure |
| `node tools/ingest.mjs read-chunk <file> [--offset N] [--limit N]` | Read file chunks for LLM analysis |
| `node tools/ingest.mjs diff <slug> <data-folder>` | Find new/changed files (hash comparison) |
| `node tools/ingest.mjs mark-done <slug> <data-folder>` | Record current files as processed |
| `node tools/persona-editor.mjs profile get <slug> [--path "field"]` | Read profile (full or specific field) |
| `node tools/persona-editor.mjs profile set <slug> --path "field" --value V` | Modify profile field + auto-regenerate SKILL.md |
| `node tools/persona-editor.mjs profile set <slug> --json '{...}'` | Deep-merge JSON into profile |
| `node tools/persona-editor.mjs profile add-facet <slug> <key> --json '{...}'` | Add identity facet |
| `node tools/persona-editor.mjs profile remove-facet <slug> <key>` | Remove identity facet |
| `node tools/persona-editor.mjs memory add <slug> <cat> <topic> --body "..." [--importance N] [--tags "a,b"]` | Create memory + auto-rebuild index |
| `node tools/persona-editor.mjs memory edit <slug> <id> [--body "..."] [--importance N]` | Edit memory + auto-rebuild index |
| `node tools/persona-editor.mjs memory delete <slug> <id>` | Delete memory + auto-rebuild index |
| `node tools/persona-editor.mjs memory list <slug> [--category C] [--sort importance\|created]` | List memories |
| `node tools/persona-editor.mjs memory show <slug> <id>` | View full memory content |
| `node tools/persona-editor.mjs user add <slug> <id> [--name N] [--relation R] [--notes N]` | Register conversation partner |
| `node tools/persona-editor.mjs user list <slug>` | List registered conversation partners |
| `node tools/persona-editor.mjs user remove <slug> <id>` | Remove conversation partner |
| `node tools/persona-editor.mjs user set-default <slug> <id\|none>` | Set/clear default conversation partner |
| `node tools/persona-editor.mjs sync <slug>` | Manual full sync (index + SKILL) |
| `node tools/memory-writer.mjs <slug> <category> <topic> --body "..." [--type T] [--importance N] [--tags "a,b"]` | Low-level: create memory file (no sync) |
| `node tools/memory-retriever.mjs <slug> "<query>" [--top-k 5] [--phase start\|middle\|deep]` | Retrieve memories |
| `node tools/memory-walker.mjs <slug> --seeds "id1,id2" [--max-nodes 5] [--min-strength 0.15]` | Walk memory links |
| `node tools/persona-generator.mjs <slug>` | Generate SKILL.md + identity files |
| `node tools/persona-generator.mjs <slug> --summary` | Output personality summary |
| `node tools/session-manager.mjs compose <slug> "<msg>" [--phase P] [--user <id>]` | Compose memory-injected prompt (with user identity) |
| `node tools/session-manager.mjs extract <slug> "<response>"` | Extract `<new-memory>` from AI response |
| `node tools/session-manager.mjs save-memory <slug> <cat> <topic> "<body>"` | Save conversation memory |
| `node tools/session-manager.mjs rebuild-index <slug>` | Rebuild FAISS index and links |
| `node tools/session-manager.mjs log-feedback <slug> "<retrieved>" "<used>"` | Log training feedback |
| `node tools/memory-consolidator.mjs stats <slug>` | Memory statistics |
| `node tools/memory-consolidator.mjs prune <slug> [--min-importance 0.1] [--dry-run]` | Decay pruning |
| `node tools/memory-consolidator.mjs merge <slug> [--similarity 0.85] [--dry-run]` | Similarity merging |

### Python Models (`model/`)

| Command | Description |
|---------|-------------|
| `python3 model/embedder.py build <memories_dir> <output_dir>` | Build FAISS vector index |
| `python3 model/embedder.py query <dir> "<query>" [--top-k 50]` | Query vector index |
| `python3 model/embed_daemon.py [--socket /tmp/distillme_embed.sock]` | Start embedding daemon (auto-managed, usually no need to start manually) |
| `python3 model/linker.py info` | Print model parameter info |
| `python3 model/linker.py rerank <persona_dir>` | Model re-ranking (JSON via stdin) |
| `python3 model/train_linker.py <persona_dir> [--epochs 20] [--lr 1e-3]` | Train linker from feedback log |
| `python3 model/train_linker.py <persona_dir> --info` | Check training data statistics |
| `python3 model/cold_start.py init-weights` | Test cold start initialization |
| `python3 model/cold_start.py generate-links <persona_dir>` | Generate heuristic memory links |

---

## Data Storage

All data is stored locally. Nothing is uploaded.

```
~/.claude/distill_me/{slug}/
├── profile.json           # Personality profile
├── config.json            # Runtime config (retrieval params, model params)
├── index.faiss            # HNSW vector index (O(log n) retrieval)
├── index_flat.faiss       # Flat index copy (for reconstruct)
├── index_meta.json        # Vector ID → memory file path mapping
├── graph_cache.json       # Graph cache (O(1) load, avoids per-file scan)
├── identities/            # Identity config files (loaded on demand)
│   ├── phd_student.md
│   └── ...
├── model/
│   ├── linker_weights.pt  # Trained MLP weights
│   └── train_meta.json    # Latest training metadata
├── memories/              # Hierarchical memory folders
│   ├── identity/
│   ├── relationships/
│   ├── experiences/
│   ├── knowledge/
│   ├── opinions/
│   ├── habits/
│   └── conversations/
└── logs/
    └── training_log.jsonl # Training feedback log

~/.claude/skills/{slug}/
└── SKILL.md               # Claude Code discoverable skill entry
```

## profile.json Format

```json
{
  "basic": {
    "name": "Alice",
    "nickname": "Ali",
    "occupation": "Physics grad student",
    "languages": ["English", "Chinese"],
    "location": "Boston"
  },
  "personality": {
    "big_five": {
      "openness": 0.85,
      "conscientiousness": 0.7,
      "extraversion": 0.35,
      "agreeableness": 0.6,
      "neuroticism": 0.3
    },
    "traits": ["curious", "quiet", "persistent"],
    "decision_style": "rational",
    "energy_source": "solitude"
  },
  "communication": {
    "formality": 0.4,
    "humor_level": 0.5,
    "emoji_usage": "rare",
    "tone": "warm but direct",
    "catchphrases": ["interesting", "let me think"],
    "writing_patterns": ["short sentences", "likes ellipses"]
  },
  "values": {
    "core_values": ["authenticity", "creativity"],
    "interests": ["quantum field theory", "coffee", "reading"],
    "strong_opinions": ["remote work is better for deep thinking"]
  },
  "emotional_patterns": {
    "baseline_mood": "calm and focused",
    "triggers": {
      "positive": ["solving hard problems", "deep conversations with friends"],
      "negative": ["frequent interruptions", "superficiality"]
    }
  }
}
```

---

## Performance Guarantees

| Operation | Complexity | Note |
|-----------|-----------|------|
| Vector search | **O(log n)** | HNSW index (auto-enabled at n>=64) |
| Graph cache load | **O(1)** | Single JSON file, no per-file scanning |
| Link walking | **O(k)** | k = neighbor count, HashMap lookup |
| Heuristic scoring | **O(1) per item** | Fixed top-50, doesn't grow with n |
| Model re-ranking | **O(50)** | Fixed candidate set, forward pass ~1ms |

Typical retrieval latency for 10K memories: < 200ms (first load ~2-3s for model initialization).

**Embedding daemon**: On first invocation, `embed_daemon.py` starts automatically and stays resident via Unix socket, eliminating the ~13s Python cold-start overhead per call. Multiple Node processes share a single daemon.

---

## Project Structure

```
distill-me/
├── SKILL.md                           # Claude Code skill entry point
├── README.md                          # Chinese documentation
├── README_EN.md                       # This file
├── package.json                       # Node.js dependencies
├── requirements.txt                   # Python dependencies
├── .gitignore
├── prompts/
│   ├── intake.md                      # User information intake template
│   ├── distiller.md                   # Personality distillation prompt
│   ├── memory-extractor.md            # Memory extraction prompt
│   ├── persona-builder.md             # Skill generation prompt
│   └── conversation-system.md         # Runtime system prompt template
├── tools/
│   ├── ingest.mjs                     # Data scanning and initialization
│   ├── persona-editor.mjs             # Unified edit entry (profile + memories + auto-sync)
│   ├── persona-generator.mjs          # Generate SKILL.md + identity files
│   ├── memory-writer.mjs              # Memory file create/edit/delete
│   ├── memory-retriever.mjs           # Four-layer retrieval pipeline
│   ├── memory-walker.mjs              # Link walking + graph cache
│   ├── memory-consolidator.mjs        # Memory pruning/merging/stats
│   └── session-manager.mjs            # Conversation mgmt, memory extraction, index rebuild
├── model/
│   ├── embedder.py                    # sentence-transformers + FAISS
│   ├── embed_daemon.py                # Embedding daemon (eliminates cold start)
│   ├── embed-client.mjs               # Node-side daemon client
│   ├── linker.py                      # 410K MLP memory scorer
│   ├── train_linker.py                # Linker training script
│   └── cold_start.py                  # Cold start + heuristic linking
├── lib/
│   ├── memory-format.mjs              # YAML+MD parser
│   ├── graph.mjs                      # Graph operations
│   └── utils.mjs                      # Utility functions
└── test/
    └── run-tests.mjs                  # End-to-end test suite
```

---

## Typical Workflow

```
                    ┌─────────────┐
                    │ Personal    │  Chat logs, diaries, notes...
                    │ Data        │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ Distillation│  ingest → distiller → memory-extractor
                    │ (one-time)  │  → embedder → cold_start → persona-generator
                    └──────┬──────┘
                           │
              ┌────────────▼────────────┐
              │  Conversation (ongoing)  │
              │                          │
              │  User message + identity │
              │    → memory-retriever    │  5 seeds (FAISS + heuristic)
              │    → memory-walker       │  log₂(n) level BFS walk
              │    → session-manager     │  compose <user> + <memory>
              │    → Claude response     │
              │    → extract <new-memory>│  selective (compressed summary)
              │    → log-feedback        │  record training data
              └────────────┬─────────────┘
                           │
              ┌────────────▼────────────┐
              │  Maintenance (periodic)  │
              │                          │
              │  persona-editor          │  edit profile/memories/users
              │  ingest diff + update    │  incremental data import
              │  consolidator prune      │  prune decayed memories
              │  consolidator merge      │  merge similar memories
              │  train_linker.py         │  train linker model
              └─────────────────────────┘
```

---

## Testing

```bash
# Run full end-to-end tests (~3-5 minutes, includes model loading)
node test/run-tests.mjs
```

The test suite creates a temporary persona and verifies:

1. Directory initialization → 7 category folders
2. Memory writing → YAML frontmatter + ID generation + file parsing
3. FAISS index → build + top-K query
4. Cold start → heuristic link generation + weight initialization
5. Four-layer retrieval → embedding + heuristic scoring + sort verification
6. Conversation pipeline → prompt composition + memory extraction + feedback logging + index rebuild
7. Lifecycle management → stats + decay pruning + long-tail decay math verification

Temporary data is automatically cleaned up after tests.

## Roadmap

DistillMe's goal goes beyond text chat. The memory graph + persona model architecture is modality-agnostic — the same retrieval pipeline can drive any output form.

### Shipped: DistillMe VTuber

**[DistillMe VTuber](https://github.com/SonnyNondegeneracy/DistillMe-VTuber)** is the first multimodal application built on DistillMe — proving that the memory graph + persona model can drive output beyond text:

- **3D Avatar**: VRM model + expression blending + lip sync + action system
- **Voice Cloning**: CosyVoice TTS, speak in your own voice
- **Livestream Chat**: Concurrent processing pipeline, AI auto-replies to every message in order
- **One-Click Distillation**: Drag & drop materials, fully automated persona extraction → memory indexing → voice cloning

The same four-layer retrieval pipeline, from text chat to VTuber livestream — still sounds like you after the thousandth message.

### Shipped: DistillMe Teacher

**[DistillMe Teacher](https://github.com/SonnyNondegeneracy/distill-me-teacher)** gives your digital twin teaching powers — the same retrieval pipeline drives knowledge-based Q&A and proactive lectures:

- **Knowledge Retrieval**: Upload textbooks/notes, LLM distills them into structured knowledge memories with FAISS vector search
- **LaTeX Blackboard**: Auto-compiled and rendered inline during conversation, pages flip in sync with TTS
- **Lesson Plans**: LLM-generated structured teaching plans, AI proactively lectures step by step
- **Student Personalization**: Auto-tracks student errors/preferences/mastery for adaptive teaching
- **Teacher Style**: Configurable speaking style via style_profile.json, injected into the system prompt

### Next

- **Voice**: Speech rhythm, intonation patterns, vocal habits
- **Visual style**: Expression preferences, art style, visual storytelling
- Cross-persona memory sharing

## Limitations

- Persona quality depends on the richness of input data — more data means a more well-rounded persona
- The online model needs 3-5 conversations before producing meaningful improvements
- Memory extraction relies on LLM analysis and may miss or misinterpret information
- First load of the sentence-transformers model takes a few seconds (subsequent calls use the resident daemon for millisecond-level response)
- All data is stored purely locally — no network transmission

## Version

- **v1.2.0** (2026-04-03/04): Embedding daemon + persona hot-update + adaptive retrieval
  - Embedding daemon (`embed_daemon.py`): Unix socket resident process, eliminates ~13s/call Python cold start, compose latency drops from 79s to ~6s
  - `persona-editor.mjs`: Unified profile + memory + user editing CLI with automatic cascade updates after each change
  - Conversation partner identity: `user add/list/remove` to register partners, `compose --user <id>` injects identity info, affects tone and memory retrieval
  - log(n) adaptive retrieval: seeds fixed at 5 + multi-level BFS walk depth log₂(n), total injected memories scale logarithmically with store size
  - Incremental update: `ingest.mjs diff/mark-done` detects new/changed files via SHA-256 hash, `/distill-me update` for one-command update
  - `train_linker.py`: Train linker MLP from feedback log (supports class-weighted BCE, early stopping)
  - Linker compatible with new memories: input is embedding pairs not fixed IDs, new memories are immediately scorable without retraining
  - Speaking style parameterization: `profile.speaking_style` controls length limits, decision tree, silence behaviors
  - Identity system externalized: facet configs moved from inline SKILL.md to `identities/*.md` loaded on demand
- **v1.1.0** (2026-04-03): Identity system + speaking philosophy
  - Identity system: Each persona can define multiple social identities (PhD student, streamer, project leader, etc.), with support for inheritance (`variant_of`) and mixing (`mix_of`)
  - Speaking philosophy: Memories are subconscious, not scripts — injected memories shape behavior but are never recited; most irrelevant memories should be silently ignored
  - Stochastic memory retrieval: Softmax-weighted sampling replaces deterministic top-K; top 3 guaranteed + random sampling for the rest
  - Stochastic link walking: BFS results are softmax-sampled; same query returns different combinations each time
  - Profile config can be slowly modified during conversations (max 1 value per conversation, max 10 per day)
- **v1.0.0** (2026-04-02): Initial release
  - Hierarchical folder memory system + link graph
  - FAISS HNSW O(log n) vector retrieval + O(1) graph cache
  - 410K parameter online learning MLP
  - Long-tail power-law decay (core memories retain 86%+ after 10 years)
  - Selective memory writing (compressed summaries, not raw text)
  - Memory lifecycle management (decay pruning + similarity merging)
  - Claude Code Skill integration
