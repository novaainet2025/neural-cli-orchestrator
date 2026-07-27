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
      max_memory_restart: '512M',
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '15s',
      // src/index.ts의 15초 drain + orphan/lock 영속화가 끝날 시간을 보장한다.
      kill_timeout: 20000,
      env: {
        // 환경 변수 override를 허용해 격리 검증·다중 인스턴스 배포가 가능하다.
        PORT: Number(process.env.PORT || 6200),
        WS_PORT: Number(process.env.WS_PORT || 6201),
        NODE_ENV: 'production',
      },
    },
  ],
};
