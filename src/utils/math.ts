/**
 * 두 숫자를 더한다.
 * @param a 첫 번째 피연산자
 * @param b 두 번째 피연산자
 * @returns a와 b의 합
 * @throws {TypeError} 비숫자 입력인 경우
 * @throws {Error} null, undefined, NaN 입력인 경우
 */
export function add(a: number, b: number): number {
  if (a == null || b == null) {
    throw new Error('Both "a" and "b" are required');
  }

  if (typeof a !== 'number' || typeof b !== 'number') {
    throw new TypeError('Both "a" and "b" must be numbers');
  }

  if (Number.isNaN(a) || Number.isNaN(b)) {
    throw new Error('NaN is not allowed');
  }

  return a + b;
}

export function addTwo(a: number, b: number): number {
  return add(a, b);
}
