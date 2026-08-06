import { describe, it, expect } from 'vitest';
import { serialize, deserialize, type TreeNode } from './binaryTree.js';

const leaf = (val: number): TreeNode => ({ val, left: null, right: null });

describe('serialize / deserialize 왕복', () => {
  it('null 트리', () => {
    expect(serialize(null)).toBe('null');
    expect(deserialize('null')).toBeNull();
  });

  it('단일 노드', () => {
    expect(deserialize(serialize(leaf(7)))).toEqual(leaf(7));
  });

  it('좌우가 있는 트리 — 구조와 값이 보존된다', () => {
    const root: TreeNode = { val: 1, left: leaf(2), right: { val: 3, left: leaf(4), right: null } };
    expect(deserialize(serialize(root))).toEqual(root);
  });

  it('한쪽으로만 자란 트리도 보존된다', () => {
    let root: TreeNode = leaf(0);
    for (let i = 1; i < 50; i += 1) root = { val: i, left: root, right: null };
    expect(deserialize(serialize(root))).toEqual(root);
  });

  it('음수·0·소수를 보존한다', () => {
    const root: TreeNode = { val: -1, left: leaf(0), right: leaf(1.5) };
    expect(deserialize(serialize(root))).toEqual(root);
  });
});

describe('deserialize 입력 검증', () => {
  it('키가 빠지면 거부한다', () => {
    expect(() => deserialize('{"val":1}')).toThrow('Invalid tree JSON');
    expect(() => deserialize('{"val":1,"left":null}')).toThrow('Invalid tree JSON');
  });

  it('val 이 숫자가 아니면 거부한다', () => {
    expect(() => deserialize('{"val":"1","left":null,"right":null}')).toThrow('Invalid tree JSON');
  });

  it('유한하지 않은 수는 거부한다', () => {
    // JSON 에 Infinity 리터럴은 없지만 null 로 직렬화돼 들어오는 경로가 있다.
    expect(() => deserialize(JSON.stringify({ val: Infinity, left: null, right: null })))
      .toThrow('Invalid tree JSON');
  });

  it('원시값·배열은 거부한다', () => {
    expect(() => deserialize('5')).toThrow('Invalid tree JSON');
    expect(() => deserialize('"x"')).toThrow('Invalid tree JSON');
    expect(() => deserialize('[]')).toThrow('Invalid tree JSON');
  });

  it('자식 쪽 결함도 잡는다 — 재귀 검증', () => {
    const bad = '{"val":1,"left":{"val":"nope","left":null,"right":null},"right":null}';
    expect(() => deserialize(bad)).toThrow('Invalid tree JSON');
  });

  it('JSON 자체가 깨지면 파서 오류가 그대로 난다', () => {
    expect(() => deserialize('{oops')).toThrow();
  });
});
