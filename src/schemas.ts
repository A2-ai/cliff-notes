import { z } from "zod";

// What we feed the LLM for entry rewriting.
export interface EntryInput {
  pr_number: number | null;
  raw_subject: string;
  pr_title: string | null;
  pr_body: string | null;
  type: string;
  scope: string | null;
  author: string | null;
  url: string | null;
}

// What we expect back from the LLM for each entry.
const RewrittenEntrySchema = z.object({
  pr_number: z.number().int().nullable(),
  rewritten: z.string().min(1).max(280),
  highlight: z.boolean().optional().default(false),
});

export type RewrittenEntry = z.infer<typeof RewrittenEntrySchema>;

export const RewriteResponseSchema = z.object({
  entries: z.array(RewrittenEntrySchema),
});

export type RewriteResponse = z.infer<typeof RewriteResponseSchema>;

export function buildRewriteSchema(inputs: EntryInput[]) {
  const expectedPRs = inputs.map((e) => e.pr_number);
  return RewriteResponseSchema.superRefine((data, ctx) => {
    if (data.entries.length !== inputs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expected ${inputs.length} entries, got ${data.entries.length}`,
        path: ["entries"],
      });
      return;
    }
    for (let i = 0; i < expectedPRs.length; i++) {
      const got = data.entries[i]?.pr_number ?? null;
      const want = expectedPRs[i] ?? null;
      if (got !== want) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `entry ${i}: pr_number must be ${want === null ? "null" : want}, got ${got === null ? "null" : got}`,
          path: ["entries", i, "pr_number"],
        });
      }
    }
  });
}

export const SummaryResponseSchema = z.object({
  summary: z.string().min(1).max(2000),
});

export type SummaryResponse = z.infer<typeof SummaryResponseSchema>;
