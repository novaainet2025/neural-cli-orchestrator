/**
 * Post-execution provider failover is default-on for legacy tasks, but an explicit
 * metadata opt-out must be authoritative. This mirrors intake selection without
 * silently changing tasks that predate the flag.
 */
export function isAutomaticProviderFailoverAllowed(metadataJson: string | null): boolean {
  if (!metadataJson) return true;
  try {
    const metadata: unknown = JSON.parse(metadataJson);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return true;
    return (metadata as Record<string, unknown>).allowProviderFailover !== false;
  } catch {
    return true;
  }
}
