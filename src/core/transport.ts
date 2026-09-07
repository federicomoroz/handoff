/**
 * The seam between the app and the outside world.
 *
 * It is the standard Fetch API signature, nothing more. Production passes the global
 * `fetch`; the demo and the tests pass the `fetch` of the Hono app that simulates the
 * ERP. Both are `(Request) => Promise<Response>`, so the adapter runs exactly the same
 * code either way: no sockets, no test library, and no `if (TESTING)` branch that would
 * let production and tests drift apart.
 *
 * This is the TypeScript translation of the `ASGITransport` trick from shipping-quote,
 * and it comes out cleaner here because the seam is a standard rather than a library
 * class.
 */
export type Transport = (req: Request) => Promise<Response>;

/** The real transport. Used once SGC stops being simulated. */
export const networkTransport: Transport = (req) => fetch(req);

/**
 * Adapts a Hono app's `fetch` to `Transport`.
 *
 * Hono can answer synchronously when no handler is async, so its signature is
 * `Response | Promise<Response>`. `Transport` keeps the exact Fetch API shape — which is
 * what makes it valuable — and the difference is normalised here, once, instead of at
 * every call site.
 */
export const appTransport = (app: {
  fetch: (req: Request) => Response | Promise<Response>;
}): Transport => async (req) => app.fetch(req);
