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
   * Multi-level BFS walk from seed IDs.
   * Depth = maxDepth levels. At each level, expand from current frontier.
   * Returns all discovered nodes (excluding seeds) with scores.
   *
   * Score decays multiplicatively: parent_score * edge_strength per hop.
   * This ensures distant memories get lower scores but remain reachable.
   */
  walk(seedIds, seedScores, { maxDepth = 3, maxNodes = 10, minStrength = 0.15 } = {}) {
    const visited = new Set(seedIds);
    const allCandidates = [];

    // Current frontier: [{id, score}]
    let frontier = seedIds.map(id => ({ id, score: seedScores.get(id) || 0.5 }));

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier = [];

      for (const { id: parentId, score: parentScore } of frontier) {
        for (const edge of this.getNeighbors(parentId)) {
          if (visited.has(edge.targetId)) continue;
          if (edge.strength < minStrength) continue;
          if (!this.nodes.has(edge.targetId)) continue;

          visited.add(edge.targetId);
          const childScore = parentScore * edge.strength;
          const entry = {
            id: edge.targetId,
            score: childScore,
            fromId: parentId,
            relation: edge.relation,
            depth: depth + 1,
          };
          allCandidates.push(entry);
          nextFrontier.push({ id: edge.targetId, score: childScore });
        }
      }

      frontier = nextFrontier;
    }

    // Sort by score descending, attach node data
    allCandidates.sort((a, b) => b.score - a.score);
    const result = [];
    for (const c of allCandidates) {
      if (result.length >= maxNodes) break;
      const node = this.nodes.get(c.id);
      result.push({
        id: c.id,
        score: c.score,
        fromId: c.fromId,
        relation: c.relation,
        depth: c.depth,
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
