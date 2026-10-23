import { useQuery } from "@tanstack/react-query";
import {
  Link,
  useCanGoBack,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { type ComponentProps, useState } from "react";
import { DuetIcon } from "@/components/duet/icons";
import { MicOrb } from "@/components/duet/mic-orb";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { appConfig } from "@/lib/generated/application-config";
import { cn } from "@/lib/utils";
import {
  useChatOrb,
  useChatStep,
  useChatWorking,
  useUnownedServerWork,
} from "./chat-presence";
import { usePageChromeState } from "./page-chrome";

const DISC =
  "duet-glass grid shrink-0 place-items-center rounded-full text-duet-ink shadow-duet-glass transition-transform duration-[var(--duet-dur-tap)] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-accent/40 active:scale-95";

/** The header's side discs: 46px, past the 44px a finger needs. */
const SIDE = 46;

/** The person's initial, from their name, or their email when they have none. */
export function initialOf(user: { name?: string | null; email: string }) {
  const source = user.name?.trim() || user.email;
  return (source.match(/\p{L}|\p{N}/u)?.[0] ?? "?").toUpperCase();
}

/**
 * The film's header: the menu in a disc on the left, OpenDuet's mic orb in the centre (back to
 * Chat), the person's initial in a disc on the right (their settings). The orb follows Chat: it
 * thinks while the Bot works, listens while the person types, and rests on every other screen.
 * While it thinks, a pill under it says what the Bot is doing.
 *
 * `floating` lays it over a screen that scrolls under it, behind a fade, as on Chat, Tasks and
 * Make. Otherwise it is a bar in the page's flow, for the screens the menu opens.
 */
export function ShellHeader({
  floating,
  menuOpen,
  onMenu,
}: {
  floating: boolean;
  menuOpen: boolean;
  onMenu: () => void;
}) {
  const { data: user } = useQuery(currentUserQueryOptions());
  const side = SIDE;
  const centre = floating ? 62 : 48;
  return (
    <header
      className={cn(
        "duet-face z-20 flex items-start justify-between px-4",
        floating
          ? "pointer-events-none absolute inset-x-0 top-0 h-32 bg-[linear-gradient(var(--duet-surface)_52%,transparent)] pt-3"
          : "relative h-16 shrink-0 items-center border-border border-b bg-background",
      )}
    >
      <Disc
        aria-expanded={menuOpen}
        aria-label="Menu"
        className={floating ? "mt-2" : undefined}
        onClick={onMenu}
        size={side}
      >
        <DuetIcon name="menu" size={21} />
      </Disc>
      {/* The span between the discs, so the pill under the orb can never reach under either. */}
      <div className="flex min-w-0 flex-1 flex-col items-center gap-1 px-2">
        <Link
          aria-label={`${appConfig.brand.productName} chat`}
          className="pointer-events-auto grid shrink-0 place-items-center rounded-full transition-transform focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-accent/40 active:scale-95"
          style={{ width: centre, height: centre }}
          to="/"
        >
          <ChatOrb size={centre - 2} />
        </Link>
        {floating ? <ChatStep /> : null}
      </div>
      <Link
        aria-label="Your settings"
        className={cn(DISC, "pointer-events-auto", floating && "mt-2")}
        style={{ width: side, height: side }}
        to="/settings"
      >
        <span className="type-nav font-semibold">
          {user ? initialOf(user) : null}
        </span>
      </Link>
    </header>
  );
}

/** Its own component, so a keystroke in Chat re-renders the orb and not the whole header. */
function ChatOrb({ size }: { size: number }) {
  const { state, keystrokes } = useChatOrb();
  return <MicOrb keystrokes={keystrokes} size={size} state={state} />;
}

/**
 * What the Bot is doing right now, in a pill under the orb: the step its line in the transcript is
 * running, or that it is thinking. Only on the floating header, which is Chat's, and its own
 * component for the orb's reason: it reads the step alone, so a keystroke does not reach it.
 *
 * Always mounted, so it can fade out as well as in, and so the live region is already there when
 * the first step arrives: a region added with its text in it is not announced. It holds the last
 * step while it fades, and hides that from screen readers, which hear each new step once. It
 * slides only for somebody who has not asked for less motion; for them it fades, and its words
 * stop shimmering, as a running tool line's do.
 */
function ChatStep() {
  const step = useChatStep();
  const [held, setHeld] = useState(step);
  if (step !== null && step !== held) setHeld(step);
  const shown = step !== null;
  return (
    <div aria-live="polite" className="flex max-w-full justify-center">
      <p
        aria-hidden={shown ? undefined : true}
        className="duet-glass type-caption flex h-6 max-w-full items-center rounded-full px-2.5 font-semibold text-duet-ink shadow-duet-glass transition-[opacity,translate] duration-[var(--duet-dur-swap)] data-[shown=false]:opacity-0 data-[shown=false]:ease-[var(--duet-ease-in)] data-[shown=true]:ease-[var(--duet-ease-out)] motion-safe:data-[shown=false]:-translate-y-1"
        data-shown={shown}
      >
        <span className="tool-line-running truncate">{held}</span>
      </p>
    </div>
  );
}

/**
 * The chrome for a page pushed over the app (parity-spec 2.9): a back disc on the left, the page's
 * title in a glass pill in the middle, and nothing on the right. No menu, no avatar and no tab bar,
 * so a page reads as somewhere you came to and go back from.
 *
 * It floats over the page behind the same fade as a tab's header, so what scrolls passes under it.
 * Back goes back through history when there is any, and otherwise to the list the page names, or
 * to Chat.
 */
export function PageHeader() {
  const chrome = usePageChromeState();
  const back = useBack();
  return (
    <header className="duet-face pointer-events-none absolute inset-x-0 top-0 z-20 flex h-[88px] items-start gap-2 bg-[linear-gradient(var(--duet-surface)_58%,transparent)] px-4 pt-3">
      <Disc aria-label="Back" onClick={back} size={SIDE}>
        <DuetIcon name="chevronLeft" size={22} />
      </Disc>
      <div className="flex min-w-0 flex-1 justify-center">
        {chrome?.title ? (
          <TitlePill
            serverWork={chrome.serverWork ?? null}
            status={chrome.status === true}
            title={chrome.title}
          />
        ) : null}
      </div>
      {/* The "…" disc, or the space it would take, so the pill stays centred. */}
      {chrome?.actions ? (
        <div className="pointer-events-auto shrink-0">{chrome.actions}</div>
      ) : (
        <span aria-hidden className="shrink-0" style={{ width: SIDE }} />
      )}
    </header>
  );
}

/**
 * Where back goes: back through history when there is any, and otherwise to the list the page
 * names, or to Chat. The back disc and the edge swipe both use it.
 */
export function useBack(): () => void {
  const chrome = usePageChromeState();
  const router = useRouter();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  return () => {
    if (canGoBack) router.history.back();
    else void navigate(chrome?.backTo ?? { to: "/" });
  };
}

/**
 * The page's name in a glass pill, as Duet's task page has it (card-01), and under it, while the
 * Bot works, what it is doing: the same words as Chat's pill under the orb.
 */
function TitlePill({
  title,
  status,
  serverWork,
}: {
  title: string;
  status: boolean;
  serverWork: string | null;
}) {
  const own = useChatStep();
  const server = useUnownedServerWork(serverWork, useChatWorking());
  const step = own ?? server;
  const working = status && step !== null;
  return (
    <div className="duet-glass flex h-[46px] min-w-0 max-w-full flex-col items-center justify-center rounded-full px-4 shadow-duet-glass">
      {/* The page's heading is its own, for screen readers; this is what the eye reads. */}
      <p
        aria-hidden
        className="type-sub max-w-full truncate font-semibold text-duet-ink"
      >
        {title}
      </p>
      {status ? (
        <p
          aria-live="polite"
          className="type-caption max-w-full truncate text-duet-ink-2"
          hidden={!working}
        >
          {working ? <span className="tool-line-running">{step}</span> : null}
        </p>
      ) : null}
    </div>
  );
}

/** The "…" disc on a page's right, for what belongs to the page but not on it. */
export function MoreDisc(props: ComponentProps<"button">) {
  return (
    <Disc aria-label="More" size={SIDE} {...props}>
      <DuetIcon name="more" size={22} stroke={2.4} />
    </Disc>
  );
}

function Disc({
  size,
  className,
  ...props
}: ComponentProps<"button"> & { size: number }) {
  return (
    <button
      className={cn(DISC, "pointer-events-auto", className)}
      style={{ width: size, height: size }}
      type="button"
      {...props}
    />
  );
}
