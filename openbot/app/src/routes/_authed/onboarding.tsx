import { WEB_HARNESSES } from "@openbot/shared/harnesses";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  redirect,
  useLocation,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import * as React from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { HarnessMark } from "@/components/agents/harness-mark";
import { Composer } from "@/components/channels/composer";
import { FINISH_MS, MicOrb } from "@/components/duet/mic-orb";
import { SELF_HOST_URL } from "@/components/layout/self-host-banner";
import { CapabilityDemo } from "@/components/onboarding/capability-demo";
import { ConnectAppsStep } from "@/components/onboarding/connect-apps-step";
import { IllustrationFrame } from "@/components/onboarding/illustration-frame";
import { useNotifyStep } from "@/components/onboarding/notify-step";
import {
  type OnboardingStep,
  OnboardingWizard,
} from "@/components/onboarding/onboarding-wizard";
import { SetupChecklist } from "@/components/onboarding/setup-checklist";
import { buttonVariants } from "@/components/ui/button";
import { primaryBot } from "@/lib/agents/primary-bot";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions, needsOnboarding } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { appConfig } from "@/lib/generated/application-config";
import {
  advanceOnboardingMutationOptions,
  completeOnboardingMutationOptions,
} from "@/lib/onboarding/mutations";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/**
 * Every step, by id, with the number the server stores for it.
 *
 * `POST /api/me/onboarding` keeps a step as an integer, so each id has a number of its own. A
 * number per id, never a position in the list: the three local-evaluation steps join the list only
 * for somebody trying OpenDuet alone, and a position would mean a different step to them than to
 * everybody else. 0 is the server's "not started".
 */
const STEP_NUMBER = {
  welcome: 1,
  computer: 2,
  roster: 3,
  local: 4,
  agents: 5,
  organization: 6,
  apps: 7,
  notify: 8,
  setup: 9,
} as const;
type StepId = keyof typeof STEP_NUMBER;

const isStepId = (value: unknown): value is StepId =>
  typeof value === "string" && Object.hasOwn(STEP_NUMBER, value);

/** The step a stored number names, or null for "not started" and for a number no step has. */
function stepForNumber(step: number | undefined): StepId | null {
  const found = Object.entries(STEP_NUMBER).find(([, at]) => at === step);
  return found ? (found[0] as StepId) : null;
}

/**
 * The step Next was pressed on, kept in the history entry it pushed (`onboardingFrom`). Kept in the
 * entry rather than in memory, so it survives a reload: the bar's Back after a reload still pops the
 * entry instead of adding a second one for the same step.
 */
type OnboardingEntry = { onboardingFrom?: unknown };

/**
 * A consent in flight: the step it left from and the history entry it left, in this tab's session
 * storage so it survives the trip to the vendor and back.
 */
const CONSENT_KEY = "openduet-onboarding-consent";
type ConsentDeparture = { step: StepId; entry: string | null };

/** The key TanStack Router gives the current history entry, or null. */
function currentEntryKey(): string | null {
  const state = window.history.state as { __TSR_key?: unknown } | null;
  return typeof state?.__TSR_key === "string" ? state.__TSR_key : null;
}

/** Leaves for a vendor's consent from a step, noting where from. */
function leaveForConsent(step: StepId, url: string) {
  try {
    sessionStorage.setItem(
      CONSENT_KEY,
      JSON.stringify({ step, entry: currentEntryKey() }),
    );
  } catch {
    // Storage refused: the return still lands on the step, Back just isn't rewritten.
  }
  window.location.assign(url);
}

/** The consent this tab left for, if there is one. Read only; dropped once it has been used. */
function readConsentDeparture(): ConsentDeparture | null {
  try {
    const raw = sessionStorage.getItem(CONSENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { step?: unknown; entry?: unknown };
    if (!isStepId(parsed.step)) return null;
    return {
      step: parsed.step,
      entry: typeof parsed.entry === "string" ? parsed.entry : null,
    };
  } catch {
    return null;
  }
}

function dropConsentDeparture() {
  try {
    sessionStorage.removeItem(CONSENT_KEY);
  } catch {
    // Nothing to drop.
  }
}

export const Route = createFileRoute("/_authed/onboarding")({
  /*
   * WHERE SOMEBODY IS LIVES IN THE ADDRESS. `?step=<id>` is the step on screen, so a reload stays
   * on it, browser Back and Forward walk the steps, and a consent started on a step comes back to
   * it (`?step=apps` or `?step=setup`; see `connectedAccountsUrlFor` on the server).
   * `?connected=failed` says that consent did not go through, and is dropped once read. Anything
   * else is ignored.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { step?: StepId; connected?: "failed" } => ({
    // Named even when absent: the router lays this over the raw search, so a key left out would
    // keep whatever was typed into the address.
    step: isStepId(search.step) ? search.step : undefined,
    connected: search.connected === "failed" ? "failed" : undefined,
  }),
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    // Somebody who has finished, or whose deployment tracks no onboarding, has no business here.
    if (!user || !needsOnboarding(user)) {
      throw redirect({ to: "/" });
    }
  },
  component: RouteComponent,
});

function WelcomeStep() {
  return (
    <div className="w-full flex flex-col items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight max-w-md text-center [overflow-wrap:anywhere]">
        Welcome to {appConfig.brand.productName}
      </h1>
      <div className="h-8" />
      <IllustrationFrame
        className="flex min-w-0 flex-col items-center px-4 pt-12 pb-8"
        label="A message box where you hand off tasks to your Bots"
      >
        <MicOrb size={72} />
        {/*
         * A POSTER OF A COMPOSER, AND THE FRAME AROUND IT IS WHAT MAKES IT ONE: `IllustrationFrame` is
         * `pointer-events-none` and `inert`. Nothing here is
         * meant to be typed in, clicked or dropped on: it is a picture of the thing the person is
         * about to get, shown while they read a sentence about it.
         *
         * THE DROP THAT PASSES STRAIGHT THROUGH IT IS SOMEBODY ELSE'S TO CATCH, WHICH IS WORTH
         * SAYING OUT LOUD. The composer guards its own form against a dropped file navigating the
         * whole app away (`refuseDragOver` in `composer.tsx`), and that guard cannot fire here: an
         * element with no pointer events is never the target of the drop, so the event goes past it
         * to the document as if this composer were not on the page. What catches it is
         * `useUnclaimedDropGuard` in `routes/__root.tsx`, which refuses every drop nobody claimed —
         * the reason that guard lives at the root rather than in the composer, and the reason this
         * wrapper does not need to change to be safe. Taking `pointer-events-none` off to "fix" the
         * drop would turn the poster back into a live composer with nowhere to upload to.
         */}
        <div className="max-w-md w-full mx-auto mt-10">
          <Composer
            compact
            className="min-w-0"
            editorClassName="text-base"
            initialValue="Hand off tasks to your team of Bots"
          />
        </div>
      </IllustrationFrame>
    </div>
  );
}

function ComputerUseStep() {
  return (
    <div className="w-full flex flex-col items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight max-w-md text-center [overflow-wrap:anywhere]">
        Each Bot has its own computer
      </h1>
      <div className="h-8" />
      <CapabilityDemo kind="search" />
    </div>
  );
}

/** What a roster card needs — placeholders carry these three fields and nothing more. */
type RosterCard = Pick<AgentProfile, "id" | "name" | "avatarSeed">;

/**
 * Stand-ins for a deployment that has fewer than three public agents to show. Invented names on
 * purpose: they illustrate what a roster looks like without claiming any of these exist here.
 */
const AGENTS_PLACEHOLDER: RosterCard[] = [
  {
    id: "placeholder-research",
    name: "Research Analyst",
    avatarSeed: "research-analyst",
  },
  { id: "placeholder-data", name: "Data Analyst", avatarSeed: "data-analyst" },
  {
    id: "placeholder-support",
    name: "Support Desk",
    avatarSeed: "support-agent",
  },
];

function RosterStep() {
  const { data: agents } = useQuery(agentListQueryOptions());
  const explore =
    agents?.filter((a) => !a.mine && a.visibility === "public") ?? [];
  // Always three cards: real public agents first, placeholders topping up a sparse deployment.
  // slice past the end is just [], so a roster of three or more takes no placeholders at all.
  const roster: Array<RosterCard & { example?: boolean }> = [
    ...explore.slice(0, 3),
    ...AGENTS_PLACEHOLDER.slice(explore.length).map((placeholder) => ({
      ...placeholder,
      example: true,
    })),
  ];

  /*
   * THE ROSTER IS THIS STEP'S PICTURE, AND THE ONLY ONE. It used to sit under an animated approval
   * card (the hand-off demo), which filled a phone's screen by itself: the step about picking a Bot
   * opened on Refuse and Allow once, with the Bots to pick from cut off below the fold. Asking
   * before acting has its own step, so here the roster is drawn first and whole.
   */
  return (
    <div className="w-full flex flex-col items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight max-w-md text-center [overflow-wrap:anywhere]">
        Pick a Bot or make your own
      </h1>
      <div className="h-8" />
      <IllustrationFrame
        className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4"
        label={`Bot roster: ${roster.map((a) => `${a.name} (${a.example ? "example" : "available"})`).join(", ")}, and one of your own`}
      >
        {roster.map((a) => {
          return (
            <div
              key={a.id}
              // Dimmed and labelled, so an invented name never reads as a Bot this deployment has.
              className={`bg-card p-4 rounded-lg flex flex-row gap-4 items-center ${a.example ? "opacity-70" : ""}`}
            >
              <AbstractAvatar
                id={a.id}
                name={a.name}
                seed={a.avatarSeed}
                size={40}
              />
              <div className="flex min-w-0 flex-col">
                <h3 className="line-clamp-1 text-base font-medium tracking-tight">
                  {a.name}
                </h3>
                {a.example ? (
                  <span className="text-xs text-muted-foreground">Example</span>
                ) : null}
              </div>
            </div>
          );
        })}
        <div className="bg-card p-4 rounded-lg flex flex-row gap-4 items-center">
          <div className="rounded-full size-[40px] border border-foreground/30 border-dashed" />
          <h3 className="line-clamp-1 text-base font-medium tracking-tight text-foreground/70">
            Your own Bot
          </h3>
        </div>
      </IllustrationFrame>
    </div>
  );
}

/*
 * THE THREE SLIDES BELOW ARE FOR SOMEBODY TRYING OPENBOT ON THEIR OWN MACHINE, and only they see them
 * (see `localEvaluation` in RouteComponent). They answer what that person is deciding: where their
 * data is, whether their own agents fit, and what taking it to their organization involves (OB-02 in
 * the product backlog). None of it is said to an organization's own people, who are past all three.
 */

/**
 * Where an evaluator's data is kept, said as the server actually keeps it.
 *
 * IT USED TO SAY CONVERSATIONS STAYED ON THIS COMPUTER, AND THEY DO NOT. The server refuses to start
 * without CopilotKit Intelligence (`INTELLIGENCE_API_URL` and `INTELLIGENCE_API_KEY`, see
 * `.env.example` and `docs/telemetry.md`), because Intelligence owns durable threads and memory. Its
 * address defaults to CopilotKit's managed service, and only somebody who runs Intelligence
 * themselves points it elsewhere. So each sentence below is one thing this install verifiably does:
 *
 * - Bots and settings are rows in this install's own Postgres (`agents`, preferences, rules).
 *   "This install's database", not "this computer": `DATABASE_URL` decides where that is, and
 *   nothing here reads it. Files and connected accounts are left out on purpose. A file's bytes are
 *   in that database, but what a message carries about it also reaches the thread and the model;
 *   and an app connected through Composio or Arcade is held by that service, not here.
 * - Conversations and memory are in Intelligence, named, with where it runs by default.
 * - Every message goes to the model provider this install was set up with.
 * - The CopilotKit runtime sends usage events to CopilotKit unless `DO_NOT_TRACK=1` or
 *   `COPILOTKIT_TELEMETRY_DISABLED=true` is set (`server/src/telemetry.ts`). Naming the variable is
 *   fine here: this step is shown only to a single-user install, whose one reader runs the server.
 *
 * Nothing about sign-in: activating a local install signs you in to CopilotKit, which is its own
 * question and not this step's.
 */
function LocalStep() {
  return (
    <div className="w-full flex flex-col items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight max-w-md text-center [overflow-wrap:anywhere]">
        Where your data lives
      </h1>
      <p className="mt-3 max-w-md text-center text-muted-foreground">
        Your Bots and settings stay in this install's database. Conversations
        and memory are kept in CopilotKit Intelligence, in CopilotKit's cloud
        unless you host it yourself. What you ask goes to your AI model.
      </p>
      <p className="type-caption mt-3 max-w-md text-center text-duet-ink-3">
        CopilotKit also receives usage events. Set DO_NOT_TRACK=1 to turn them
        off.
      </p>
      <div className="h-8" />
      <CapabilityDemo kind="approval" />
    </div>
  );
}

/** Every framework the New Bot wizard offers by name; "an agent you already run" is the sentence. */
const FRAMEWORKS = WEB_HARNESSES.filter((harness) => harness.id !== "byo-url");

function AgentsStep() {
  return (
    <div className="w-full flex flex-col items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight max-w-md text-center [overflow-wrap:anywhere]">
        Bring the agents you already have
      </h1>
      <p className="mt-3 max-w-md text-center text-muted-foreground">
        Any AG-UI agent can join as a Bot. Add one from Bots, then New Bot.
      </p>
      <div className="h-8" />
      <CapabilityDemo kind="brief" />
      <IllustrationFrame
        className="mt-4 flex flex-wrap justify-center gap-2 p-4"
        label={`Frameworks that work as Bots: ${FRAMEWORKS.map((harness) => harness.name).join(", ")}`}
      >
        {FRAMEWORKS.map((harness) => (
          <span
            className="flex items-center gap-2 rounded-full bg-card px-3 py-1.5 text-sm"
            key={harness.id}
          >
            <HarnessMark id={harness.mark} name={harness.name} />
            {harness.name}
          </span>
        ))}
      </IllustrationFrame>
    </div>
  );
}

/**
 * CopilotKit's other open products, named and described as the website's own Products menu has them
 * (copilotkit.ai). Somebody trying OpenDuet on their own machine is the person most likely to want
 * one of them, and this is the slide about what comes after trying it. `ref` tells CopilotKit the
 * visit came from onboarding.
 */
const MORE_FROM_COPILOTKIT = [
  {
    name: "OpenBot",
    line: "The self-hosted assistant OpenDuet is built on.",
    href: "https://www.copilotkit.ai/openbot?ref=openduet_onboarding",
  },
  {
    name: "OpenMuse",
    line: "A personal agent with its own browser and files, on iOS, Android and web.",
    href: "https://www.copilotkit.ai/openmuse?ref=openduet_onboarding",
  },
  {
    name: "OpenDots",
    line: "Always-on coworkers for text, calls and Slack.",
    href: "https://www.copilotkit.ai/opendots?ref=openduet_onboarding",
  },
] as const;

function OrganizationStep() {
  return (
    <div className="w-full flex flex-col items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight max-w-md text-center [overflow-wrap:anywhere]">
        Deploy it for your organization
      </h1>
      <p className="mt-3 max-w-md text-center text-muted-foreground">
        Run one container image, or a Helm chart for EKS, GKE or AKS. Your
        people sign in with Google, Microsoft or Okta. Enterprise deployments
        are available now in early access.
      </p>
      <div className="h-8" />
      <CapabilityDemo kind="task" />
      {/*
       * The real controls on these slides, so they sit outside the frame: a frame means picture.
       * New tabs, because following one must not cost this person their place in onboarding.
       */}
      <a
        className={cn(
          buttonVariants({ variant: "outline" }),
          "mt-6 h-auto min-h-[44px] max-w-full whitespace-normal text-center",
        )}
        href={SELF_HOST_URL}
        rel="noopener noreferrer"
        target="_blank"
      >
        Get early access
      </a>
      <section
        aria-labelledby="more-from-copilotkit"
        className="mt-8 w-full max-w-lg"
      >
        <h2
          className="type-sub px-1 font-medium text-duet-ink-2"
          id="more-from-copilotkit"
        >
          More from CopilotKit
        </h2>
        <ul className="mt-2 overflow-hidden rounded-2xl border border-border">
          {MORE_FROM_COPILOTKIT.map((product, index) => (
            <li
              className={index > 0 ? "border-t border-border" : undefined}
              key={product.name}
            >
              <a
                className="flex min-h-[44px] items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-accent/40"
                href={product.href}
                rel="noopener noreferrer"
                target="_blank"
              >
                <span className="min-w-0 flex-1">
                  <span className="type-body block font-medium">
                    {product.name}
                  </span>
                  <span className="type-sub block text-duet-ink-2">
                    {product.line}
                  </span>
                </span>
                <span aria-hidden className="text-duet-ink-3">
                  ↗
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * The last step: what this deployment has, and what still needs setting up.
 *
 * Nothing on it stops somebody finishing. A required gap is said plainly and the button below still
 * works, because nobody can set a server's environment from a browser.
 */
function SetupStep({
  openPage,
  leaveFor,
  notice,
  finished = false,
}: {
  finished?: boolean;
  openPage: (path: string) => void;
  leaveFor: (url: string) => void;
  notice?: string;
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center">
      <h1 className="type-big text-center font-semibold text-duet-ink">
        Check your setup
      </h1>
      <p className="type-sub mt-2.5 max-w-sm text-center text-duet-ink-2">
        See what's ready and what needs setting up.
      </p>
      <div className="my-6" data-onboarding-finish={finished ? "" : undefined}>
        <MicOrb size={56} state={finished ? "finished" : "idle"} />
      </div>
      <SetupChecklist
        leaveFor={leaveFor}
        notice={notice}
        openPage={openPage}
        returnTo="onboarding"
      />
    </div>
  );
}

const STEPS: OnboardingStep[] = [
  { id: "welcome", render: () => <WelcomeStep /> },
  { id: "computer", render: () => <ComputerUseStep /> },
  { id: "roster", render: () => <RosterStep /> },
];

function RouteComponent() {
  const navigate = useNavigate();
  const router = useRouter();
  const location = useLocation();
  const search = Route.useSearch();
  const complete = useMutation(completeOnboardingMutationOptions(queryClient));
  const advance = useMutation(advanceOnboardingMutationOptions(queryClient));
  const me = useQuery(currentUserQueryOptions());

  // A failed consent is told once, on the step it came back to: not after a reload, and not after
  // the person has moved on and come back.
  const [failedOn, setFailedOn] = React.useState(() =>
    search.connected === "failed" && isStepId(search.step) ? search.step : null,
  );

  /*
   * BACK FROM A CONSENT. Leaving for Google's consent leaves its page in this tab's history, so
   * browser Back right after the return used to land on Google rather than on the step before. The
   * browser keeps that entry whatever this page does, so the return rewrites the entries after it:
   * the one it arrived on becomes the step before, and the step itself is pushed on top, from it.
   * Back then walks to the step before, as it would had the person pressed Next to get here, and
   * Google's page is one further back. Not on a return to the very entry that left, which is the
   * person pressing Back on the vendor's page rather than finishing there.
   */
  const [returned, setReturned] = React.useState<StepId | null>(() => {
    const departure = readConsentDeparture();
    if (!departure || departure.step !== search.step) return null;
    return departure.entry !== null && departure.entry === currentEntryKey()
      ? null
      : departure.step;
  });

  /*
   * The step on screen: the address's, else the one the server saved, else the first. Arriving
   * without one (from the gate's redirect, say) writes it into the address in place, so the entry
   * the person lands on already names its step. `connected` is dropped the same way, and only it.
   */
  const saved = stepForNumber(me.data?.onboarding?.step);
  const asked = isStepId(search.step) ? search.step : undefined;
  const current: StepId = asked ?? saved ?? "welcome";
  React.useEffect(() => {
    if (returned !== null) return;
    if (asked !== undefined && search.connected === undefined) return;
    navigate({ to: "/onboarding", search: { step: current }, replace: true });
  }, [navigate, current, asked, search.connected, returned]);

  // Saved wherever the person goes, by Next, Back, the browser or a consent's return.
  const savedStep = me.data?.onboarding?.step;
  const { mutate: save } = advance;
  React.useEffect(() => {
    if (savedStep === undefined || savedStep === STEP_NUMBER[current]) return;
    save(STEP_NUMBER[current]);
  }, [current, savedStep, save]);

  /*
   * NEXT PUSHES, AND BACK RETURNS THROUGH HISTORY WHEN IT CAN. Next adds an entry carrying the step
   * it was pressed on, so browser Back walks back a step. The bar's Back pops that entry when it was
   * pushed from the step behind, and otherwise (arriving by a link, say) replaces this entry with
   * the step behind, so history never holds the same step twice in a row.
   */
  const cameFrom = (location.state as OnboardingEntry).onboardingFrom;
  const move = (to: string, way: "forward" | "back") => {
    if (!isStepId(to)) return;
    setFailedOn(null);
    if (way === "back" && cameFrom === to) {
      router.history.back();
      return;
    }
    const state: Record<string, unknown> =
      way === "forward" ? { onboardingFrom: current } : {};
    navigate({
      to: "/onboarding",
      search: { step: to },
      replace: way === "back",
      state,
    });
  };

  // The way out: set once the completion is saved, it fades the whole page and then navigates. The
  // destination is home, or the page a checklist row was opened for.
  const [leaving, setLeaving] = React.useState<string | null>(null);
  const [finishedTo, setFinishedTo] = React.useState<string | null>(null);
  const reduced = useReducedMotion() === true;
  const finish = (to = "/") => {
    if (complete.isPending || finishedTo !== null) return;
    complete.mutate(undefined, { onSuccess: () => setFinishedTo(to) });
  };
  React.useEffect(() => {
    if (finishedTo === null) return;
    const timer = setTimeout(
      () => setLeaving(finishedTo),
      reduced ? 150 : FINISH_MS,
    );
    return () => clearTimeout(timer);
  }, [finishedTo, reduced]);
  React.useEffect(() => {
    if (leaving === null) return;
    // Navigation must also complete in a background tab, where animation frames may pause.
    const timer = setTimeout(
      () => navigate({ to: leaving as "/" }),
      reduced ? 0 : 300,
    );
    return () => clearTimeout(timer);
  }, [leaving, navigate, reduced]);

  /*
   * The three local slides, before the checklist, are for somebody evaluating OpenBot locally, never
   * for an organization's people:
   * the server says single-user mode, which an organization's deployment, always behind sign-in,
   * cannot be in. Until the answer arrives they are left out, so a slow or failed request never
   * shows an organization's employees a page about deploying OpenBot themselves.
   *
   * NOT GATED ON `selfHostBanner` AS WELL. That flag is off for any deployment with a paid
   * Intelligence entitlement, and the stack `copilotkit local` installs runs on an enterprise
   * evaluation licence, so every CLI evaluator, the person these slides are for, would never see them.
   */
  const { data: capabilities, isPending: asking } = useQuery(
    deploymentCapabilitiesQueryOptions(),
  );
  const { data: agents } = useQuery(agentListQueryOptions());
  const notify = useNotifyStep(
    primaryBot(agents)?.name ?? appConfig.brand.productName,
  );
  const steps: OnboardingStep[] = [
    ...STEPS,
    ...(capabilities?.localEvaluation
      ? [
          { id: "local", render: () => <LocalStep /> },
          { id: "agents", render: () => <AgentsStep /> },
          { id: "organization", render: () => <OrganizationStep /> },
        ]
      : []),
    /*
     * The two optional steps, before the checklist as in Duet. Continue and Not now both move on,
     * and Not now writes nothing; the checklist after them says what was left.
     */
    {
      id: "apps",
      render: () => (
        <ConnectAppsStep
          failed={failedOn === "apps"}
          leaveFor={(url) => leaveForConsent("apps", url)}
        />
      ),
      primaryLabel: "Continue",
      secondary: { label: "Not now" },
      optional: true,
    },
    notify,
    {
      id: "setup",
      render: () => (
        <SetupStep
          finished={finishedTo !== null}
          notice={
            failedOn === "setup"
              ? "Couldn't connect your Gmail and Calendar. Try again."
              : undefined
          }
          // Onboarding cannot stay open behind another page, so opening one finishes it first.
          openPage={(path) => finish(path)}
          leaveFor={(url) => leaveForConsent("setup", url)}
        />
      ),
    },
  ];

  // A local-evaluation step in the address waits for the answer that puts it in the list, rather
  // than drawing step 1 for a moment and then jumping.
  const waiting =
    asking &&
    (current === "local" || current === "agents" || current === "organization");

  // The rewrite described at `returned`, once the list of steps is known. The order as one string,
  // so the effect runs when the list changes rather than on every render that rebuilds it.
  const order = steps.map((step) => step.id).join(" ");
  React.useEffect(() => {
    if (returned === null || asking) return;
    dropConsentDeparture();
    setReturned(null);
    const ids = order.split(" ");
    const at = ids.indexOf(returned);
    const before = ids[at - 1];
    if (at === -1 || !isStepId(before)) return;
    /*
     * Through the history itself, flushed between the two: the router queues history writes and
     * folds a replace followed by a push into one push, which left the arrival entry as it was.
     */
    const href = (step: StepId) =>
      router.buildLocation({ to: "/onboarding", search: { step } }).href;
    router.history.replace(href(before), {});
    router.history.flush();
    const state: Record<string, unknown> = { onboardingFrom: before };
    router.history.push(href(returned), state);
  }, [returned, asking, order, router]);

  return (
    // Outside `_app` on purpose: no sidebar and no chrome until onboarding is done.
    // The fade runs only after the completion is saved, so a failed save never fades a page the
    // person still needs — and navigation waits for the fade, so the home screen never pops in
    // over a half-faded wizard.
    <motion.div
      animate={{ opacity: leaving ? 0 : 1 }}
      className={`min-h-svh w-full ${leaving ? "pointer-events-none" : ""}`}
      initial={false}
      transition={{ duration: reduced ? 0 : 0.3, ease: "easeOut" }}
    >
      {waiting ? null : (
        <OnboardingWizard
          finishLabel={`Start using ${appConfig.brand.productName}`}
          finishing={complete.isPending || finishedTo !== null}
          onMove={move}
          stepId={current}
          notice={
            complete.error ? (
              <p className="type-sub text-center text-duet-red" role="alert">
                {complete.error.message}
              </p>
            ) : null
          }
          onFinish={() => finish()}
          steps={steps}
        />
      )}
    </motion.div>
  );
}
