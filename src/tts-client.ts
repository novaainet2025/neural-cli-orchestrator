const SINO_ONES = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'] as const;

/** Sino-Korean reading for nonnegative integers (TTS-safe range up to 99,999). */
export function toSinoKorean(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    throw new RangeError(`toSinoKorean expects a nonnegative finite number, got ${n}`);
  }
  if (n === 0) {
    return '영';
  }
  let remainder = Math.floor(n);
  let parts: string[] = [];

  const wan = Math.floor(remainder / 10000);
  remainder %= 10000;
  if (wan !== 0) {
    parts.push(wan === 1 ? '만' : `${toSinoKorean(wan)}만`);
  }

  const thou = Math.floor(remainder / 1000);
  remainder %= 1000;
  if (thou !== 0) {
    parts.push(thou === 1 ? '천' : `${SINO_ONES[thou]}천`);
  }

  const hun = Math.floor(remainder / 100);
  remainder %= 100;
  if (hun !== 0) {
    parts.push(hun === 1 ? '백' : `${SINO_ONES[hun]}백`);
  }

  const ten = Math.floor(remainder / 10);
  remainder %= 10;
  if (ten !== 0) {
    parts.push(ten === 1 ? '십' : `${SINO_ONES[ten]}십`);
  }

  if (remainder !== 0) {
    parts.push(SINO_ONES[remainder]);
  }

  return parts.join('');
}

const NATIVE_BEFORE_COUNTER: Record<number, string> = {
  1: '한',
  2: '두',
  3: '세',
  4: '네',
  5: '다섯',
  6: '여섯',
  7: '일곱',
  8: '여덟',
  9: '아홉',
  10: '열',
  11: '열한',
  12: '열두',
  13: '열세',
  14: '열네',
  15: '열다섯',
  16: '열여섯',
  17: '열일곱',
  18: '열여덟',
  19: '열아홉',
  20: '스물',
};

/**
 * Native Korean quantifier form for 1–20 (한~스물); 21+ uses {@link toSinoKorean}.
 */
export function toNativeKorean(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    throw new RangeError(`toNativeKorean expects a nonnegative finite number, got ${n}`);
  }
  const whole = Math.floor(n);
  if (whole >= 1 && whole <= 20) {
    return NATIVE_BEFORE_COUNTER[whole];
  }
  return toSinoKorean(whole);
}

const KO_COUNT_REGEX = /(\d{1,3}(?:,\d{3})*|\d+)\s*(개|명)/g;
const KOREAN_CHAR_REGEX = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/;

/**
 * Normalize Arabic numerals before Korean counters for more natural TTS (개·명 → native 1–20, else hanja-style).
 */
export function normalizeKoreanNumbers(text: string): string {
  return text.replace(KO_COUNT_REGEX, (_full, digits: string, unit: string) => {
    const n = Number.parseInt(String(digits).replace(/,/g, ''), 10);
    if (Number.isNaN(n)) {
      return _full;
    }
    return `${toNativeKorean(n)} ${unit}`;
  });
}

/** True when the input contains Hangul syllables or jamo. */
export function containsKorean(text: string): boolean {
  return KOREAN_CHAR_REGEX.test(text);
}

/**
 * CosyVoice2 text frontend only normalizes Chinese safely.
 * Korean text must bypass it, otherwise Hangul falls into the English path and degrades badly.
 */
export function shouldDisableCosyVoiceTextFrontend(text: string, lang = 'ko'): boolean {
  const normalizedLang = lang.trim().toLowerCase();
  return normalizedLang === 'ko' || normalizedLang.startsWith('ko-') || containsKorean(text);
}

export interface CosyVoice2SynthesisPlan {
  inferenceMode: 'cross_lingual';
  normalizedText: string;
  textFrontend: boolean;
  hasKorean: boolean;
  reason: 'korean-bypass' | 'default-frontend';
}

/**
 * Derive the safe CosyVoice2 synthesis settings for mixed-language input.
 * Korean keeps `text_frontend=false`; other languages stay on the default frontend path.
 */
export function planCosyVoice2Synthesis(text: string, lang = 'ko'): CosyVoice2SynthesisPlan {
  const hasKorean = containsKorean(text);
  const disableFrontend = shouldDisableCosyVoiceTextFrontend(text, lang);
  return {
    inferenceMode: 'cross_lingual',
    normalizedText: disableFrontend ? normalizeKoreanNumbers(text) : text,
    textFrontend: !disableFrontend,
    hasKorean,
    reason: disableFrontend ? 'korean-bypass' : 'default-frontend',
  };
}
