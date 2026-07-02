module.exports = {
  apps: [
    {
      name: 'nco-backend',
      // tsx 셸 래퍼는 PM2 cluster 모드에서 ERR_MODULE_NOT_FOUND로 크래시 루프(252회) —
      // 컴파일된 dist를 fork 모드로 실행 (npm run build 필요)
      script: 'dist/index.js',
      cwd: '/Users/nova-ai/project/nco',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '768M',
      env: {
        PORT: 6200,
        WS_PORT: 6201,
        NODE_ENV: 'production',
        // macOS 네이티브 Ollama (WSL 전용 172.28.112.1은 이 Mac에서 도달 불가 — timeout 원인)
        OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
      },
    },
  ],
};
