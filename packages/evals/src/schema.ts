import { z } from "zod";

/**
 * Dataset v2. The difference from v1 is provenance: every case records where its
 * label came from and who stood behind it, so a report can refuse to present
 * unreviewed labels as a quality result.
 */
export const DecisionSchema = z.enum(["ALLOW", "REVIEW", "BLOCK"]);
export type Decision = z.infer<typeof DecisionSchema>;

export const RiskClassSchema = z.enum([
  "READ_ONLY", "REVERSIBLE_WRITE", "EXTERNAL_COMMUNICATION", "FINANCIAL", "DESTRUCTIVE", "CREDENTIAL_OR_SECRET"
]);

/**
 * `generated` labels are machine-produced and carry no authority. `reviewed`
 * means a named annotator stood behind the label. `disputed` means reviewers
 * disagreed and the case is quarantined until resolved.
 */
export const ReviewStatusSchema = z.enum(["generated", "reviewed", "disputed"]);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const CaseKindSchema = z.enum([
  "supported",        // the action the user plainly asked for
  "target-swap",      // right operation, wrong recipient or resource
  "scope-creep",      // broader than what was asked
  "paraphrase",       // same request, different wording
  "hard-negative",    // superficially similar to a supported case but wrong
  "injection",        // retrieved or user text attempting to redirect the action
  "multilingual",     // non-English phrasing of a supported or unsupported case
  "ambiguous"         // genuinely underspecified; REVIEW is the correct answer
]);

export const AnnotationSchema = z.object({
  status: ReviewStatusSchema,
  /** Stable identifiers, never personal contact details. */
  annotators: z.array(z.string().min(1).max(64)).max(10),
  reviewedAt: z.string().datetime().optional(),
  /** Why the label is what it is. Required once a case is reviewed. */
  rationale: z.string().min(10).max(2000).optional(),
  /** Set when annotators disagreed, so the disagreement is visible rather than averaged away. */
  dissent: z.string().max(2000).optional()
}).strict();

export const EvalCaseSchema = z.object({
  id: z.string().min(1).max(128),
  kind: CaseKindSchema,
  riskClass: RiskClassSchema,
  difficulty: z.enum(["easy", "medium", "hard"]),
  tags: z.array(z.string().min(1).max(64)).min(1).max(20),
  input: z.object({
    userIntent: z.string().min(1).max(4000),
    proposedAction: z.object({
      tool: z.string().min(1).max(128),
      operation: z.string().min(1).max(128),
      arguments: z.record(z.string(), z.unknown())
    }).strict(),
    resources: z.record(z.string(), z.unknown()).optional(),
    deterministicFacts: z.record(z.string(), z.unknown()).optional()
  }).strict(),
  expectedDecision: DecisionSchema,
  /** Outcomes a correct system may return. A single value means the label is strict. */
  acceptableDecisions: z.array(DecisionSchema).min(1),
  annotation: AnnotationSchema,
  notes: z.string().max(2000).optional()
}).strict().refine((value) => value.acceptableDecisions.includes(value.expectedDecision), {
  message: "expectedDecision must be among acceptableDecisions",
  path: ["acceptableDecisions"]
}).refine((value) => value.annotation.status !== "reviewed" || Boolean(value.annotation.rationale), {
  message: "A reviewed case must record why the label is what it is",
  path: ["annotation", "rationale"]
}).refine((value) => value.annotation.status !== "reviewed" || value.annotation.annotators.length > 0, {
  message: "A reviewed case must name its annotators",
  path: ["annotation", "annotators"]
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const DatasetSchema = z.object({
  name: z.string().min(1).max(64),
  schemaVersion: z.literal(2),
  /** Bump when cases change. Reports pin this so a comparison is honest. */
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(10).max(500),
  /** The annotator guidance these labels were produced under. */
  guideline: z.string().min(1).max(200),
  cases: z.array(EvalCaseSchema).min(1)
}).strict();

export type Dataset = z.infer<typeof DatasetSchema>;

export interface DatasetSummary {
  total: number;
  reviewed: number;
  generated: number;
  disputed: number;
  byKind: Record<string, number>;
  byRisk: Record<string, number>;
  byDifficulty: Record<string, number>;
}

export function summarizeDataset(dataset: Dataset): DatasetSummary {
  const count = <T extends string>(pick: (item: EvalCase) => T) => {
    const result: Record<string, number> = {};
    for (const item of dataset.cases) result[pick(item)] = (result[pick(item)] ?? 0) + 1;
    return result;
  };
  return {
    total: dataset.cases.length,
    reviewed: dataset.cases.filter((item) => item.annotation.status === "reviewed").length,
    generated: dataset.cases.filter((item) => item.annotation.status === "generated").length,
    disputed: dataset.cases.filter((item) => item.annotation.status === "disputed").length,
    byKind: count((item) => item.kind),
    byRisk: count((item) => item.riskClass),
    byDifficulty: count((item) => item.difficulty)
  };
}
