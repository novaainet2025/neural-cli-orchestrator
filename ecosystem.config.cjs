module.exports = {
  apps: [
    {
      name: 'nco-backend',
      script: 'npx',
      args: 'tsx src/index.ts',
      cwd: '/home/nova/projects/neural-cli-orchestrator',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        PORT: 6200,
        WS_PORT: 6201,
        NODE_ENV: 'production',
      },
    },
  ],
};
