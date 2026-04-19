module.exports = {
  apps: [
    {
      name: 'nco-backend',
      script: './node_modules/.bin/tsx',
      args: 'src/index.ts',
      cwd: '/Users/nova-ai/project/nco',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 5000,
      max_restarts: 5,
      env: {
        PORT: 6200,
        WS_PORT: 6201,
        NODE_ENV: 'production',
      },
    },
    {
      // macOS Apple Silicon — MLX server (Gemma 4 26B A4B 4-bit)
      // Enabled via: pm2 start ecosystem.config.cjs --only mlx-server
      name: 'mlx-server',
      interpreter: 'none',
      script: '/Users/nova-ai/.local/bin/mlx_lm.server',
      args: '--model /Users/nova-ai/project/LM-models/mlx/gemma-4-26b-a4b-it-4bit --port 8000 --host 127.0.0.1',
      cwd: '/Users/nova-ai/project/nco',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '30G',
      restart_delay: 8000,
      max_restarts: 5,
    },
  ],
};
