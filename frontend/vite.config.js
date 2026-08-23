import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  // Wails serves assets from a relative root, so emitted URLs must be relative.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    // Use happy-dom for a fast, browser-like DOM without a real browser.
    environment: "happy-dom",
    // Run the global setup file before every test file so Vue Test Utils,
    // Wails mock globals, and any other shared fixtures are always in place.
    setupFiles: ["./src/test/setup.js"],
    // Expose vi / describe / it / expect globally so tests read like plain
    // English without import noise at the top of every file.
    globals: true,
    alias: {
      "../wailsjs/go/main/Service.js": "/src/test/mocks/wails-service.js",
      "../wailsjs/runtime/runtime.js": "/src/test/mocks/wails-runtime.js",
      "../../wailsjs/runtime/runtime.js": "/src/test/mocks/wails-runtime.js",
    },
    // Collect coverage with v8 (no extra binary needed).
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{js,vue}"],
      exclude: ["src/test/**", "src/main.js"],
    },
  },
});
