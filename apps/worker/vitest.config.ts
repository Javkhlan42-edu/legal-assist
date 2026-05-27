import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['../../test/worker/**/*.test.ts'],
    passWithNoTests: false,
  },
});
