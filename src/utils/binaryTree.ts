export interface TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
}

/** Recursively encode a binary tree into a JSON-serializable structure. */
function encode(node: TreeNode | null): unknown {
  if (node === null) return null;
  return {
    val: node.val,
    left: encode(node.left),
    right: encode(node.right),
  };
}

/** Recursively decode a JSON-parsed structure back into a TreeNode. */
function decode(data: unknown): TreeNode | null {
  if (data === null) return null;
  if (typeof data !== 'object' || !('val' in data) || !('left' in data) || !('right' in data)) {
    throw new Error('Invalid tree JSON');
  }
  const { val, left, right } = data as {
    val: unknown;
    left: unknown;
    right: unknown;
  };
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new Error('Invalid tree JSON');
  }
  return {
    val,
    left: decode(left),
    right: decode(right),
  };
}

export function serialize(root: TreeNode | null): string {
  return JSON.stringify(encode(root));
}

export function deserialize(data: string): TreeNode | null {
  return decode(JSON.parse(data));
}
