import { existsSync } from 'node:fs';

export function resolveInternalProjectDir(): string {
  const configured = process.env.NCO_PROJECT_DIR?.trim();
  if (configured && existsSync(configured)) {
    return configured;
  }

  const cwd = process.cwd();
  return existsSync(cwd) ? cwd : process.cwd();
}
