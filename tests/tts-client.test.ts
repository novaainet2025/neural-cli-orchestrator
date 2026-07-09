import { describe, expect, it } from 'vitest';
import {
  containsKorean,
  normalizeKoreanNumbers,
  planCosyVoice2Synthesis,
  shouldDisableCosyVoiceTextFrontend,
  toNativeKorean,
  toSinoKorean,
} from '../src/tts-client.js';

describe('toSinoKorean', () => {
  it('maps common values', () => {
    expect(toSinoKorean(0)).toBe('영');
    expect(toSinoKorean(10)).toBe('십');
    expect(toSinoKorean(21)).toBe('이십일');
    expect(toSinoKorean(100)).toBe('백');
    expect(toSinoKorean(102)).toBe('백이');
    expect(toSinoKorean(12345)).toBe('만이천삼백사십오');
  });
});

describe('toNativeKorean', () => {
  it('uses pure Korean for 1–20 before counters', () => {
    expect(toNativeKorean(1)).toBe('한');
    expect(toNativeKorean(4)).toBe('네');
    expect(toNativeKorean(9)).toBe('아홉');
    expect(toNativeKorean(10)).toBe('열');
    expect(toNativeKorean(11)).toBe('열한');
    expect(toNativeKorean(12)).toBe('열두');
    expect(toNativeKorean(13)).toBe('열세');
    expect(toNativeKorean(14)).toBe('열네');
    expect(toNativeKorean(19)).toBe('열아홉');
    expect(toNativeKorean(20)).toBe('스물');
  });

  it('falls back to sino-style for 21+', () => {
    expect(toNativeKorean(21)).toBe('이십일');
    expect(toNativeKorean(100)).toBe('백');
  });
});

describe('normalizeKoreanNumbers', () => {
  it('uses native numerals for 개·명 between 1 and 20', () => {
    expect(normalizeKoreanNumbers('상자 5개 있습니다')).toContain('다섯');
    expect(normalizeKoreanNumbers('학생 3명 입장')).toContain('세');
    expect(normalizeKoreanNumbers('11개')).toBe('열한 개');
    expect(normalizeKoreanNumbers('12개')).toBe('열두 개');
    expect(normalizeKoreanNumbers('13개')).toBe('열세 개');
    expect(normalizeKoreanNumbers('14개')).toBe('열네 개');
    expect(normalizeKoreanNumbers('20개')).toBe('스물 개');
  });

  it('uses sino-style numerals from 21 upward', () => {
    expect(normalizeKoreanNumbers('21개')).toBe('이십일 개');
    expect(normalizeKoreanNumbers('100명')).toBe('백 명');
  });

  it('strips grouping commas before parsing', () => {
    expect(normalizeKoreanNumbers('1,234개')).toBe('천이백삼십사 개');
  });

  it('leaves unrelated text untouched', () => {
    expect(normalizeKoreanNumbers('no-counter 20')).toBe('no-counter 20');
  });
});

describe('containsKorean', () => {
  it('detects Hangul syllables and jamo', () => {
    expect(containsKorean('안녕하세요')).toBe(true);
    expect(containsKorean('ㄱㅏ')).toBe(true);
    expect(containsKorean('hello 123')).toBe(false);
  });
});

describe('shouldDisableCosyVoiceTextFrontend', () => {
  it('disables frontend for Korean language tags even without Hangul', () => {
    expect(shouldDisableCosyVoiceTextFrontend('seoul station', 'ko')).toBe(true);
    expect(shouldDisableCosyVoiceTextFrontend('seoul station', 'ko-KR')).toBe(true);
  });

  it('disables frontend whenever Hangul appears', () => {
    expect(shouldDisableCosyVoiceTextFrontend('가격은 12개 입니다', 'en')).toBe(true);
  });

  it('keeps frontend enabled for non-Korean text', () => {
    expect(shouldDisableCosyVoiceTextFrontend('hello world', 'en')).toBe(false);
    expect(shouldDisableCosyVoiceTextFrontend('你好，世界', 'zh')).toBe(false);
  });
});

describe('planCosyVoice2Synthesis', () => {
  it('pins Korean synthesis to cross_lingual with frontend disabled', () => {
    expect(planCosyVoice2Synthesis('상자 5개 있습니다', 'ko')).toEqual({
      inferenceMode: 'cross_lingual',
      normalizedText: '상자 다섯 개 있습니다',
      textFrontend: false,
      hasKorean: true,
      reason: 'korean-bypass',
    });
  });

  it('keeps mixed Korean text on the Korean-safe path', () => {
    expect(planCosyVoice2Synthesis('오늘 3명 meeting', 'en')).toEqual({
      inferenceMode: 'cross_lingual',
      normalizedText: '오늘 세 명 meeting',
      textFrontend: false,
      hasKorean: true,
      reason: 'korean-bypass',
    });
  });

  it('leaves non-Korean text on the default frontend path', () => {
    expect(planCosyVoice2Synthesis('hello world', 'en')).toEqual({
      inferenceMode: 'cross_lingual',
      normalizedText: 'hello world',
      textFrontend: true,
      hasKorean: false,
      reason: 'default-frontend',
    });
  });
});
