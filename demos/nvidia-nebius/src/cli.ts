import "dotenv/config";
import { createDemoModel, runDemo, ScenarioSchema } from "./runtime.js";
const backend = process.argv.includes("--nebius") ? "nebius" : process.argv.includes("--live") ? "nvidia" : "fake";
const scenario = ScenarioSchema.parse(process.argv.find((arg) => arg.startsWith("--scenario="))?.slice(11) ?? "injection");
const result = await runDemo(scenario, createDemoModel(backend));
console.log(JSON.stringify(result, null, 2));
