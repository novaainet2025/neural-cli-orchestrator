test('validate timeout values', () => {
  expect(calculateTimeoutMs(20001)).toBe(20000);
  expect(calculateTimeoutMs(1e20)).toBe(300000);
  expect(calculateTimeoutMs(NaN)).toBe(300000);
  expect(calculateTimeoutMs(-5)).toBe(1);
  expect(calculateTimeoutMs(20000)).toBe(20000);
});