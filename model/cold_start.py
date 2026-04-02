#!/usr/bin/env python3
"""
Cold Start — initialize linker weights and generate heuristic memory links.

The linker is initialized so its output approximates cosine similarity,
ensuring no degradation vs. pure heuristic retrieval before any training.

Usage:
  python cold_start.py init-weights                    # Print initialized weights info
  python cold_start.py generate-links <persona_dir>   # Generate heuristic links between memories
"""

import sys
import os
import json
import glob
import re

import torch
import numpy as np


def initialize_weights(model):
    """
    Initialize MemoryLinker weights to approximate cosine similarity.

    The input is [A; B; A*B; |A-B|] where A and B are L2-normalized.
    Cosine similarity = sum(A*B). We initialize the first layer to
    extract the A*B component and sum it, with subsequent layers
    preserving this signal.
    """
    with torch.no_grad():
        embed_dim = 384

        # First layer: Linear(1536, 256)
        W1 = model.head[0].weight
        b1 = model.head[0].bias
        W1.zero_()
        b1.zero_()
        # Route the A*B block (positions [2*384 : 3*384]) into first 384 outputs
        # with a simple averaging pattern
        for i in range(min(256, embed_dim)):
            idx = 2 * embed_dim + i
            if idx < W1.shape[1]:
                W1[i, idx] = 1.0

        # Second layer: Linear(256, 64)
        W2 = model.head[3].weight
        b2 = model.head[3].bias
        W2.zero_()
        b2.zero_()
        # Average groups of 4 from the first 256
        for i in range(64):
            for j in range(4):
                idx = i * 4 + j
                if idx < 256:
                    W2[i, idx] = 0.25

        # Third layer: Linear(64, 1)
        W3 = model.head[6].weight
        b3 = model.head[6].bias
        W3.zero_()
        b3.zero_()
        # Sum all 64 outputs (normalized by 64 to stay in [0,1] range after sigmoid)
        W3[0, :] = 1.0 / 64.0
        b3[0] = 0.0  # Sigmoid(0) = 0.5, which is neutral

    return model


def parse_memory_file(path):
    """Parse YAML frontmatter from a memory file."""
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    match = re.match(r'^---\n(.*?)\n---\n(.*)$', content, re.DOTALL)
    if not match:
        return None, content.strip()
    import yaml
    meta = yaml.safe_load(match.group(1))
    body = match.group(2).strip()
    return meta, body


def generate_links(persona_dir):
    """
    Generate heuristic links between memories using:
    1. Embedding similarity (FAISS)
    2. Entity co-occurrence
    3. Temporal proximity
    """
    import faiss
    import yaml

    # Use flat index for reconstruct and neighbor search
    flat_path = os.path.join(persona_dir, 'index_flat.faiss')
    index_path = os.path.join(persona_dir, 'index.faiss')
    meta_path = os.path.join(persona_dir, 'index_meta.json')

    actual_index_path = flat_path if os.path.exists(flat_path) else index_path
    if not os.path.exists(actual_index_path):
        print(json.dumps({"error": "No FAISS index. Run embedder.py build first."}))
        sys.exit(1)

    index = faiss.read_index(actual_index_path)
    with open(meta_path, 'r') as f:
        metas = json.load(f)

    n = len(metas)
    if n < 2:
        print(json.dumps({"status": "skipped", "reason": "Need at least 2 memories"}))
        return

    # Find top-5 nearest neighbors for each memory
    k = min(6, n)  # +1 because self is included
    all_embs = np.array([index.reconstruct(i) for i in range(n)], dtype='float32')
    scores, indices = index.search(all_embs, k)

    # Build entity co-occurrence index for secondary linking
    # Extract Chinese/English keywords from body and tags
    import re as _re
    entity_to_metas = {}  # entity_str -> set of meta indices
    for idx, m in enumerate(metas):
        tokens = set(m.get('tags', []))
        preview = m.get('body_preview', '')
        # Extract Chinese segments (2+ chars)
        for seg in _re.findall(r'[\u4e00-\u9fff]{2,}', preview):
            tokens.add(seg)
        # Extract English words (3+ chars)
        for w in _re.findall(r'[a-zA-Z]{3,}', preview):
            tokens.add(w.lower())
        for t in tokens:
            entity_to_metas.setdefault(t, set()).add(idx)

    links_added = 0

    for i in range(n):
        mem_path = metas[i].get('abs_path')
        if not mem_path or not os.path.exists(mem_path):
            continue

        meta, body = parse_memory_file(mem_path)
        if not meta:
            continue

        existing_link_ids = set()
        if meta.get('links'):
            existing_link_ids = {l['id'] for l in meta['links']}

        new_links = list(meta.get('links', []))

        # --- Method 1: Embedding similarity neighbors ---
        for j_idx in range(1, k):  # Skip index 0 (self)
            neighbor = indices[i][j_idx]
            if neighbor < 0 or neighbor >= n:
                continue

            neighbor_id = metas[neighbor]['id']
            if neighbor_id in existing_link_ids:
                continue

            sim_score = float(scores[i][j_idx])
            if sim_score < 0.15:
                continue

            # Determine relation type
            my_type = meta.get('type', 'semantic')
            their_type = metas[neighbor].get('type', 'semantic')
            relation = 'related'
            if my_type == 'episodic' and their_type == 'episodic':
                relation = 'temporal-near'
            elif my_type == 'emotional' or their_type == 'emotional':
                relation = 'evokes'
            elif my_type != their_type:
                relation = 'connects'

            new_links.append({
                'id': neighbor_id,
                'relation': relation,
                'strength': round(sim_score, 3),
            })
            existing_link_ids.add(neighbor_id)
            links_added += 1

        # --- Method 2: Entity co-occurrence linking ---
        my_tokens = set(meta.get('tags', []))
        for seg in _re.findall(r'[\u4e00-\u9fff]{2,}', body):
            my_tokens.add(seg)
        for w in _re.findall(r'[a-zA-Z]{3,}', body):
            my_tokens.add(w.lower())

        co_occurring = set()
        for token in my_tokens:
            for j in entity_to_metas.get(token, set()):
                if j != i:
                    co_occurring.add(j)

        for j in co_occurring:
            neighbor_id = metas[j]['id']
            if neighbor_id in existing_link_ids:
                continue
            # Compute actual similarity for strength
            sim = float(all_embs[i] @ all_embs[j])
            strength = max(sim, 0.2)  # Floor at 0.2 since entity overlap is strong signal
            new_links.append({
                'id': neighbor_id,
                'relation': 'co-entity',
                'strength': round(strength, 3),
            })
            existing_link_ids.add(neighbor_id)
            links_added += 1

        # Write back if new links were added
        if len(new_links) > len(meta.get('links', [])):
            meta['links'] = new_links
            meta['updated'] = __import__('datetime').datetime.now().isoformat()
            yaml_str = yaml.safe_dump(meta, allow_unicode=True, default_flow_style=False).strip()
            with open(mem_path, 'w', encoding='utf-8') as f:
                f.write(f"---\n{yaml_str}\n---\n\n{body}\n")

    print(json.dumps({
        "status": "ok",
        "memories_processed": n,
        "links_added": links_added,
    }))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == 'init-weights':
        from linker import MemoryLinker
        model = MemoryLinker()
        model = initialize_weights(model)
        # Test: for identical vectors, should output ~0.5+ (via sigmoid)
        test_a = torch.randn(1, 384)
        test_a = test_a / test_a.norm()
        with torch.no_grad():
            score_same = model(test_a, test_a).item()
            score_diff = model(test_a, -test_a).item()
        print(json.dumps({
            "status": "ok",
            "total_params": sum(p.numel() for p in model.parameters()),
            "test_same_vector_score": round(score_same, 4),
            "test_opposite_vector_score": round(score_diff, 4),
        }, indent=2))

    elif cmd == 'generate-links':
        if len(sys.argv) < 3:
            print("Usage: python cold_start.py generate-links <persona_dir>")
            sys.exit(1)
        generate_links(sys.argv[2])

    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
