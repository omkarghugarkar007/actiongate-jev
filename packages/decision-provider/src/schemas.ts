import { z } from "zod";
import type { DecisionProviderRequest, DecisionProviderResponse } from "@actiongate/core";

const probability = z.number().min(0).max(1);
const NoulAnswerSchema = z.object({ type: z.literal("noul"), noul: probability }).strict();
const ChoiceAnswerSchema = z.object({ type: z.literal("choice"), choice: z.string(), probabilities: z.record(z.string(), probability), confidence: probability }).strict();
const ScoreAnswerSchema = z.object({ type: z.literal("score"), score: z.number(), probabilities: z.record(z.string(), probability), confidence: probability, legend: z.record(z.string(), z.string()).optional() }).strict();

export const OpenRouterDecisionResponseSchema = z.object({
  model: z.string().min(1),
  provider: z.string().optional(),
  answers: z.record(z.string(), z.discriminatedUnion("type", [NoulAnswerSchema, ChoiceAnswerSchema, ScoreAnswerSchema])),
  usage: z.object({
    input_tokens: z.number().optional(), output_tokens: z.number().optional(), cost: z.number().optional(),
    inputTokens: z.number().optional(), outputTokens: z.number().optional(), costUsd: z.number().optional()
  }).passthrough().optional()
}).passthrough();

export function parseProviderResponse(raw: unknown, request: DecisionProviderRequest): DecisionProviderResponse {
  const parsed = OpenRouterDecisionResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`JEV_MALFORMED_RESPONSE:${parsed.error.issues[0]?.message ?? "invalid response"}`);
  for (const [key, question] of Object.entries(request.questions)) {
    const answer = parsed.data.answers[key];
    if (!answer) throw new Error(`JEV_MISSING_ANSWER:${key}`);
    if (answer.type !== question.type) throw new Error(`JEV_MALFORMED_RESPONSE:${key} answer type mismatch`);
    if (answer.type === "choice" && question.type === "choice") {
      if (!(answer.choice in question.criteria)) throw new Error(`JEV_MALFORMED_RESPONSE:${key} chose unknown option`);
      const expected = Object.keys(question.criteria).sort();
      const actual = Object.keys(answer.probabilities).sort();
      if (expected.join("|") !== actual.join("|")) throw new Error(`JEV_MALFORMED_RESPONSE:${key} probability options mismatch`);
    }
  }
  const usage = parsed.data.usage;
  const normalizedUsage = usage ? {
    ...(usage.input_tokens != null || usage.inputTokens != null ? { inputTokens: usage.input_tokens ?? usage.inputTokens } : {}),
    ...(usage.output_tokens != null || usage.outputTokens != null ? { outputTokens: usage.output_tokens ?? usage.outputTokens } : {}),
    ...(usage.cost != null || usage.costUsd != null ? { costUsd: usage.cost ?? usage.costUsd } : {})
  } : undefined;
  return {
    provider: "openrouter",
    model: parsed.data.model,
    answers: parsed.data.answers,
    ...(normalizedUsage ? { usage: normalizedUsage } : {}),
    ...(parsed.data.provider ? { metadata: { upstreamProvider: parsed.data.provider } } : {})
  };
}
