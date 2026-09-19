import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@actiongate/core": `${root}packages/core/src/index.ts`,
      "@actiongate/decision-provider": `${root}packages/decision-provider/src/index.ts`,
      "@actiongate/sdk": `${root}packages/sdk-js/src/index.ts`,
      "@actiongate/db": `${root}packages/db/src/index.ts`
    }
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.live.test.ts"],
    coverage: { reporter: ["text", "html"] }
  }
});
