import type { Message } from "@ag-ui/core";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { toVisibleChatItems } from "@/components/channels/chat-messages";
import { FINISH_MS, type MicOrbState } from "@/components/duet/mic-orb";
import { primaryBot } from "@/lib/agents/primary-bot";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type ApprovalInboxData,
  type ApprovalRequest,
  approvalInboxOptions,
} from "@/lib/approvals";
import { ongoingChannel } from "@/lib/channels/ongoing";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { STEP_PHRASES, stepPhrase } from "@/lib/plugins/tool-name";

/**
 * What Chat is doing, for the header's orb to show, as the film's phone header does: it thinks
 * while OpenDuet works, listens while the person types, and lands a finished answer. And, on any
 * screen, when something the person allowed the Bot to do is done, it plays a check.
 *
 * The shell owns the header and Chat sits inside it, so this is a context the shell provides and
 * Chat reports into, rather than anything global. Reports go through one context and the header
 * reads another, so a keystroke re-renders the orb and nothing else on the screen. The step under
 * the orb travels on a pair of its own for the same reason: a keystroke does not reach the pill,
 * and a new step does not reach the orb.
 */
export type ChatPresence = {
  /** Chat is on screen and reporting. Everywhere else the orb rests. */
  chat: boolean;
  /** The Bot has the turn: asked and not answered yet, browser actions in the middle included. */
  working: boolean;
  /** The composer has something typed in it. */
  drafting: boolean;
  /** Counts every edit to the draft, for the orb's grille slots to light on. */
  edits: number;
  /** Counts the turns that ended in an answer, rather than a failure or a Stop. */
  answers: number;
  /** Counts the actions the person allowed that finished while the app was open (`useFinishedForYou`). */
  finishes: number;
};

/** How long the orb holds "done": its glow springs up and settles away, and its nod plays out. */
export const LANDING_MS = 2600;

const AT_REST: ChatPresence = {
  chat: false,
  working: false,
  drafting: false,
  edits: 0,
  answers: 0,
  finishes: 0,
};

const ReportContext = createContext<Dispatch<
  SetStateAction<ChatPresence>
> | null>(null);
const PresenceContext = createContext<ChatPresence>(AT_REST);
const StepReportContext = createContext<Dispatch<
  SetStateAction<string | null>
> | null>(null);
const StepContext = createContext<string | null>(null);
/** Whether Chat is on screen, on its own so the pill can ask without hearing every keystroke. */
const OnChatContext = createContext(false);
/** Whether the conversation on screen has a turn of its own running, without the keystrokes. */
const WorkingContext = createContext(false);
/** What the server is doing in Chat's conversation, if anything (`useServerWork`). */
const ServerWorkContext = createContext<string | null>(null);

/**
 * `serverWork` is what the shell reads off the server for Chat's conversation (`useServerWork`): the
 * phrase for a turn the server is running there, or null. The pill and the orb show it, for work
 * this screen did not start.
 */
export function ChatPresenceProvider({
  children,
  serverWork = null,
}: {
  children: ReactNode;
  serverWork?: string | null;
}) {
  const [presence, setPresence] = useState(AT_REST);
  const [step, setStep] = useState<string | null>(null);
  return (
    <ReportContext.Provider value={setPresence}>
      <StepReportContext.Provider value={setStep}>
        <ServerWorkContext.Provider value={serverWork}>
          <PresenceContext.Provider value={presence}>
            <OnChatContext.Provider value={presence.chat}>
              <WorkingContext.Provider value={presence.working}>
                <StepContext.Provider value={step}>
                  {children}
                </StepContext.Provider>
              </WorkingContext.Provider>
            </OnChatContext.Provider>
          </PresenceContext.Provider>
        </ServerWorkContext.Provider>
      </StepReportContext.Provider>
    </ReportContext.Provider>
  );
}

/**
 * The orb's state for what Chat is doing. The Bot working outranks the person typing, since a
 * correction typed mid-answer waits for the turn to end; typing cuts a landing short. A finish
 * outranks everything, on any screen: it is over in a moment, and the orb goes back to the rest.
 */
export function orbStateFor(
  presence: ChatPresence,
  landing: boolean,
  finishing = false,
): MicOrbState {
  if (finishing) return "finished";
  if (!presence.chat) return "idle";
  if (presence.working) return "thinking";
  if (presence.drafting) return "listening";
  return landing ? "done" : "idle";
}

/** What the pill under the orb says while the Bot works and no step of its own is running. */
export const THINKING = STEP_PHRASES.thinking;

/**
 * What the pill says when the server is running something in Chat this screen did not start: the
 * continuation after Allow once, a suggestion started from the card, a check-in, another tab.
 */
export const SERVER_WORKING = STEP_PHRASES.working;

/**
 * What the Bot is doing right now, in a line for the pill under the orb, or null when it has not
 * got the turn.
 *
 * The newest step still waiting on its result, as a phrase about the person (`stepPhrase`): "Searching
 * your email", never "Gmail search messages". Steps the pill does not name, such as the reply chips,
 * are passed over. Only this turn's steps count: a call from an earlier turn that never got its result
 * is not running, it was cut off. With no step running the Bot is thinking, or writing what it found.
 */
export function stepFor(
  messages: readonly Message[],
  working: boolean,
  approvals: readonly ApprovalRequest[] = [],
): string | null {
  if (!working) return null;
  const items = toVisibleChatItems(messages);
  // The turn began at the person's last message: their words, or files sent without any.
  const turn = items.slice(
    items.findLastIndex(
      (item) =>
        item.kind === "attachments" ||
        (item.kind === "text" && item.role === "user"),
    ) + 1,
  );
  const running = turn
    .flatMap((item) =>
      item.kind === "tool" &&
      item.result === undefined &&
      !approvals.some(
        (request) =>
          request.action.toolCallId === item.toolCall.id &&
          (request.decision === "deny" || request.decision === "handled"),
      )
        ? [stepPhrase(item.toolCall.function.name)]
        : [],
    )
    .findLast((phrase) => phrase !== null);
  return running ?? THINKING;
}

/** What the pill says once the Bot has been thinking with nothing to show for a while. */
export const STILL_WORKING = "Still working on it";
/** And once that while has become long. */
export const TAKING_LONGER = "Taking longer than usual";
/** How long a quiet "Thinking it through" lasts before the pill says it is still working. */
export const STILL_WORKING_MS = 20_000;
/** How long before it says this is taking longer than usual. */
export const TAKING_LONGER_MS = 60_000;

/**
 * The pill's phrase for a wait that has gone quiet: "Thinking it through", then "Still working on
 * it" after {@link STILL_WORKING_MS} with nothing new, then "Taking longer than usual" after
 * {@link TAKING_LONGER_MS}. Every other phrase is passed through: a named step already says what is
 * happening, and a turn that is writing is not quiet.
 */
export function patientStep(
  step: string | null,
  quietForMs: number,
): string | null {
  if (step !== THINKING) return step;
  if (quietForMs >= TAKING_LONGER_MS) return TAKING_LONGER;
  if (quietForMs >= STILL_WORKING_MS) return STILL_WORKING;
  return step;
}

/**
 * {@link patientStep}, timed from the last sign of progress.
 *
 * WHY THE APP SAYS SOMETHING EARLY, AND THE SERVER DOES NOT. A model that hangs held the pill on
 * "Thinking it through" for more than two minutes, until the request itself timed out and the turn
 * failed. The server's stall guard (`server/src/channels/stall-guard.ts`) watches remote Bots only,
 * and ending a slow turn sooner is not obviously right: a long tool call or a slow model may still
 * answer. So nothing is ended here. The pill only stops implying that all is well: after 20 quiet
 * seconds it says the Bot is still working, after a minute that this is taking longer than usual.
 *
 * `progress` is anything that changes when the turn moves (the transcript's length, the last
 * message's size), so writing, a new step or a tool result starts the quiet clock again.
 */
export function usePatientStep(
  step: string | null,
  progress: string,
): string | null {
  const moved = `${step ?? ""}\u0000${progress}`;
  const [quiet, setQuiet] = useState({ since: Date.now(), now: Date.now() });
  const [movedAt, setMovedAt] = useState(moved);
  if (movedAt !== moved) {
    // Reset during render, so the frame that moved never shows a stale "Still working on it".
    setMovedAt(moved);
    const now = Date.now();
    setQuiet({ since: now, now });
  }
  const thinking = step === THINKING;
  useEffect(() => {
    if (!thinking) return;
    const timers = [STILL_WORKING_MS, TAKING_LONGER_MS].map((ms) =>
      setTimeout(
        () => setQuiet((current) => ({ ...current, now: Date.now() })),
        Math.max(0, quiet.since + ms - Date.now()),
      ),
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [thinking, quiet.since]);
  return patientStep(step, quiet.now - quiet.since);
}

/**
 * Whether the server says Chat's conversation has a turn running, and that conversation's thread,
 * from the busy flag it puts on the conversation list. That flag covers runs this screen never
 * started, which is the point: without it the pill and the orb sat still for the 20 seconds after
 * Allow once while the Bot sent the email.
 *
 * Chat's conversation is found the way the Chat tab finds it (`ChatScreen`): the main Bot's most
 * recently used conversation. When Chat's identity changes there, this changes with it.
 */
export function useChatServerBusy(onChat: boolean): {
  busy: boolean;
  threadId?: string;
} {
  const agents = useQuery({ ...agentListQueryOptions(), enabled: onChat });
  const channels = useInfiniteQuery({
    ...channelListQueryOptions(),
    enabled: onChat,
  });
  if (!onChat) return { busy: false };
  const bot = primaryBot(agents.data);
  const chat = bot ? ongoingChannel(channels.data, bot.id) : undefined;
  return chat
    ? { busy: chat.busy === true, threadId: chat.threadId }
    : { busy: false };
}

/** How recent an action has to be for the run after it to be that action going ahead. */
const DECISION_WINDOW_MS = 5 * 60_000;

/**
 * What the server is doing in a conversation while its busy flag is up, as a pill phrase, or null
 * when it is not busy.
 *
 * The flag says only that a turn is running. When the newest decision in that thread allowed an
 * action that is still approved or being carried out, the pill names it ("Sending your email");
 * once it completes, or otherwise, the phrase is "Working on it".
 */
export function serverWorkPhrase(
  busy: boolean,
  threadId: string | undefined,
  inbox: ApprovalInboxData | undefined,
  now = Date.now(),
): string | null {
  if (!busy) return null;
  // The newest decision wins. A refusal or completion must not resurrect an earlier allowed send.
  const decided = (inbox?.requests ?? [])
    .filter(
      (request) =>
        request.action.threadId === threadId &&
        request.decision != null &&
        typeof request.decidedAt === "string" &&
        now - Date.parse(request.decidedAt) < DECISION_WINDOW_MS,
    )
    .sort(
      (a, b) => Date.parse(b.decidedAt ?? "") - Date.parse(a.decidedAt ?? ""),
    )
    .at(0);
  return decided &&
    (decided.status === "approved" || decided.status === "consumed") &&
    (decided.decision === "allow_once" || decided.decision === "allow_always")
    ? approvedActionPhrase(decided)
    : SERVER_WORKING;
}

/** The phrase for an action the person allowed, read from what it does. */
export function approvedActionPhrase(request: ApprovalRequest): string {
  const [server = "", tool = ""] = request.action.toolRef.split("/");
  const args =
    request.action.args && typeof request.action.args === "object"
      ? (request.action.args as Record<string, unknown>)
      : {};
  /*
   * The gate every outgoing message passes through. An email when it goes to an address: the
   * inbox carries the scope (`external:ana@…`) and audience, not the message's own fields.
   */
  if (tool === "share_private_information") {
    const audience = `${request.action.scope} ${String(args.audience ?? "")}`;
    return /\S@\S/.test(audience) ? STEP_PHRASES.sendEmail : SERVER_WORKING;
  }
  return stepPhrase(`mcp__${server}__${tool}`) ?? SERVER_WORKING;
}

/** `serverWorkPhrase` for a conversation, reading the approvals the app already polls. */
export function useServerWork(
  busy: boolean,
  threadId: string | undefined,
): string | null {
  const queryClient = useQueryClient();
  const inbox = useQuery({ ...approvalInboxOptions(), enabled: busy });
  /*
   * The inbox polls, so the decision that just started this run may not be in it yet. Read it
   * again the moment the conversation goes busy, rather than guessing from a request still shown
   * waiting.
   */
  useEffect(() => {
    if (busy)
      void queryClient.invalidateQueries({
        queryKey: approvalInboxOptions().queryKey,
      });
  }, [busy, queryClient]);
  return serverWorkPhrase(busy, threadId, inbox.data);
}

/**
 * Server work this screen did not start: null while the screen's own turn runs, and for the rest of
 * that busy spell. The server's flag goes down a moment after the screen's own turn ends, and
 * without this the pill ended every turn on "Working on it" as it faded.
 */
export function useUnownedServerWork(
  serverWork: string | null,
  localWorking: boolean,
): string | null {
  const owned = useRef(false);
  if (serverWork === null) owned.current = false;
  else if (localWorking) owned.current = true;
  return serverWork !== null && !owned.current ? serverWork : null;
}

/**
 * Report a conversation's turn and draft to the header, for as long as it is mounted. Only Chat's
 * conversation reports (`enabled`), and outside the shell there is nothing to report to.
 *
 * `working` is the turn, not the run, for the reason `ConversationView` gives: a browser action
 * ends one run and starts another, and the orb would land in the gap. `failed` is the turn having
 * ended without an answer. `step` is what `stepFor` says about the turn, null when there is none.
 * Hand the composer `onTextChange`, and call `onStop` when somebody presses Stop, so a stopped
 * answer does not land either.
 */
export function useReportChatPresence(
  enabled: boolean,
  {
    working,
    failed,
    step = null,
  }: { working: boolean; failed: boolean; step?: string | null },
): { onTextChange: (text: string) => void; onStop: () => void } | undefined {
  const context = useContext(ReportContext);
  const report = enabled ? context : null;
  const stepContext = useContext(StepReportContext);
  const reportStep = enabled ? stepContext : null;
  const wasWorking = useRef(false);
  const stopped = useRef(false);
  const typed = useRef("");

  useEffect(() => {
    if (!report) return;
    if (working && !wasWorking.current) stopped.current = false;
    const answered =
      wasWorking.current && !working && !failed && !stopped.current;
    wasWorking.current = working;
    report((presence) => ({
      ...presence,
      chat: true,
      working,
      answers: presence.answers + (answered ? 1 : 0),
    }));
  }, [report, working, failed]);

  useEffect(() => {
    reportStep?.(step);
  }, [reportStep, step]);

  // Leaving Chat rests the orb, mid-turn included: an answer nobody is there to see does not land.
  useEffect(() => {
    if (!report) return;
    return () =>
      report((presence) => ({
        ...presence,
        chat: false,
        working: false,
        drafting: false,
      }));
  }, [report]);
  // And takes its step with it, so the pill does not name work on a screen that is gone.
  useEffect(() => {
    if (!reportStep) return;
    return () => reportStep(null);
  }, [reportStep]);

  const onTextChange = useCallback(
    (text: string) => {
      if (!report || text === typed.current) return;
      typed.current = text;
      report((presence) => ({
        ...presence,
        drafting: text.trim() !== "",
        edits: presence.edits + 1,
      }));
    },
    [report],
  );
  const onStop = useCallback(() => {
    stopped.current = true;
  }, []);

  return report ? { onTextChange, onStop } : undefined;
}

/**
 * Count one finish for the header's orb to play, from anywhere inside the shell: what
 * `FinishedForYou` reports each action the person allowed through. Outside the shell it does nothing.
 */
export function useReportFinish(): () => void {
  const report = useContext(ReportContext);
  return useCallback(
    () =>
      report?.((presence) => ({
        ...presence,
        finishes: presence.finishes + 1,
      })),
    [report],
  );
}

/** The header orb's state and keystrokes, from what Chat and `useReportFinish` last reported. */
export function useChatOrb(): { state: MicOrbState; keystrokes: number } {
  const reported = useContext(PresenceContext);
  // Work the server is doing in Chat thinks too, as a turn this screen started does.
  const serverWork = useUnownedServerWork(
    useContext(ServerWorkContext),
    reported.working,
  );
  const presence =
    serverWork !== null && reported.chat && !reported.working
      ? { ...reported, working: true }
      : reported;
  // The answer whose landing has played out. Behind `answers` while the orb holds "done".
  const [landed, setLanded] = useState(presence.answers);
  useEffect(() => {
    if (presence.answers === landed) return;
    // Away from Chat the landing is over, so coming straight back does not replay it.
    if (!presence.chat) {
      setLanded(presence.answers);
      return;
    }
    const timer = setTimeout(() => setLanded(presence.answers), LANDING_MS);
    return () => clearTimeout(timer);
  }, [presence.answers, presence.chat, landed]);
  // The finish whose check has played. Behind `finishes` while the orb holds "finished"; another
  // finish while one plays holds it a little longer rather than playing twice.
  const [finished, setFinished] = useState(presence.finishes);
  useEffect(() => {
    if (presence.finishes === finished) return;
    const timer = setTimeout(() => setFinished(presence.finishes), FINISH_MS);
    return () => clearTimeout(timer);
  }, [presence.finishes, finished]);
  return {
    state: orbStateFor(
      presence,
      presence.answers !== landed,
      presence.finishes !== finished,
    ),
    keystrokes: presence.edits,
  };
}

/**
 * Whether Chat's composer has something typed in it, from what Chat last reported.
 *
 * It reads the context every keystroke changes, so a caller re-renders on each one: read it in a
 * small leaf, as Chat's first day does, rather than in a component with a screen under it.
 */
export function useChatDrafting(): boolean {
  return useContext(PresenceContext).drafting;
}

/**
 * What the pill under the orb says, from what Chat last reported, or that the Bot is working when
 * the server has a turn running in Chat that this screen did not start. Null hides it.
 */
export function useChatStep(): string | null {
  const step = useContext(StepContext);
  const onChat = useContext(OnChatContext);
  const serverWork = useUnownedServerWork(
    useContext(ServerWorkContext),
    useChatWorking(),
  );
  return step ?? (onChat ? serverWork : null);
}

/** Whether the conversation on screen has a turn of its own running. Keystrokes don't reach it. */
export function useChatWorking(): boolean {
  return useContext(WorkingContext);
}
