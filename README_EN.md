# DistillMe — Distill Your Digital Persona

Distill a lifelike, memory-rich, continuously learning digital persona from personal data.

## What Is This

DistillMe is a personal digital persona distillation system that runs on [Claude Code](https://claude.ai/claude-code). Give it a folder of personal data (chat logs, diaries, notes, etc.) and it will:

1. **Distill personality**: Extract character traits, communication style, values, and interests from text
2. **Build a memory graph**: Extract discrete memories, store them in hierarchical folders, and interlink them into a walkable graph
3. **Generate a conversational persona**: Produce a Claude Code Skill that chats like the real person
4. **Keep learning**: Selectively extract new memories during conversations and online-train a small model to improve memory retrieval

---

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

### Memory Retrieval: Four-Layer Pipeline

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
  │ Select top-8                          │
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
  │ Layer 4: Link Walking                 │
  │ From top-8, expand 3-5 linked memories│
  │ Token budget ~800                     │
  └──────────────┬───────────────────────┘
                 │
                 ▼
         Injected as <memory> tags
         Fed to Claude for response generation
```

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
| 0.95 | 0.950 | 0.904 | 0.866 | Core memory, retains 91% after a year |
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
# Check training status
python3 model/trainer.py status ~/.claude/distill_me/alice

# Manually trigger training
python3 model/trainer.py train ~/.claude/distill_me/alice
```

---

## Tool Reference

### Node.js Tools (`tools/`)

| Command | Description |
|---------|-------------|
| `node tools/ingest.mjs scan <folder>` | Scan data folder, report file statistics |
| `node tools/ingest.mjs init <slug>` | Initialize persona directory structure |
| `node tools/ingest.mjs read-chunk <file> [--offset N] [--limit N]` | Read file chunks for LLM analysis |
| `node tools/memory-writer.mjs <slug> <category> <topic> --body "..." [--type T] [--importance N] [--tags "a,b"]` | Create memory file |
| `node tools/memory-retriever.mjs <slug> "<query>" [--top-k 8] [--phase start\|middle\|deep]` | Retrieve memories |
| `node tools/memory-walker.mjs <slug> --seeds "id1,id2" [--max-nodes 5] [--min-strength 0.15]` | Walk memory links |
| `node tools/persona-generator.mjs <slug>` | Generate SKILL.md |
| `node tools/persona-generator.mjs <slug> --summary` | Output personality summary |
| `node tools/session-manager.mjs compose <slug> "<msg>" [--phase P]` | Compose memory-injected prompt |
| `node tools/session-manager.mjs extract <slug> "<response>"` | Extract `<new-memory>` from AI response |
| `node tools/session-manager.mjs save-memory <slug> <cat> <topic> "<body>"` | Manually save conversation memory |
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
| `python3 model/linker.py info` | Print model parameter info |
| `python3 model/linker.py rerank <persona_dir>` | Model re-ranking (JSON via stdin) |
| `python3 model/trainer.py train <persona_dir> [--epochs 3]` | Online training |
| `python3 model/trainer.py status <persona_dir>` | Check training status |
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
├── model/
│   └── linker_weights.pt  # Trained MLP weights
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

---

## Project Structure

```
distill-me/
├── SKILL.md                           # Claude Code skill entry point
├── README.md                          # This file (Chinese)
├── README_EN.md                       # English documentation
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
│   ├── memory-writer.mjs              # Memory file creation
│   ├── memory-retriever.mjs           # Four-layer retrieval pipeline
│   ├── memory-walker.mjs              # Link walking + graph cache
│   ├── memory-consolidator.mjs        # Memory pruning/merging/stats
│   ├── persona-generator.mjs          # Generate profile + SKILL.md
│   └── session-manager.mjs            # Conversation mgmt, memory extraction, index rebuild
├── model/
│   ├── embedder.py                    # sentence-transformers + FAISS
│   ├── linker.py                      # 410K MLP memory scorer
│   ├── trainer.py                     # Online training
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
              │  User message            │
              │    → memory-retriever    │  O(log n) retrieval
              │    → memory-walker       │  link walking
              │    → session-manager     │  compose <memory> prompt
              │    → Claude response     │
              │    → extract <new-memory>│  selective (compressed summary)
              │    → log-feedback        │  record training data
              └────────────┬─────────────┘
                           │
              ┌────────────▼────────────┐
              │  Maintenance (periodic)  │
              │                          │
              │  consolidator stats      │  check memory health
              │  consolidator prune      │  prune decayed memories
              │  consolidator merge      │  merge similar memories
              │  rebuild-index           │  rebuild index
              │  trainer train           │  online model training
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

## Limitations

- Persona quality depends on the richness of input data — more data means a more well-rounded persona
- The online model needs 3-5 conversations before producing meaningful improvements
- Memory extraction relies on LLM analysis and may miss or misinterpret information
- First load of the sentence-transformers model takes a few seconds
- All data is stored purely locally — no network transmission

## Version

- **v1.0.0** (2026-04-02): Initial release
  - Hierarchical folder memory system + link graph
  - FAISS HNSW O(log n) vector retrieval + O(1) graph cache
  - 410K parameter online learning MLP
  - Long-tail power-law decay (core memories retain 86%+ after 10 years)
  - Selective memory writing (compressed summaries, not raw text)
  - Memory lifecycle management (decay pruning + similarity merging)
  - Claude Code Skill integration
