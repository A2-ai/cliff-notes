import { z } from "zod";

export interface EntryMember {
  sha: string;
  subject: string;
  body: string;
  type: string | null;
  scope: string | null;
  files: string[];
  additions: number;
  deletions: number;
}

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
  commit_sha: string | null;
  commit_url: string | null;
  members: EntryMember[];
  curated_by: "solo" | "pr" | "llm";
  llm_reason?: string;
}

export interface CurationInput extends EntryMember {
  index: number;
  author: string | null;
  pr_number: number | null;
  pr_url: string | null;
}

// What we expect back from the LLM for each entry.
const RewrittenEntrySchema = z.object({
  pr_number: z.number().int().nullable(),
  rewritten: z
    .string()
    .min(1)
    .max(400)
    .describe(
      "One sentence, at most 400 characters (about 50 words). State the purpose of the change and name at most two or three specific changes; do not enumerate every item from the PR body.",
    ),
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

const CurationGroupSchema = z.object({
  member_indices: z.array(z.number().int().nonnegative()).min(1),
  primary_index: z.number().int().nonnegative(),
  reason: z.string().min(1).max(200),
});

const CurationOmittedSchema = z.object({
  index: z.number().int().nonnegative(),
  reason: z.string().min(1).max(200),
});

export const CurationResponseSchema = z.object({
  groups: z.array(CurationGroupSchema).default([]),
  omitted: z.array(CurationOmittedSchema).default([]),
});

export type CurationResponse = z.infer<typeof CurationResponseSchema>;

export function buildCurationSchema(
  residual: CurationInput[],
  opts: {
    maxPerGroup: number;
    maxIndexGap: number;
    requireSameType: boolean;
    allowOmissions: boolean;
  },
) {
  return CurationResponseSchema.superRefine((data, ctx) => {
    if (!opts.allowOmissions && data.omitted.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "omissions are disabled",
        path: ["omitted"],
      });
    }

    const seen = new Map<number, string>();
    const expected = new Set(residual.map((_, i) => i));

    function record(index: number, path: (string | number)[]) {
      if (!expected.has(index)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `index ${index} is out of range`,
          path,
        });
        return;
      }
      const prior = seen.get(index);
      if (prior) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `index ${index} appears more than once (${prior})`,
          path,
        });
        return;
      }
      seen.set(index, path.join("."));
    }

    data.groups.forEach((group, groupIdx) => {
      const indices = group.member_indices;
      if (!indices.includes(group.primary_index)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "primary_index must be included in member_indices",
          path: ["groups", groupIdx, "primary_index"],
        });
      }
      if (indices.length > opts.maxPerGroup) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `group exceeds max_per_group ${opts.maxPerGroup}`,
          path: ["groups", groupIdx, "member_indices"],
        });
      }
      if (indices.length > 0 && Math.max(...indices) - Math.min(...indices) > opts.maxIndexGap) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `group exceeds max_index_gap ${opts.maxIndexGap}`,
          path: ["groups", groupIdx, "member_indices"],
        });
      }
      if (opts.requireSameType) {
        const types = new Set(indices.map((i) => residual[i]?.type ?? null));
        if (types.size > 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "group mixes commit types",
            path: ["groups", groupIdx, "member_indices"],
          });
        }
      }
      indices.forEach((index, memberIdx) => {
        record(index, ["groups", groupIdx, "member_indices", memberIdx]);
      });
    });

    data.omitted.forEach((omitted, omittedIdx) => {
      record(omitted.index, ["omitted", omittedIdx, "index"]);
    });

    for (const index of expected) {
      if (!seen.has(index)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `missing disposition for index ${index}`,
          path: [],
        });
      }
    }
  });
}
