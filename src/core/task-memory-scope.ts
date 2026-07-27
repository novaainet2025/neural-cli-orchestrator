export interface MemoryContextEntry {
  id: string;
  content: string;
  score: number;
  semantic: boolean;
}

const SAFE_TEAM_ID = /^[A-Za-z0-9._-]+$/;

/**
 * Return the shared vector-memory namespace for a team task.
 *
 * Personal agent memory remains unchanged. Setting NCO_TEAM_MEMORY_SCOPE=off
 * disables only the additional team namespace for an immediate rollback.
 */
export function resolveTeamMemoryScope(
  teamId: string | null | undefined,
  setting = process.env.NCO_TEAM_MEMORY_SCOPE,
): string | null {
  if (setting?.trim().toLowerCase() === 'off') return null;
  const normalized = teamId?.trim();
  if (!normalized || !SAFE_TEAM_ID.test(normalized)) return null;
  return `team:${normalized}`;
}

/**
 * Merge personal and team recall without injecting the same content twice.
 * When duplicate content has different scores, keep the stronger match.
 */
export function mergeMemoryContextEntries<T extends MemoryContextEntry>(
  groups: ReadonlyArray<ReadonlyArray<T>>,
  limit = 5,
): T[] {
  if (limit <= 0) return [];

  const byContent = new Map<string, T>();
  for (const group of groups) {
    for (const entry of group) {
      const key = entry.content.trim().replace(/\s+/g, ' ');
      const previous = byContent.get(key);
      if (!previous || entry.score > previous.score) {
        byContent.set(key, entry);
      }
    }
  }

  return [...byContent.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
