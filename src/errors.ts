interface Issue {
  path: (string | number)[];
  message: string;
}

const MAX_CAUSE_DEPTH = 8;

// AI SDK wraps schema failures as NoObjectGeneratedError -> TypeValidationError -> ZodError,
// so the actionable detail lives several `cause` hops down.
export function formatError(err: unknown, opts: { verbose?: boolean } = {}): string {
  if (!(err instanceof Error)) return String(err);

  const lines = [err.message];
  const issues = findIssues(err);
  if (issues.length > 0) {
    lines.push(
      ...issues.map((i) => `  - ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`),
    );
  }
  if (opts.verbose) {
    const text = (err as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) {
      lines.push("raw model response:", text);
    }
  }
  return lines.join("\n");
}

function findIssues(err: unknown): Issue[] {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth++) {
    const issues = (current as { issues?: unknown }).issues;
    if (Array.isArray(issues)) {
      return issues.filter(isIssue);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return [];
}

function isIssue(value: unknown): value is Issue {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Issue).path) &&
    typeof (value as Issue).message === "string"
  );
}
