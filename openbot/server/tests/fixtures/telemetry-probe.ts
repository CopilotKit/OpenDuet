/*
 * Run in a fresh process by telemetry.test.ts. Builds a CopilotKit runtime the way the server does,
 * with fetch replaced first so nothing reaches the real telemetry endpoint, and prints what would
 * have been sent.
 */
const requests: unknown[] = [];
globalThis.fetch = (async (url: string | URL, options?: RequestInit) => {
  requests.push({
    url: String(url),
    headers: options?.headers,
    body: JSON.parse(String(options?.body)),
  });
  return new Response('{"ok":true}', { status: 202 });
}) as typeof fetch;

// The same order as the server: telemetry.ts before anything that imports the runtime.
const { runtimeTelemetryProperties } = await import("../../src/telemetry");
const { CopilotRuntime, createCopilotRuntimeHandler } = await import(
  "@copilotkit/runtime/v2"
);

const runtime = new CopilotRuntime({
  agents: {},
  telemetryProperties: runtimeTelemetryProperties(
    process.env.PROBE_ACCESSIBILITY !== "off",
  ),
} as ConstructorParameters<typeof CopilotRuntime>[0]);
createCopilotRuntimeHandler({ runtime });
// The instance event is sent after a resolved promise, not synchronously.
await new Promise((resolve) => setTimeout(resolve, 100));
console.log(JSON.stringify(requests));

// A module, so top-level await is allowed here.
export {};
