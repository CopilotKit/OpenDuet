import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { DuetIcon, type DuetIconName } from "@/components/duet/icons";
import { approvalInboxOptions } from "@/lib/approvals";
import { DURATION, EASE_OUT } from "@/lib/motion";
import { useReducedMotionPreference } from "@/lib/reduced-motion";
import { needsInputCount } from "@/lib/tasks/groups";
import { taskListQueryOptions } from "@/lib/tasks/queries";
import { cn } from "@/lib/utils";

export type ShellTab = "chat" | "tasks" | "make";

const TABS: {
  id: ShellTab;
  to: "/" | "/tasks" | "/make";
  icon: DuetIconName;
  label: string;
}[] = [
  { id: "chat", to: "/", icon: "chat", label: "Chat" },
  { id: "tasks", to: "/tasks", icon: "tasks", label: "Tasks" },
  { id: "make", to: "/make", icon: "sparkle", label: "Make" },
];

/**
 * Which tab a path belongs to, or null for a page pushed over the app. Something open over the
 * Make grid (`/make/<id>`) is still the Make tab, and a task over Tasks is still Tasks. A channel
 * (`/channels/<id>`) is a conversation like Chat's, under Chat's tab. A conversation opened from
 * the menu (`/channel/<id>`) is not Chat: it is a page, with a back disc and no tab bar
 * (parity-spec 2.9).
 */
export function tabForPath(pathname: string): ShellTab | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return "chat";
  // A channel is a conversation like Chat's, under the same header and tab bar.
  if (/^\/channels\/[^/]+$/.test(path)) return "chat";
  // A task opens over the Tasks list, so the list's tab stays current under it.
  if (path === "/tasks" || /^\/tasks\/[^/]+$/.test(path)) return "tasks";
  if (path === "/make" || /^\/make\/[^/]+$/.test(path)) return "make";
  return null;
}

/**
 * The floating pill at the foot of the app: Chat, Tasks and Make, the current one on a grey
 * capsule. Tasks carries the number of things waiting on the person, counted the way its Needs input
 * group lists them (`needsInputCount`), so the badge and the screen never disagree.
 *
 * The capsule slides from the tab left to the one chosen (one element, moved by transform), so the
 * eye follows the change instead of finding the capsule gone from one place and drawn in another.
 * The badge springs in when something starts waiting and shrinks away when nothing does, and its
 * number turns over when the count changes, the new digit rising into place as the old one leaves:
 * the bar's way of saying something arrived (parity-spec scene 7). With reduced motion the capsule
 * moves without sliding and the badge and its number fade.
 */
export function TabBar({ current }: { current: ShellTab }) {
  const inbox = useQuery(approvalInboxOptions());
  const tasks = useQuery(taskListQueryOptions());
  const waiting = needsInputCount(tasks.data, inbox.data);
  const reduced = useReducedMotionPreference();
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
             * Chat ("/" would match all three), and Tasks and Make also over a task or a page open on
             * them.
             */
            activeOptions={{ exact: tab.id === "chat" }}
            aria-current={on ? "page" : undefined}
            aria-label={badge ? `${tab.label}, ${badge} waiting` : tab.label}
            className={cn(
              "relative isolate flex flex-1 flex-col items-center justify-center gap-px rounded-[27px] transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-accent/40",
              on ? "text-duet-ink" : "text-duet-ink-2 hover:text-duet-ink",
            )}
            key={tab.id}
            to={tab.to}
          >
            {on ? (
              <motion.span
                aria-hidden
                className="-z-10 absolute inset-0 rounded-[27px] bg-duet-tile"
                data-tab-capsule=""
                layoutId={reduced ? undefined : "duet-tab-capsule"}
                transition={{ duration: DURATION.enter, ease: EASE_OUT }}
              />
            ) : null}
            <DuetIcon name={tab.icon} size={20} stroke={on ? 2.1 : 1.9} />
            <span
              className={cn(
                "type-caption",
                on ? "font-semibold" : "font-medium",
              )}
            >
              {tab.label}
            </span>
            <AnimatePresence initial={false}>
              {badge ? (
                <TabBadge count={badge} on={on} reduced={reduced} />
              ) : null}
            </AnimatePresence>
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * A gentle overshoot for the badge, past full size and back: the bar's one springy thing, as a
 * notification badge is. Anything bigger would bounce in the corner of the eye every time a count
 * changed.
 */
const BADGE_POP = [0.34, 1.36, 0.64, 1] as const;

/**
 * The count of what is waiting, in the one badge style (parity-spec 2.2): the accent, with what sits
 * on it. It pops in from a little below and to the left of where it settles, and its number turns
 * over in place when it changes.
 */
function TabBadge({
  count,
  on,
  reduced,
}: {
  count: number;
  on: boolean;
  reduced: boolean;
}) {
  return (
    <motion.span
      animate={{ opacity: 1, scale: 1, x: 0, y: 0, filter: "blur(0px)" }}
      aria-hidden
      className={cn(
        "type-caption absolute top-1 left-1/2 ml-[7px] grid h-5 min-w-5 place-items-center overflow-hidden rounded-full bg-duet-accent px-1 font-semibold text-duet-on-accent tabular-nums",
        on
          ? "shadow-[0_0_0_2px_var(--duet-tile)]"
          : "shadow-[0_0_0_2px_var(--duet-card)]",
      )}
      data-tab-badge=""
      exit={
        reduced
          ? { opacity: 0, transition: { duration: DURATION.tap } }
          : {
              opacity: 0,
              scale: 0.6,
              transition: { duration: DURATION.tap, ease: EASE_OUT },
            }
      }
      initial={
        reduced
          ? { opacity: 0 }
          : { opacity: 0, scale: 0.5, x: -4, y: 6, filter: "blur(2px)" }
      }
      transition={
        reduced
          ? { duration: DURATION.swap }
          : {
              duration: DURATION.enter,
              ease: EASE_OUT,
              scale: { duration: DURATION.sheet, ease: BADGE_POP },
            }
      }
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          className="block"
          exit={
            reduced
              ? { opacity: 0 }
              : { opacity: 0, y: -8, filter: "blur(2px)" }
          }
          initial={
            reduced ? { opacity: 0 } : { opacity: 0, y: 8, filter: "blur(2px)" }
          }
          key={count}
          transition={{ duration: DURATION.swap, ease: EASE_OUT }}
        >
          {count}
        </motion.span>
      </AnimatePresence>
    </motion.span>
  );
}
