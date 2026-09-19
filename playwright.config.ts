import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:3000" },
  webServer: [
    { command: "pnpm dev:api", url: "http://localhost:8080/health", reuseExistingServer: true, env: { ...process.env, DECISION_PROVIDER: "fake", ACTIONGATE_API_KEY: "ag_test_local" } },
    { command: "pnpm dev:web", url: "http://localhost:3000", reuseExistingServer: true, env: { ...process.env, ACTIONGATE_API_KEY: "ag_test_local", API_URL: "http://localhost:8080" } }
  ]
});
