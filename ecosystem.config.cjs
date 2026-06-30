module.exports = {
  apps: [
    {
      name: 'nco-backend',
      script: './node_modules/.bin/tsx',
      args: 'src/index.ts',
      cwd: '/Users/nova-ai/project/nco',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '15s',         // 15초 이상 실행시 안정 판정 (카운터 리셋 방지)
      env: {
        PORT: 6200,
        WS_PORT: 6201,
        NODE_ENV: 'production',
        PATH: [
          '/Users/nova-ai/.local/bin',
          '/opt/homebrew/bin',
          '/opt/homebrew/sbin',
          '/usr/local/bin',
          '/usr/bin',
          '/bin',
          '/usr/sbin',
          '/sbin',
        ].join(':'),
      },
    },
    {
      // macOS Apple Silicon — MLX LLM server (Gemma 4 26B A4B 4-bit)
      // OpenAI-compatible API on port 8000
      // Start: pm2 start ecosystem.config.cjs --only mlx-server
      name: 'mlx-server',
      interpreter: 'bash',
      script: '/Users/nova-ai/project/nco/cli-installs/mlx-server-wrapper.sh',
      args: '',
      cwd: '/Users/nova-ai/project/nco',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '30G',
      restart_delay: 10000,      // 재시작 간격 10s
      max_restarts: 20,          // 크래시 루프 감지 임계값 상향
      min_uptime: '30s',         // 30초 이상 실행되면 안정으로 간주
      kill_timeout: 5000,        // 종료 대기 5s
    },
    {
      // MLX keepalive — sends /v1/chat/completions every 25s to prevent idle exit
      // Without this, mlx_lm.server exits after ~30s of inactivity
      name: 'mlx-keepalive',
      interpreter: 'bash',
      script: '/Users/nova-ai/project/nco/cli-installs/mlx-keepalive.sh',
      cwd: '/Users/nova-ai/project/nco',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '64M',
      restart_delay: 5000,
      max_restarts: 50,
      min_uptime: '10s',
    },
    {
      // Anthropic-to-MLX proxy — converts Anthropic API ↔ OpenAI format
      // Listens on port 4100, forwards to MLX server at port 8000
      // Used by Claude Code: ANTHROPIC_BASE_URL=http://localhost:4100
      name: 'mlx-proxy',
      script: '/Users/nova-ai/project/nco/cli-installs/anthropic-mlx-proxy.py',
      args: '4100',
      interpreter: 'python3',
      cwd: '/Users/nova-ai/project/nco',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      restart_delay: 5000,
      max_restarts: 10,
    },
  ],
};
