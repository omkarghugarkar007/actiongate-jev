import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:3000" },
  webServer: [
    { command: "pnpm demo:research", url: "http://127.0.0.1:8097/health", reuseExistingServer: false },
    { command: "pnpm hackathon:workbench", url: "http://127.0.0.1:8096", reuseExistingServer: false },
    { command: "pnpm demo:nvidia", url: "http://127.0.0.1:8095/health", reuseExistingServer: false, env: { ...process.env, DEMO_BACKEND: "fake", NVIDIA_DEMO_PORT: "8095" } },
    { command: "pnpm dev:api", url: "http://localhost:8080/health", reuseExistingServer: true, env: { ...process.env, DECISION_PROVIDER: "fake", ACTIONGATE_API_KEY: "ag_test_local" } },
    { command: "pnpm dev:web", url: "http://localhost:3000", reuseExistingServer: true, env: { ...process.env, ACTIONGATE_API_KEY: "ag_test_local", API_URL: "http://localhost:8080" } }
  ]
});
