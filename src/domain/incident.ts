/** The three claims this agent triages. */
export type IncidentKind = 'delayed' | 'damaged' | 'lost';

/**
 * What the customer reported, before touching the ERP.
 *
 * `customerMessage` is raw text, deliberately: it is the only unstructured part of an
 * incident, and an eval case has to start where the real problem starts rather than at
 * an already digested summary.
 */
export interface Incident {
  readonly orderId: string;
  readonly kind: IncidentKind;
  readonly customerMessage: string;
  readonly reportedAt: Date;
  readonly channel: string | null;
}
