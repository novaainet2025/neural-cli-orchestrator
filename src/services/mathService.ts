import { add } from '../utils/math.js';

const SAFE_ABS_LIMIT = Number.MAX_SAFE_INTEGER;

export class MathValidationError extends Error {
  statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'MathValidationError';
  }
}

function assertValidNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    throw new MathValidationError(`Invalid numbers: "${label}" must be a finite number`);
  }

  if (Math.abs(value) > SAFE_ABS_LIMIT) {
    throw new MathValidationError(`Invalid numbers: "${label}" exceeds safe numeric limits`);
  }

  return value;
}

export interface AddResult {
  result: number;
  ok: true;
}

export function validateAdd(a: unknown, b: unknown): AddResult {
  const left = assertValidNumber(a, 'a');
  const right = assertValidNumber(b, 'b');
  const result = add(left, right);

  if (!Number.isFinite(result) || Math.abs(result) > SAFE_ABS_LIMIT) {
    throw new MathValidationError('Invalid numbers: result exceeds safe numeric limits');
  }

  return { result, ok: true };
}

export function validateAddTwo(a: unknown, b: unknown): AddResult {
  return validateAdd(a, b);
}
