import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DuetIcon, type DuetIconName } from "@/components/duet/icons";
import { approvalInboxOptions, waitingOnYou } from "@/lib/approvals";
import { cn } from "@/lib/utils";

export type ShellTab = "chat" | "tasks" | "pages";

const TABS: {
  id: ShellTab;
  to: "/" | "/tasks" | "/pages";
  icon: DuetIconName;
  label: string;
}[] = [
  { id: "chat", to: "/", icon: "chat", label: "Chat" },
  { id: "tasks", to: "/tasks", icon: "tasks", label: "Tasks" },
  { id: "pages", to: "/pages", icon: "page", label: "Pages" },
];

/**
 * Which tab a path belongs to, or null for a page pushed over the app. A page open over the Pages
 * list (`/pages/<id>`) is still the Pages tab. A conversation opened from the menu (`/channel/<id>`)
 * is not Chat: it is a page, with a back disc and no tab bar (parity-spec 2.9).
 */
export function tabForPath(pathname: string): ShellTab | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return "chat";
  if (path === "/tasks") return "tasks";
  if (path === "/pages" || /^\/pages\/[^/]+$/.test(path)) return "pages";
  return null;
}

/**
 * The floating pill at the foot of the app: Chat, Tasks and Pages, the current one on a grey
 * capsule. Tasks carries the number of things waiting on the person, counted from the same list its
 * "Needs you" section shows, so the badge and the screen never disagree.
 */
export function TabBar({ current }: { current: ShellTab }) {
  const inbox = useQuery(approvalInboxOptions());
  const waiting = waitingOnYou(inbox.data).count;
  return (
    <nav
      aria-label="Main"
      className="duet-face duet-glass absolute inset-x-0 bottom-[22px] z-20 mx-auto flex h-16 w-[344px] max-w-[calc(100%-32px)] gap-0.5 rounded-[32px] p-[5px] shadow-duet-glass"
    >
      {TABS.map((tab) => {
        const on = tab.id === current;
        const badge = tab.id === "tasks" && waiting > 0 ? waiting : 0;
        return (
          <Link
            /*
             * What is announced is what is drawn: the tab `current` names carries aria-current. The
             * router sets it on its own active link too, so its matching is made to agree: exact for
             * Chat and Tasks ("/" would match all three), and Pages also over a page open on it.
             */
            activeOptions={{ exact: tab.id !== "pages" }}
            aria-current={on ? "page" : undefined}
            aria-label={badge ? `${tab.label}, ${badge} waiting` : tab.label}
            className={cn(
              "relative flex flex-1 flex-col items-center justify-center gap-px rounded-[27px] transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-accent/40",
              on
                ? "bg-duet-tile text-duet-ink"
                : "text-duet-ink-2 hover:text-duet-ink",
            )}
            key={tab.id}
            to={tab.to}
          >
            <DuetIcon name={tab.icon} size={20} stroke={on ? 2.1 : 1.9} />
            <span
              className={cn(
                "type-caption",
                on ? "font-semibold" : "font-medium",
              )}
            >
              {tab.label}
            </span>
            {badge ? (
              <span
                aria-hidden
                className={cn(
                  // The one badge style (parity-spec 2.2): the accent, with what sits on it.
                  "type-caption absolute top-1 left-1/2 ml-[7px] grid h-5 min-w-5 place-items-center rounded-full bg-duet-accent px-1 font-semibold text-duet-on-accent tabular-nums",
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
