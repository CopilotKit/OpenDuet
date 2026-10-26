import type { Message } from "@ag-ui/core";
import {
  type Attachment,
  CopilotChatConfigurationProvider,
  UseAgentUpdate,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import type { TaskReplyContext } from "@openbot/shared/task-reply";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { attachmentModality } from "@/components/channels/chat-messages";
import { toAgentOptions } from "@/components/channels/composer";
import { ConversationView } from "@/components/channels/conversation-view";
import {
  seedMessage,
  takeFirstMessage,
  transcriptMessages,
} from "@/components/channels/transcript-messages";
import { VoiceCallWidget } from "@/components/channels/voice-call-widget";
import { HandoffResumeNotice } from "@/components/computer/handoff-resume-notice";
import { Topic } from "@/components/duet/kit";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { type ApprovalInboxData, approvalInboxOptions } from "@/lib/approvals";
import { attachmentUrl } from "@/lib/channels/attachments";
import { readFirstDay } from "@/lib/channels/first-day";
import {
  followTurn,
  freshConnectionAfterStop,
  joinOrFollow,
  liveRun,
} from "@/lib/channels/follow-turn";
import {
  recordChannelActivityMutationOptions,
  setChannelBusy,
} from "@/lib/channels/mutations";
import {
  type AgentChannel,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import {
  forgetRunError,
  recalledRunError,
  rememberRunError,
} from "@/lib/channels/run-error-memory";
import {
  claimSeed,
  interruptsToAnswer,
  isApprovalWaitingResult,
  isThreadBusyError,
  isThreadLocked,
  sayableReason,
  seedStillNeeded,
  staleApprovalWaits,
  ThreadBusyError,
  waitingToolCalls,
  withApprovalWaits,
  withoutMessages,
  withoutUnansweredCalls,
} from "@/lib/channels/run-lifecycle";
import { useActiveBot } from "@/lib/copilot/active-bot";
import { observeApprovalAgent } from "@/lib/copilot/approval-context";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { afterMs } from "@/lib/copilot/join-thread";
import { repairUnansweredToolCalls } from "@/lib/copilot/repair-history";
import { stoppedReason } from "@/lib/copilot/stopped-turn";
import { readThreadMessages } from "@/lib/copilot/thread-messages";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import {
  askChannelAgent,
  messageText,
  voiceContext,
  withVoiceContext,
} from "@/lib/voice/agent-bridge";
import {
  cachedVoiceArchive,
  loadVoiceArchive,
  useVoiceArchive,
  voiceArchiveContext,
  withVoiceChats,
} from "@/lib/voice/archive";
import { useVoiceCall } from "@/lib/voice/use-voice-call";
import { queryClient } from "@/query-client";
import { newId } from "../../lib/new-id";

/**
 * How long a stalled thread join is worth waiting for before it is ended.
 *
 * Ended, not outrun. See `lib/copilot/join-thread.ts` for what a connect left in flight does to the
 * next message sent.
 */
const JOIN_DEADLINE_MS = 1500;

/**
 * Backstop for a message typed before the runtime agent exists; it must not be discarded.
 */
const SEND_WITHOUT_RUNTIME_AFTER_MS = 1500;

/** When a Bot's announced turn is read for, while the store may not have it yet. */
const CATCH_UP_DELAYS_MS = [0, 750, 1500];
/**
 * When it is read again after a read that changed the transcript, until a read changes nothing. The
 * store has settled a server-run reply within about a second of announcing it; the last wait covers
 * a slower store.
 */
const SETTLE_DELAYS_MS = [750, 1500, 3000];

/**
 * Following a turn this tab did not start; see `lib/channels/follow-turn.ts`.
 *
 * The retry is how soon an idle thread is joined again while the turn has not started yet. The
 * longest wait is for a continuation after Allow once that never comes: past it the conversation is
 * given back. The silence is how long a followed join may go without a single event before it is
 * taken for stalled and ended; a Bot's own stall guard ends a quiet turn well before that.
 */
const FOLLOW_RETRY_MS = 1000;
const FOLLOW_MAX_MS = 90_000;
const FOLLOW_SILENCE_MS = 180_000;
const FOLLOW_QUIET_MS = 30_000;
/** How long the stored transcript may take to read when it stands in for a replay. */
const STAND_IN_READ_MS = 6000;

const NOTHING: readonly Message[] = [];

type ChannelActivitySignature = {
  agentId: string;
  at: string;
  text: string;
};

function sameActivity(
  left: ChannelActivitySignature | null,
  right: ChannelActivitySignature | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.agentId === right.agentId &&
    left.at === right.at &&
    left.text === right.text
  );
}

export function channelHistoryNotice({
  restoring,
  messageCount,
  lastMessageAt,
  historyAvailability,
  historyReadFailed = false,
  unreadable,
}: {
  restoring: boolean;
  messageCount: number;
  lastMessageAt: string | null;
  historyAvailability: "ready" | "unavailable";
  historyReadFailed?: boolean;
  unreadable: number;
}): string | null {
  if (restoring) return null;

  if (
    historyAvailability === "unavailable" &&
    (historyReadFailed || (messageCount === 0 && lastMessageAt !== null))
  ) {
    return "Couldn't load earlier messages. You can keep using this conversation.";
  }

  if (unreadable > 0) {
    return unreadable === 1
      ? "One earlier message couldn't be read, so it isn't shown. Everything else is here."
      : `${unreadable} earlier messages couldn't be read, so they aren't shown. Everything else is here.`;
  }

  return null;
}

/**
 * Insert missing durable messages before their next shared ID, keeping local content and order.
 * A shorter read can still contain missing turns after unreadable rows are filtered out. Without a
 * following shared anchor, append the missing tail: the store cannot place it among local-only rows.
 *
 * A message the transcript took from the store (`fromStore`) is the store's to correct: when a later
 * read holds it with different content, the later read wins. The store assembles a reply the server
 * ran (after Allow once, a routine, a handoff) from that run's events over about a second, and a
 * read in that window returns the reply under its final id with pieces missing from the middle. A
 * message this tab streamed itself is never replaced: there the local copy is the whole one and the
 * store's may still lag it.
 *
 * Return the original array when nothing was added or corrected so refreshes can wait for the store
 * to catch up.
 */
function mergeStoredMessages(
  local: Message[],
  stored: Message[],
  fromStore: ReadonlySet<string>,
): Message[] {
  const localIds = new Set(local.map((message) => message.id));
  const seenStored = new Map<string, Message>();
  const before = new Map<string, Message[]>();
  let pending: Message[] = [];
  for (const message of stored) {
    if (seenStored.has(message.id)) continue;
    seenStored.set(message.id, message);
    if (localIds.has(message.id)) {
      if (pending.length > 0) before.set(message.id, pending);
      pending = [];
    } else {
      pending.push(message);
    }
  }
  let corrected = false;
  const current = local.map((message) => {
    const newer = fromStore.has(message.id)
      ? seenStored.get(message.id)
      : undefined;
    if (!newer || sameContent(newer, message)) return message;
    corrected = true;
    return newer;
  });
  if (before.size === 0 && pending.length === 0 && !corrected) return local;
  return [
    ...current.flatMap((message) => [
      ...(before.get(message.id) ?? []),
      message,
    ]),
    ...pending,
  ];
}

/** Whether two copies of a message say the same thing: its text or parts, and any tool calls. */
function sameContent(left: Message, right: Message): boolean {
  const said = (message: Message) =>
    JSON.stringify([
      message.role,
      "content" in message ? message.content : null,
      "toolCalls" in message ? message.toolCalls : null,
    ]);
  return said(left) === said(right);
}

/** Note the ids a merge added from the store, so a later read may correct them. */
function rememberFromStore(
  fromStore: Set<string>,
  before: readonly Message[],
  after: readonly Message[],
) {
  const had = new Set(before.map((message) => message.id));
  for (const message of after) {
    if (!had.has(message.id)) fromStore.add(message.id);
  }
}

/**
 * The uploaded id and filename an `Attachment` carries once it is `ready`, read from the
 * `metadata` the composer's `onUpload` stamped on it — see `composer/attachments.ts`. Not the
 * SDK's own `attachment.id`, which is a client-side handle for the upload placeholder rather than
 * the id this deployment stored the file under.
 */
function uploadedAttachment(attachment: Attachment): {
  attachmentId: string;
  filename?: string;
} {
  const metadata = attachment.metadata as
    | { attachmentId?: unknown; filename?: unknown }
    | undefined;
  const attachmentId = metadata?.attachmentId;
  if (typeof attachmentId !== "string") {
    throw new Error("Attachment is missing its uploaded id.");
  }
  const filename =
    typeof metadata?.filename === "string" ? metadata.filename : undefined;
  return filename ? { attachmentId, filename } : { attachmentId };
}

/**
 * One attachment, turned into the part shape a stored message carries.
 *
 * THE MODALITY COMES FROM THE BYTES, NOT FROM `attachment.type`, AND THIS IS THE ONLY PLACE IT CAN.
 *
 * `attachment.type` is the browser's claim, fixed before the upload and never reconciled with what
 * the file turned out to be. The server stopped trusting it — `resolvePart` decides an attachment's
 * modality with `classifyAttachment` on its own sniffed `mimeType` — but that correction lives on
 * the server and never comes back here. What this function writes IS the stored message, so a
 * `document` written here is what every later render of that message reads, for ever: a screenshot
 * whose part the browser mislabelled drew a grey file card over the picture, and the transcript's
 * document probe then paid a whole-file read per render for the privilege.
 *
 * Narrowed through the source union rather than read straight off, for the reason `parkedTiles` in
 * `chat-transcript.tsx` narrows the same field: a `data` source's `mimeType` is `file.type`, the
 * very claim being refused, and only a `url` source has been past the server. `attachmentModality`
 * falls back to the declared type when there is no corroborated one, so an attachment that somehow
 * arrives unuploaded is written exactly as it used to be.
 *
 * The comment this replaces said only "image" and "document" reach here because the composer's
 * upload config accepts no other kind of file. That reason is no longer true — the config's
 * `accept` is now the wildcard, and it is `screenPickedFiles` that holds the line. The conclusion still
 * holds; the justification had rotted, which is why the modality is now derived rather than cast.
 */
function toAttachmentPart(attachment: Attachment) {
  const { attachmentId, filename } = uploadedAttachment(attachment);
  const { source } = attachment;
  const mimeType =
    source.type === "url" && source.mimeType ? source.mimeType : undefined;
  return {
    type: attachmentModality(attachment.type, mimeType),
    source: { type: "url" as const, value: attachmentUrl(attachmentId) },
    metadata: filename ? { attachmentId, filename } : { attachmentId },
  };
}

/**
 * A plain string when there is nothing attached, exactly as every message in every channel has
 * always been sent — never a single-element array wrapping the same text, which every existing
 * reader would take a different path for no gain. With attachments, the text goes first as its
 * own part and is left out entirely when empty, since an empty text part is noise the model has
 * to read past.
 *
 * Exported for the test that pins this wire format. Reaching it through `deliver`/`say` would mean
 * standing up `useAgent`'s runtime, the thread join and the ready/join gates around it just to
 * observe a pure string-in-object-out mapping — none of that machinery bears on what this function
 * decides, so a narrow export is the honest way to test the contract without restructuring the
 * module around a test.
 */
export function toMessageContent(
  trimmed: string,
  attachments: readonly Attachment[],
) {
  if (attachments.length === 0) return trimmed;
  const refs = attachments.map(toAttachmentPart);
  return trimmed ? [{ type: "text" as const, text: trimmed }, ...refs] : refs;
}

/** What the roster's "last thing said" reads when a message carried no caption. */
function describeAttachments(attachments: readonly Attachment[]): string {
  if (attachments.length === 1) {
    const { filename } = uploadedAttachment(attachments[0]);
    return filename ? `Sent ${filename}` : "Sent an attachment";
  }
  return `Sent ${attachments.length} attachments`;
}

/**
 * One channel's conversation with one coworker.
 *
 * The local agent id is channel-scoped so two channels with the same coworker keep separate
 * durable threads.
 */
/**
 * The run was refused because another holds the conversation: the server's own turn, or another
 * tab's. Said in the person's terms, never with the thread's id.
 */
const THREAD_LOCKED = /\bthread\b.*\block/i;
const STILL_FINISHING =
  "OpenDuet is still finishing something. Send this again when it's done.";

export function ChannelChat({
  channel,
  runtimeAgentId,
  inShell = false,
  topic,
  task,
  lead,
  folded = false,
  onSubmitted,
}: {
  channel: AgentChannel;
  runtimeAgentId: string;
  /** The app shell's Chat tab; see `ConversationView`. */
  inShell?: boolean;
  /** What the conversation is about, drawn above it as the film's topic label. */
  topic?: string | null;
  /**
   * This conversation is a task's own, open on its page (components/duet/task-sheet.tsx).
   *
   * `busy` while a turn runs here that this tab may not have started: the task's own on the server,
   * or another tab's. A send waits in the queue and goes when it ends, and the Bot shows as
   * thinking. Stop stays for a turn this tab started; for anyone else's there is nothing here to
   * stop.
   * `send` while the task couldn't finish: a send is drawn at once and handed there, to run as the
   * task's own turn with the person's words, instead of running here without the task.
   */
  task?: {
    busy: boolean;
    durable?: boolean;
    queued?: { messageId: string; text: string }[];
    send?: (
      input: { text: string; messageId: string } & TaskReplyContext,
    ) => Promise<void>;
  };
  /** Drawn above the conversation in place of the topic, such as a task's report. */
  lead?: ReactNode;
  /** Keep the conversation folded under the lead; see `ChatTranscript`. */
  folded?: boolean;
  /** The person sent something from the composer. */
  onSubmitted?: () => void;
}) {
  const taskBusy = task?.busy ?? false;
  // A retry may fall back to the server queue. Keep its preview separate from real history so
  // it cannot hide the accepted Queued row or overwrite the reply once the server records it.
  const [taskPreviews, setTaskPreviews] = useState<Message[]>([]);
  // The core attaches the frontend tool registry; direct agent runs do not.
  const { copilotkit } = useCopilotKit();
  // Mentions are scoped to the channel's permitted agents.
  const { data: agentProfiles } = useQuery(agentListQueryOptions());
  const channelAgentId = `channel:${channel.id}`;
  const { agent, isReady } = useAgent({
    agentId: channelAgentId,
    runtimeAgentId,
    threadId: channel.threadId,
    updates: [
      UseAgentUpdate.OnMessagesChanged,
      UseAgentUpdate.OnRunStatusChanged,
    ],
  });
  useEffect(() => observeApprovalAgent(agent), [agent]);

  /**
   * A turn this tab did not start is going, and this tab is following it: one already running when
   * Chat opened, one the server runs after Allow once, one another tab or device started. While it
   * is true the conversation is busy exactly as for a turn sent from here: the pill and Stop show,
   * and anything typed is Queued until it ends. See `follow` below.
   */
  const [following, setFollowing] = useState(false);
  const followingRef = useRef(false);
  /** The follow in progress, for a seed that has to wait for it. */
  const followDone = useRef<Promise<void>>(Promise.resolve());
  const follow = useRef<
    (options?: {
      first?: Promise<unknown>;
      done?: (runs: { finished: number }) => boolean;
    }) => Promise<void>
  >(() => Promise.resolve());
  /** Every run this screen's agent has seen start, live or replayed; see `follow`. */
  const knownRuns = useRef(new Set<string>());
  useEffect(() => {
    const subscription = agent.subscribe({
      onRunStartedEvent: ({ event }) => {
        knownRuns.current.add(event.runId);
      },
    });
    return () => subscription.unsubscribe();
  }, [agent]);
  /** A followed turn has gone quiet for {@link FOLLOW_QUIET_MS}; see `follow`. */
  const [followQuiet, setFollowQuiet] = useState(false);
  /**
   * A follow asked for while this tab's own turn holds the thread, started when that turn ends: a
   * join now would detach the turn it is waiting behind.
   */
  const followAfterTurn = useRef<{
    done?: (runs: { finished: number }) => boolean;
  } | null>(null);
  /**
   * The stored transcript, drawn in place of the agent's while a join replays the thread up to a
   * live run; see the join effect. Null the rest of the time.
   */
  const [standIn, setStandIn] = useState<readonly Message[] | null>(null);
  /** Read the store again; see the activity effect. Settles what a follow streamed. */
  const pullRef = useRef<() => void>(() => {});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * First-message seed from the compose screen. It is taken once per mount and retained until the
   * agent has its own messages because joining a fresh thread can temporarily empty the agent.
   */
  const [seed] = useState<Message | null>(() => {
    const pending = takeFirstMessage(channel.id);
    return pending ? seedMessage(pending, newId()) : null;
  });

  /** Cleared by the send-on-mount effect without restarting it. */
  const seedRef = useRef(seed);
  seedRef.current = seed;

  /** Promise gate for ordering the first message after the thread join when possible. */
  const openJoinGate = useRef<() => void>(() => {});
  const joinGate = useRef<Promise<void> | null>(null);
  if (joinGate.current === null) {
    joinGate.current = new Promise<void>((resolve) => {
      openJoinGate.current = resolve;
    });
  }
  const joinGatePromise = joinGate.current;

  /** Promise gate so messages typed before runtime readiness wait instead of being discarded. */
  const openReadyGate = useRef<() => void>(() => {});
  const readyGate = useRef<Promise<void> | null>(null);
  if (readyGate.current === null) {
    readyGate.current = new Promise<void>((resolve) => {
      openReadyGate.current = resolve;
    });
  }
  const readyGatePromise = readyGate.current;
  const isReadyRef = useRef(isReady);
  isReadyRef.current = isReady;

  /*
   * THE AGENT IS READ WHEN IT IS USED, NEVER CAPTURED BEFORE A WAIT. `useAgent` hands back a
   * provisional agent until the proxied one is registered, and a different object afterwards. The
   * stale one still runs and still reaches the thread, so the answer is stored and shows up on the
   * next reload while the rendered agent sits empty. `say` waits, so it spans that swap.
   */
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const voiceArchive = useVoiceArchive(channel.id);
  const [voiceContextNotice, setVoiceContextNotice] = useState<string | null>(
    null,
  );

  /**
   * History has been asked for and has not arrived. True for a channel opened from the roster, where
   * an empty transcript is also a real answer; false for one started from the compose screen, which
   * already has the message that started it.
   */
  const [restoring, setRestoring] = useState(seed === null);
  /**
   * How many stored turns this app could not read.
   *
   * Held rather than derived, because the transcript is the running agent's once history is handed
   * over: `agent.messages` is what was restored, and what was dropped on the way in is not
   * recoverable from it.
   */
  const [unreadable, setUnreadable] = useState(0);
  const [historyAvailability, setHistoryAvailability] = useState<
    "ready" | "unavailable"
  >("ready");
  const [historyReadFailed, setHistoryReadFailed] = useState(false);
  // Mount reads and Bot refreshes share one ordering: only the newest read owns the notice.
  const historyReadVersion = useRef(0);
  /** Messages the transcript took from the store, which a later read may correct; see the merge. */
  const fromStore = useRef(new Set<string>());
  useEffect(() => {
    if (isReady) openReadyGate.current();
  }, [isReady]);

  // Join the gateway socket, restore durable history, then release the first-message gate.
  useEffect(() => {
    if (!isReady) return;
    let current = true;
    const version = ++historyReadVersion.current;

    void (async () => {
      /*
       * WHETHER A TURN IS GOING, asked of the runtime the moment Chat opens, beside the join
       * (`liveRun`). Its answer is the live run's id. Where it cannot say, what the replay shows is
       * the fallback at the deadline: a run that has started and not finished, since replayed runs
       * open and close as they go by and only a live one is left open.
       */
      const asking = liveRun({
        agentId: runtimeAgentId,
        threadId: channel.threadId,
      });
      // The stored transcript, asked for at once too: a long thread takes a moment to read.
      const reading = readThreadMessages(channel.threadId, runtimeAgentId);
      let runOpen = false;
      let runId: string | null | undefined;
      /** The join has replayed up to the live run's own start: what it draws now is current. */
      let reachedLive = false;
      /** Set while the stored transcript stands in for the replay; see below. */
      let release: (() => void) | null = null;
      const watch = agent.subscribe({
        onRunStartedEvent: ({ event }) => {
          runOpen = true;
          if (runId && event.runId === runId) reachedLive = true;
          release?.();
        },
        onRunFinishedEvent: () => {
          runOpen = false;
        },
        onRunErrorEvent: () => {
          runOpen = false;
        },
      });
      const connect = copilotkit.connectAgent({ agent });
      const joined = connect.then(
        () => undefined,
        () => undefined,
      );
      let live: Promise<void> | null = null;
      let followed = false;
      try {
        const first = await Promise.race([
          asking,
          joined.then(() => "joined" as const),
        ]);
        if (first !== "joined") runId = first;
        if (typeof runId === "string") {
          live = joined;
        } else {
          // Bounded unless a turn is going; `follow-turn.ts` has why, `join-thread.ts` why bounded.
          ({ live } = await joinOrFollow({
            connect,
            deadline: afterMs(JOIN_DEADLINE_MS),
            detach: () => agent.detachActiveRun(),
            // A run seen open at the deadline may have started since the first answer: ask again.
            runOpen: async () => {
              if (!runOpen) return false;
              const again = await liveRun({
                agentId: runtimeAgentId,
                threadId: channel.threadId,
              });
              return again === undefined ? true : again !== null;
            },
          }));
        }

        /*
         * A TURN IS GOING: show it going, and stay with it to the end. Following starts at once, so
         * the pill and Stop show and what is typed is Queued; the gate opens so nothing waits on it
         * (a seed meets the busy thread and waits its turn).
         *
         * THE STORED TRANSCRIPT STANDS IN WHILE THE JOIN REPLAYS. On a fresh page the join replays
         * the whole thread before it reaches the live run, which on a long thread takes seconds, and
         * drawing the replay meant old history on screen and the pill walking every earlier turn's
         * steps. So the store's copy is drawn as soon as it is read, and the replay takes over when
         * it reaches the live run's own start, from where everything it draws is current. Calls the
         * store holds no result for (a stopped run's) are left out of the stand-in: the pill would
         * otherwise name one of them as the step under way. History is read again when the turn is
         * over, by the follow, when a read cannot race the stream for the same messages.
         */
        if (live && current) {
          const following = follow.current({ first: live });
          openJoinGate.current();
          if (typeof runId === "string") {
            // Nothing is drawn until there is a whole transcript to draw: the stand-in, or the
            // replay once it has reached the live run. Drawn piecemeal, the transcript scrolled
            // through old turns as they came; drawn whole, it opens at the latest message.
            let ended = false;
            const show = () => {
              if (current) setRestoring(false);
            };
            release = () => {
              if (!reachedLive) return;
              release = null;
              setStandIn(null);
              show();
            };
            release();
            void (async () => {
              let stored = await reading;
              // The store answers slowly while the replay floods the page: give it longer here.
              if (stored.availability !== "ready" && !reachedLive && !ended)
                stored = await readThreadMessages(
                  channel.threadId,
                  runtimeAgentId,
                  { deadlineMs: STAND_IN_READ_MS },
                );
              if (ended || reachedLive || stored.availability !== "ready")
                return;
              setStandIn(withoutUnansweredCalls(stored.messages));
              show();
            })();
            await following;
            ended = true;
          } else {
            if (current) setRestoring(false);
            await following;
          }
          release = null;
          setStandIn(null);
          // The follow read the store as it ended, with retries and its own notice rules; a second,
          // single-shot read here could only fail on a slow store and claim history was lost.
          followed = true;
        }
      } catch {
        /*
         * A join that throws is a join that is over. It must not take the gate with it: everything
         * typed afterwards waits on that gate, so a throw here would silence the conversation
         * rather than degrade it. History is restored below either way.
         */
      } finally {
        watch.unsubscribe();
      }

      try {
        if (followed) return;
        const stored = await reading;
        const isCurrent = current && version === historyReadVersion.current;
        if (isCurrent) {
          // The gateway snapshot can lag the store. Keep its valid local rows even when the
          // corresponding stored row is unreadable, while restoring other readable additions.
          const messages = mergeStoredMessages(
            agent.messages,
            stored.messages,
            fromStore.current,
          );
          if (messages !== agent.messages) {
            rememberFromStore(fromStore.current, agent.messages, messages);
            agent.setMessages(messages);
          }
        }
        /*
         * Said on screen rather than only counted. A turn the history store holds and this app cannot
         * parse is left out of the transcript, and a record people read back must not have a hole in
         * it that nothing accounts for. Set even when nothing was restored: a thread whose every turn
         * is unreadable is exactly the case where silence would read as "this conversation is empty".
         */
        if (isCurrent) {
          setUnreadable(stored.unreadable);
          setHistoryAvailability(stored.availability);
          // A gateway snapshot may be partial; neither it nor a later send proves this read succeeded.
          setHistoryReadFailed(stored.availability === "unavailable");
        }
      } finally {
        // Cleared on failure too: placeholders over an empty transcript promise messages that are
        // never coming.
        if (current) setRestoring(false);
        // Release even on join/restore failure; the gate orders messages, not withholds them.
        openJoinGate.current();
      }
    })();

    return () => {
      current = false;
    };
  }, [copilotkit, agent, isReady, channel.threadId, runtimeAgentId]);

  /*
   * A turn nobody here streamed, surfaced while the channel is open.
   *
   * A relayed handoff answer runs on the server and lands in this thread with no browser attached.
   * The roster hears about it — the activity socket patches the channel-list cache — but this
   * transcript restores history once, on mount, and would show the new turn only after leaving and
   * coming back. So it watches that same cache: when this channel's `lastMessageAt` advances to a
   * moment a Bot authored, the durable history is read again. Riding the roster's own cache rather
   * than a second subscription means "the sidebar updated" and "the transcript refreshes" are the
   * one signal, and cannot drift apart.
   *
   * The same merge as mount places a recovered durable prefix before its shared local anchors,
   * preserving current content and local-only messages in both the transcript and the next run.
   *
   * Retried briefly, because the roster is patched when the turn is on record with the runner and
   * the platform's read of the thread can be a beat behind it. And read again after a read that
   * changed the transcript, until one changes nothing: the store assembles the turn from its run's
   * events over about a second, so the first read that has it can hold it with pieces missing. Each
   * later read corrects it (see `mergeStoredMessages`), and the one that changes nothing is the
   * store having settled.
   */
  useEffect(() => {
    const authoredActivity = (): ChannelActivitySignature | null => {
      const cache = queryClient.getQueryData<{
        pages: { channels: ChannelSummary[] }[];
      }>(channelKeys.list());
      const summary = cache?.pages
        .flatMap((page) => page.channels)
        .find((row) => row.id === channel.id);
      // Only a Bot's turn is news here; a person's own line arrives through the run that sent it.
      if (
        !summary ||
        summary.lastMessageAgentId === null ||
        summary.lastMessageAt === null ||
        summary.lastMessage === null
      ) {
        return null;
      }
      return {
        agentId: summary.lastMessageAgentId,
        at: summary.lastMessageAt,
        text: summary.lastMessage,
      };
    };

    const initialActivity = authoredActivity();
    let lastSeen = initialActivity;
    let cancelled = false;

    const pull = () => {
      // A followed turn is streaming the same messages; reading the store now would add them twice.
      // The follow reads once it is over.
      if (followingRef.current) return;
      const version = ++historyReadVersion.current;
      const isCurrent = () =>
        !cancelled && version === historyReadVersion.current;
      void (async () => {
        let sawReady = false;
        // The waits still to come: catching up, then, once a read changes something, settling.
        const waits = [...CATCH_UP_DELAYS_MS];
        let settling = false;
        while (waits.length > 0) {
          const delayMs = waits.shift() ?? 0;
          const lastCatchUp = !settling && waits.length === 0;
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          if (!isCurrent()) return;
          const stored = await readThreadMessages(
            channel.threadId,
            runtimeAgentId,
          );
          if (!isCurrent()) return;
          if (stored.availability === "unavailable") {
            // Only an exhausted refresh with no successful read is a failure to announce. Keep the
            // last known ready notice when the store already answered this refresh cycle.
            if (lastCatchUp && !sawReady) {
              setHistoryAvailability("unavailable");
              setHistoryReadFailed(true);
            }
            continue;
          }
          sawReady = true;
          // A ready read owns the notice even when every readable id is already on screen.
          setUnreadable(stored.unreadable);
          setHistoryAvailability("ready");
          setHistoryReadFailed(false);
          const current = agentRef.current;
          const messages = mergeStoredMessages(
            current.messages,
            stored.messages,
            fromStore.current,
          );
          if (messages === current.messages) {
            // After a change, a read with nothing new is the store having settled.
            if (settling) return;
            continue;
          }
          rememberFromStore(fromStore.current, current.messages, messages);
          current.setMessages(messages);
          if (!settling) {
            settling = true;
            waits.splice(0, waits.length, ...SETTLE_DELAYS_MS);
          }
        }
      })();
    };

    pullRef.current = pull;

    /*
     * ANOTHER TAB OR DEVICE STARTED A TURN HERE. The roster's busy flag says so (`busy` on the row,
     * patched by the activity socket), and this tab follows it: the run streams in, and what is
     * typed meanwhile is Queued rather than refused by the lock. Its own turns raise the same flag,
     * so one is ignored while this tab has a turn of its own.
     */
    const channelBusy = (): boolean => {
      const cache = queryClient.getQueryData<{
        pages: { channels: ChannelSummary[] }[];
      }>(channelKeys.list());
      return (
        cache?.pages
          .flatMap((page) => page.channels)
          .find((row) => row.id === channel.id)?.busy === true
      );
    };
    let wasBusy = channelBusy();

    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      const busy = channelBusy();
      if (busy && !wasBusy && turnsRef.current === 0 && !followingRef.current)
        void follow.current({ done: () => !channelBusy() });
      wasBusy = busy;
      const activity = authoredActivity();
      if (activity && !sameActivity(activity, lastSeen)) {
        lastSeen = activity;
        if (sameActivity(selfReportedBotActivity.current, activity)) return;
        pull();
      }
    });
    void (async () => {
      await joinGatePromise;
      if (
        !cancelled &&
        initialActivity &&
        !sameActivity(selfReportedBotActivity.current, initialActivity)
      ) {
        pull();
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [channel.id, channel.threadId, joinGatePromise, runtimeAgentId]);

  // Tool calls from this conversation act on this coworker's own computer.
  useActiveBot(runtimeAgentId);

  const skillCommands = useSkillCommands(runtimeAgentId);
  const historyNotice = channelHistoryNotice({
    restoring,
    messageCount: agent.messages.length,
    lastMessageAt: channel.lastMessageAt,
    historyAvailability,
    historyReadFailed,
    unreadable,
  });

  // Run failures arrive as events and are reported only for turns started in this mount.
  const [runError, setRunErrorState] = useState<string | null>(null);
  /**
   * Every report goes through here, so the note kept for a reload is always the one on screen, kept
   * with the conversation's last message so a reload shows it only while it is still the latest
   * news (`lib/channels/run-error-memory.ts`). A new turn's `null` forgets it.
   */
  const setRunError = useCallback(
    (said: string | null) => {
      setRunErrorState(said);
      if (said === null) forgetRunError(channel.id);
      else
        rememberRunError(
          channel.id,
          said,
          agentRef.current.messages.at(-1)?.id ?? null,
        );
    },
    [channel.id],
  );
  const awaitingReply = useRef(false);
  /**
   * WHY THIS TURN ENDED WITHOUT AN ANSWER, KEPT WHERE `deliver` CAN STILL SEE IT — because the one
   * thing that knows is a subscriber, and the one thing that has to act on it is an `await`.
   *
   * `copilotkit.runAgent` DOES NOT REJECT ON A FAILED RUN. `CopilotKitCore.runAgent` catches
   * everything the agent throws, reports it through `emitError` as `AGENT_RUN_FAILED`, and returns
   * `{ result: undefined, newMessages: [] }` — a value indistinguishable from a run that finished
   * with nothing to say. So a gateway 503, a stream that dies, a model that refuses the request:
   * every one of them arrived here as a resolved promise, and `say` reported success for a turn
   * that never reached the server.
   *
   * WHAT THAT COST, WHICH IS THE REASON THIS EXISTS. `say` resolving is what every caller reads as
   * "it went". The composer clears the box and gives up the chips it was riding; the queue empties
   * into a draft nothing retries; `conversation-view.tsx` never runs either of the failure paths it
   * has written for exactly this. The person is left with the failed turn in the transcript and a
   * notice under it, the words unretryable, and the files behind them staged rows that nothing on
   * any screen points at any more. The notice is honest and everything under it was not.
   *
   * READ OFF THE SAME `fail` THE NOTICE IS, and deliberately not from a second subscription of its
   * own. `fail` already answers the one question a separate subscriber would get wrong: a turn the
   * PERSON stopped also reaches `onRunFailed`, with an abort, and `onStop` clears `awaitingReply`
   * before it — so Stop is not a failure here and nothing restores a draft somebody chose to end.
   *
   * ONE SLOT FOR ONE TURN AT A TIME, the same assumption `awaitingReply` beside it already makes.
   * Two overlapping turns — a component button pressed during a composer send — would have the
   * second clear the first's reason, which reports the earlier turn as successful. That is the
   * pre-existing shape of `awaitingReply`, not a new one, and narrowing it means giving a run a
   * handle that `copilotkit.runAgent` does not hand back.
   */
  const turnFailure = useRef<string | null>(null);
  /**
   * A request was refused because another run holds the thread. `deliver` distinguishes a send
   * that never started from a continuation whose earlier work must not be automatically repeated.
   * Kept beside `turnFailure`: the subscriber knows, and `deliver` has to act on it.
   */
  const turnLocked = useRef(false);
  const assistantMessagesBeforeRun = useRef<Set<string>>(new Set());

  /*
   * TWO DIFFERENT FACTS ABOUT ONE TURN, AND NEITHER OF THEM IS `agent.isRunning`.
   *
   * `turnsInFlight` counts what a person would call the Bot having the turn: from the moment `say`
   * is entered until the whole thing has come back, browser actions in the middle included. It is
   * what decides whether the next thing typed is sent or parked, and what tells the queue its wait
   * is over.
   *
   * `runsInFlight` counts what Stop can actually reach: the run `copilotkit.runAgent` opens, and
   * nothing before it. A turn can be in flight for a second and a half before that, while `say`
   * waits for the runtime agent, and a Stop drawn in that window aborts a controller nobody has
   * made yet.
   *
   * `agent.isRunning` looks like both and is neither. It reports the run on the wire, and a turn
   * that touches the browser is several runs in a row: the Bot asks for a click, the run ENDS so
   * the browser can answer it, and another run starts carrying the answer. The agent reports itself
   * idle in every one of those gaps — the truth about the wire and a lie about the turn. OpenBot
   * registers every computer tool as a frontend tool, so the gaps open on ordinary work rather than
   * on some edge case, and anything keyed on the turn ending fires in the middle of one instead.
   *
   * Counters rather than booleans because nothing stops a second turn being started from a
   * component button while the first is still going, and two overlapping turns must not have the
   * first one to finish declare the conversation idle.
   */
  const [turnsInFlight, setTurnsInFlight] = useState(0);
  /* Authoritative once this screen unmounts, where `setTurnsInFlight` becomes a no-op. */
  const turnsRef = useRef(0);
  const [runsInFlight, setRunsInFlight] = useState(0);

  /**
   * Tell the roster what was just said. Failures here must not block the conversation.
   */
  const recordActivity = useMutation(recordChannelActivityMutationOptions());
  const selfReportedBotActivity = useRef<ChannelActivitySignature | null>(null);

  const report = (text: string, agentId: string | null) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const at = new Date().toISOString();
    if (agentId !== null) {
      selfReportedBotActivity.current = { agentId, at, text: trimmed };
    }
    recordActivity.mutate({
      agentId,
      at,
      channelId: channel.id,
      text: trimmed,
    });
  };
  const reportRef = useRef(report);
  reportRef.current = report;

  /**
   * Everything `say` does once it has something worth sending, split out so the counter it is
   * wrapped in covers every way out of here, a throw included.
   */
  const deliver = async (
    trimmed: string,
    skillInstructions: string[],
    attachments: Attachment[],
    skipIf?: () => boolean,
  ) => {
    // Wait briefly for the runtime agent instance before adding the message.
    if (!isReadyRef.current) {
      await Promise.race([
        readyGatePromise,
        afterMs(SEND_WITHOUT_RUNTIME_AFTER_MS),
      ]);
    }

    /*
     * EVERY TURN WAITS FOR THE JOIN, not just the first of a new channel: a message added while the
     * connect is in flight is erased by it either way. Unbounded only in appearance — the join
     * effect bounds itself and opens this gate from a `finally`. If that effect never ran there is
     * no runtime agent, and no connect in flight to wait on.
     */
    if (isReadyRef.current) {
      await joinGatePromise;
    }

    // A send that only makes sense against the thread as it now stands; see the seed below.
    if (skipIf?.()) return "";

    // Every wait is behind us, so this is the agent the screen is actually rendering. Read once and
    // used throughout, so the message, the repair and the run cannot land on two different agents.
    // Give initial voice history time to restore, while keeping ordinary chat usable on failure.
    setVoiceContextNotice(null);
    let voiceHistoryTimer: ReturnType<typeof setTimeout> | undefined;
    const priorCalls = await Promise.race([
      loadVoiceArchive(channel.id),
      new Promise<never>((_resolve, reject) => {
        voiceHistoryTimer = setTimeout(
          () => reject(new Error("Voice history timed out")),
          2000,
        );
      }),
    ])
      .catch(() => {
        setVoiceContextNotice(
          "Couldn’t bring in what was said on the call. You may need to repeat it.",
        );
        return cachedVoiceArchive(channel.id);
      })
      .finally(() => clearTimeout(voiceHistoryTimer));
    const target = agentRef.current;
    const existingMessageIds = new Set(
      target.messages.map((message) => message.id),
    );

    setRunError(null);
    turnFailure.current = null;
    turnLocked.current = false;
    assistantMessagesBeforeRun.current = new Set(
      target.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.id),
    );
    awaitingReply.current = true;

    /*
     * THE SKILL GOES IN FRONT OF THE MESSAGE, AS A SYSTEM TURN. A `/` chip is one token in the
     * composer; what it stands for is the instruction added here, ahead of what the person typed, so
     * the Bot reads the job before the request.
     *
     * A system message rather than text prepended to theirs, because the two are not the same kind
     * of thing: the transcript should show what a person said, and pasting the skill into their
     * words puts sentences in their mouth and makes the reply quote instructions back at them.
     *
     * `transcriptMessages` draws user and assistant turns, so this never appears on screen — the
     * chip is what says a skill was used, and it stays visible in the message they sent.
     */
    // What this turn adds, so a turn that never reaches the server can take it back off screen.
    const added = new Set<string>();
    for (const instruction of skillInstructions) {
      const id = newId();
      added.add(id);
      target.addMessage({
        content: instruction,
        id,
        role: "system",
      });
    }

    const voiceHistory = voiceArchiveContext(priorCalls);
    // Older development calls used a system row, which built-in agents discard.
    const previousVoiceContextId = `voice-history:${channel.id}`;
    if (
      target.messages.some((message) => message.id === previousVoiceContextId)
    )
      target.setMessages(
        target.messages.filter(
          (message) => message.id !== previousVoiceContextId,
        ),
      );

    const userMessageId = newId();
    added.add(userMessageId);
    target.addMessage({
      content: toMessageContent(trimmed, attachments),
      id: userMessageId,
      role: "user",
    });
    // The roster previews what was asked. Chat's first day sends a request nobody typed, framed for
    // the model (`shared/first-day.ts`); the preview gets the request, not the frame.
    report(
      readFirstDay(trimmed) ?? (trimmed || describeAttachments(attachments)),
      null,
    );

    /*
     * AN APPROVAL'S WAIT IS NOT THIS RUN'S TO ANSWER. A turn that asked before acting ended on an
     * interrupt, and the SDK refuses every later run until one answers it with `resume`, before any
     * request is made. OpenBot never answers it that way: the person decides in the approval card
     * or on Tasks, and the server carries out the action and continues the conversation itself. So
     * those waits are dropped here, and what the person typed is sent. See `isAnsweredByInbox`.
     *
     * AND THE BOT IS TOLD THE TRUTH ABOUT THE CALL. A call still waiting in a card has no result,
     * which no provider accepts, and the generic repair below would answer it "interrupted … do not
     * assume it succeeded": the Bot then said the email was not sent while Allow once could still
     * send it. Each waiting call gets `APPROVAL_WAITING_RESULT` instead, and once the action's real
     * result has come in, it takes the placeholder's place. Waiting means the interrupts this run
     * would otherwise trip on, and the cards the inbox still shows pending in this thread.
     */
    const waiting = waitingToolCalls(target.pendingInterrupts);
    const inbox = queryClient.getQueryData<ApprovalInboxData>(
      approvalInboxOptions().queryKey,
    );
    // An inbox not yet read cannot say a card was decided, so every placeholder still counts.
    if (!inbox) {
      for (const message of target.messages)
        if (isApprovalWaitingResult(message) && "toolCallId" in message)
          waiting.add(message.toolCallId);
    }
    for (const request of inbox?.requests ?? []) {
      if (
        request.status === "pending" &&
        request.action.threadId === channel.threadId &&
        request.action.toolCallId
      )
        waiting.add(request.action.toolCallId);
    }
    const toAnswer = interruptsToAnswer(target.pendingInterrupts);
    if (toAnswer !== target.pendingInterrupts) {
      target.pendingInterrupts = [...toAnswer];
    }
    /*
     * A placeholder whose card has since been decided is out of date, and the action's real result
     * may be in the store before it reaches this tab: the server's continuation records it there,
     * and a join does not always carry a result for a call it did not start. Read once, so it can
     * take the placeholder's place.
     */
    if (staleApprovalWaits(target.messages, waiting)) {
      const stored = await readThreadMessages(
        channel.threadId,
        runtimeAgentId,
      ).catch(() => null);
      if (stored?.availability === "ready") {
        const merged = mergeStoredMessages(
          target.messages,
          stored.messages,
          fromStore.current,
        );
        if (merged !== target.messages) {
          rememberFromStore(fromStore.current, target.messages, merged);
          target.setMessages(merged);
        }
      }
    }
    const settled = withApprovalWaits(target.messages, waiting, newId);
    if (settled !== target.messages) {
      const before = new Set(target.messages.map((message) => message.id));
      for (const message of settled)
        if (!before.has(message.id)) added.add(message.id);
      target.setMessages([...settled]);
    }

    // Providers reject later turns if prior tool calls have no result; repair before sending.
    const repaired = repairUnansweredToolCalls(target.messages);
    if (repaired !== target.messages) {
      target.setMessages(repaired as typeof target.messages);
    }

    /*
     * WHETHER THE RUN STARTED AT ALL. `runAgent` resolves the same for a run that finished and for
     * one refused before it began (an interrupt nothing answers, say), and only the first reaches
     * `onRunFailed`. A turn that never started is a failed send, never a sent one.
     */
    let started = false;
    /*
     * And whether the server's run did. A send that never reached it (the network dropped, the
     * request was refused with a 500) failed before anything was stored, so the same rule applies:
     * its bubble comes off screen and the words go back in the box. Left drawn, it read as sent,
     * and sending the words again drew a second copy beside it.
     */
    let serverStarted = false;
    const startWatch = target.subscribe({
      onRunInitialized: () => {
        started = true;
      },
      onRunStartedEvent: () => {
        serverStarted = true;
      },
    });
    setRunsInFlight((count) => count + 1);
    try {
      await withVoiceContext(copilotkit, target.agentId, voiceHistory, () =>
        copilotkit.runAgent({ agent: target }),
      );
    } finally {
      startWatch.unsubscribe();
      // A frontend tool finishes one run before its continuation; track failures for the whole turn.
      awaitingReply.current = false;
      setRunsInFlight((count) => count - 1);
    }

    /*
     * ANOTHER RUN HAD THE THREAD: the server continuing after Allow once, another tab, another
     * device on the same first day. Only a turn that never started can come off screen and wait
     * in the queue. A refused continuation may follow completed frontend actions: keep that history
     * and fail for an explicit retry, since requeueing the original request could repeat them.
     * Following an untouched send starts before the throw, so the queue waits for the other run.
     */
    if (turnLocked.current) {
      turnLocked.current = false;
      awaitingReply.current = false;
      if (serverStarted) {
        const message =
          "The Bot couldn't continue because another turn started. Review what it already did before trying again.";
        setRunError(message);
        throw new Error(message);
      }
      const kept = withoutMessages(target.messages, added);
      if (kept !== target.messages) target.setMessages([...kept]);
      void follow.current();
      throw new ThreadBusyError();
    }

    if (turnFailure.current !== null && !serverStarted) {
      const kept = withoutMessages(target.messages, added);
      if (kept !== target.messages) target.setMessages([...kept]);
      throw new Error(turnFailure.current);
    }

    if (!started && turnFailure.current === null) {
      awaitingReply.current = false;
      const kept = withoutMessages(target.messages, added);
      if (kept !== target.messages) target.setMessages([...kept]);
      const message = "Couldn't send your message. Try again.";
      setRunError(message);
      throw new Error(message);
    }

    /*
     * A TURN THAT DID NOT HAPPEN FAILS THE SEND, which is the only way anything upstream can tell.
     * See `turnFailure` for why the resolved promise above says nothing about that.
     *
     * AFTER the `finally`, not inside the `try`: the run is over either way, so the counter that
     * draws the Stop button must come down before this throws. Throwing from inside would leave
     * `runsInFlight` high for a run that has already ended.
     *
     * WHAT THE THROW REACHES, so it is clear this is a message and not a crash. The composer's
     * `catch` puts the words and the chips back; `conversation-view.tsx` puts a drained queue back
     * as retryable entries carrying their files. Nothing here reports the failure — `runError` was
     * already set from the same `fail` that set this, and the transcript already draws it — so this
     * adds a retry, not a second sentence.
     *
     * THE MESSAGE STAYS ON SCREEN. `deliver` added it above and nothing takes it away: it is what
     * the failed turn WAS, it is what the notice under it is about, and removing it would delete a
     * partial answer that a mid-stream failure had already produced. The restored draft beside it
     * is the retry, the same way a failed composer send has always put its words back while the
     * transcript kept the turn.
     */
    if (turnFailure.current !== null) {
      throw new Error(turnFailure.current);
    }
    return target.messages
      .filter(
        (message) =>
          message.role === "assistant" && !existingMessageIds.has(message.id),
      )
      .map(messageText)
      .filter(Boolean)
      .join("\n\n");
  };

  /**
   * Send a user turn through the channel, including activity reporting and history repair.
   *
   * Every user turn in this channel goes through here — what the composer sends, the seed from the
   * compose screen, and a button inside a rendered component. That is what makes the counter worth
   * keeping here rather than in the view: the view sees only the turns it started itself, and a
   * queue that drains on the wrong one of those posts a correction into the middle of an answer.
   */
  const say = async (
    text: string,
    skillInstructions: string[] = [],
    attachments: Attachment[] = [],
    { skipIf }: { skipIf?: () => boolean } = {},
  ) => {
    const trimmed = text.trim();
    // A pasted screenshot with no caption is still a message to send: `canSendDraft` already
    // unlocks the button for exactly this case, so refusing it here would leave the button
    // enabled and inert.
    if (!trimmed && attachments.length === 0) return "";

    // Voice and typed requests share this turn boundary, including gaps between frontend tools.
    if (turnsRef.current > 0) {
      throw new Error(
        "This Bot is still working on something. Wait for it, or stop it first.",
      );
    }
    // A turn this tab did not start is going: not a refusal, a wait. The queue parks the words.
    if (followingRef.current || agentRef.current.isRunning) {
      throw new ThreadBusyError();
    }

    const busyOwner = newId();
    turnsRef.current += 1;
    setTurnsInFlight(turnsRef.current);
    const busyStarted = setChannelBusy({
      channelId: channel.id,
      busy: true,
      runId: busyOwner,
    });
    try {
      return await deliver(trimmed, skillInstructions, attachments, skipIf);
    } finally {
      turnsRef.current -= 1;
      setTurnsInFlight(turnsRef.current);
      // Sent from here rather than from an effect on `turnsInFlight`: this runs after unmount, that
      // does not, and the last turn out is what takes the roster's working indicator down.
      if (turnsRef.current === 0) {
        // A delayed start must settle before its release, including after this tab unmounts.
        // `setChannelBusy` absorbs transport failures: a lost response may still have committed.
        void busyStarted.then(() =>
          setChannelBusy({
            channelId: channel.id,
            busy: false,
            runId: busyOwner,
          }),
        );
        const waiting = followAfterTurn.current;
        followAfterTurn.current = null;
        if (waiting) void follow.current(waiting);
      }
    }
  };

  useEffect(() => {
    const fail = (reported: unknown) => {
      if (!awaitingReply.current) return;
      awaitingReply.current = false;
      const message = stoppedReason(reported);
      // `deliver` decides whether this can wait or already-started work needs an explicit retry.
      if (isThreadLocked(reported) || isThreadLocked(new Error(message))) {
        turnLocked.current = true;
        return;
      }
      // Both halves of one fact: the sentence the transcript shows, and the reason `deliver` throws
      // so the draft behind the turn is restored rather than counted as sent. See `turnFailure`.
      const said = sayableReason(message);
      turnFailure.current = said;
      setRunError(said);
    };
    const subscription = agent.subscribe?.({
      // Both surfaces fall back to the same sentence, from the same place, so a person who uses
      // both is not told two different things about the same silence.
      onRunErrorEvent: ({ event }) => fail(event?.message),
      onRunFailed: ({ error }) => fail(error),
      onRunFinishedEvent: () => {
        const wasOurs = awaitingReply.current;
        if (!wasOurs) return;

        const reply = [...agent.messages]
          .reverse()
          .find(
            (message) =>
              message.role === "assistant" &&
              !assistantMessagesBeforeRun.current.has(message.id),
          );
        const content = typeof reply?.content === "string" ? reply.content : "";
        if (content) reportRef.current(content, runtimeAgentId);
      },
    });
    return () => subscription?.unsubscribe();
  }, [agent, runtimeAgentId, setRunError]);

  /** Stable reference for effects and component callbacks. */
  const sayRef = useRef(say);
  sayRef.current = say;
  const stopEpoch = useRef(0);

  const call = useVoiceCall({
    channelId: channel.id,
    disabled: !channel.active,
    context: async () =>
      [
        voiceArchiveContext(await loadVoiceArchive(channel.id)).slice(-6000),
        voiceContext(agentRef.current.messages).slice(-6000),
      ]
        .filter(Boolean)
        .join("\n\n"),
    anchorMessageId: () => agentRef.current.messages.at(-1)?.id ?? null,
    askAgent: async (request, signal) => {
      const started = stopEpoch.current;
      const answer = await askChannelAgent(request, signal, {
        busy: () =>
          turnsRef.current > 0 ||
          followingRef.current ||
          agentRef.current.isRunning,
        send: (text) => sayRef.current(text),
      });
      if (started !== stopEpoch.current)
        throw new Error("The user stopped this task before it completed.");
      return answer;
    },
  });
  const stopTask = () => {
    awaitingReply.current = false;
    stopEpoch.current++;
    copilotkit.stopAgent({ agent });
    freshConnectionAfterStop(agent);
  };

  /**
   * Follow a turn this tab did not start until it lands. See `lib/channels/follow-turn.ts`.
   *
   * One at a time: a second ask while one is going waits on the same one. Stop ends it (the stop
   * reaches the followed run, whose join then ends), as does leaving the screen. A followed join
   * that goes quiet for {@link FOLLOW_SILENCE_MS} is ended as stalled, and one quiet for
   * {@link FOLLOW_QUIET_MS} says so above the composer when something is waiting behind it. When it
   * is over, the store is read once, which settles whatever streamed and is what drains the queue.
   *
   * `done` is handed how many runs this follow has seen start and finish, which is how a follow
   * that waits for the server's continuation knows it has actually come and gone.
   */
  follow.current = ({ first, done } = {}) => {
    if (followingRef.current) return followDone.current;
    followingRef.current = true;
    setFollowing(true);
    // Reads already in flight would race the stream for the same messages.
    historyReadVersion.current++;
    const epoch = stopEpoch.current;
    /*
     * Runs counted are the ones this tab had not seen before the follow began. A join replays what
     * the tab has not seen, which on a transport without a cursor is the thread's old runs too, and
     * those must not pass for the turn being waited on.
     */
    const seenBefore = new Set(knownRuns.current);
    const runs = { started: false, finished: 0 };
    const counting = agentRef.current.subscribe({
      onRunStartedEvent: ({ event }) => {
        runs.started = !seenBefore.has(event.runId);
      },
      onRunFinishedEvent: () => {
        if (runs.started) runs.finished += 1;
        runs.started = false;
      },
    });
    const watched = (joining: Promise<unknown>) => {
      const target = agentRef.current;
      let stall: ReturnType<typeof setTimeout> | undefined;
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      const heard = () => {
        clearTimeout(stall);
        clearTimeout(quietTimer);
        setFollowQuiet(false);
        stall = setTimeout(
          () => void target.detachActiveRun(),
          FOLLOW_SILENCE_MS,
        );
        quietTimer = setTimeout(() => setFollowQuiet(true), FOLLOW_QUIET_MS);
      };
      heard();
      const listening = target.subscribe({ onEvent: heard });
      return joining.finally(() => {
        clearTimeout(stall);
        clearTimeout(quietTimer);
        listening.unsubscribe();
      });
    };
    followDone.current = (async () => {
      try {
        await followTurn({
          ...(first ? { first: watched(first) } : {}),
          connect: () =>
            watched(copilotkit.connectAgent({ agent: agentRef.current })),
          ...(done ? { done: () => done(runs) } : {}),
          stopped: () => !alive.current || epoch !== stopEpoch.current,
          wait: afterMs,
          retryMs: FOLLOW_RETRY_MS,
          maxMs: FOLLOW_MAX_MS,
        });
      } finally {
        counting.unsubscribe();
        followingRef.current = false;
        setFollowing(false);
        setFollowQuiet(false);
        if (alive.current) pullRef.current();
      }
    })();
    return followDone.current;
  };

  /*
   * ALLOW ONCE HANDS THE TURN TO THE SERVER. Deciding an approval (in its card, on Tasks, in another
   * tab) queues the action; the server carries it out and continues this conversation on its own,
   * a second or two later. Until that continuation has landed the conversation is busy: what is
   * typed meanwhile is Queued and answered after it, and the continuation streams into this tab.
   * Without this the conversation read as idle, a message sent in that gap raced the server for the
   * thread, and the reply came in only when a later read happened to find it.
   *
   * Watched in the approvals inbox the card itself reads, so a decision made anywhere counts.
   */
  useEffect(() => {
    const seen = new Map<string, string>();
    const check = () => {
      const inbox = queryClient.getQueryData<ApprovalInboxData>(
        approvalInboxOptions().queryKey,
      );
      for (const request of inbox?.requests ?? []) {
        const before = seen.get(request.id);
        seen.set(request.id, request.status);
        if (before !== "pending" || request.status === "pending") continue;
        const toolCallId = request.action.toolCallId;
        const ours =
          request.action.threadId === channel.threadId ||
          (toolCallId !== undefined &&
            agentRef.current.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.toolCalls?.some((call) => call.id === toolCallId),
            ));
        if (!ours) continue;
        const wait = {
          /*
           * Landed once the continuation's own run has been seen to start and finish. Not once the
           * call has a result: a message sent while the card waited gave the call a placeholder (see
           * `APPROVAL_WAITING_RESULT`), and treating that as the result ended the follow before the
           * continuation began, so the next message raced it for the thread.
           */
          done: (runs: { finished: number }) => runs.finished > 0,
        };
        if (turnsRef.current > 0) followAfterTurn.current = wait;
        else void follow.current(wait);
      }
    };
    check();
    return queryClient.getQueryCache().subscribe(check);
  }, [channel.threadId]);

  /**
   * Component buttons speak as user turns without forcing every transcript card to re-render.
   *
   * The rejection is swallowed HERE rather than left to the void, and that is not a style choice:
   * `say` throws on a failed turn now (see `turnFailure`), and a voided promise with nothing on the
   * end of it is an unhandled rejection — in this repository's test runner, a failure attributed to
   * whichever test happened to be running when it surfaced. There is nothing to restore for this
   * caller either way: the words came from a button inside a rendered card, not from a box somebody
   * is still holding, and the failed turn is already reported by `runError` under the transcript.
   */
  const askFromComponent = useCallback((text: string) => {
    void sayRef.current(text).catch(() => undefined);
  }, []);

  /**
   * Send the create-channel seed once. No waiting of its own: `say` owns that for every turn, and a
   * second copy of the ordering here was the one that could disagree with it.
   *
   * ONCE PER CHANNEL IN THIS PAGE, BY CONSTRUCTION. `claimSeed` is module-level, so StrictMode
   * running this twice, a remount, or a greeting stashed twice for the same channel all send it
   * once. ONCE PER THREAD ACROSS DEVICES, by the lock: a second device opening the same first day
   * meets the first one's run, follows it, and sends its own request only if the thread does not
   * already hold one. See `seedStillNeeded`.
   */
  useEffect(() => {
    const pending = seedRef.current;
    if (!pending) return;
    seedRef.current = null;
    if (!claimSeed(channel.id)) return;
    const text = typeof pending.content === "string" ? pending.content : "";

    // Swallowed for the reason `askFromComponent` above records: `say` throws on a failed turn, and
    // the seed has no box to go back into — it was typed on a screen that has already navigated
    // away. The transcript keeps the seeded message and the notice under it says what happened.
    // Decided against the thread as `say` finds it once joined, which is where another device's
    // greeting shows up.
    const skipIf = () => !seedStillNeeded(text, agentRef.current.messages);
    void (async () => {
      // A busy thread is waited out, a few times at most: each wait is a whole turn.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await sayRef.current(text, [], [], { skipIf });
          return;
        } catch (error) {
          if (!isThreadBusyError(error)) return;
          await Promise.all([followDone.current, afterMs(FOLLOW_RETRY_MS)]);
          if (!alive.current) return;
        }
      }
    })();

    // Keep `seed` in state; transcriptMessages gives it up once the agent holds a user turn.
  }, [channel.id]);

  const presenceInbox = useQuery({
    ...approvalInboxOptions(),
    enabled: inShell,
  });
  const botName =
    agentProfiles?.find((profile) => profile.id === runtimeAgentId)?.name ??
    channel.name;
  const messages = transcriptMessages(
    restoring ? NOTHING : (standIn ?? agent.messages),
    seed,
  );
  const recordedOrQueued = new Set([
    ...messages.map((message) => message.id),
    ...(task?.queued ?? []).map((reply) => reply.messageId),
  ]);

  /*
   * The failed turn's sentence from before a reload, while nothing has happened since: read only
   * once history is back and no turn is going, and only while the last message is the one it was
   * about. See `lib/channels/run-error-memory.ts`.
   */
  const recalledError =
    runError === null && !restoring && turnsInFlight === 0 && !agent.isRunning
      ? recalledRunError(channel.id, agent.messages.at(-1)?.id ?? null)
      : null;

  return (
    // Activity renderers resolve their agent through this SDK context. It must match useAgent's
    // channel instance so an action continues this thread instead of looking for a default agent.
    <CopilotChatConfigurationProvider
      agentId={channelAgentId}
      threadId={channel.threadId}
    >
      <ConversationProvider ask={askFromComponent}>
        <div className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col">
          <VoiceCallWidget
            call={call}
            agentId={runtimeAgentId}
            name={botName}
            avatarSeed={
              agentProfiles?.find((profile) => profile.id === runtimeAgentId)
                ?.avatarSeed ?? runtimeAgentId
            }
            taskRunning={agent.isRunning || runsInFlight > 0}
          />
          <ConversationView
            approvals={presenceInbox.data?.requests}
            folded={folded}
            serverQueued={task?.queued}
            inShell={inShell}
            lead={lead ?? (topic ? <Topic>{topic}</Topic> : null)}
            placeholder={task ? `Reply to ${botName}` : `Message ${botName}`}
            queuedNotice={
              following && followQuiet
                ? `${botName} is still finishing something. I'll send this next.`
                : undefined
            }
            voiceCall={
              call.available
                ? {
                    active: call.active,
                    supported: call.supported,
                    onStart: call.open,
                  }
                : undefined
            }
            agents={toAgentOptions(agentProfiles, channel.agentIds)}
            // Failed-task retries carry words only; ordinary durable replies retain composer features.
            channelId={task?.send && !task.durable ? undefined : channel.id}
            /*
             * THE TURN, not the run. `say` waits for the runtime agent and the join before a run starts,
             * and `agent.isRunning` alone leaves that gap unmarked — which is the one moment the
             * "Thinking" line exists for. Same value as `pending`, deliberately.
             */
            busy={agent.isRunning || turnsInFlight > 0 || following || taskBusy}
            // The `/` menu exposes only skills granted to this Bot.
            commands={task?.send && !task.durable ? undefined : skillCommands}
            // Readiness is handled by `say`; deletion is the only disabled-chat state.
            disabled={!channel.active}
            /*
             * NOTHING WHILE HISTORY IS RESTORING, then all of it at once. A join replays the thread
             * turn by turn, and the transcript scrolls each new turn to the top as it lands: on a
             * long thread, drawing the replay as it came left the screen parked on an old turn. The
             * restoring rows stand in until the whole transcript is here, and it then opens at the
             * latest message.
             */
            messages={withVoiceChats(
              [
                ...messages,
                ...taskPreviews.filter(
                  (message) => !recordedOrQueued.has(message.id),
                ),
              ],
              voiceArchive.entries,
            )}
            notice={
              /*
               * Two things can be worth saying at once — a deleted coworker and a history with holes in
               * it — and they are independent, so neither is an `else` for the other.
               */
              <>
                <HandoffResumeNotice
                  botId={runtimeAgentId}
                  agent={agent}
                  ready={isReady && !restoring && channel.active}
                  run={async () => {
                    setRunsInFlight((count) => count + 1);
                    try {
                      await copilotkit.runAgent({ agent });
                    } finally {
                      setRunsInFlight((count) => count - 1);
                    }
                  }}
                />
                {voiceArchive.error && (
                  <p className="pb-2 text-sm text-destructive" role="alert">
                    Couldn’t load voice chats. Reload the page.
                  </p>
                )}
                {voiceContextNotice && (
                  <p
                    className="pb-2 text-sm text-muted-foreground"
                    role="status"
                  >
                    {voiceContextNotice}
                  </p>
                )}
                {historyNotice ? (
                  <p
                    className="pb-2 text-sm text-muted-foreground"
                    role="status"
                  >
                    {historyNotice}
                  </p>
                ) : null}
                {channel.active ? null : (
                  <p
                    className="pb-2 text-sm text-muted-foreground"
                    role="status"
                  >
                    This Bot was deleted. You can still read this conversation,
                    but the Bot can't reply.
                  </p>
                )}
              </>
            }
            onSubmit={async (draft) => {
              onSubmitted?.();
              if (task?.send) {
                const messageId = newId();
                if (!task.durable)
                  setTaskPreviews((messages) => [
                    ...messages,
                    { id: messageId, role: "user", content: draft.text },
                  ]);
                try {
                  await task.send({
                    text: draft.text,
                    messageId,
                    ...(draft.attachments.length
                      ? {
                          attachmentIds: draft.attachments.map(
                            (attachment) =>
                              uploadedAttachment(attachment).attachmentId,
                          ),
                        }
                      : {}),
                    ...(draft.commandIds.length
                      ? { skillIds: draft.commandIds }
                      : {}),
                  });
                } catch (error) {
                  // Taken back off, and thrown on, so the composer puts the words back in the box.
                  setTaskPreviews((messages) =>
                    messages.filter((message) => message.id !== messageId),
                  );
                  throw error;
                }
                return;
              }
              // `draft.agentId` carries the @mentioned coworker, but nothing routes on it yet: this
              // channel is pinned to one `runtimeAgentId` for the life of its thread, so honouring a
              // per-message mention is a change to that binding, not to the composer.
              //
              // `commandIds` are the `/` chips that survived into the send, in the order they were
              // typed. Resolved against the same list the menu was built from, so a chip left over from
              // a skill that has since been revoked resolves to nothing rather than to a stale
              // instruction — the menu is refetched, and this reads from it.
              const skillInstructions = draft.commandIds
                .map(
                  (id) =>
                    skillCommands.find((command) => command.id === id)?.prompt,
                )
                .filter((instruction): instruction is string =>
                  Boolean(instruction),
                );

              await say(draft.text, skillInstructions, draft.attachments);
            }}
            /**
             * Stop through the core so the abort signal reaches frontend tools; `say` repairs any
             * unanswered tool call before the next turn.
             */
            onStop={stopTask}
            /*
             * The turn, not the run. A browser action ends one run and starts another, and telling the
             * conversation it is idle in between is what would drain a parked correction into the
             * middle of an answer: a second turn racing the first on one thread, with a fabricated
             * result stitched over a tool call that is still executing.
             */
            pending={
              !task?.send &&
              (agent.isRunning || turnsInFlight > 0 || following || taskBusy)
            }
            /*
             * A channel outlives its turns, so it is the screen where waiting is worth offering. A
             * correction typed mid-answer is held here, in this tab, and runs as one follow-up turn the
             * moment this one is over — including when it is over because somebody pressed the button
             * above.
             */
            queueWhileBusy={!task?.send}
            restoring={restoring}
            /*
             * The run, not the turn. Stop reaches a run through the core's abort controller, and that
             * controller does not exist until `say` has finished waiting for the runtime agent — so
             * this is the one place the narrower fact is the honest one to draw a button from.
             */
            stoppable={
              (agent.isRunning || runsInFlight > 0 || following) &&
              !(taskBusy && turnsInFlight === 0)
            }
            /*
             * At the END OF THE TRANSCRIPT rather than above the composer, which is where this used to
             * be. A turn that ends without an answer leaves a gap exactly where the reply was going to
             * appear, and the person is already looking at it; an explanation in the composer area is a
             * different part of the screen from the thing it explains.
             *
             * `runError` carries whatever ended the turn, in that thing's own words. A Bot that stopped
             * streaming says so, because the deployment's stall watchdog writes that sentence into the
             * run before closing it; see server/src/channels/stall-guard.ts.
             */
            stopped={
              runError && THREAD_LOCKED.test(runError)
                ? STILL_FINISHING
                : (runError ?? recalledError ?? undefined)
            }
          />
        </div>
      </ConversationProvider>
    </CopilotChatConfigurationProvider>
  );
}
