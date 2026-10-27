import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { DuetCard } from "@/components/duet/kit";
import { MicOrb } from "@/components/duet/mic-orb";
import { MorningBriefCard } from "@/components/duet/morning-brief-card";
import { TaskRow } from "@/components/duet/task-card";
import type { ApprovalRequest } from "@/lib/approvals";
import { IllustrationFrame } from "./illustration-frame";

export type CapabilityDemoKind = "brief" | "approval" | "task" | "search";
export const DEMO_BEAT_MS = 2400;

const APPROVAL: ApprovalRequest = {
  id: "onboarding-example",
  status: "pending",
  createdAt: "2026-10-23T09:00:00Z",
  action: {
    botId: "openduet",
    threadId: "onboarding-example",
    toolRef: "openbot/share_private_information",
    effect: "share_private",
    scope: "external:ana@example.com",
    args: {
      audience: "google-workspace: ana@example.com",
      preview: "Hi Ana, Friday works. I'll bring the samples.",
    },
    target: {},
  },
};

const LABELS: Record<CapabilityDemoKind, string> = {
  brief:
    "Example: a morning brief arrives with a delivery to confirm and a studio visit today",
  search:
    "Example: the Bot searches your email, then brings you a morning brief",
  approval:
    "Example: the Bot asks before sending an email, with Refuse and Allow once",
  task: "Example: a task moves from Working to Ready for review",
};

/**
 * The brief's date line: today, as the real brief writes its own (`morning-brief-tool.tsx`).
 *
 * It was a fixed "Friday, October 23", which was right on the day it was written and wrong, with
 * a weekday that no longer matched, on every day after. The rows under it name a day ("Friday")
 * and never a date, so today is the one date the card can always show truthfully.
 */
export function demoDate(now: Date = new Date()): string {
  return now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/** Real cards, isolated from input. A hidden/offscreen demo stops its clock and orb. */
export function CapabilityDemo({ kind }: { kind: CapabilityDemoKind }) {
  const reduced = useReducedMotion() === true;
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    const element = container.current;
    let intersecting = true;
    const update = () => setVisible(intersecting && !document.hidden);
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            intersecting = entry?.isIntersecting ?? false;
            update();
          });
    if (element) observer?.observe(element);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  useEffect(() => {
    if (reduced || !visible) return;
    const timer = setInterval(
      () => setBeat((value) => (value + 1) % 3),
      DEMO_BEAT_MS,
    );
    return () => clearInterval(timer);
  }, [reduced, visible]);
  const phase = reduced ? 2 : beat;
  const done = phase === 2;
  const approval = kind === "approval";
  const task = kind === "task";
  const caption = approval
    ? done
      ? "Only after your OK"
      : "You decide what gets sent"
    : task
      ? done
        ? "Ready when you are"
        : "Taking care of it"
      : done
        ? "Here's what needs you today"
        : "Searching your email";

  return (
    <div
      className="w-full min-w-0"
      data-capability-demo={kind}
      data-demo-phase={phase}
      ref={container}
    >
      <IllustrationFrame
        className="min-w-0 space-y-5 p-4 sm:p-6"
        label={LABELS[kind]}
      >
        <div className="flex min-w-0 items-center gap-4 px-2 py-3">
          <MicOrb
            size={48}
            state={done ? "done" : "thinking"}
            still={reduced || !visible}
          />
          <p className="type-sub min-w-0 text-duet-ink-2">{caption}</p>
        </div>
        <motion.div
          animate={{
            opacity: phase === 0 && !approval ? 0.55 : 1,
            y: phase === 0 && !reduced ? 8 : 0,
          }}
          initial={false}
          // Slower than any token on purpose: this is a demo the person watches, one beat
          // (DEMO_BEAT_MS) at a time, not a control answering a press.
          transition={{ duration: reduced ? 0 : 0.45, ease: [0.16, 1, 0.3, 1] }}
        >
          {approval ? (
            <ApprovalCard
              onDecide={() => {}}
              request={
                done
                  ? {
                      ...APPROVAL,
                      status: "completed",
                      decision: "allow_once",
                      decidedAt: "2026-10-23T09:00:00Z",
                    }
                  : APPROVAL
              }
            />
          ) : task ? (
            <DuetCard>
              <TaskRow
                status={done ? "ready_for_review" : "working"}
                title="Confirm Friday's delivery"
              />
            </DuetCard>
          ) : (
            <MorningBriefCard
              canWait={[]}
              date={demoDate()}
              greeting="Your day, at a glance."
              needsYou={[
                {
                  id: "delivery",
                  title: "Confirm the delivery",
                  why: "Ana needs a yes for Friday.",
                },
              ]}
              today={[
                {
                  id: "visit",
                  title: "Studio visit at 2",
                  why: "The samples are ready.",
                },
              ]}
            />
          )}
        </motion.div>
      </IllustrationFrame>
    </div>
  );
}
