import { defineConfig } from '/Users/nova-ai/project/nova-use/node_modules/vitest/dist/config.js'

export default defineConfig({
  root: '/Users/nova-ai/project/nova-use',
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
