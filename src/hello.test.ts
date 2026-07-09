import { describe, expect, it, vi, afterEach } from 'vitest';
import { printHelloWorld } from './hello.js';

describe('printHelloWorld', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints Hello World', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printHelloWorld();

    expect(logSpy).toHaveBeenCalledWith('Hello World');
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
