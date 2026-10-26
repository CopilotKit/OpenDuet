# Intelligence sign-up and OpenDuet usage tracking

OpenDuet uses the telemetry the CopilotKit runtime already sends. It adds no events of its own, and
there is no separate analytics SDK or key to configure.

## What is required

A CopilotKit Intelligence project is required. The server refuses to start without
`INTELLIGENCE_API_KEY`, and `scripts/start.sh` stops unless the runtime reports a valid licence.
Intelligence holds threads and memory, so an OpenDuet without it would forget every conversation.

Create or pick the project from the repository root:

```sh
npx --yes copilotkit@latest login
npx --yes copilotkit@latest project select
bun openbot/scripts/setup-learning.ts
```

`project select` writes two values to `.env`. Keep both, and deploy them together:

| Variable                   | Purpose                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `CPK_INTELLIGENCE_API_KEY` | The project's server-only key. `setup-learning.ts` copies it to `INTELLIGENCE_API_KEY`, which is what the server reads. |
| `CPK_TELEMETRY_ID`         | The CLI-issued identity of that project. The runtime sends it with each event, so usage can be tied to the Intelligence account. |

Do not generate a telemetry ID yourself or copy one from another project. An API key alone does not
give runtime telemetry an identity.

## What is sent

The runtime sends its own events to `https://telemetry.copilotkit.ai/ingest`. OpenDuet changes two
things about them, both in `openbot/server/src/telemetry.ts`:

- It adds `accessibility_title: "OpenDuet"`. The value is fixed, not taken from the tenant
  package's product name, so a renamed fork is still counted as OpenDuet.
  `OPENBOT_ACCESSIBILITY_DISABLED=true` drops the name.
- It sets `COPILOTKIT_TELEMETRY_SAMPLE_RATE` to `1` when nothing else has. The SDK's own default is
  5%, too thin to see one deployment's setup and first use. A value you set wins.

The events:

- `oss.runtime.instance_created`: the server created its runtime handler.
- `oss.runtime.copilot_request_created`: a request reached the runtime. This is evidence of use,
  not proof that the model answered.
- `intelligence_signup`: sent by Intelligence itself when an account is created, not by OpenDuet.

The project key is never put in an event.

## Turning it off

Set either `COPILOTKIT_TELEMETRY_DISABLED=true` or `DO_NOT_TRACK=1`, and restart the server. Both
accept `true` or `1`.

## How it is tested

`openbot/server/tests/telemetry.test.ts` starts the runtime in a fresh process with `fetch` replaced, so
nothing leaves the machine. It checks:

- the OpenDuet tag;
- the CLI-issued identity header;
- full sampling by default;
- that an explicit sample rate wins;
- that both opt-outs stop every event;
- that turning off the name leaves events unnamed.

These tests prove what the runtime sends from this repository. They do not prove that the events
arrive or that the identity resolves. To check that, after deploying, run one chat and look for
events whose `accessibility_title` is `OpenDuet` in CopilotKit's PostHog project.
