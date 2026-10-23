import { useState } from "react";
import { attentionSummary } from "@/components/bot-profile/attention";
import { MicOrb } from "@/components/duet/mic-orb";
import type { OnboardingStep } from "@/components/onboarding/onboarding-wizard";
import { appConfig } from "@/lib/generated/application-config";
import {
  requestNotificationPermission,
  useNotificationPermission,
} from "@/lib/setup/notifications";

const PRODUCT = appConfig.brand.productName;

/** How long "Notifications on" shows before the step moves on by itself. */
export const GRANTED_BEAT_MS = 1_000;

/**
 * The notification the preview shows: the one this web app raises today, word for word.
 *
 * `AttentionNotifier` (`bot-profile/attention.tsx`) titles it "<Bot> needs you" and says what is
 * waiting with `attentionSummary`, which is called here so the body cannot drift from it. A Bot with
 * a question and an approval waiting is the common case it fires for.
 */
export function notificationPreview(botName: string): {
  title: string;
  body: string;
} {
  return {
    title: `${botName} needs you`,
    body: attentionSummary({
      agentId: "preview",
      name: botName,
      questions: 1,
      approvals: 1,
      handoffs: 0,
      unread: 0,
      paused: false,
      notify: "all",
    }),
  };
}

/**
 * Onboarding's Get notified step: a preview of the notification, and the button that asks the
 * browser for permission.
 *
 * Its buttons are the frame's, so this returns the whole step. "Turn on notifications" asks the
 * browser, and shows a spinner while its prompt is up. A yes turns the button green, "Notifications
 * on", for a beat and then moves on by itself. A no, a prompt closed without an answer, or a
 * browser with no notifications at all says so on the step, and the button becomes Next. "Not now"
 * moves on and asks nothing. The step is optional, so the button keeps its place when Not now goes.
 */
export function useNotifyStep(botName: string): OnboardingStep {
  const permission = useNotificationPermission();
  const [asking, setAsking] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const granted = permission === "granted";
  // Answered, or nothing to ask: the button only moves on from here.
  const done =
    permission === "denied" || permission === "unsupported" || dismissed;

  /*
   * Why the button now says Next, said just above it in the frame's notice slot rather than under
   * the phone: on a small screen the phone pushes anything under it out of view, and the person
   * would see "Next" with no reason.
   */
  const said =
    permission === "denied"
      ? "Notifications are blocked for this site. Allow them in your browser's site settings to turn them on."
      : permission === "unsupported"
        ? "This browser can't show notifications."
        : dismissed && permission === "default"
          ? "You can turn them on later in Settings."
          : null;

  return {
    id: "notify",
    render: () => <NotifyStep botName={botName} />,
    notice: said ? (
      <p className="type-sub text-center text-duet-ink-2" role="status">
        {said}
      </p>
    ) : undefined,
    optional: true,
    primaryLabel: granted
      ? "Notifications on"
      : done
        ? "Next"
        : "Turn on notifications",
    primaryDone: granted,
    primaryPending: asking,
    onPrimary:
      granted || done
        ? undefined
        : (next) => {
            setAsking(true);
            void requestNotificationPermission().then((answer) => {
              setAsking(false);
              if (answer === "granted") setTimeout(next, GRANTED_BEAT_MS);
              // The prompt closed with neither answer: the browser still says "default".
              else if (answer === "default") setDismissed(true);
            });
          },
    secondary: granted || done ? undefined : { label: "Not now" },
    footnote: `Notifications show while ${PRODUCT} is open in a browser tab.`,
  };
}

function NotifyStep({ botName }: { botName: string }) {
  const preview = notificationPreview(botName);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center">
      <h1 className="type-big text-center font-semibold text-duet-ink">
        Get notified
      </h1>
      <p className="type-sub mt-2.5 max-w-sm text-center text-duet-ink-2">
        Allow notifications so {PRODUCT} can tell you when it needs your input.
      </p>
      {/*
       * A ghost phone, so the card reads as something arriving on a screen: taller than it is wide,
       * its top fading out rather than drawn, the notification over it and four app tiles under it.
       */}
      <div
        aria-label={`A notification from ${PRODUCT}: ${preview.title}. ${preview.body}.`}
        className="relative mt-6 flex h-[380px] w-[300px] max-w-full flex-col items-center"
        data-ghost-phone=""
        role="img"
      >
        <div
          aria-hidden
          className="absolute inset-0 rounded-[46px] bg-linear-to-b from-duet-surface to-duet-tile shadow-[inset_0_0_0_1.5px_var(--duet-hair)] [mask-image:linear-gradient(to_bottom,transparent,black_38%)]"
        />
        <div
          className="relative mt-[120px] flex w-[272px] max-w-[calc(100%-24px)] items-center gap-3 rounded-[20px] bg-duet-card px-3 py-3 shadow-duet-card"
          data-notification-preview=""
        >
          <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-duet-tile">
            <MicOrb size={30} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[14px] font-semibold leading-[18px] text-duet-ink">
                {preview.title}
              </span>
              <span className="shrink-0 text-[12px] leading-4 text-duet-ink-3">
                now
              </span>
            </span>
            <span className="block truncate text-[14px] leading-[18px] text-duet-ink-2">
              {preview.body}
            </span>
          </span>
        </div>
        <div aria-hidden className="relative mt-14 flex gap-3">
          {[0, 1, 2, 3].map((tile) => (
            <span
              className="size-[52px] rounded-[14px] bg-duet-card/80 shadow-[inset_0_0_0_1px_var(--duet-hair-2)]"
              key={tile}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
