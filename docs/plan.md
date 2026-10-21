# OpenDuet v0 plan

Written 21 October 2026 with Jerel, when this repository held only the README, the banner and the launch film.

## What OpenDuet is for

OpenDuet is a template. A builder, most likely a platform or IT team at a company, copies it, gives it their own name, model and apps, and rolls it out to the people they work with. Those people connect their own mail and calendar. OpenDuet then starts each day with a short brief, says what needs them and why, holds what can wait, and asks before it sends anything.

It rolls up to CopilotKit Soar, the business version of OpenBot. That decides what comes first:

- **Where the data lives, and who decides.** It runs in the company's own environment, on the models the company picks. One gateway decides every action and records it.
- **It learns from people's own work.** A correction such as "this could have waited" changes what it does next time.
- **New code stays thin.** OpenBot already has approvals, scheduled routines, the masked password box, a computer for each Bot, sign-in, audit and delivery. OpenDuet adds only what OpenBot lacks.
- **Every claim is checked against the code.** The README's status table changes only when a feature works. Nothing about Claude goes beyond the line saying OpenDuet is not affiliated with Anthropic.
- **The way in.** CopilotKit Intelligence is mandatory, as it is in OpenMuse. The free Developer plan is enough. The main call to action, in the README and in the app's banner, is "Talk to a CopilotKit engineer", with a `ref` tag on each link that the website must allowlist.
- **Usage is measured, the way OpenMuse measures it.**
  - The runtime's own telemetry is tagged `OpenDuet` and is not sampled.
  - The CLI-issued `CPK_TELEMETRY_ID` ties usage to the Intelligence account.
  - Opting out stays one setting.
  - The details are in [telemetry.md](telemetry.md).

Success means a real person connects their own accounts, and OpenDuet reliably saves them time without ever acting behind their back. The app looks and works like the one in the launch film, but every part of it runs on real data. A screen with nothing real to show yet shows an honest empty state, never a placeholder that pretends.

## How OpenBot comes in

- **The base.** OpenDuet is upstream `CopilotKit/openbot` `main` at `74051c1d` (21 October 2026, CI green), imported as one commit so this repository's history stays its own. Upstream is the only copy of OpenBot with approvals, routines with a worker, and the masked secret box together. Jerel's fork (`jerelvelarde/openbot`) runs production and has drifted. The local `~/Projects/openbot` has uncommitted work on an old base. Neither is a base.
- **Where it lives.** Everything from OpenBot is in `openbot/`, laid out exactly as upstream, so updates apply with `--directory=openbot`. The root holds only OpenDuet's own files: the README, `scripts/start.sh` and `stop.sh`, `docs/`, `evals/` and `assets/`.
  - The real `.env` is `openbot/.env`, because OpenBot's scripts rewrite it in place.
  - The root `.env` is a link to it, which `scripts/start.sh` makes the first time it runs.
  - A root `bun install` installs `openbot/`.
- **Taking OpenBot updates.** Bring them in on purpose, one pinned commit at a time. Each update applies the change between the OpenBot commit OpenDuet is on and a newer one, merged three ways into OpenDuet's own edits:

  ```sh
  git remote add openbot https://github.com/CopilotKit/openbot.git   # once
  git fetch openbot main
  git diff 74051c1d <commit> | git apply -3 --directory=openbot   # <commit>: a newer OpenBot commit with green CI
  ```

  Resolve any conflicts, commit with both OpenBot commits named in the message, and change `74051c1d` here to the new one. `README.md` always keeps OpenDuet's text. After an update that brings migrations, run `bun run --cwd openbot/server db:migrate`.
- **The rename is light, on purpose.** Everything that makes this OpenDuet is in the tenant package `openbot/examples/openduet`: the product name, the Bots, the channels, the model and the skills. The only other changes are:
  - the app's `<title>`;
  - the start script's banner, which reads the name from the package;
  - the default `TENANT_PACKAGE_DIR`;
  - the Docker image names.

  The `@openbot/*` packages, the `OPENBOT_*` settings, the database name and the Helm chart keep OpenBot's names. Renaming them would touch about 750 files, would make every upstream merge a conflict, and a builder renames the product again anyway. The same folder is what a builder copies to make the product theirs.

## The app: the one in the launch film, on OpenBot's working parts

OpenBot's web app (`openbot/app`) is refactored into the app the launch film shows. The film's components are the design source (`launch-film/film/src/duet/`, notes in `launch-film/notes/duet-ui-anatomy.md`). Each part is backed by something OpenBot already does:

| In the film | What backs it |
| --- | --- |
| Floating header (menu, mark, initial) and the Chat, Inbox and Activity tab bar | A new app shell. OpenBot's pages stay reachable from the menu: Connections, approval rules, Routines, Settings, Admin |
| Chat: one ongoing thread with OpenDuet | The OpenDuet Bot's channel, CopilotKit chat, Intelligence threads |
| The approval card: Refuse, Allow once, and "Always allow …" below them | OpenBot approvals (`approval_requests`, rules, resume). The buttons read Refuse, Allow once and Always allow |
| "Needs your password" with a masked field | OpenBot's secret box (`computer_request_secret`): the value goes to the site, never to the transcript |
| "OpenDuet's computer", working while you're away | Each Bot's own computer, which you can watch live and take over |
| Inbox: what is waiting on you | Pending approvals and questions now, and needs-you items from slice 2. Empty: "Nothing has needed you today." |
| Activity: what it did, and "Handled for you" | OpenBot's audit trail and activity, in plain words |
| The morning brief card (Needs you / Can wait) | Slice 2's triage. Until then it does not appear |

Wide screens show the same single column, centred; there is no separate desktop design.

## Where OpenDuet should beat Duet

Each of these answers a gap Duet itself admits, or is something it cannot do as a hosted app:

| Duet today | OpenDuet | When |
| --- | --- | --- |
| Checks connected accounts every few hours, to save usage | Notices new mail within minutes. It syncs cheaply and makes no model call until something new arrives. It uses Gmail push when the deployment has a public address | Slice 3 |
| Can misjudge what is urgent | Every item says why it needs you, and its precision and recall are measured on a labelled set that ships with the repository | Slice 2 |
| No way to say "that could have waited" | Corrections become rules the person can see and edit. An administrator can lock rules for everyone | Slice 3 |
| Its browser cannot be watched | The Bot's own browser can be watched live, and you can take the wheel. OpenBot already has this | Today |
| Lives in a separate app | Web, Slack, Teams and phone. OpenBot has the channels; the brief and approvals go through them | Slice 4 |
| Usage limits | Self-hosted, with any model and the company's own keys | Today |
| Messages arrive whenever they arrive | Quiet hours and a digest | Slice 4 |
| Failures are opaque | The brief says what it could not check, and why: a source not connected, an expired sign-in, a failed sync | Slice 2 |

## Slices

Each slice is usable end to end on its own and goes up as its own draft PR.

### Slice 1: OpenDuet boots

- OpenBot is imported at a pinned commit, in `openbot/`. The tenant package `openbot/examples/openduet` is the default.
- The app is refactored to match the launch film: Chat, Inbox, Activity, the approval card and the password box, all on OpenBot's working parts (see the table above).
- CopilotKit Intelligence is required to start, and the runtime's telemetry is tagged OpenDuet (see [telemetry.md](telemetry.md)).
- The README quick start works from a clean clone: `git clone`, `cp .env.example .env`, `bun install`, the Intelligence steps, then `bash scripts/start.sh`, which serves http://localhost:3010.
- **Done when** a fresh clone boots to the app, the OpenDuet Bot answers, and a short recording shows it.

### Slice 2: Gmail and Calendar, triage, brief, approved reply

- **Google connector.** Gmail and Google Calendar connect directly with Google OAuth, the same way OpenBot's Drive connector works:
  - an administrator registers the OAuth client once;
  - each person consents with their own account, and no administrator can connect an account for someone else;
  - there is no third-party broker;
  - read tools come first, and sending a reply is a write.
- **Triage.** Each new message gets a verdict, `needs_you` or `can_wait`, and a one-line reason.
  - Plain rules settle the obvious cases with no model call: bulk mail, `List-Unsubscribe`, `noreply` senders, receipts.
  - The model decides the rest and must give a reason.
  - Every verdict is stored with whatever decided it, so it can be audited and corrected.
- **Morning brief.** A routine posts the brief in the OpenDuet channel:
  - what needs you, each item with its reason;
  - what can wait, as one line;
  - today's calendar;
  - what it could not check, and why.
- **Approved reply.** OpenDuet drafts the reply. Sending it pauses for **Allow once / Always allow / Refuse**. The app's "Deny" is relabelled "Refuse" to match the README, the banner and the film.
- **Proof:**
  - a labelled set of synthetic mail (`evals/triage/`), with precision and recall for `needs_you` reported in the PR;
  - an end-to-end test against a fake Gmail: no send reaches it until a person answers, Refuse never sends, and Always allow sends the next one without asking;
  - a short recording on a test Google account. Jerel's real inbox is never used without asking him first.

### Later slices

- **Slice 3:** watching and learning.
  - Incremental Gmail and Calendar sync, and push where possible.
  - "This could have waited" and "this needed me" corrections, which turn into visible rules.
  - Needs-you rules the person can edit, and administrators can lock.
- **Slice 4:** reaching people where they are.
  - The brief and approvals in Slack, Teams and on the phone.
  - Quiet hours and a digest.
  - A native phone app with push. The web app already has the film's phone layout; this adds notifications that carry no message content. It starts from OpenBot's Expo app in `openbot/mobile`.
- **Slice 5:** the check on what leaves.
  - Every outgoing message is checked before the approval card shows.
  - Card numbers and government IDs are always refused.
  - Health and finance details go out only on the person's explicit instruction.
  - It compares who will receive a message with how sensitive its contents are.
  - Each check is numbered and has a test, so it can line up with CopilotKit's Open Safety Skills list if that ships.

## Rules for the build

- Draft PRs only. Nothing is merged, and the repository stays private.
- Commit messages are plain, with no co-author or attribution lines.
- The README status table changes only when a feature really lands.
- Tests and recordings use synthetic or consented data only.

## Calls made without Jerel

These are open to change:

- Base on upstream main at a pinned commit, not on the v0.2.0 tag. Main includes a month of fixes, including the onboarding for local evaluators.
- Keep the internal OpenBot names, as described above.
- Put everything from OpenBot in `openbot/`, the app included. The app is OpenDuet's design, but moving it out would mean rewriting every Dockerfile, compose context and cross-package import.
- PR #1 is one commit.
- Ship one OpenDuet Bot (built-in), plus a "Your agent" Bot that runs the LangGraph agent over AG-UI, to show that any agent can do the job.
- Connect Google directly, not through Composio or Arcade, so mail never passes through a third party.
- The README links to `copilotkit.ai/talk-to-an-engineer?ref=openduet_readme`, the same convention as `openbot_readme`, `openmuse_readme` and `opendots_readme`. The app banner uses `ref=openduet_app`. The website counts a ref only if it is on `TALK_TO_ENGINEER_REFS`; anything else is recorded as `contact_us`. Both refs therefore need adding there before launch, the way `opendots_readme` was added in CopilotKit/website#629. The wording needs Travis and Sam to agree before the repository goes public.
