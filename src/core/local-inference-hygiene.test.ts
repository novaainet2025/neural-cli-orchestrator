import { describe, it, expect } from 'vitest';
import {
  parseElapsedMs,
  parsePsLine,
  isLocalInferenceHygieneEnabled,
  resolveOllamaBaseUrl,
} from './local-inference-hygiene.js';

describe('parseElapsedMs', () => {
  it('mm:ss', () => {
    expect(parseElapsedMs('00:27')).toBe(27_000);
    expect(parseElapsedMs('12:25')).toBe(745_000);
  });

  it('hh:mm:ss — 오늘 관측한 멈춘 로더', () => {
    // 실측 `11:50:32` = 11시간 50분 32초.
    expect(parseElapsedMs('11:50:32')).toBe((11 * 3600 + 50 * 60 + 32) * 1000);
  });

  it('dd-hh:mm:ss — 하루 넘은 프로세스', () => {
    // 실측 `01-00:18:36`. mm:ss 로 잘못 읽으면 하루짜리를 18분으로 본다.
    expect(parseElapsedMs('01-00:18:36')).toBe((86_400 + 18 * 60 + 36) * 1000);
  });

  it('**하루 표기를 시분초와 혼동하지 않는다** — 유예 판정이 뒤집히는 자리', () => {
    const oneDay = parseElapsedMs('01-00:18:36')!;
    const eighteenMin = parseElapsedMs('18:36')!;
    expect(oneDay).toBeGreaterThan(eighteenMin);
    expect(oneDay / eighteenMin).toBeGreaterThan(70);
  });

  it('쓰레기 입력은 null', () => {
    for (const bad of ['', '  ', 'abc', '1:2:3:4', 'x-01:02']) {
      expect(parseElapsedMs(bad)).toBeNull();
    }
  });
});

describe('parsePsLine', () => {
  it('실제 ps 출력을 파싱한다 — RSS 는 KiB', () => {
    const line = '41243 38528   9296 11:50:32 /opt/homebrew/Cellar/ollama/0.32.5/libexec/lib/ollama/llama-server --model /blobs/x';
    const s = parsePsLine(line)!;
    expect(s.pid).toBe(41243);
    expect(s.ppid).toBe(38528);
    expect(s.rssBytes).toBe(9296 * 1024);
    expect(s.elapsedMs).toBe((11 * 3600 + 50 * 60 + 32) * 1000);
    expect(s.command).toContain('llama-server');
  });

  it('명령줄에 공백이 많아도 끝까지 잡는다', () => {
    const line = '1 2 3 00:05 /bin/node --a --b "c d" -e';
    expect(parsePsLine(line)!.command).toBe('/bin/node --a --b "c d" -e');
  });

  it('헤더·빈 줄·깨진 줄은 null', () => {
    for (const bad of ['', '   ', 'PID PPID RSS ELAPSED COMMAND', 'abc def']) {
      expect(parsePsLine(bad)).toBeNull();
    }
  });
});

describe('토글과 주소', () => {
  it('기본은 켜짐 — 감시가 옵트아웃이어야 사고를 잡는다', () => {
    expect(isLocalInferenceHygieneEnabled(undefined)).toBe(true);
  });

  it.each(['0', 'false', 'off', 'OFF', ' Off '])('%s 면 끈다', (v) => {
    expect(isLocalInferenceHygieneEnabled(v)).toBe(false);
  });

  it('기본 주소는 루프백 — localhost 는 000 을 낸 이력이 있다', () => {
    expect(resolveOllamaBaseUrl(undefined)).toBe('http://127.0.0.1:11434');
  });

  it('끝 슬래시를 정규화한다', () => {
    expect(resolveOllamaBaseUrl('http://host:1234///')).toBe('http://host:1234');
  });
});
