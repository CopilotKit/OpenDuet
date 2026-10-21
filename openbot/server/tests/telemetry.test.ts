import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROBE = join(import.meta.dir, "fixtures", "telemetry-probe.ts");

type Sent = {
  url: string;
  headers: Record<string, string>;
  body: {
    event: string;
    global_properties: Record<string, unknown>;
  };
};

/**
 * Builds a runtime in a fresh process, because the SDK reads the sample rate and the opt-outs once,
 * when its telemetry client is created. Runs from an empty directory so Bun loads no `.env`.
 */
async function capture(
  overrides: Record<string, string> = {},
): Promise<Sent[]> {
  const directory = await mkdtemp(join(tmpdir(), "openduet-telemetry-"));
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of [
    "DO_NOT_TRACK",
    "COPILOTKIT_TELEMETRY_DISABLED",
    "COPILOTKIT_TELEMETRY_SAMPLE_RATE",
    "COPILOTKIT_TELEMETRY_URL",
    "COPILOTKIT_LICENSE_TOKEN",
  ])
    delete env[key];
  try {
    const child = Bun.spawn([process.execPath, PROBE], {
      cwd: directory,
      env: { ...env, CPK_TELEMETRY_ID: "test-project-identity", ...overrides },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`probe exited ${code}: ${stderr}`);
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "[]");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("runtime telemetry", () => {
  test("names OpenDuet, carries the CLI-issued identity, and is not sampled away", async () => {
    const sent = await capture();
    expect(sent).toHaveLength(1);
    const [event] = sent;
    expect(event?.url).toBe("https://telemetry.copilotkit.ai/ingest");
    expect(event?.headers["X-CopilotKit-Telemetry-Id"]).toBe(
      "test-project-identity",
    );
    expect(event?.body.event).toBe("oss.runtime.instance_created");
    expect(event?.body.global_properties.accessibility_title).toBe("OpenDuet");
    expect(event?.body.global_properties.sampleRate).toBe(1);
  });

  test("an explicit sample rate wins over the default", async () => {
    expect(await capture({ COPILOTKIT_TELEMETRY_SAMPLE_RATE: "0" })).toEqual(
      [],
    );
  });

  test("either opt-out stops every event", async () => {
    for (const key of ["DO_NOT_TRACK", "COPILOTKIT_TELEMETRY_DISABLED"])
      for (const value of ["true", "1"])
        expect(await capture({ [key]: value })).toEqual([]);
  }, 30_000);

  test("OPENBOT_ACCESSIBILITY_DISABLED leaves the product unnamed", async () => {
    const [event] = await capture({ PROBE_ACCESSIBILITY: "off" });
    expect(event?.body.global_properties).not.toHaveProperty(
      "accessibility_title",
    );
  });
});
