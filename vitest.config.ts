import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      // Only the pure entry re-export is excluded — security-critical modules
      // (scope/path confinement, consumers) must stay measured (AGENTS.md).
      exclude: ['src/index.ts'],
      thresholds: {
        statements: 80,
        branches: 68,
        functions: 80,
        lines: 80,
      },
    },
  },
})
