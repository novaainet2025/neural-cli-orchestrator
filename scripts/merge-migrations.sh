#!/bin/sh
# 배포본의 마이그레이션을 기존 설치본에 **덧붙인다**. 절대 지우지 않는다.
#
# 왜 필요한가. 마이그레이션 검사는 번호가 아니라 **파일명 단위**다
# (`database.ts` 의 `sqlByFile: Map<파일명, sql>`). 그래서 같은 번호에 다른 파일이
# 공존해도 충돌하지 않지만, DB 가 이미 적용한 파일이 디렉터리에서 사라지면
# `Applied migration <파일> is missing from db/migrations. Applied migrations are
# append-only` 로 **기동이 거부된다.**
#
# 기기마다 계보가 갈린다. 실측(kangnote, 2026-08-07): 그 기기 DB 는 139건을 적용했고
# 그중 `125_audit_epochs.sql`·`126_task_idempotency_keys.sql` 은 내 저장소에 없다.
# 내 tgz 는 137건이라, 디렉터리를 통째로 교체하면 그 둘이 사라져 부팅이 죽는다.
# 실제로 두 번 겪었다(2026-08-06, 2026-08-07).
#
# **번호를 재배정해 합치지 말 것.** 파일명이 바뀌면 `schema_migrations` 의 기존 행과
# 안 맞아 같은 실패가 재발한다. 올바른 상태는 "배포본 전체 + 그 기기 고유분" 이다.
#
# 사용법:  sh scripts/merge-migrations.sh <배포본 migrations> <설치본 migrations>
set -eu

SRC="${1:?사용법: merge-migrations.sh <배포본 migrations 디렉터리> <설치본 migrations 디렉터리>}"
DST="${2:?사용법: merge-migrations.sh <배포본 migrations 디렉터리> <설치본 migrations 디렉터리>}"

[ -d "$SRC" ] || { echo "배포본 마이그레이션 디렉터리가 없습니다: $SRC" >&2; exit 1; }
mkdir -p "$DST"

# 설치본에만 있는 파일 = 그 기기 고유 계보. 보존 대상으로 먼저 알린다.
only_in_dst=$(comm -13 "$(ls "$SRC" | sort > /tmp/.mm-src; echo /tmp/.mm-src)" \
                       "$(ls "$DST" | sort > /tmp/.mm-dst; echo /tmp/.mm-dst)" || true)
if [ -n "$only_in_dst" ]; then
  echo "설치본 고유 마이그레이션 (보존):"
  echo "$only_in_dst" | sed 's/^/  /'
fi

# -n: 이미 있는 파일은 덮지 않는다. 기존 파일의 내용을 바꾸면 체크섬이 어긋난다.
added=0
for f in "$SRC"/*.sql; do
  [ -e "$f" ] || continue
  base=$(basename "$f")
  if [ ! -e "$DST/$base" ]; then
    cp "$f" "$DST/$base"
    added=$((added + 1))
  fi
done

rm -f /tmp/.mm-src /tmp/.mm-dst
echo "추가 $added 건 · 설치본 총 $(ls "$DST"/*.sql 2>/dev/null | wc -l | tr -d ' ') 건"
echo "삭제 0 건 (이 스크립트는 절대 지우지 않습니다)"
