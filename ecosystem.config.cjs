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
    {
      name: 'nco-vllm',
      interpreter: 'none',
      script: '/home/nova/vllm-env/bin/python',
      args: '-m vllm.entrypoints.openai.api_server --model /mnt/d/llm-models/vllm/gemma-4-26B-A4B-it-NVFP4 --quantization modelopt --dtype auto --kv-cache-dtype fp8 --gpu-memory-utilization 0.85 --max-model-len 8192 --max-num-seqs 4 --trust-remote-code --port 8000 --host 127.0.0.1',
      cwd: '/home/nova',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '20G',
      restart_delay: 10000,
      max_restarts: 3,
      env: {
        VLLM_NVFP4_GEMM_BACKEND: 'marlin',
      },
    },
  ],
};
