#!/usr/bin/env python3
"""
Embedding daemon — keeps SentenceTransformer loaded, serves queries via Unix domain socket.

Eliminates the ~13s cold start per Python invocation by staying alive across calls.
Multiple Node processes share the same daemon via the socket.

Protocol:
  Each request is a length-prefixed JSON message: 4-byte big-endian length + JSON bytes.
  Each response follows the same format.

Usage:
  python embed_daemon.py [--socket /tmp/distillme_embed.sock]
"""

import sys
import os
import json
import signal
import socket
import struct
import threading
import atexit

os.environ.setdefault('CUDA_VISIBLE_DEVICES', '')

import numpy as np
import torch

SOCKET_PATH = os.environ.get('DISTILLME_SOCKET', '/tmp/distillme_embed.sock')

# Lazy-load heavy modules once
_encoder = None
_faiss_cache = {}  # persona_dir -> (index, flat_index, metas)
_linker_cache = {}  # persona_dir -> model
_lock = threading.Lock()


def get_encoder():
    global _encoder
    if _encoder is None:
        from sentence_transformers import SentenceTransformer
        _encoder = SentenceTransformer('paraphrase-multilingual-MiniLM-L12-v2', device='cpu')
        print(f"[daemon] encoder loaded", file=sys.stderr, flush=True)
    return _encoder


def get_faiss_data(persona_dir):
    import faiss
    if persona_dir in _faiss_cache:
        return _faiss_cache[persona_dir]

    flat_path = os.path.join(persona_dir, 'index_flat.faiss')
    index_path = os.path.join(persona_dir, 'index.faiss')
    meta_path = os.path.join(persona_dir, 'index_meta.json')

    actual_path = flat_path if os.path.exists(flat_path) else index_path
    if not os.path.exists(actual_path):
        return None, None, None

    index = faiss.read_index(index_path) if os.path.exists(index_path) else None
    flat_index = faiss.read_index(flat_path) if os.path.exists(flat_path) else index

    with open(meta_path, 'r', encoding='utf-8') as f:
        metas = json.load(f)

    _faiss_cache[persona_dir] = (index, flat_index, metas)
    return index, flat_index, metas


def get_linker(persona_dir):
    if persona_dir in _linker_cache:
        return _linker_cache[persona_dir]

    weights_path = os.path.join(persona_dir, 'model', 'linker_weights.pt')
    if not os.path.exists(weights_path):
        _linker_cache[persona_dir] = None
        return None

    sys.path.insert(0, os.path.dirname(__file__))
    from linker import MemoryLinker
    model = MemoryLinker()
    model.load_state_dict(torch.load(weights_path, map_location='cpu', weights_only=True))
    model.eval()
    _linker_cache[persona_dir] = model
    return model


def handle_query(req):
    persona_dir = req['persona_dir']
    text = req['text']
    top_k = req.get('top_k', 50)

    index, _, metas = get_faiss_data(persona_dir)
    if index is None:
        return []

    encoder = get_encoder()
    query_emb = encoder.encode([text], normalize_embeddings=True)
    query_emb = np.array(query_emb, dtype='float32')

    scores, indices = index.search(query_emb, min(top_k, len(metas)))

    results = []
    for score, idx in zip(scores[0], indices[0]):
        if idx < 0 or idx >= len(metas):
            continue
        entry = dict(metas[idx])
        entry['embedding_score'] = float(score)
        results.append(entry)

    return results


def handle_embed(req):
    encoder = get_encoder()
    emb = encoder.encode([req['text']], normalize_embeddings=True)
    return emb[0].tolist()


def handle_rerank(req):
    persona_dir = req['persona_dir']
    query = req['query']
    candidate_ids = req['candidate_ids']

    model = get_linker(persona_dir)
    if model is None:
        return {}

    _, flat_index, metas = get_faiss_data(persona_dir)
    if flat_index is None:
        return {}

    id_to_idx = {m['id']: i for i, m in enumerate(metas)}

    encoder = get_encoder()
    query_emb = encoder.encode([query], normalize_embeddings=True)
    query_tensor = torch.tensor(query_emb, dtype=torch.float32)

    scores = {}
    for cid in candidate_ids:
        idx = id_to_idx.get(cid)
        if idx is None:
            continue
        mem_emb = flat_index.reconstruct(idx)
        mem_tensor = torch.tensor(mem_emb, dtype=torch.float32).unsqueeze(0)
        with torch.no_grad():
            score = model(query_tensor, mem_tensor).item()
        scores[cid] = score

    return scores


def dispatch(req):
    cmd = req.get('cmd', '')
    if cmd == 'ping':
        return {"status": "ok"}
    elif cmd == 'query':
        return handle_query(req)
    elif cmd == 'embed':
        return handle_embed(req)
    elif cmd == 'rerank':
        return handle_rerank(req)
    elif cmd == 'invalidate':
        pd = req.get('persona_dir')
        if pd:
            _faiss_cache.pop(pd, None)
            _linker_cache.pop(pd, None)
        else:
            _faiss_cache.clear()
            _linker_cache.clear()
        return {"status": "ok"}
    else:
        return {"error": f"Unknown command: {cmd}"}


def recv_msg(conn):
    """Receive a length-prefixed message."""
    raw_len = b''
    while len(raw_len) < 4:
        chunk = conn.recv(4 - len(raw_len))
        if not chunk:
            return None
        raw_len += chunk
    msg_len = struct.unpack('>I', raw_len)[0]
    if msg_len > 10 * 1024 * 1024:  # 10MB sanity limit
        return None
    data = b''
    while len(data) < msg_len:
        chunk = conn.recv(min(msg_len - len(data), 65536))
        if not chunk:
            return None
        data += chunk
    return json.loads(data.decode('utf-8'))


def send_msg(conn, obj):
    """Send a length-prefixed message."""
    data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
    conn.sendall(struct.pack('>I', len(data)) + data)


def handle_client(conn, addr):
    try:
        while True:
            req = recv_msg(conn)
            if req is None:
                break
            if req.get('cmd') == 'shutdown':
                send_msg(conn, {"status": "shutdown"})
                conn.close()
                os._exit(0)
            with _lock:
                try:
                    result = dispatch(req)
                except Exception as e:
                    result = {"error": str(e)}
            send_msg(conn, result)
    except (ConnectionResetError, BrokenPipeError):
        pass
    finally:
        conn.close()


def cleanup():
    try:
        os.unlink(SOCKET_PATH)
    except OSError:
        pass


def main():
    # Parse args
    sock_path = SOCKET_PATH
    for i, arg in enumerate(sys.argv):
        if arg == '--socket' and i + 1 < len(sys.argv):
            sock_path = sys.argv[i + 1]

    # Clean up stale socket
    if os.path.exists(sock_path):
        try:
            test_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            test_sock.connect(sock_path)
            test_sock.close()
            print(f"[daemon] Another daemon is already running on {sock_path}", file=sys.stderr)
            sys.exit(0)
        except ConnectionRefusedError:
            os.unlink(sock_path)

    atexit.register(cleanup)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(sock_path)
    os.chmod(sock_path, 0o600)
    server.listen(5)

    print(f"[daemon] Listening on {sock_path}", file=sys.stderr, flush=True)

    # Pre-warm encoder in background
    threading.Thread(target=get_encoder, daemon=True).start()

    while True:
        conn, addr = server.accept()
        t = threading.Thread(target=handle_client, args=(conn, addr), daemon=True)
        t.start()


if __name__ == '__main__':
    main()
