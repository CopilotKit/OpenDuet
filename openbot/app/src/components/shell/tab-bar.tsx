import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DuetIcon, type DuetIconName } from "@/components/duet/icons";
import { approvalInboxOptions, waitingOnYou } from "@/lib/approvals";
import { cn } from "@/lib/utils";

export type ShellTab = "chat" | "inbox" | "activity";

const TABS: {
  id: ShellTab;
  to: "/" | "/inbox" | "/activity";
  icon: DuetIconName;
  label: string;
}[] = [
  { id: "chat", to: "/", icon: "chat", label: "Chat" },
  { id: "inbox", to: "/inbox", icon: "inbox", label: "Inbox" },
  { id: "activity", to: "/activity", icon: "activity", label: "Activity" },
];

/** Which tab a path belongs to, or null for a screen opened from the menu. */
export function tabForPath(pathname: string): ShellTab | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return "chat";
  if (path === "/inbox") return "inbox";
  if (path === "/activity") return "activity";
  return null;
}

/**
 * The floating pill at the foot of the app: Chat, Inbox and Activity, the current one on a grey
 * capsule. Inbox carries the number of things waiting on the person, counted from the same list the
 * Inbox shows, so the badge and the screen never disagree.
 */
export function TabBar({ current }: { current: ShellTab }) {
  const inbox = useQuery(approvalInboxOptions());
  const waiting = waitingOnYou(inbox.data).count;
  return (
    <nav
      aria-label="Main"
      className="duet-face relative z-20 mx-auto mb-[22px] flex h-16 w-[300px] max-w-[calc(100%-32px)] shrink-0 gap-0.5 rounded-[32px] bg-duet-card p-[5px] shadow-duet-float"
    >
      {TABS.map((tab) => {
        const on = tab.id === current;
        const badge = tab.id === "inbox" && waiting > 0 ? waiting : 0;
        return (
          <Link
            // The router marks the current tab with aria-current; exact, or "/" would match all three.
            activeOptions={{ exact: true }}
            aria-label={badge ? `${tab.label}, ${badge} waiting` : tab.label}
            className={cn(
              "relative flex flex-1 flex-col items-center justify-center gap-px rounded-[27px] transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40",
              on
                ? "bg-duet-tile text-duet-ink"
                : "text-duet-ink-2 hover:text-duet-ink",
            )}
            key={tab.id}
            to={tab.to}
          >
            <DuetIcon name={tab.icon} size={20} stroke={on ? 2.1 : 1.9} />
            <span
              className={cn("type-label", on ? "font-semibold" : "font-medium")}
            >
              {tab.label}
            </span>
            {badge ? (
              <span
                aria-hidden
                className={cn(
                  "absolute top-1 left-1/2 ml-[7px] grid h-5 min-w-5 place-items-center rounded-full bg-duet-violet px-1 font-bold text-[13px] text-white tabular-nums",
                  on
                    ? "shadow-[0_0_0_2px_var(--duet-tile)]"
                    : "shadow-[0_0_0_2px_var(--duet-card)]",
                )}
              >
                {badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
