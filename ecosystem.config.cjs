module.exports = {
  apps: [
    {
      name: 'nco-backend',
      // tsx 셸 래퍼는 PM2 cluster 모드에서 ERR_MODULE_NOT_FOUND로 크래시 루프(252회) —
      // 컴파일된 dist를 fork 모드로 실행 (npm run build 필요)
      script: 'dist/index.js',
      // 머신 중립화(2026-07-02): 경로는 이 파일 위치 기준, 머신별 값(OLLAMA_BASE_URL 등)은
      // .env(비추적)에서 읽는다 — 공유 저장소에 머신 전용 값 커밋 금지 (pull 충돌 원인)
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '768M',
      env: {
        PORT: 6200,
        WS_PORT: 6201,
        NODE_ENV: 'production',
      },
    },
  ],
};
