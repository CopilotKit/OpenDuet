import { IconPlayerStop, IconVolume } from "@tabler/icons-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { MessageFooter } from "@/components/ui/message";
import { speechText } from "@/lib/speech-text";

type Playback = {
  id: string;
  utterance: SpeechSynthesisUtterance;
};

// SpeechSynthesis has one queue per window, even when several transcripts are mounted.
let stopCurrent: (() => void) | null = null;

/** One owner per transcript. Old utterance callbacks never alter a newer session. */
export function useReadAloud(scope: string | undefined, blocked: boolean) {
  const current = useRef<Playback | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const supported =
    typeof window !== "undefined" &&
    typeof window.speechSynthesis?.speak === "function" &&
    typeof window.speechSynthesis.cancel === "function" &&
    typeof window.SpeechSynthesisUtterance === "function";
  const stop = useCallback((ownerId?: string) => {
    if (ownerId !== undefined && current.current?.id !== ownerId) return;
    const playback = current.current;
    current.current = null;
    if (stopCurrent === stop) stopCurrent = null;
    if (playback) {
      playback.utterance.onend = null;
      playback.utterance.onerror = null;
      window.speechSynthesis.cancel();
    }
    setActiveId(null);
  }, []);
  useEffect(() => {
    if (blocked) stop();
  }, [blocked, stop]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing conversation identity must cancel playback.
  useEffect(() => {
    setError("");
    const onHide = () => stop();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      stop();
    };
  }, [scope, stop]);
  return {
    activeId,
    error,
    supported,
    blocked,
    stop,
    toggle(id: string, text: string) {
      const same = current.current?.id === id;
      stop();
      setError("");
      if (same || blocked || !supported) return;
      const words = speechText(text);
      if (!words) return;
      stopCurrent?.();
      try {
        const utterance = new window.SpeechSynthesisUtterance(words);
        const playback = { id, utterance };
        current.current = playback;
        stopCurrent = stop;
        utterance.onend = () => {
          if (current.current === playback) stop();
        };
        utterance.onerror = () => {
          if (current.current !== playback) return;
          stop();
          setError("Could not read this message aloud. Please try again.");
        };
        setActiveId(id);
        window.speechSynthesis.speak(utterance);
      } catch {
        stop();
        setError("Could not read this message aloud. Please try again.");
      }
    },
  };
}

export const ReadAloudContext = createContext<ReturnType<
  typeof useReadAloud
> | null>(null);

export function ReadAloudButton({ id, text }: { id: string; text: string }) {
  const playback = useContext(ReadAloudContext);
  const active = playback?.activeId === id;
  const stop = playback?.stop;
  // biome-ignore lint/correctness/useExhaustiveDependencies: replacing source text must cancel its audio.
  useEffect(() => {
    // A removed or replaced message must release its audio, including on navigation.
    return () => {
      if (active) stop?.(id);
    };
  }, [active, stop, text, id]);
  const available = Boolean(playback?.supported && !playback.blocked);
  const words = useMemo(
    () => (available ? speechText(text) : ""),
    [available, text],
  );
  if (!playback || !words) return null;
  const label = active ? "Stop reading" : "Read aloud";
  return (
    <MessageFooter>
      <Button
        aria-label={label}
        title={label}
        variant="ghost"
        size="icon"
        className="text-duet-ink-3 hover:text-duet-ink"
        onClick={() => playback.toggle(id, text)}
      >
        {active ? (
          <IconPlayerStop aria-hidden="true" />
        ) : (
          <IconVolume aria-hidden="true" />
        )}
      </Button>
    </MessageFooter>
  );
}
