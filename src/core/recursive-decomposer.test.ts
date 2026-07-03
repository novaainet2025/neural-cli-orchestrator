import { describe, it, expect } from 'vitest';
import {
  decompose,
  buildLeafPrompt,
  defaultSplitter,
  flatten,
  getLeaves,
  countNodes,
  maxDepthOf,
  type DecomposeNode,
  type Splitter,
} from './recursive-decomposer.js';

/**
 * A deterministic binary splitter: every prompt of length > 1 splits into two
 * shorter halves ("A|B"). Guarantees a controllable, fully deterministic tree
 * that only stops on depth/maxNodes/length — ideal for testing bounds.
 */
const binarySplitter: Splitter = (prompt) => {
  const t = prompt.trim();
  if (t.length <= 1) return [];
  const mid = Math.floor(t.length / 2);
  return [`${t.slice(0, mid)}|L`, `${t.slice(mid)}|R`];
};

describe('recursive-decomposer', () => {
  it('splits a numbered/step prompt into subtasks and stops on leaves', () => {
    const task = '1. gather data\n2. train model\n3. evaluate results';
    const root = decompose(task, { maxDepth: 4 });

    expect(root.depth).toBe(0);
    expect(root.parentId).toBeNull();
    expect(root.lineage).toEqual([]);
    expect(root.children).toHaveLength(3);

    const prompts = root.children.map((c) => c.prompt);
    expect(prompts).toEqual(['gather data', 'train model', 'evaluate results']);

    // Each child is a single short clause -> not further decomposable -> leaf.
    for (const child of root.children) {
      expect(child.depth).toBe(1);
      expect(child.parentId).toBe(root.id);
      expect(child.children).toHaveLength(0);
    }

    // ids are path-based and deterministic.
    expect(root.id).toBe('task');
    expect(root.children.map((c) => c.id)).toEqual(['task.0', 'task.1', 'task.2']);
  });

  it('enforces the depth cap (nodes at maxDepth are leaves)', () => {
    // A source string long enough to keep splitting well past the cap.
    const src = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const maxDepth = 2;
    const root = decompose(src, { maxDepth, maxNodes: 1000, splitter: binarySplitter });

    expect(maxDepthOf(root)).toBe(maxDepth);
    // Every node at the cap must have no children.
    for (const n of flatten(root)) {
      if (n.depth === maxDepth) {
        expect(n.children).toHaveLength(0);
      }
    }
    // With a strict binary splitter and depth 2: 1 + 2 + 4 = 7 nodes.
    expect(countNodes(root)).toBe(7);
  });

  it('enforces the maxNodes cap regardless of splittability', () => {
    const src = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const maxNodes = 5;
    const root = decompose(src, { maxDepth: 10, maxNodes, splitter: binarySplitter });

    expect(countNodes(root)).toBeLessThanOrEqual(maxNodes);
    expect(countNodes(root)).toBeGreaterThan(1); // it did decompose at least once
  });

  it('accumulates lineage as the root->parent prompt summary chain', () => {
    const src = 'abcdefghijklmnop';
    const root = decompose(src, { maxDepth: 3, maxNodes: 1000, splitter: binarySplitter });

    const leaves = getLeaves(root);
    expect(leaves.length).toBeGreaterThan(0);

    for (const leaf of leaves) {
      // lineage length equals the number of ancestors (== leaf depth).
      expect(leaf.lineage).toHaveLength(leaf.depth);

      // Reconstruct the ancestor chain by id and compare prompt summaries.
      const chain = ancestorsOf(root, leaf);
      const expected = chain.map((a) =>
        a.prompt.replace(/\s+/g, ' ').trim(),
      );
      // Summaries here are short (< default 80 chars) so they equal the
      // normalized prompt verbatim.
      expect(leaf.lineage).toEqual(expected);
    }
  });

  it('buildLeafPrompt injects the lineage above the focused subtask', () => {
    const task = '1. design the api\n2. implement handlers\n3. write tests';
    const root = decompose(task);
    const leaf = root.children[0]!;

    const rendered = buildLeafPrompt(leaf);
    expect(rendered).toContain('Context (ancestor task chain, root first):');
    expect(rendered).toContain('1. 1. design the api 2. implement handlers 3. write tests'.slice(0, 20));
    expect(rendered).toContain('Your focused subtask:');
    expect(rendered.endsWith(leaf.prompt.trim())).toBe(true);

    // Root has empty lineage -> buildLeafPrompt returns the bare prompt.
    expect(buildLeafPrompt(root)).toBe(task.trim());
  });

  it('treats a non-decomposable prompt as a single-node leaf tree', () => {
    const root = decompose('do one atomic thing');
    expect(root.children).toHaveLength(0);
    expect(countNodes(root)).toBe(1);
    expect(getLeaves(root)).toEqual([root]);
  });

  it('is deterministic: identical inputs yield identical trees', () => {
    const task = '1. alpha\n2. beta\n3. gamma';
    const a = decompose(task, { splitter: binarySplitter, maxDepth: 3 });
    const b = decompose(task, { splitter: binarySplitter, maxDepth: 3 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('defaultSplitter returns [] for atomic prompts and >1 for compound', () => {
    expect(defaultSplitter('single clause', 0)).toEqual([]);
    expect(defaultSplitter('first thing. second thing. third thing.', 0)).toEqual([
      'first thing',
      'second thing',
      'third thing',
    ]);
  });
});

/** Test helper: rebuild the ancestor chain (root..parent) for a node by id. */
function ancestorsOf(root: DecomposeNode, target: DecomposeNode): DecomposeNode[] {
  const byId = new Map<string, DecomposeNode>();
  for (const n of flatten(root)) byId.set(n.id, n);
  const chain: DecomposeNode[] = [];
  let current: DecomposeNode | undefined = target;
  while (current && current.parentId !== null) {
    const parent = byId.get(current.parentId);
    if (!parent) break;
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}
