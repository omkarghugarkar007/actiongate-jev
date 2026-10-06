import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assertPublicEvidence, RecordingSchema } from "../src/recording.js";

const original = JSON.parse(await readFile(new URL("../verification/nebius-workbench-2026-10-06.json", import.meta.url), "utf8"));
describe("public live evidence integrity", () => {
  it("keeps every planned case and the clarification hold, without raw permits", () => {
    const record = RecordingSchema.parse(original);
    expect(record.runs).toHaveLength(12);
    expect(record.runs.find((run) => run.id === "injection-r1")?.assertions.desiredOutcomeObserved).toBe(false);
    expect(() => assertPublicEvidence(record)).not.toThrow();
  });
  it("rejects removal of a held run and invented success assertions", () => {
    const removed = structuredClone(original); removed.runs.shift();
    expect(RecordingSchema.safeParse(removed).success).toBe(false);
    const invented = structuredClone(original); invented.runs[0].assertions.desiredOutcomeObserved = true;
    expect(RecordingSchema.safeParse(invented).success).toBe(false);
  });
  it("rejects fake evidence relabeled as live and unpriced model attribution", () => {
    const fake = structuredClone(original);
    for (const event of fake.runs[0].result.events) {
      if (event.data?.model?.provider) event.data.model.provider = "fake";
      if (event.data?.provider) event.data.provider = "fake";
    }
    expect(RecordingSchema.safeParse(fake).success).toBe(false);
  });
  it("rejects raw permits in nested event data and credential values inside text", () => {
    const leak = structuredClone(original); leak.runs[0].result.events[0].data.grant = { token: "fixture-raw-permit" };
    expect(() => assertPublicEvidence(leak)).toThrow("forbidden credential field");
    expect(() => assertPublicEvidence({ message: "echo fixture-provider-secret" }, ["fixture-provider-secret"])).toThrow("credential value");
  });
});
