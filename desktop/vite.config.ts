// `vitest/config` re-exports Vite's defineConfig with the `test` block typed.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Keep the dev server aligned with src-tauri/tauri.conf.json (devUrl http://localhost:1420).
export default defineConfig({
  plugins: [react()],
  // Do not clear the terminal, so Tauri/Rust output stays visible during `tauri dev`.
  clearScreen: false,
  test: {
    // Vitest's default includes match `tests/bundle.test.cjs` and the WDIO
    // E2E specs under `e2e/`, but those files are standalone suites (node:test
    // via `node desktop/tests/bundle.test.cjs`; WebdriverIO via
    // `npm --prefix desktop run test:native`) and cannot opt themselves out
    // of vitest collection. Excluding them here keeps every suite
    // independently runnable; the defaults are re-listed because an explicit
    // `exclude` replaces them.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      "tests/bundle.test.cjs",
      "e2e/**"
    ]
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // src-tauri is owned by Cargo and the Tauri CLI, not by Vite.
      ignored: ["**/src-tauri/**"]
    }
  }
});
