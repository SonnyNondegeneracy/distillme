#!/usr/bin/env python3
"""
Embedding engine + FAISS index for memory retrieval.

Usage:
  python embedder.py build <memories_dir> <output_dir>   # Build index from memory files
  python embedder.py query <output_dir> "<query>" [--top-k 50]  # Query the index
  python embedder.py embed "<text>"                       # Get embedding for a single text
"""

import sys
import os
import json
import glob
import re
import numpy as np

# Lazy imports for faster CLI startup
_model = None
_model_name = 'paraphrase-multilingual-MiniLM-L12-v2'


def get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(_model_name)
    return _model


def parse_memory_file(path):
    """Parse a memory .md file with YAML frontmatter."""
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    match = re.match(r'^---\n(.*?)\n---\n(.*)$', content, re.DOTALL)
    if not match:
        return None, content.strip()

    import yaml
    meta = yaml.safe_load(match.group(1))
    body = match.group(2).strip()
    return meta, body


def build_index(memories_dir, output_dir):
    """Build FAISS index from all memory files under memories_dir."""
    import faiss

    # Collect all .md files recursively
    md_files = glob.glob(os.path.join(memories_dir, '**', '*.md'), recursive=True)
    if not md_files:
        print(json.dumps({"error": "No memory files found", "dir": memories_dir}))
        sys.exit(1)

    model = get_model()
    texts = []
    metas = []

    for path in md_files:
        meta, body = parse_memory_file(path)
        if not meta or not meta.get('id'):
            continue
        # Combine tags + body for richer embedding
        tags_str = ' '.join(meta.get('tags', []))
        embed_text = f"{tags_str} {body}"
        texts.append(embed_text)
        metas.append({
            'id': meta['id'],
            'path': os.path.relpath(path, memories_dir),
            'abs_path': path,
            'type': meta.get('type', 'semantic'),
            'importance': meta.get('importance', 0.5),
            'created': meta.get('created', ''),
            'tags': meta.get('tags', []),
            'body_preview': body[:200],
        })

    if not texts:
        print(json.dumps({"error": "No valid memories with IDs found"}))
        sys.exit(1)

    # Encode
    embeddings = model.encode(texts, show_progress_bar=True, normalize_embeddings=True)
    embeddings = np.array(embeddings, dtype='float32')

    # Build FAISS index
    # Use HNSW for O(log n) retrieval when n >= 64, else flat (exact) for small sets
    dim = embeddings.shape[1]
    n = len(embeddings)
    if n >= 64:
        # HNSW: O(log n) approximate nearest neighbor
        # M=32 edges per node, efConstruction=200 for build quality
        index = faiss.IndexHNSWFlat(dim, 32, faiss.METRIC_INNER_PRODUCT)
        index.hnsw.efConstruction = 200
        index.hnsw.efSearch = 64  # query-time quality, tunable
    else:
        # Small set: exact search is fine and supports reconstruct()
        index = faiss.IndexFlatIP(dim)
    index.add(embeddings)

    # Always save a flat copy alongside for reconstruct() (needed by linker rerank)
    flat_index = faiss.IndexFlatIP(dim)
    flat_index.add(embeddings)
    faiss.write_index(flat_index, os.path.join(output_dir, 'index_flat.faiss'))

    # Save
    os.makedirs(output_dir, exist_ok=True)
    faiss.write_index(index, os.path.join(output_dir, 'index.faiss'))
    with open(os.path.join(output_dir, 'index_meta.json'), 'w', encoding='utf-8') as f:
        json.dump(metas, f, ensure_ascii=False, indent=2)

    print(json.dumps({
        "status": "ok",
        "count": len(texts),
        "dimension": dim,
        "index_type": "HNSW" if n >= 64 else "Flat",
        "index_path": os.path.join(output_dir, 'index.faiss'),
        "flat_path": os.path.join(output_dir, 'index_flat.faiss'),
    }))


def query_index(output_dir, query_text, top_k=50):
    """Query the FAISS index and return top-K results."""
    import faiss

    index_path = os.path.join(output_dir, 'index.faiss')
    meta_path = os.path.join(output_dir, 'index_meta.json')

    index = faiss.read_index(index_path)
    with open(meta_path, 'r', encoding='utf-8') as f:
        metas = json.load(f)

    model = get_model()
    query_emb = model.encode([query_text], normalize_embeddings=True)
    query_emb = np.array(query_emb, dtype='float32')

    scores, indices = index.search(query_emb, min(top_k, len(metas)))

    results = []
    for score, idx in zip(scores[0], indices[0]):
        if idx < 0 or idx >= len(metas):
            continue
        entry = dict(metas[idx])
        entry['embedding_score'] = float(score)
        results.append(entry)

    print(json.dumps(results, ensure_ascii=False))


def embed_text(text):
    """Embed a single text and print the vector."""
    model = get_model()
    emb = model.encode([text], normalize_embeddings=True)
    print(json.dumps(emb[0].tolist()))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == 'build':
        if len(sys.argv) < 4:
            print("Usage: python embedder.py build <memories_dir> <output_dir>")
            sys.exit(1)
        build_index(sys.argv[2], sys.argv[3])

    elif cmd == 'query':
        if len(sys.argv) < 4:
            print("Usage: python embedder.py query <output_dir> \"<query>\" [--top-k 50]")
            sys.exit(1)
        top_k = 50
        if '--top-k' in sys.argv:
            idx = sys.argv.index('--top-k')
            top_k = int(sys.argv[idx + 1])
        query_index(sys.argv[2], sys.argv[3], top_k)

    elif cmd == 'embed':
        if len(sys.argv) < 3:
            print("Usage: python embedder.py embed \"<text>\"")
            sys.exit(1)
        embed_text(sys.argv[2])

    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)
