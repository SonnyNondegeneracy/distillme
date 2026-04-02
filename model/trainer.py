#!/usr/bin/env python3
"""
Online trainer for the MemoryLinker model.

Reads training logs (positive/negative retrieval pairs) and trains
the linker head in a few epochs. Designed to run at the end of each
conversation session.

Usage:
  python trainer.py train <persona_dir> [--epochs 3] [--lr 1e-4]
  python trainer.py status <persona_dir>
"""

import sys
import os
import json
from datetime import datetime

import torch
import torch.nn as nn
import torch.optim as optim
import numpy as np


def load_training_data(persona_dir):
    """Load training pairs from the feedback log."""
    log_path = os.path.join(persona_dir, 'logs', 'training_log.jsonl')
    if not os.path.exists(log_path):
        return [], []

    positives = []  # (context, memory_id, 1.0)
    negatives = []  # (context, memory_id, 0.0)

    with open(log_path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            ctx = entry.get('context_preview', '')
            for mid in entry.get('positive', []):
                positives.append((ctx, mid, 1.0))
            for mid in entry.get('negative', []):
                negatives.append((ctx, mid, 0.0))

    return positives, negatives


def train(persona_dir, epochs=3, lr=1e-4):
    """Train the linker model on accumulated feedback."""
    import faiss
    from sentence_transformers import SentenceTransformer
    from linker import MemoryLinker, load_model

    positives, negatives = load_training_data(persona_dir)
    total = len(positives) + len(negatives)

    if total < 5:
        print(json.dumps({
            "status": "skipped",
            "reason": f"Not enough training data ({total} pairs, need >= 5)",
            "positives": len(positives),
            "negatives": len(negatives),
        }))
        return

    # Load or create model
    model = load_model(persona_dir)
    if model is None:
        # Initialize from cold start
        from cold_start import initialize_weights
        model = MemoryLinker()
        initialize_weights(model)

    model.train()
    optimizer = optim.Adam(model.parameters(), lr=lr)
    criterion = nn.BCELoss()

    # Load encoder and flat index (HNSW doesn't support reconstruct)
    encoder = SentenceTransformer('paraphrase-multilingual-MiniLM-L12-v2')
    flat_path = os.path.join(persona_dir, 'index_flat.faiss')
    index_path = os.path.join(persona_dir, 'index.faiss')
    meta_path = os.path.join(persona_dir, 'index_meta.json')

    actual_index_path = flat_path if os.path.exists(flat_path) else index_path
    if not os.path.exists(actual_index_path):
        print(json.dumps({"status": "error", "reason": "No FAISS index found"}))
        return

    index = faiss.read_index(actual_index_path)
    with open(meta_path, 'r') as f:
        metas = json.load(f)
    id_to_idx = {m['id']: i for i, m in enumerate(metas)}

    # Prepare training pairs
    all_pairs = positives + negatives
    np.random.shuffle(all_pairs)

    losses = []
    for epoch in range(epochs):
        epoch_loss = 0.0
        n_samples = 0
        np.random.shuffle(all_pairs)

        for ctx_text, mem_id, label in all_pairs:
            idx = id_to_idx.get(mem_id)
            if idx is None:
                continue

            # Encode context
            ctx_emb = encoder.encode([ctx_text], normalize_embeddings=True)
            ctx_tensor = torch.tensor(ctx_emb, dtype=torch.float32)

            # Reconstruct memory embedding
            mem_emb = index.reconstruct(idx)
            mem_tensor = torch.tensor(mem_emb, dtype=torch.float32).unsqueeze(0)

            label_tensor = torch.tensor([[label]], dtype=torch.float32)

            # Forward + backward
            optimizer.zero_grad()
            pred = model(ctx_tensor, mem_tensor)
            loss = criterion(pred, label_tensor)
            loss.backward()
            optimizer.step()

            epoch_loss += loss.item()
            n_samples += 1

        if n_samples > 0:
            losses.append(epoch_loss / n_samples)

    # Save weights
    weights_dir = os.path.join(persona_dir, 'model')
    os.makedirs(weights_dir, exist_ok=True)
    weights_path = os.path.join(weights_dir, 'linker_weights.pt')
    torch.save(model.state_dict(), weights_path)

    print(json.dumps({
        "status": "ok",
        "epochs": epochs,
        "total_pairs": total,
        "positives": len(positives),
        "negatives": len(negatives),
        "losses": losses,
        "weights_path": weights_path,
    }))


def status(persona_dir):
    """Check training status."""
    weights_path = os.path.join(persona_dir, 'model', 'linker_weights.pt')
    log_path = os.path.join(persona_dir, 'logs', 'training_log.jsonl')

    has_model = os.path.exists(weights_path)
    positives, negatives = load_training_data(persona_dir)

    result = {
        "has_trained_model": has_model,
        "total_training_pairs": len(positives) + len(negatives),
        "positive_pairs": len(positives),
        "negative_pairs": len(negatives),
    }

    if has_model:
        stat = os.stat(weights_path)
        result["model_size_kb"] = round(stat.st_size / 1024, 1)
        result["last_trained"] = datetime.fromtimestamp(stat.st_mtime).isoformat()

    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == 'train':
        if len(sys.argv) < 3:
            print("Usage: python trainer.py train <persona_dir>")
            sys.exit(1)
        epochs = 3
        lr = 1e-4
        for i in range(3, len(sys.argv)):
            if sys.argv[i] == '--epochs':
                epochs = int(sys.argv[i + 1])
            if sys.argv[i] == '--lr':
                lr = float(sys.argv[i + 1])
        train(sys.argv[2], epochs, lr)
    elif cmd == 'status':
        if len(sys.argv) < 3:
            print("Usage: python trainer.py status <persona_dir>")
            sys.exit(1)
        status(sys.argv[2])
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
