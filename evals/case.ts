import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * The eval case format, and the reason it is two files.
 *
 * A case never carries its own answer. `cases/*.jsonl` describes a situation; the
 * expected behaviour lives in `labels.jsonl` and is joined by `case_id` at load time.
 * That split is not tidiness: it is what makes requirement 12 checkable. The agent runs
 * over a case, the grader runs over a label, and no object ever holds both while a model
 * is looking at it.
 *
 * Both schemas are `strictObject`. A misspelled key in a hand-written JSONL file is
 * otherwise ignored in silence, and a case that quietly drops its `erp_seed_overrides`
 * still runs — it just measures something other than what it says it measures.
 */

const IsoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not an ISO date');

export const EvalCaseSchema = z.strictObject({
  case_id: z.string().regex(/^(esc|act)-[a-z0-9-]+$/, 'must start with esc- or act-'),
  split: z.enum(['dev', 'test']),
  tags: z.array(z.string().min(1)),
  incident: z.strictObject({
    order_id: z.string().min(1),
    kind: z.enum(['delayed', 'damaged', 'lost']),
    customer_message: z.string().min(1),
    reported_at: IsoDate,
    channel: z.string().min(1).nullable(),
  }),
  erp_profile: z.enum(['sgc_hostile', 'sgc_tame']),
  /**
   * Edits applied to a copy of the seed before the trial, addressed by path:
   * `orders.FC-10241.total`. An unknown path throws rather than doing nothing — see
   * `seed-overrides.ts` for why that matters more than it looks.
   */
  erp_seed_overrides: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).default({}),
  /** The case clock. Frozen so "delayed but within the promise" does not rot into "delayed for months". */
  evaluated_at: IsoDate,
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const EvalLabelSchema = z.strictObject({
  case_id: z.string().min(1),
  /** Whether a human has to look at this one. The first of the two directions. */
  must_escalate: z.boolean(),
  /**
   * Every action a competent operator could defend here. More than one is normal: on a
   * delivered damaged item both a reship and a refund are reasonable, and scoring one of
   * them wrong would be measuring my taste rather than the agent's judgement.
   */
  acceptable_actions: z.array(z.enum(['reship', 'refund', 'request_evidence', 'escalate'])).min(1),
  /**
   * The facts that make this case what it is. Not every fact read — the ones without
   * which the answer cannot be justified, so citing them is evidence of reasoning rather
   * than of listing.
   */
  decisive_facts: z.array(z.string().min(1)),
  /** How this label came to exist. A label nobody can trace is a label nobody can argue with. */
  label_source: z.enum(['human-written', 'derived-from-policy']),
  /** Why, in one line. For the report, and for the next person who disagrees with it. */
  rationale: z.string().min(10),
});

export type EvalLabel = z.infer<typeof EvalLabelSchema>;

/** A case and its label, joined. Only the runner builds this; the agent never sees it. */
export interface LabelledCase {
  readonly evalCase: EvalCase;
  readonly label: EvalLabel;
}

function parseJsonl<T>(path: string, schema: z.ZodType<T>): T[] {
  const lines = readFileSync(path, 'utf-8')
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line.length > 0 && !line.startsWith('//'));

  return lines.map(({ line, number }) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      throw new Error(`${path}:${number} is not valid JSON: ${(error as Error).message}`);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new Error(`${path}:${number} does not match the schema — ${issues}`);
    }
    return parsed.data;
  });
}

export const loadCases = (path: string): EvalCase[] => parseJsonl(path, EvalCaseSchema);
export const loadLabels = (path: string): EvalLabel[] => parseJsonl(path, EvalLabelSchema);

/**
 * Joins cases to labels, and refuses anything ambiguous.
 *
 * Every failure below has been a real bug in someone's eval suite: a duplicated id makes
 * one case silently shadow another, an unlabelled case scores against nothing, and an
 * orphan label is usually the leftover of a case that was renamed — which means the
 * thing it was guarding stopped being measured and nobody noticed.
 */
export function joinCases(cases: readonly EvalCase[], labels: readonly EvalLabel[]): LabelledCase[] {
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.case_id)) throw new Error(`duplicate case_id: ${c.case_id}`);
    seen.add(c.case_id);
  }

  const byId = new Map<string, EvalLabel>();
  for (const label of labels) {
    if (byId.has(label.case_id)) throw new Error(`duplicate label for: ${label.case_id}`);
    byId.set(label.case_id, label);
  }

  const joined = cases.map((evalCase) => {
    const label = byId.get(evalCase.case_id);
    if (!label) throw new Error(`case has no label: ${evalCase.case_id}`);
    return { evalCase, label };
  });

  const orphans = [...byId.keys()].filter((id) => !seen.has(id));
  if (orphans.length > 0) throw new Error(`labels with no case: ${orphans.join(', ')}`);

  return joined;
}

/** Turns a case into the domain object the agent actually receives. */
export function toIncident(evalCase: EvalCase) {
  return {
    orderId: evalCase.incident.order_id,
    kind: evalCase.incident.kind,
    customerMessage: evalCase.incident.customer_message,
    reportedAt: new Date(evalCase.incident.reported_at),
    channel: evalCase.incident.channel,
  };
}
