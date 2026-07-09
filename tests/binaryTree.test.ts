import { describe, it, expect } from 'vitest';
import { serialize, deserialize, type TreeNode } from '../src/utils/binaryTree';

function node(val: number, left: TreeNode | null = null, right: TreeNode | null = null): TreeNode {
  return { val, left, right };
}

describe('binary tree serialize / deserialize', () => {
  it('round-trips null', () => {
    expect(deserialize(serialize(null))).toBeNull();
  });

  it('round-trips a single node', () => {
    const root = node(1);
    expect(deserialize(serialize(root))).toEqual(root);
  });

  it('round-trips a full tree', () => {
    const root = node(1, node(2, node(4), node(5)), node(3, null, node(6)));
    expect(deserialize(serialize(root))).toEqual(root);
  });

  it('produces valid JSON with null markers', () => {
    const json = serialize(node(1, node(2), null));
    expect(JSON.parse(json)).toEqual({
      val: 1,
      left: { val: 2, left: null, right: null },
      right: null,
    });
  });
});
