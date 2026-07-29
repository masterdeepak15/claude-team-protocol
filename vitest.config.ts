import { defineConfig } from "vitest/config";

// Scope test discovery to this package's own tests/ — without this,
// vitest's default include glob scans the whole repo recursively and would
// also try to run teamhub-client/'s tests (a separate, independently
// published package with its own node_modules/test runner) from here.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
