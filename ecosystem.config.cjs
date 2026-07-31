// Nova Fleet — PM2 ecosystem (중립 SSOT — 머신 로컬 앱은 ecosystem.local.cjs, git 비추적)
module.exports = {
  apps: [
    {
      name: 'nco-backend',
      // tsx 셸 래퍼는 PM2 cluster 모드에서 ERR_MODULE_NOT_FOUND로 크래시 루프(252회) —
      // 컴파일된 dist를 fork 모드로 실행 (npm run build 필요)
      script: 'dist/index.js',
      // 머신 중립화(2026-07-02): 경로는 이 파일 위치 기준, 머신별 값(OLLAMA_BASE_URL,
      // NCO_MEM0_NO_EMBED 등)은 .env(비추적)에서 읽는다 — 공유 저장소에 머신 전용 값 커밋 금지
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      // 실측 RSS는 startup governance + provider queue 초기화 후 약 465~530 MiB다.
      // 512M 기본값은 정상 프로세스를 PM2의 30초 검사 주기마다 재시작시켰다.
      //
      // 2026-07-30: 768M 도 같은 이유로 부족해졌다. pm2.log 실측 피크
      //   817MB / 827MB / 831MB / 890MB / 897MB / 938MB / 948MB / 957MB / 1020MB / 1247MB
      // → 07-28~30 사이 max-memory-restart 초과 재시작 12회(그중 오늘 6회). 정상 워크로드의
      // 자연 피크가 상한을 넘는 것이라 장애가 아니다. 그런데 재시작마다 in-flight 태스크의
      // 결과 라우팅이 끊겨 위임·토론이 연쇄 실패했다(F2 orphan → CB open → F1 cascade).
      // 상주 바닥값의 주범은 vector-memory.ts 의 축출 없는 HNSW indexCache 이고 그쪽은 별도 수정 중.
      // 호스트 RAM 48GB, PM2 전체 합계 398MiB 이므로 2G(=RAM 4%)는 진짜 OOM 위험이 없다.
      // 머신별 상한은 환경변수로 낮추거나 높일 수 있다.
      max_memory_restart: process.env.NCO_MAX_MEMORY_RESTART || '2G',
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '15s',
      // gateway.close() 실측 10.7초 + src/index.ts의 15초 drain + 큐/DB 정리를 보장한다.
      // 20초에서는 drain 도중 PM2가 SIGKILL한 T1 사건(2026-07-31 11:41/11:46/11:51)이 있었다.
      kill_timeout: Number(process.env.NCO_KILL_TIMEOUT_MS || 45000),
      env: {
        // 환경 변수 override를 허용해 격리 검증·다중 인스턴스 배포가 가능하다.
        PORT: Number(process.env.PORT || 6200),
        WS_PORT: Number(process.env.WS_PORT || 6201),
        NODE_ENV: 'production',
      },
    },
  ],
};
