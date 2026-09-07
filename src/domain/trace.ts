/**
 * The trace of one triage: what happened, in what order, and how long it took.
 *
 * `Tracer` is the abstraction ports and adapters consume; `TraceRecorder` is the only
 * implementation. It is propagated explicitly as a parameter, not through a global or
 * an async context: if an adapter needs to trace, it has to say so in its signature,
 * and that is visible when reading the code.
 *
 * Timings are relative to when the recorder was built, so each request owns its own and
 * no state is shared between cases.
 */

export type TraceStep =
  | 'input'
  | 'erp'
  | 'model'
  | 'output'
  | 'retry'
  | 'error';

export interface TraceEntry {
  readonly step: TraceStep;
  readonly label: string;
  readonly detail: string;
  readonly elapsedMs: number;
}

export interface Tracer {
  readonly entries: readonly TraceEntry[];
  mark(step: TraceStep, label: string, detail: string): void;
}

export class TraceRecorder implements Tracer {
  readonly entries: TraceEntry[] = [];
  private readonly startedAt = performance.now();

  mark(step: TraceStep, label: string, detail: string): void {
    this.entries.push({
      step,
      label,
      detail,
      elapsedMs: Math.round((performance.now() - this.startedAt) * 100) / 100,
    });
  }
}

/** For paths where the trace is not needed. Accumulates nothing. */
export const NULL_TRACER: Tracer = {
  entries: [],
  mark: () => {},
};
