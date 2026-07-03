/**
 * Recursive Task Decomposer + Lineage (P2-11 "fractals")
 *
 * Decomposes a composite task into a self-similar subtask tree and injects
 * a root->parent "lineage" context chain into leaf prompts.
 *
 * Design goals:
 *  - Deterministic: no Date.now()/Math.random(); IDs are path-based.
 *  - Bounded: depth cap + maxNodes cap prevent over-decomposition / runaway trees.
 *  - Pluggable: the split rule is an injectable `splitter` function.
 *  - Self-contained: no external wiring; pure logic (git worktree isolation is
 *    intentionally out of scope).
 */

/** A node in the decomposition tree. */
export interface DecomposeNode {
  /** Path-based deterministic id, e.g. "task", "task.0", "task.0.1". */
  id: string;
  /** The (sub)task prompt for this node. */
  prompt: string;
  /** 0 for the root, +1 per level. */
  depth: number;
  /** Parent node id, or null for the root. */
  parentId: string | null;
  /** Direct child nodes (empty for leaves). */
  children: DecomposeNode[];
  /** Summaries of root->parent prompts, in order (root first). Root node = []. */
  lineage: string[];
}

/**
 * Splits a prompt into sub-prompts for the next depth level.
 * Return `[]` (or a single-element array) to signal "cannot decompose further"
 * — the node is then treated as a leaf.
 */
export type Splitter = (prompt: string, depth: number) => string[];

export interface DecomposeOptions {
  /** Max tree depth. Nodes at this depth are never split. Default 4. */
  maxDepth?: number;
  /** Hard cap on total node count (includes the root). Default 64. */
  maxNodes?: number;
  /** Injectable split rule. Default: {@link defaultSplitter}. */
  splitter?: Splitter;
  /** Prefix used for the root id. Default "task". */
  idPrefix?: string;
  /** Max chars kept per lineage summary entry. Default 80. */
  lineageSummaryLength?: number;
}

interface ResolvedOptions {
  maxDepth: number;
  maxNodes: number;
  splitter: Splitter;
  idPrefix: string;
  lineageSummaryLength: number;
}

const DEFAULTS: Omit<ResolvedOptions, 'splitter'> = {
  maxDepth: 4,
  maxNodes: 64,
  idPrefix: 'task',
  lineageSummaryLength: 80,
};

/** Collapse whitespace to single spaces and trim. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Deterministic default splitter.
 *
 * Strategy (first that yields >1 part wins):
 *  1. Explicit steps: lines beginning with `1.`, `2)`, `- `, `* `, or `Step N`.
 *  2. Sentence / clause boundaries: `.`, `!`, `?`, `;`, or newlines.
 *  3. Otherwise: not decomposable -> return [] (leaf).
 */
export function defaultSplitter(prompt: string, _depth = 0): string[] {
  const text = prompt.trim();
  if (!text) return [];

  // 1. Explicit step / bullet markers.
  const stepParts = text
    .split(/\r?\n/)
    .map((line) =>
      line.replace(/^\s*(?:step\s*\d+\s*[:.)-]?|\d+\s*[.)]|[-*•])\s*/i, '').trim(),
    )
    .filter((line) => line.length > 0);
  const looksLikeSteps =
    /(^|\n)\s*(?:step\s*\d+|\d+\s*[.)]|[-*•])\s+/i.test(text) && stepParts.length > 1;
  if (looksLikeSteps) return stepParts;

  // 2. Sentence / clause boundaries.
  const sentenceParts = text
    .split(/(?<=[.!?;])\s+|\r?\n+/)
    .map((s) => s.replace(/[.!?;]+$/, '').trim())
    .filter((s) => s.length > 0);
  if (sentenceParts.length > 1) return sentenceParts;

  // 3. Not decomposable.
  return [];
}

/** Truncate + normalize a prompt into a compact lineage summary entry. */
function summarize(prompt: string, maxLen: number): string {
  const norm = normalizeWhitespace(prompt);
  if (norm.length <= maxLen) return norm;
  return `${norm.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

function resolveOptions(opts: DecomposeOptions = {}): ResolvedOptions {
  return {
    maxDepth: opts.maxDepth ?? DEFAULTS.maxDepth,
    maxNodes: opts.maxNodes ?? DEFAULTS.maxNodes,
    splitter: opts.splitter ?? defaultSplitter,
    idPrefix: opts.idPrefix ?? DEFAULTS.idPrefix,
    lineageSummaryLength: opts.lineageSummaryLength ?? DEFAULTS.lineageSummaryLength,
  };
}

/**
 * Decompose a composite task into a self-similar subtask tree.
 *
 * Termination is guaranteed by:
 *  - `maxDepth`: nodes at the cap are leaves (never split).
 *  - `maxNodes`: once the total node budget is exhausted, no further children
 *    are created (remaining nodes stay leaves).
 *  - splitter contract: a `<= 1` element result marks a leaf, and any child
 *    identical to its parent is dropped (prevents non-shrinking recursion).
 *
 * Traversal is depth-first, left-to-right, so ids and ordering are stable.
 */
export function decompose(task: string, opts: DecomposeOptions = {}): DecomposeNode {
  const o = resolveOptions(opts);
  const maxNodes = Math.max(1, o.maxNodes);

  const root: DecomposeNode = {
    id: o.idPrefix,
    prompt: task,
    depth: 0,
    parentId: null,
    children: [],
    lineage: [],
  };

  // Shared, mutable node budget (root already consumes one slot).
  const budget = { count: 1 };

  const expand = (node: DecomposeNode): void => {
    if (node.depth >= o.maxDepth) return;
    if (budget.count >= maxNodes) return;

    const rawParts = o.splitter(node.prompt, node.depth);
    if (!Array.isArray(rawParts) || rawParts.length <= 1) return;

    const parentNorm = normalizeWhitespace(node.prompt);
    const parts = rawParts
      .map((p) => (typeof p === 'string' ? p.trim() : ''))
      .filter((p) => p.length > 0 && normalizeWhitespace(p) !== parentNorm);
    if (parts.length <= 1) return;

    const childLineage = [...node.lineage, summarize(node.prompt, o.lineageSummaryLength)];

    for (let i = 0; i < parts.length; i++) {
      if (budget.count >= maxNodes) break;
      const child: DecomposeNode = {
        id: `${node.id}.${i}`,
        prompt: parts[i]!,
        depth: node.depth + 1,
        parentId: node.id,
        children: [],
        lineage: childLineage,
      };
      budget.count++;
      node.children.push(child);
      expand(child);
    }
  };

  expand(root);
  return root;
}

/**
 * Build the final leaf prompt with the ancestor lineage injected at the top.
 * Works for any node; most useful for leaves.
 */
export function buildLeafPrompt(node: DecomposeNode): string {
  if (node.lineage.length === 0) {
    return node.prompt.trim();
  }
  const contextLines = node.lineage
    .map((entry, idx) => `  ${idx + 1}. ${entry}`)
    .join('\n');
  return [
    'Context (ancestor task chain, root first):',
    contextLines,
    '---',
    'Your focused subtask:',
    node.prompt.trim(),
  ].join('\n');
}

/** Depth-first flatten of the tree into an array (root first). */
export function flatten(root: DecomposeNode): DecomposeNode[] {
  const out: DecomposeNode[] = [];
  const walk = (n: DecomposeNode): void => {
    out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

/** All leaf nodes (no children), in depth-first order. */
export function getLeaves(root: DecomposeNode): DecomposeNode[] {
  return flatten(root).filter((n) => n.children.length === 0);
}

/** Total node count in the tree (includes the root). */
export function countNodes(root: DecomposeNode): number {
  return flatten(root).length;
}

/** Maximum depth present in the tree. */
export function maxDepthOf(root: DecomposeNode): number {
  return flatten(root).reduce((max, n) => (n.depth > max ? n.depth : max), 0);
}
