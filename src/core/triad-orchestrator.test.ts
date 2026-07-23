import { describe, expect, it } from 'vitest';
import { normalizeOwnedFiles, triadOrchestrator } from './triad-orchestrator.js';

describe('normalizeOwnedFiles', () => {
  it('normalizes, sorts, and de-duplicates relative paths', () => {
    expect(normalizeOwnedFiles('/tmp/project', [
      './src/b.ts',
      'src/a.ts',
      'src/b.ts',
    ])).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('rejects path traversal and absolute ownership', () => {
    expect(() => normalizeOwnedFiles('/tmp/project', ['../secret'])).toThrow(/invalid owned file/);
    expect(() => normalizeOwnedFiles('/tmp/project', ['/etc/passwd'])).toThrow(/invalid owned file/);
  });

  it('rejects volatile shared-state paths', () => {
    expect(() => normalizeOwnedFiles('/tmp/project', ['db/nco.db'])).toThrow(/shared\/volatile/);
    expect(() => normalizeOwnedFiles('/tmp/project', ['data/team-runner/team_x.last'])).toThrow(/shared\/volatile/);
  });

  it('requires all three experience receipts before starting UI work', () => {
    expect(() => triadOrchestrator.start({} as never, {
      goal: '프론트엔드 UI 접근성과 user flow를 구현',
      projectDir: '/tmp',
      ownedFiles: ['src/example.ts'],
      proofCommands: [
        { name: 'build', command: 'npm run build', kind: 'verifier_exit_0' },
        { name: 'probe', command: 'node probe.js', kind: 'behavior_probe' },
        { name: 'a11y', command: 'node a11y.js', kind: 'a11y' },
      ],
    })).toThrow(/visual_or_dom.*user_path|user_path.*visual_or_dom/);
  });

  it('fails closed for shared-tree writes when Redis ownership is unavailable', () => {
    expect(() => triadOrchestrator.start({} as never, {
      goal: '백엔드 버그 수정',
      projectDir: '/tmp',
      ownedFiles: ['src/example.ts'],
      proofCommands: [
        { name: 'build', command: 'npm run build', kind: 'verifier_exit_0' },
        { name: 'probe', command: 'node probe.js', kind: 'behavior_probe' },
      ],
    })).toThrow(/requires Redis file ownership/);
  });
});
