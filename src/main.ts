import { serve } from '@hono/node-server';
import { buildTriageStack } from './composition';
import { buildHttpRoutes } from './adapters/primary/http-routes';

/**
 * The process entry point, and the second place in the repo allowed to name an adapter.
 *
 * It does almost nothing on purpose: assemble the stack through the composition root,
 * hand it to the routes, listen. Everything that could be a decision was already made in
 * `composition.ts`, which is what lets the eval runner and this server be the same agent.
 */

const PORT = Number(process.env['PORT'] ?? 8007);

const stack = buildTriageStack();
const app = buildHttpRoutes(stack);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`handoff listening on :${info.port}`);
  console.log(`  decider: ${stack.deciderId}`);
  // Printed rather than assumed. Leaving `erpTransport` out builds the simulated SGC,
  // which is the right default for a demo about that ERP and the wrong thing to discover
  // later — so the server says which one it is talking to, every time it starts.
  console.log(`  erp:     ${stack.erp}`);
  if (stack.erp === 'simulated') {
    console.log('');
    console.log('  The bundled ERP is a fixed snapshot from late August 2026. Pass');
    console.log('  "evaluated_at" to see anything other than "everything is stale":');
    console.log('');
    console.log(`    curl -s localhost:${info.port}/api/triage -H 'content-type: application/json' \\`);
    console.log(`      -d '{"order_id":"FC-10241","kind":"damaged",`);
    console.log(`           "customer_message":"Me llego la caja mojada y no enciende.",`);
    console.log(`           "evaluated_at":"2026-08-30T15:00:00Z"}'`);
  }
});
