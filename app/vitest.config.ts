import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['test/e2e/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
  },
})
