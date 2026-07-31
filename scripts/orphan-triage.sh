#!/usr/bin/env bash
# orphan-triage.sh — 재기동으로 생긴 고아 태스크 즉시 조치 (dry-run 기본)
#
# 부팅 시 자동 복구는 이미 있다: src/index.ts:85 recoverOrphanedTasks()
#   + src/core/orphan-recovery-policy.ts, 상한 MAX_ORPHAN_REQUEUE=2 (src/index.ts:55).
# 이 스크립트가 채우는 공백은 **부팅을 기다리지 않는 즉시 조치**와,
# 자동 복구가 다루지 않는 두 부류다:
#   (a) status=cancelled 인데 response 가 이미 있는 것 → 재실행하면 중복. 완료로 정정해야 한다.
#   (b) MAX_ORPHAN_REQUEUE 초과로 dead_letter 에 들어간 것 → 자동 복구가 손대지 않는다.
#
# 실측 근거(2026-07-30): 오늘 재시작 23회. 상한이 2라 태스크가 금방 poison 에 도달한다.
#   dead_letter(orphan) 431 · cancelled+출력없음 390 · cancelled+출력있음 125 · failed+orphaned 16
#   status=cancelled 671건(14일) 중 사용자/운영자 명시 취소는 0건이었다.
#
# 사용:
#   orphan-triage.sh report                 # 현황만 (기본)
#   orphan-triage.sh fix-completed [--apply]  # (a) 출력 있는 cancelled → completed 정정
#   orphan-triage.sh requeue [--apply]        # (b) 출력 없는 cancelled/orphaned → queued 재투입
#   orphan-triage.sh rescue-dlq [--apply]     # dead_letter orphan → requeue_count 리셋 후 재투입
#   orphan-triage.sh all [--apply]            # 위 3개 순서대로
#
# 안전장치:
#   - 기본 dry-run. --apply 없이는 DB 를 쓰지 않는다.
#   - 재투입 대상은 **게이트가 열린 프로바이더로만** 재배정한다(닫힌 곳에 던지면 F1 파생 실패).
#   - 사용자/운영자 명시 취소(user cancelled 등)는 절대 되살리지 않는다.
#   - 변경 전 대상 id 목록을 파일로 남긴다(되돌리기 근거).

set -u
DB="${NCO_DB:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/db/nco.db}"
NCO_URL="${NCO_API_URL:-http://localhost:6200}"
OUT_DIR="${NCO_ORPHAN_TRIAGE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/data/orphan-triage}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

APPLY=0
for a in "$@"; do [ "$a" = "--apply" ] && APPLY=1; done
CMD="${1:-report}"

_gate_available() {
  curl -s -m 8 "$NCO_URL/api/agents" 2>/dev/null | python3 -c '
import sys, json
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
for a in d.get("agents", []):
    if ((a.get("gate") or {}).get("available")) is True:
        print(a.get("id"))
'
}

# 사용자/운영자 명시 취소 제외 조건 (task-failover.ts POLICY_FAILURE_PATTERNS 와 동일 의도)
POLICY_EXCLUDE="AND COALESCE(error,'') NOT LIKE '%user cancelled%'
                AND COALESCE(error,'') NOT LIKE '%user_cancelled%'
                AND COALESCE(error,'') NOT LIKE '%operator cancelled%'
                AND COALESCE(error,'') NOT LIKE '%operator_cancelled%'"

cmd_report() {
  echo "── 고아 현황 (DB: $DB) ────────────────────────────"
  sqlite3 -header -column "$DB" "
    SELECT 'A. cancelled+출력있음 (완료 정정 대상)' k, COUNT(*) n FROM tasks
      WHERE status='cancelled' AND COALESCE(TRIM(response),'')<>'' $POLICY_EXCLUDE
    UNION ALL
    SELECT 'B. cancelled+출력없음 (재투입 대상)', COUNT(*) FROM tasks
      WHERE status='cancelled' AND COALESCE(TRIM(response),'')='' $POLICY_EXCLUDE
    UNION ALL
    SELECT 'C. failed/timed_out + orphaned* (재투입 대상)', COUNT(*) FROM tasks
      WHERE status IN ('failed','timed_out','lease_expired') AND COALESCE(error,'') LIKE 'orphaned%'
    UNION ALL
    SELECT 'D. dead_letter orphan (구조 대상)', COUNT(*) FROM dead_letter_tasks
      WHERE reason LIKE 'orphaned%';"
  echo
  echo "── 게이트 열린 프로바이더 (재배정 후보) ──────────"
  local avail; avail="$(_gate_available | tr '\n' ' ')"
  echo "  ${avail:-(없음 — 재투입 보류해야 한다)}"
  echo
  echo "  ※ --apply 없이는 아무것도 변경하지 않는다."
}

_pick_provider() {
  local avail; avail="$(_gate_available | head -1)"
  printf '%s' "$avail"
}

cmd_fix_completed() {
  echo "── A. cancelled + 출력있음 → completed 정정 ──────"
  local list="$OUT_DIR/fix-completed-$STAMP.txt"
  sqlite3 "$DB" "SELECT id FROM tasks
    WHERE status='cancelled' AND COALESCE(TRIM(response),'')<>'' $POLICY_EXCLUDE;" > "$list"
  local n; n="$(wc -l < "$list" | tr -d ' ')"
  echo "  대상 ${n}건 · 목록: $list"
  echo "  근거: 산출물이 이미 있으므로 재실행은 중복 작업이다. 재기동이 완료 직후 취소로 마킹한 사례."
  if [ "$APPLY" -eq 1 ] && [ "${n:-0}" -gt 0 ]; then
    sqlite3 "$DB" "UPDATE tasks
      SET status='completed',
          error=NULL,
          completed_at=COALESCE(completed_at, datetime('now')),
          updated_at=datetime('now')
      WHERE id IN (SELECT id FROM tasks
        WHERE status='cancelled' AND COALESCE(TRIM(response),'')<>'' $POLICY_EXCLUDE);"
    echo "  ✓ 적용됨 (${n}건)"
  else
    echo "  (dry-run)"
  fi
}

cmd_requeue() {
  echo "── B/C. 출력없는 고아 → queued 재투입 ───────────"
  local prov; prov="$(_pick_provider)"
  if [ -z "$prov" ]; then
    echo "  ✗ 게이트 열린 프로바이더가 없다 → 재투입 보류(닫힌 곳에 던지면 F1 파생 실패)."
    return 0
  fi
  local list="$OUT_DIR/requeue-$STAMP.txt"
  sqlite3 "$DB" "SELECT id FROM tasks
    WHERE ((status='cancelled' AND COALESCE(TRIM(response),'')='')
        OR (status IN ('failed','timed_out','lease_expired') AND COALESCE(error,'') LIKE 'orphaned%'))
      AND COALESCE(orphan_requeue_count,0) < 2
      $POLICY_EXCLUDE;" > "$list"
  local n; n="$(wc -l < "$list" | tr -d ' ')"
  echo "  대상 ${n}건 (requeue_count<2) · 재배정 프로바이더: $prov · 목록: $list"
  if [ "$APPLY" -eq 1 ] && [ "${n:-0}" -gt 0 ]; then
    sqlite3 "$DB" "UPDATE tasks
      SET status='queued',
          assigned_to='$prov',
          orphan_requeue_count = COALESCE(orphan_requeue_count,0) + 1,
          error=NULL, lease_expires_at=NULL, acked_at=NULL,
          updated_at=datetime('now')
      WHERE id IN (SELECT id FROM tasks
        WHERE ((status='cancelled' AND COALESCE(TRIM(response),'')='')
            OR (status IN ('failed','timed_out','lease_expired') AND COALESCE(error,'') LIKE 'orphaned%'))
          AND COALESCE(orphan_requeue_count,0) < 2
          $POLICY_EXCLUDE);"
    echo "  ✓ 적용됨 (${n}건) — NCO 워커가 큐에서 집어간다"
  else
    echo "  (dry-run)"
  fi
}

cmd_rescue_dlq() {
  echo "── D. dead_letter orphan 구조 ───────────────────"
  local prov; prov="$(_pick_provider)"
  if [ -z "$prov" ]; then echo "  ✗ 가용 프로바이더 없음 → 보류."; return 0; fi
  local list="$OUT_DIR/rescue-dlq-$STAMP.txt"
  sqlite3 "$DB" "SELECT task_id FROM dead_letter_tasks WHERE reason LIKE 'orphaned%';" > "$list"
  local n; n="$(wc -l < "$list" | tr -d ' ')"
  echo "  대상 ${n}건 · 재배정: $prov · 목록: $list"
  echo "  주의: 이들은 재큐 상한(2)을 이미 초과했다. 구조는 상한을 되돌리는 것이므로"
  echo "        재기동이 계속되는 상황에서는 다시 poison 이 된다 — 재시작을 먼저 멈춰야 한다."
  if [ "$APPLY" -eq 1 ] && [ "${n:-0}" -gt 0 ]; then
    sqlite3 "$DB" "UPDATE tasks
      SET status='queued', assigned_to='$prov', orphan_requeue_count=0,
          error=NULL, lease_expires_at=NULL, acked_at=NULL, updated_at=datetime('now')
      WHERE id IN (SELECT task_id FROM dead_letter_tasks WHERE reason LIKE 'orphaned%');"
    sqlite3 "$DB" "DELETE FROM dead_letter_tasks WHERE reason LIKE 'orphaned%';"
    echo "  ✓ 적용됨 (${n}건) — dead_letter 에서 제거 후 재투입"
  else
    echo "  (dry-run)"
  fi
}

case "$CMD" in
  report)        cmd_report ;;
  fix-completed) cmd_fix_completed ;;
  requeue)       cmd_requeue ;;
  rescue-dlq)    cmd_rescue_dlq ;;
  all)           cmd_fix_completed; echo; cmd_requeue; echo; cmd_rescue_dlq ;;
  *) sed -n '1,30p' "$0" >&2; exit 2 ;;
esac
