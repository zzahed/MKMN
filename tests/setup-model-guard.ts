/**
 * The network guard for the test suite: no test talks to a real server, and a
 * model request must never leave the test process. Every fetch here fails with
 * this explanation unless the test opted in — by stubbing `fetch` (the usual
 * way: the stub replaces this guard wholesale) or by setting
 * `globalThis.__mkmnAllowModelFetch = true` for a test that drives the real
 * guard deliberately (none exists today).
 */
declare global {
  var __mkmnAllowModelFetch: boolean | undefined;
}

const real = globalThis.fetch.bind(globalThis);

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (globalThis.__mkmnAllowModelFetch !== true) {
    const url = typeof input === "string" ? input : input instanceof URL ? String(input) : String((input as Request).url ?? input);
    return Promise.reject(
      new Error(
        `a test reached the network (${url}). A model request must go to a FakeModel ` +
        `(src/core/harness/testing.ts, passed as fetchFn) or a stubbed fetch; ` +
        `nothing in the suite is allowed to open a real connection.`,
      ),
    );
  }
  return real(input, init);
}) as typeof fetch;
