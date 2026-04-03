#!/usr/bin/env python3
"""
Memory Link Scorer — small MLP that re-ranks memory candidates.

Architecture:
  Input A: conversation context → frozen sentence-transformer → 384-dim
  Input B: candidate memory    → frozen sentence-transformer → 384-dim
  Concat [A; B; A*B; |A-B|]   → 1536-dim
  Linear(1536, 256) → ReLU → Dropout(0.1)
  Linear(256, 64)   → ReLU → Dropout(0.1)
  Linear(64, 1)     → Sigmoid → relevance score

Usage:
  python linker.py rerank <persona_dir>    # Reads JSON from stdin: {query, candidate_ids}
  python linker.py info                     # Print model info
"""

import sys
import os
import json

import torch
import torch.nn as nn
import numpy as np


class MemoryLinker(nn.Module):
    """Small MLP head for memory relevance scoring."""

    def __init__(self, embed_dim=384):
        super().__init__()
        input_dim = embed_dim * 4  # [A; B; A*B; |A-B|]
        self.head = nn.Sequential(
            nn.Linear(input_dim, 256),
            nn.ReLU(),
            nn.Dropout(0.1),
            nn.Linear(256, 64),
            nn.ReLU(),
            nn.Dropout(0.1),
            nn.Linear(64, 1),
            nn.Sigmoid(),
        )

    def forward(self, emb_a, emb_b):
        """
        Args:
            emb_a: (batch, embed_dim) - context embeddings
            emb_b: (batch, embed_dim) - memory embeddings
        Returns:
            (batch, 1) - relevance scores
        """
        combined = torch.cat([
            emb_a,
            emb_b,
            emb_a * emb_b,
            torch.abs(emb_a - emb_b),
        ], dim=-1)
        return self.head(combined)

    @staticmethod
    def param_count():
        model = MemoryLinker()
        return sum(p.numel() for p in model.parameters())


def load_model(persona_dir, device='cpu'):
    """Load trained linker model, or return None if not available."""
    weights_path = os.path.join(persona_dir, 'model', 'linker_weights.pt')
    if not os.path.exists(weights_path):
        return None

    model = MemoryLinker()
    model.load_state_dict(torch.load(weights_path, map_location=device, weights_only=True))
    model.eval()
    return model


def rerank(persona_dir):
    """Re-rank candidate memories given a query context.

    Reads from stdin: {"query": "...", "candidate_ids": [...]}
    Needs embeddings pre-computed in index_meta.json.
    """
    import faiss
    from sentence_transformers import SentenceTransformer

    input_data = json.loads(sys.stdin.read())
    query = input_data['query']
    candidate_ids = input_data['candidate_ids']

    model = load_model(persona_dir)
    if model is None:
        print(json.dumps({}))
        return

    # Load encoder and embeddings
    encoder = SentenceTransformer('paraphrase-multilingual-MiniLM-L12-v2')
    query_emb = encoder.encode([query], normalize_embeddings=True)
    query_tensor = torch.tensor(query_emb, dtype=torch.float32)

    # Load FAISS flat index (for reconstruct) and metadata
    # HNSW index doesn't support reconstruct(), so we use the flat copy
    flat_path = os.path.join(persona_dir, 'index_flat.faiss')
    index_path = os.path.join(persona_dir, 'index.faiss')
    meta_path = os.path.join(persona_dir, 'index_meta.json')

    # Prefer flat copy; fall back to main index if flat doesn't exist
    actual_index_path = flat_path if os.path.exists(flat_path) else index_path
    if not os.path.exists(actual_index_path):
        print(json.dumps({}))
        return

    index = faiss.read_index(actual_index_path)
    with open(meta_path, 'r') as f:
        metas = json.load(f)

    # Build id → index mapping
    id_to_idx = {m['id']: i for i, m in enumerate(metas)}

    # Reconstruct embeddings for candidates
    scores = {}
    for cid in candidate_ids:
        idx = id_to_idx.get(cid)
        if idx is None:
            continue
        mem_emb = index.reconstruct(idx)
        mem_tensor = torch.tensor(mem_emb, dtype=torch.float32).unsqueeze(0)

        with torch.no_grad():
            score = model(query_tensor, mem_tensor).item()
        scores[cid] = score

    print(json.dumps(scores))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == 'rerank':
        if len(sys.argv) < 3:
            print("Usage: python linker.py rerank <persona_dir>")
            sys.exit(1)
        rerank(sys.argv[2])
    elif cmd == 'info':
        print(json.dumps({
            "model": "MemoryLinker",
            "parameters": MemoryLinker.param_count(),
            "embed_dim": 384,
            "input_dim": 1536,
            "description": "Dual-encoder MLP head for memory relevance scoring",
        }, indent=2))
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
