import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('monitor provider operational status', () => {
  const source = readFileSync(new URL('./monitor.ts', import.meta.url), 'utf8');

  it('polls the evidence-backed agents contract instead of stale daemon state', () => {
    expect(source).toContain("fetch(API+'/api/agents')");
    expect(source).toContain('setInterval(pollProviderStatus,10000)');
    expect(source).not.toContain("fetch(API+'/api/daemons')");
  });

  it('uses the page host for macOS, WSL and private-network access', () => {
    expect(source).toContain('const API=window.location.origin');
    expect(source).toContain("WS_LOCATION.protocol=window.location.protocol==='https:'?'wss:':'ws:'");
    expect(source).toContain("WS_LOCATION.port='${wsPort}'");
    expect(source).not.toContain("const API='http://localhost:");
    expect(source).not.toContain("const WS_URL='ws://localhost:");
  });

  it('renders work and limit states with operator guidance', () => {
    expect(source).toContain("a.work&&a.work.status");
    expect(source).toContain("a.limit&&a.limit.status");
    expect(source).toContain("limitState==='limited'?'LIMIT'");
    expect(source).toContain("limitState==='inconsistent'||staleLimitRecord?'STALE'");
    expect(source).toContain("const guidance=a.guidance");
    expect(source).toContain("replace(/\"/g,'&quot;')");
  });

  it('does not infer overview working state from historical task counters', () => {
    expect(source).toContain("workState==='working'?'● working'");
    expect(source).not.toContain("st.running>0?'● working'");
  });
});
