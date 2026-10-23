import { useRouterState } from "@tanstack/react-router";
import { type ReactNode, type TouchEvent, useRef, useState } from "react";
import { AttentionNotifier } from "@/components/bot-profile/attention";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { ChatPresenceProvider, useChatServerBusy } from "./chat-presence";
import { FinishedForYou } from "./finished-for-you";
import { PageHeader, ShellHeader, useBack } from "./header";
import { MenuSheet } from "./menu-sheet";
import { PageChromeProvider, usePageChromeState } from "./page-chrome";
import { TabBar, tabForPath } from "./tab-bar";

/**
 * The signed-in app, as the launch film shows it: one column the width of a phone, centred on a
 * wide screen, with the header floating over it and Chat, Tasks and Pages at its foot.
 *
 * Everything that is not a tab is a page pushed over the app, in one chrome (parity-spec 2.9): a
 * back disc, the page's title in a pill, and no menu disc, avatar or tab bar. Bots, Connections,
 * Settings and a conversation opened from the menu all draw it; none draws its own.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const tab = tabForPath(pathname);
  const [menuOpen, setMenuOpen] = useState(false);
  // Any navigation closes the menu, including a conversation picked from inside it.
  const [shownPath, setShownPath] = useState(pathname);
  if (shownPath !== pathname) {
    setShownPath(pathname);
    setMenuOpen(false);
  }
  // One socket for the app: it keeps the conversation list and its working dots live.
  useChannelEvents();
  // Work the server runs in Chat that this screen did not start, for the pill and the orb.
  const chatServerBusy = useChatServerBusy(tab === "chat");

  return (
    <ChatPresenceProvider serverBusy={chatServerBusy}>
      <div className="flex h-svh flex-col overflow-hidden bg-duet-surface">
        <AttentionNotifier />
        <FinishedForYou />
        <SelfHostBanner />
        {tab ? (
          /*
           * The tab bar floats over the foot of every tab, frosted, so what scrolls reaches the
           * bottom of the screen. `--duet-tab-space` is the height it covers there (64px and its
           * 22px from the edge): a screen pads its end by it, and Chat docks its composer above it.
           */
          <div className="duet-face relative mx-auto flex min-h-0 w-full max-w-[430px] flex-1 flex-col text-duet-ink [--duet-tab-space:86px]">
            <ShellHeader
              floating
              menuOpen={menuOpen}
              onMenu={() => setMenuOpen(true)}
            />
            <main className="flex min-h-0 flex-1 flex-col">{children}</main>
            <TabBar current={tab} />
          </div>
        ) : (
          <PageChromeProvider>
            <PageColumn>{children}</PageColumn>
          </PageChromeProvider>
        )}
        <MenuSheet onOpenChange={setMenuOpen} open={menuOpen} />
      </div>
    </ChatPresenceProvider>
  );
}

/**
 * A page under the page chrome. A conversation keeps to Chat's column; a configuration page keeps
 * the width it was built for. `--duet-tab-space` is the bottom inset with no tab bar to clear, so a
 * conversation docks its reply box at the foot of the screen with Chat's margins.
 */
function PageColumn({ children }: { children: ReactNode }) {
  const chrome = usePageChromeState();
  const swipe = useEdgeSwipeBack();
  return (
    <div
      onTouchEnd={swipe.onTouchEnd}
      onTouchStart={swipe.onTouchStart}
      className={
        chrome?.column === "phone"
          ? "duet-face relative mx-auto flex min-h-0 w-full max-w-[430px] flex-1 flex-col text-duet-ink [--duet-tab-space:max(env(safe-area-inset-bottom),12px)]"
          : "duet-face relative flex min-h-0 w-full flex-1 flex-col text-duet-ink"
      }
    >
      <PageHeader />
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}

/** How near the left edge a swipe has to start, and how far right it has to travel, to go back. */
const EDGE_PX = 24;
const SWIPE_PX = 64;

/**
 * Back on a swipe in from the left edge (parity-spec 2.9), as the back disc does: a touch that starts
 * within 24px of the page's left edge and travels at least 64px right, more across than down.
 */
export function useEdgeSwipeBack() {
  const back = useBack();
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onTouchStart: (event: TouchEvent<HTMLElement>) => {
      const touch = event.touches[0];
      const left = event.currentTarget.getBoundingClientRect().left;
      start.current =
        touch && event.touches.length === 1 && touch.clientX - left <= EDGE_PX
          ? { x: touch.clientX, y: touch.clientY }
          : null;
    },
    onTouchEnd: (event: TouchEvent<HTMLElement>) => {
      const from = start.current;
      start.current = null;
      const touch = event.changedTouches[0];
      if (!from || !touch) return;
      const across = touch.clientX - from.x;
      const down = Math.abs(touch.clientY - from.y);
      if (across >= SWIPE_PX && down < across / 2) back();
    },
  };
}
