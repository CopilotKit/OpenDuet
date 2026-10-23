import type { LinkProps } from "@tanstack/react-router";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useEffect,
  useId,
  useState,
} from "react";

/**
 * What the shell's page chrome shows for the page under it (parity-spec 2.9): every screen that is
 * not a tab (Bots, Connections, Settings, a conversation opened from the menu) is a page pushed over
 * the app, with a back disc, its title in a pill in the middle, and no menu, avatar or tab bar.
 *
 * The shell draws the chrome and the page names itself, so the title sits in one place on every
 * page and no page draws a header of its own.
 */
export type PageChrome = {
  /** The page's name, in the pill. */
  title: string | null;
  /**
   * Where back goes when there is no history to go back through, such as a link opened cold: the
   * list this page was reached from. Chat when the page does not say.
   */
  backTo?: LinkProps;
  /**
   * `phone` holds the page to Chat's column, for a conversation; `wide` leaves it the width the
   * configuration pages were built for.
   */
  column: "wide" | "phone";
  /**
   * The pill's second line is what the Bot is doing (`useChatStep`), while it works. On for a
   * conversation, whose Bot reports its steps as Chat's does.
   */
  status?: boolean;
  /** What the server is doing in this page's conversation, for that line when the page is not. */
  serverWork?: string | null;
  /** What the "…" disc on the right opens, such as the conversation's Bot and its computer. */
  actions?: ReactNode;
};

type Claim = PageChrome & { owner: string };

const NOTHING: PageChrome = { title: null, column: "wide" };

const ChromeContext = createContext<PageChrome | null>(null);
const ClaimContext = createContext<Dispatch<
  SetStateAction<Claim | null>
> | null>(null);

export function PageChromeProvider({ children }: { children: ReactNode }) {
  const [claim, setClaim] = useState<Claim | null>(null);
  return (
    <ClaimContext.Provider value={setClaim}>
      <ChromeContext.Provider value={claim ?? NOTHING}>
        {children}
      </ChromeContext.Provider>
    </ClaimContext.Provider>
  );
}

/** What the chrome shows now. Outside the shell there is no chrome, and this is null. */
export function usePageChromeState(): PageChrome | null {
  return useContext(ChromeContext);
}

/** Whether this is drawn under the shell's page chrome, which already names the page. */
export function useInPageChrome(): boolean {
  return useContext(ClaimContext) !== null;
}

/**
 * Name this page in the chrome while it is mounted. The newest page to mount owns the chrome, and
 * leaving only clears it if nothing newer has claimed it since.
 */
export function usePageChrome({
  title,
  backTo,
  column = "wide",
  status = false,
  serverWork = null,
  actions,
}: {
  title: string | null;
  backTo?: LinkProps;
  column?: PageChrome["column"];
  status?: boolean;
  serverWork?: string | null;
  /** Keep it stable across renders (`useMemo`): a new element each render claims the chrome again. */
  actions?: ReactNode;
}) {
  const claim = useContext(ClaimContext);
  const owner = useId();
  // The link's identity changes every render; what it points at is what matters.
  const backKey = backTo ? JSON.stringify(backTo) : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on what the link points at.
  useEffect(() => {
    if (!claim) return;
    claim({
      owner,
      title,
      column,
      status,
      serverWork,
      ...(backTo ? { backTo } : {}),
      ...(actions ? { actions } : {}),
    });
  }, [claim, owner, title, column, status, serverWork, actions, backKey]);
  useEffect(() => {
    if (!claim) return;
    return () =>
      claim((current) => (current?.owner === owner ? null : current));
  }, [claim, owner]);
}
