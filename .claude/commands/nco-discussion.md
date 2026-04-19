# 멀티 AI 토론을 시작합니다.
# $ARGUMENTS를 토론 주제로 사용합니다.
# 형식: /nco-discussion <토론 주제>
#
# [Ollama 모드 포함 모든 환경에서 동작]
# NCO API에 curl로 토론 세션을 생성하고, 완료까지 폴링합니다.

TOPIC="$ARGUMENTS"
NCO_URL="http://localhost:6200"

python3 - "$TOPIC" "$NCO_URL" << 'PYEOF'
import json, sys, urllib.request, time

topic   = sys.argv[1]
nco_url = sys.argv[2]

# 1. 토론 세션 생성
payload = json.dumps({
    'prompt':    topic,
    'providers': ['claude-code', 'opencode', 'gemini'],
    'maxRounds': 3
}).encode()
req = urllib.request.Request(
    f'{nco_url}/api/realtime/discussion',
    data=payload,
    headers={'Content-Type': 'application/json'}
)
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        resp = json.loads(r.read())
except Exception as e:
    print(f'[오류] 토론 세션 생성 실패: {e}')
    sys.exit(1)

session_id = resp.get('sessionId') or resp.get('id', '')
if not session_id:
    print(f'[오류] 세션 ID 없음: {resp}')
    sys.exit(1)

print(f'[토론 시작] 세션: {session_id}')
print(f'[주제] {topic}')
print('[대기 중] 최대 5분 폴링...')
sys.stdout.flush()

# 2. 완료까지 폴링 (최대 300초, 5초 간격)
for attempt in range(60):
    time.sleep(5)
    try:
        with urllib.request.urlopen(
            f'{nco_url}/api/discussions/{session_id}', timeout=5
        ) as r:
            data  = json.loads(r.read())
        disc  = data.get('discussion', data)
        status = disc.get('status', '')
        round_ = disc.get('current_round', 0)
        max_r  = disc.get('max_rounds', 3)
        elapsed = (attempt + 1) * 5

        if status == 'completed':
            result = json.loads(disc.get('result_json') or '{}')
            rounds = result.get('rounds', [])

            # Race condition guard: status=completed but result_json empty → retry up to 3x
            if not rounds:
                for retry in range(3):
                    time.sleep(3)
                    try:
                        with urllib.request.urlopen(
                            f'{nco_url}/api/discussions/{session_id}', timeout=5
                        ) as r2:
                            data2  = json.loads(r2.read())
                        disc2  = data2.get('discussion', data2)
                        result = json.loads(disc2.get('result_json') or '{}')
                        rounds = result.get('rounds', [])
                        if rounds:
                            disc = disc2
                            break
                    except Exception:
                        pass
                if not rounds:
                    print(f'\n[토론 완료] {elapsed}초 소요 — 결과 데이터 없음 (race condition 가능)')
                    print(f'세션 ID: {session_id}')
                    print(f'확인: curl -s {nco_url}/api/discussions/{session_id} | python3 -m json.tool')
                    break

            consensus = result.get('finalConsensusRate', disc.get('consensus_rate', 0))
            print(f'\n[토론 완료] {elapsed}초 소요')
            print(f'합의율: {consensus*100:.0f}%  |  라운드: {len(rounds)}')

            # 최종 라운드 응답 출력
            last = rounds[-1]
            for ai, text in last.get('responses', {}).items():
                if text and len(text.strip()) > 20:
                    print(f'\n### {ai}')
                    print(text[:800])
            break

        elif status in ('failed', 'error', 'cancelled'):
            print(f'\n[토론 실패] 상태: {status}')
            break

        else:
            # 진행 상황 표시 (10초마다)
            if attempt % 2 == 0:
                print(f'  → {elapsed}s | 상태: {status} | 라운드: {round_}/{max_r}')
                sys.stdout.flush()

    except Exception as e:
        if attempt % 4 == 0:
            print(f'  → 폴링 오류: {e}')
else:
    print('[타임아웃] 5분 초과 — 세션은 백그라운드에서 계속 진행 중일 수 있음')
    print(f'확인: curl -s {nco_url}/api/discussions/{session_id} | python3 -m json.tool')
PYEOF
