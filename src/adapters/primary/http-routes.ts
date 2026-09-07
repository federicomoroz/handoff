import { Hono } from 'hono';
import { z } from 'zod';
import { TraceRecorder } from '../../domain/trace';
import { ErpUnavailableError } from '../../ports/erp';
import { LlmUnavailableError } from '../../ports/llm';
import { MalformedDecisionError, TruncatedDecisionError } from '../../ports/triage';
import type { TriageStack } from '../../composition';
import type { CaseFacts } from '../../domain/facts';
import type { Outcome } from '../../domain/decision';

/**
 * The HTTP face of the agent: the second adapter over `TriagePort`.
 *
 * The eval runner was the first, and until this existed the primary port had one caller
 * — which is the definition of decoration this project's own README uses about ports
 * nobody replaces. Both drive the same use case through the same `buildTriageStack`, so
 * the number the eval reports is a number about the agent this route serves.
 *
 * It also gives the trace its consumer. `TraceRecorder` records every hop — each ERP
 * read, each 429, each re-login, the model call, the verdict — and before this the only
 * thing that ever read it back was an eval trajectory file. An operator looking at a
 * decision needs to see what the agent saw, in order, including the four attempts it
 * took to get the order.
 */

/**
 * The request is untrusted text from outside, so it is parsed rather than cast.
 * `strictObject`: an unknown field is a caller who thinks this API does something it
 * does not, and answering 200 to that is how a misunderstanding survives to production.
 */
const TriageRequestSchema = z.strictObject({
  order_id: z.string().min(1).max(40),
  kind: z.enum(['delayed', 'damaged', 'lost']),
  customer_message: z.string().min(1).max(4000),
  reported_at: z.iso.datetime().optional(),
  channel: z.string().min(1).max(40).nullable().optional(),
  /**
   * The evaluation clock, optional and defaulting to now.
   *
   * It exists for the same reason the eval cases pin one: every threshold in the domain
   * is relative to a moment, and "delayed but within the promise" becomes "delayed for
   * months" if the clock moves and the data does not. The bundled ERP is a fixed
   * snapshot from late August 2026, so a demo that wants to see anything other than
   * "everything is stale" has to say when it is pretending to be.
   *
   * Against a real ERP a caller would not send this and the server's own clock is right.
   */
  evaluated_at: z.iso.datetime().optional(),
});

/** What the operator gets back. Flat, and it says who decided as loudly as what was decided. */
function present(outcome: Outcome, facts: CaseFacts, tracer: TraceRecorder): unknown {
  return {
    decision: {
      action: outcome.kind === 'acted' ? outcome.proposal.action : 'escalate',
      executed: outcome.kind === 'acted',
      // `model` means it chose to hand the case over; `guardrail` means it was stopped.
      // An operator reading a queue of escalations needs to tell those apart, and so
      // does anyone deciding whether the agent is worth keeping.
      escalated_by: outcome.kind === 'escalated' ? outcome.escalatedBy : null,
      blocked_by: outcome.kind === 'escalated' ? outcome.blockedBy : [],
      amount_pesos:
        outcome.proposal.amountCents === null ? null : outcome.proposal.amountCents / 100,
      confidence_pct: Math.round(outcome.proposal.confidence * 100),
      reason: outcome.proposal.reason,
      cited: outcome.proposal.evidence,
    },
    /** Every rule, passing ones included: the report has to name all three that fired. */
    guardrails: outcome.verdicts,
    facts: {
      order: facts.order,
      shipment: facts.shipment,
      history: facts.history,
      notes: facts.notes,
      /** Said out loud. A fact that went missing in silence looks like a fact that says no. */
      missing: facts.missingFacts,
    },
    trace: tracer.entries,
  };
}

export function buildHttpRoutes(stack: TriageStack): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, decider: stack.deciderId, erp: stack.erp }));

  app.post('/api/triage', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'the body is not JSON' }, 400);
    }

    const parsed = TriageRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'the request does not match the schema',
          issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
        },
        400,
      );
    }

    const input = parsed.data;
    const tracer = new TraceRecorder();
    const incident = {
      orderId: input.order_id,
      kind: input.kind,
      customerMessage: input.customer_message,
      reportedAt: input.reported_at ? new Date(input.reported_at) : new Date(),
      channel: input.channel ?? null,
    };

    try {
      const outcome = await stack.triage.run(
        incident,
        input.evaluated_at ? new Date(input.evaluated_at) : new Date(),
        tracer,
      );
      return c.json(present(outcome, outcome.facts, tracer));
    } catch (error) {
      return c.json(failure(error, tracer), statusFor(error));
    }
  });

  return app;
}

/**
 * The three ways this can fail are three different problems, and they get three
 * different answers.
 *
 * A model that produced nothing usable is not the same as an ERP that could not be
 * reached, and neither is a bug here. Collapsing them into one 500 would leave whoever
 * is on call guessing, and it is the same distinction the eval keeps between a model
 * failure and an infrastructure one — the layers should not disagree about what went
 * wrong.
 */
function statusFor(error: unknown): 502 | 503 | 500 {
  if (error instanceof ErpUnavailableError) return 503;
  if (error instanceof LlmUnavailableError) return 503;
  if (error instanceof MalformedDecisionError || error instanceof TruncatedDecisionError) return 502;
  return 500;
}

function failure(error: unknown, tracer: TraceRecorder): unknown {
  const shape = (kind: string, detail: string): unknown => ({
    error: kind,
    detail,
    // The trace is returned on the failure path too. A request that died four hops in is
    // exactly the one somebody needs the hops for.
    trace: tracer.entries,
  });

  if (error instanceof ErpUnavailableError) return shape('erp_unavailable', error.message);
  if (error instanceof LlmUnavailableError) return shape('model_unavailable', error.message);
  if (error instanceof MalformedDecisionError) return shape('model_answered_badly', error.message);
  if (error instanceof TruncatedDecisionError) return shape('model_answer_truncated', error.message);
  return shape('internal', error instanceof Error ? error.message : String(error));
}
