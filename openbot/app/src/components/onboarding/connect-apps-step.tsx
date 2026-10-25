import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { GmailAndCalendarLogos } from "@/components/duet/google-logos";
import { DuetIcon } from "@/components/duet/icons";
import { primaryBot } from "@/lib/agents/primary-bot";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type AppAccessState,
  botAppQueryOptions,
} from "@/lib/app-access/queries";
import { appConfig } from "@/lib/generated/application-config";
import { connectAccountMutationOptions } from "@/lib/plugins/mutations";
import { setupChecklistQueryOptions } from "@/lib/setup/queries";
import { cn } from "@/lib/utils";

/** The app this step connects: Gmail and Google Calendar, one consent for both. */
export const GOOGLE_WORKSPACE = "google-workspace";

const PRODUCT = appConfig.brand.productName;

/**
 * Onboarding's Connect your apps step: one row per app, and a tap on the row starts connecting it.
 *
 * WHAT THE ROW SAYS IS THE SERVER'S. It is the app-access state for this person on the primary Bot,
 * the same answer the chat card and the setup checklist draw, so a row never reads Connected while
 * the Bot cannot use the app. `ready` reads Connected. `not_connected` and `reconnect` offer the
 * connection, which is this person's to make. Every other state is somebody else's to fix, and the
 * row says whose instead of offering a button that would fail.
 *
 * THE CONSENT COMES BACK HERE. Connect leaves for Google's consent with `returnTo=onboarding-apps`,
 * and the callback lands on this step again (`/onboarding?step=apps`), where the row is read fresh
 * and says Connected, or on a red line when it did not go through.
 */
export function ConnectAppsStep({
  failed,
  leaveFor = (url) => window.location.assign(url),
}: {
  /** The last connection came back failed. */
  failed: boolean;
  /** Where the browser goes to approve the connection: Google's own page. */
  leaveFor?: (url: string) => void;
}) {
  const agents = useQuery(agentListQueryOptions());
  const bot = primaryBot(agents.data);
  const gmail = useQuery({
    ...botAppQueryOptions(bot?.id ?? "", GOOGLE_WORKSPACE),
    enabled: bot !== undefined,
  });
  // Who is reading decides whose move a gap is: the server already said, for the checklist.
  const checklist = useQuery(setupChecklistQueryOptions());
  const admin = checklist.data?.audience === "admin";
  /*
   * A connection that failed to start, held here; a consent that came back failed, read from
   * `failed` each time. Read rather than copied, because the route clears it once the person moves
   * on, and a step brought back mid-exit by a quick Back keeps its own state.
   */
  const [problem, setProblem] = useState<string | null>(null);
  const said =
    problem ??
    (failed ? "Couldn't connect your Gmail and Calendar. Try again." : null);
  const connect = useMutation({
    ...connectAccountMutationOptions("onboarding-apps"),
    onError: (error: Error) => setProblem(error.message),
    onSuccess: (url) => {
      if (url === null) {
        setProblem("Couldn't start connecting. Try again.");
        return;
      }
      leaveFor(url);
    },
  });

  const state = gmail.data?.state;
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center">
      <h1 className="type-big text-center font-semibold text-duet-ink">
        Connect your apps
      </h1>
      <p className="type-sub mt-2.5 max-w-sm text-center text-duet-ink-2">
        This way {PRODUCT} can read what's new in your mail and calendar, and
        take care of things for you. You can connect more apps later.
      </p>
      <ul aria-label="Apps" className="mt-8 flex w-full flex-col gap-3">
        <AppRow
          admin={admin}
          connecting={connect.isPending}
          onConnect={() => {
            setProblem(null);
            connect.mutate(GOOGLE_WORKSPACE);
          }}
          state={state}
          unreadable={gmail.isError || (bot === undefined && agents.isError)}
        />
      </ul>
      {said ? (
        <p
          className="type-sub mt-3 w-full px-1 text-center text-duet-red"
          role="alert"
        >
          {said}
        </p>
      ) : null}
    </div>
  );
}

/** One app: its mark, its name, and Connected, a plus, or whose move it is. */
function AppRow({
  state,
  admin,
  connecting,
  unreadable,
  onConnect,
}: {
  state: AppAccessState | undefined;
  admin: boolean;
  connecting: boolean;
  unreadable: boolean;
  onConnect: () => void;
}) {
  const name = "Gmail and Google Calendar";
  const connectable = state === "not_connected" || state === "reconnect";
  const note = unreadable
    ? "Couldn't check it. Continue, and connect it later in Connections."
    : state === "reconnect"
      ? "Needs reconnecting."
      : state === undefined || state === "ready" || connectable
        ? null
        : admin
          ? "Not set up yet. The last step shows how."
          : "Your admin has to set this up.";

  const body = (
    <>
      <GmailAndCalendarLogos size={26} />
      <span className="min-w-0 flex-1 basis-[9rem] text-left">
        <span className="type-row block text-duet-ink">{name}</span>
        {note ? (
          <span className="type-label mt-0.5 block text-duet-ink-3">
            {note}
          </span>
        ) : null}
      </span>
      {state === "ready" ? (
        <span className="type-label flex shrink-0 items-center gap-1 font-semibold text-duet-green">
          <DuetIcon name="check" size={16} stroke={2.6} />
          Connected
        </span>
      ) : connectable ? (
        connecting ? (
          <span className="type-label shrink-0 text-duet-ink-2">
            Connecting…
          </span>
        ) : (
          <span className="shrink-0 text-duet-ink" aria-hidden>
            <DuetIcon name="plus" size={22} stroke={1.8} />
          </span>
        )
      ) : null}
    </>
  );

  const shape =
    "flex flex-wrap min-h-[60px] w-full items-center gap-3 rounded-[30px] bg-duet-card px-4 py-2.5 shadow-[inset_0_0_0_1px_var(--duet-hair)]";

  return (
    <li data-app-row={GOOGLE_WORKSPACE} data-state={state}>
      {connectable ? (
        <button
          aria-label={`${state === "reconnect" ? "Reconnect" : "Connect"} ${name}`}
          className={cn(
            shape,
            "outline-none transition-[background-color,transform] hover:bg-duet-tile focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:scale-[0.99] disabled:opacity-60",
          )}
          disabled={connecting}
          onClick={onConnect}
          type="button"
        >
          {body}
        </button>
      ) : (
        <div className={shape}>{body}</div>
      )}
    </li>
  );
}
