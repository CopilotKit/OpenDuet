import { useRouterState } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { AttentionNotifier } from "@/components/bot-profile/attention";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { ChatPresenceProvider } from "./chat-presence";
import { FinishedForYou } from "./finished-for-you";
import { ShellHeader } from "./header";
import { MenuSheet } from "./menu-sheet";
import { TabBar, tabForPath } from "./tab-bar";

/**
 * The signed-in app, as the launch film shows it: one column the width of a phone, centred on a
 * wide screen, with the header floating over it and Chat, Tasks and Activity at its foot.
 *
 * The pages the menu opens (Bots, Connections, Settings…) were built for a wide pane, so they keep
 * their width under the same header, without the tab bar.
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

  return (
    <ChatPresenceProvider>
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
          <>
            <ShellHeader
              floating={false}
              menuOpen={menuOpen}
              onMenu={() => setMenuOpen(true)}
            />
            <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
              {children}
            </main>
          </>
        )}
        <MenuSheet onOpenChange={setMenuOpen} open={menuOpen} />
      </div>
    </ChatPresenceProvider>
  );
}
