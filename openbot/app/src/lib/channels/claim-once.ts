/**
 * Something Chat sends on its own when it opens, held so that it goes once: the first-day greeting
 * (`first-day-claim.ts`) and each later day's morning brief (`morning-brief-claim.ts`).
 *
 * Three things open Chat twice: StrictMode running the effect twice, the screen remounting before
 * what it sent shows up in the roster, and a second tab opened at the same time. The guards here
 * overlap on purpose, all keyed by what the caller names (the person and the Bot, and for the brief
 * the day):
 *
 * - THIS PAGE: a set, taken before anything awaits and kept once the message went, so a second run
 *   or a remount in this page is turned away even where storage is refused.
 * - OTHER TABS NOW: a Web Lock taken with `ifAvailable`, so a tab that finds another tab mid-send
 *   gives up rather than waits its turn and sends again.
 * - OTHER TABS LATER, AND RELOADS: a timestamp in localStorage, written under that lock, that says
 *   the message already went. It expires after the claim's `holdMs`: if the tab that sent it closed
 *   before the message reached the server, a later open sends it again.
 *
 * That is as far as the browser can tell. Two devices opening the app in the same second are not
 * covered here; the server's own claim is what turns the second one away.
 *
 * A message that was not sent gives everything back: one declined because the person got there
 * first, one that failed, one that lost the lock. A later open tries again.
 */

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

export type OnceClaim = {
  /** The storage key, and the lock's name, for one claim. */
  storageKey(key: string): string;
  /**
   * Run `send` if nothing else has sent this, and hold off everything else while it runs.
   *
   * `send` answers whether it sent: false when it decided at the last moment not to, which gives the
   * claim back. A throw gives it back too, and reaches the caller.
   *
   * Resolves true only when this call sent it.
   */
  claim(key: string, send: () => Promise<boolean>): Promise<boolean>;
};

/** One kind of claim: its own storage prefix, and how long a sent one holds off another. */
export function onceClaim({
  prefix,
  holdMs,
}: {
  prefix: string;
  holdMs: number;
}): OnceClaim {
  const heldHere = new Set<string>();
  const storageKey = (key: string) => `${prefix}${key}`;

  const claimedRecently = (key: string, now: number): boolean => {
    try {
      const at = Number(window.localStorage.getItem(storageKey(key)));
      return Number.isFinite(at) && at > 0 && now - at < holdMs;
    } catch {
      return false;
    }
  };

  const writeClaim = (key: string, now: number): void => {
    try {
      window.localStorage.setItem(storageKey(key), String(now));
    } catch {
      // Storage refused (a private window, say): this page's own guard still holds.
    }
  };

  const dropClaim = (key: string): void => {
    try {
      window.localStorage.removeItem(storageKey(key));
    } catch {
      // Nothing was written, or nothing can be removed; either way there is nothing to give back.
    }
  };

  return {
    storageKey,
    async claim(key, send) {
      if (heldHere.has(key)) return false;
      heldHere.add(key);

      let sent = false;
      const attempt = async (): Promise<boolean> => {
        const now = Date.now();
        if (claimedRecently(key, now)) return false;
        writeClaim(key, now);
        try {
          sent = await send();
        } finally {
          if (!sent) dropClaim(key);
        }
        return sent;
      };

      try {
        const locks = lockManager();
        return locks
          ? await locks.request(
              storageKey(key),
              { ifAvailable: true },
              async (lock) => (lock ? attempt() : false),
            )
          : await attempt();
      } finally {
        if (!sent) heldHere.delete(key);
      }
    },
  };
}
