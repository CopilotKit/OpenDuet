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
import type { MicOrbState } from "@/components/duet/mic-orb";

/**
 * What Chat is doing, for the header's orb to show, as the film's phone header does: it thinks
 * while OpenDuet works, listens while the person types, and lands a finished answer.
 *
 * The shell owns the header and Chat sits inside it, so this is a context the shell provides and
 * Chat reports into, rather than anything global. Reports go through one context and the header
 * reads another, so a keystroke re-renders the orb and nothing else on the screen.
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
};

/** How long the orb holds "done": its glow springs up and settles away, and its nod plays out. */
export const LANDING_MS = 2600;

const AT_REST: ChatPresence = {
  chat: false,
  working: false,
  drafting: false,
  edits: 0,
  answers: 0,
};

const ReportContext = createContext<Dispatch<
  SetStateAction<ChatPresence>
> | null>(null);
const PresenceContext = createContext<ChatPresence>(AT_REST);

export function ChatPresenceProvider({ children }: { children: ReactNode }) {
  const [presence, setPresence] = useState(AT_REST);
  return (
    <ReportContext.Provider value={setPresence}>
      <PresenceContext.Provider value={presence}>
        {children}
      </PresenceContext.Provider>
    </ReportContext.Provider>
  );
}

/**
 * The orb's state for what Chat is doing. The Bot working outranks the person typing, since a
 * correction typed mid-answer waits for the turn to end; typing cuts a landing short.
 */
export function orbStateFor(
  presence: ChatPresence,
  landing: boolean,
): MicOrbState {
  if (!presence.chat) return "idle";
  if (presence.working) return "thinking";
  if (presence.drafting) return "listening";
  return landing ? "done" : "idle";
}

/**
 * Report a conversation's turn and draft to the header, for as long as it is mounted. Only Chat's
 * conversation reports (`enabled`), and outside the shell there is nothing to report to.
 *
 * `working` is the turn, not the run, for the reason `ConversationView` gives: a browser action
 * ends one run and starts another, and the orb would land in the gap. `failed` is the turn having
 * ended without an answer. Hand the composer `onTextChange`, and call `onStop` when somebody
 * presses Stop, so a stopped answer does not land either.
 */
export function useReportChatPresence(
  enabled: boolean,
  { working, failed }: { working: boolean; failed: boolean },
): { onTextChange: (text: string) => void; onStop: () => void } | undefined {
  const context = useContext(ReportContext);
  const report = enabled ? context : null;
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

/** The header orb's state and keystrokes, from what Chat last reported. */
export function useChatOrb(): { state: MicOrbState; keystrokes: number } {
  const presence = useContext(PresenceContext);
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
  return {
    state: orbStateFor(presence, presence.answers !== landed),
    keystrokes: presence.edits,
  };
}
