/*
 * How OpenDuet shows up in the telemetry the CopilotKit runtime already sends. Nothing here adds an
 * event: it names the product on the runtime's own events and stops them being sampled away.
 *
 * Imported first by `index.ts`, because the SDK reads the sample rate when its telemetry client is
 * built, and that happens as soon as the runtime package is imported.
 */

/** The `accessibility_title` on every runtime event, which is how OpenDuet's traffic is counted. */
export const TELEMETRY_APP_TITLE = "OpenDuet";

/**
 * What the runtime adds to each event it already sends. Fixed rather than the tenant package's
 * product name, so a renamed fork is still counted as OpenDuet. OPENBOT_ACCESSIBILITY_DISABLED
 * turns the name off; COPILOTKIT_TELEMETRY_DISABLED or DO_NOT_TRACK turn telemetry off.
 */
export function runtimeTelemetryProperties(accessibility: boolean): {
  accessibility_title?: string;
} {
  return accessibility ? { accessibility_title: TELEMETRY_APP_TITLE } : {};
}

/*
 * The SDK samples runtime events at 5% unless told otherwise, which is too thin to see one
 * deployment's setup and first use. Default to full capture. An explicit
 * COPILOTKIT_TELEMETRY_SAMPLE_RATE still wins, and COPILOTKIT_TELEMETRY_DISABLED=true or
 * DO_NOT_TRACK=1 still turn telemetry off entirely. `||=`, not `??=`: the SDK treats an empty
 * value as unset, so this does too.
 */
process.env.COPILOTKIT_TELEMETRY_SAMPLE_RATE ||= "1";
