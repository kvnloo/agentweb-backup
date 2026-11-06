import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
  },
});
