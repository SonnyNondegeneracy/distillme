/**
 * In-memory graph operations on the memory link structure.
 * Nodes = memory IDs, edges = links with relation + strength.
 */

export class MemoryGraph {
  constructor() {
    // id -> { meta, body, filePath }
    this.nodes = new Map();
    // id -> [{ targetId, relation, strength }]
    this.edges = new Map();
  }

  addNode(id, meta, body, filePath) {
    this.nodes.set(id, { meta, body, filePath });
    if (!this.edges.has(id)) this.edges.set(id, []);
  }

  addEdge(sourceId, targetId, relation, strength = 0.5) {
    if (!this.edges.has(sourceId)) this.edges.set(sourceId, []);
    const edges = this.edges.get(sourceId);
    const existing = edges.find(e => e.targetId === targetId);
    if (existing) {
      existing.relation = relation;
      existing.strength = strength;
    } else {
      edges.push({ targetId, relation, strength });
    }
  }

  getNeighbors(id) {
    return this.edges.get(id) || [];
  }

  getNode(id) {
    return this.nodes.get(id) || null;
  }

  /**
   * BFS walk from a set of seed IDs, expanding along links.
   * Returns nodes visited in order, up to maxNodes.
   * Scores nodes by: link strength * seed relevance score.
   */
  walk(seedIds, seedScores, { maxNodes = 5, minStrength = 0.3 } = {}) {
    const visited = new Set(seedIds);
    const candidates = [];

    for (const seedId of seedIds) {
      const seedScore = seedScores.get(seedId) || 0.5;
      for (const edge of this.getNeighbors(seedId)) {
        if (visited.has(edge.targetId)) continue;
        if (edge.strength < minStrength) continue;
        if (!this.nodes.has(edge.targetId)) continue;
        candidates.push({
          id: edge.targetId,
          score: edge.strength * seedScore,
          fromId: seedId,
          relation: edge.relation,
        });
      }
    }

    // Sort by score descending, take top-N
    candidates.sort((a, b) => b.score - a.score);
    const result = [];
    for (const c of candidates) {
      if (result.length >= maxNodes) break;
      if (visited.has(c.id)) continue;
      visited.add(c.id);
      const node = this.nodes.get(c.id);
      result.push({
        id: c.id,
        score: c.score,
        fromId: c.fromId,
        relation: c.relation,
        meta: node.meta,
        body: node.body,
      });
    }
    return result;
  }

  /**
   * Build graph from an array of parsed memory objects.
   * Each object: { meta: { id, links, ... }, body, filePath }
   */
  static fromMemories(memories) {
    const graph = new MemoryGraph();
    for (const mem of memories) {
      const id = mem.meta.id;
      if (!id) continue;
      graph.addNode(id, mem.meta, mem.body, mem.filePath);
    }
    // Add edges from links
    for (const mem of memories) {
      const id = mem.meta.id;
      if (!id || !mem.meta.links) continue;
      for (const link of mem.meta.links) {
        graph.addEdge(id, link.id, link.relation, link.strength ?? 0.5);
      }
    }
    return graph;
  }

  get size() {
    return this.nodes.size;
  }
}
