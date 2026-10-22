/**
 * Who sends the first-day greeting, so that it goes once.
 *
 * Chat sends it on its own when it opens on nothing (`chat-screen.tsx`), and three things can open it
 * twice: StrictMode running the effect twice, the screen remounting before the conversation it
 * started shows up in the roster, and a second tab opened on the same first day. The guards here
 * overlap on purpose, all keyed by the person and the Bot:
 *
 * - THIS PAGE: a set, taken before anything awaits and kept once the greeting went, so a second run
 *   or a remount in this page is turned away even where storage is refused.
 * - OTHER TABS NOW: a Web Lock taken with `ifAvailable`, so a tab that finds another tab mid-send
 *   gives up rather than waits its turn and sends again.
 * - OTHER TABS LATER, AND RELOADS: a timestamp in localStorage, written under that lock, that says a
 *   greeting already went. It expires: if the tab that sent it closed before the message reached
 *   the server, Chat still opens on nothing, and after {@link FIRST_DAY_CLAIM_MS} it greets again.
 *
 * That is as far as the browser can tell. Two devices opening the app in the same second are not
 * covered; the server has no notion of a greeting to refuse a second one.
 *
 * A greeting that was not sent gives everything back: one declined because the person got there
 * first, one that failed, one that lost the lock. A later open of Chat on nothing tries again.
 */

const STORAGE_PREFIX = "openduet.first-day-greeting:";

/** How long a sent greeting stops another: well past the few seconds it takes to reach the server. */
export const FIRST_DAY_CLAIM_MS = 5 * 60_000;

const heldHere = new Set<string>();

/** The storage key for one person's first day with one Bot. */
export function firstDayClaimKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`;
}

function claimedRecently(key: string, now: number): boolean {
  try {
    const at = Number(window.localStorage.getItem(firstDayClaimKey(key)));
    return Number.isFinite(at) && at > 0 && now - at < FIRST_DAY_CLAIM_MS;
  } catch {
    return false;
  }
}

function writeClaim(key: string, now: number): void {
  try {
    window.localStorage.setItem(firstDayClaimKey(key), String(now));
  } catch {
    // Storage refused (a private window, say): this page's own guard still holds.
  }
}

function dropClaim(key: string): void {
  try {
    window.localStorage.removeItem(firstDayClaimKey(key));
  } catch {
    // Nothing was written, or nothing can be removed; either way there is nothing to give back.
  }
}

type LockManagerLike = {
  request<T>(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>;
};

function lockManager(): LockManagerLike | null {
  const locks = (
    globalThis.navigator as { locks?: LockManagerLike } | undefined
  )?.locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

/**
 * Run `greet` if nothing else has greeted this person on this Bot's behalf, and hold off everything
 * else while it runs.
 *
 * `greet` answers whether it sent the greeting: false when it decided at the last moment not to,
 * which gives the claim back. A throw gives it back too, and reaches the caller.
 *
 * Resolves true only when this call sent it.
 */
export async function claimFirstDay(
  key: string,
  greet: () => Promise<boolean>,
): Promise<boolean> {
  if (heldHere.has(key)) return false;
  heldHere.add(key);

  let sent = false;
  const attempt = async (): Promise<boolean> => {
    const now = Date.now();
    if (claimedRecently(key, now)) return false;
    writeClaim(key, now);
    try {
      sent = await greet();
    } finally {
      if (!sent) dropClaim(key);
    }
    return sent;
  };

  try {
    const locks = lockManager();
    return locks
      ? await locks.request(
          firstDayClaimKey(key),
          { ifAvailable: true },
          async (lock) => (lock ? attempt() : false),
        )
      : await attempt();
  } finally {
    if (!sent) heldHere.delete(key);
  }
}
