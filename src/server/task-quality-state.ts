interface QualityStateDb {
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number | bigint };
  };
}

/**
 * 실행 자체가 끝났더라도 품질 게이트를 통과하지 못한 결과는 completed로 노출하지 않는다.
 * 응답 본문은 증거로 보존하고, 상태와 오류만 실패 종결로 교정한다.
 */
export function markTaskQualityRejected(
  db: QualityStateDb,
  taskId: string,
  heuristics: string[],
): boolean {
  const reason = `quality_rejected: ${heuristics.join(',')}`;
  const result = db.prepare(`
    UPDATE tasks
    SET status='failed',
        error=?,
        completed_at=COALESCE(completed_at, datetime('now')),
        updated_at=datetime('now')
    WHERE id=? AND status='completed'
  `).run(reason, taskId);
  return Number(result.changes) === 1;
}
