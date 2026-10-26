import {
  type EgressPolicy,
  pushEgressPolicy,
} from "../computer/policy-network";
import type { ComputerProvider } from "../computer/provider";
import type { WebBotAuth } from "../web-bot-auth";
import type { ComputerVerdict } from "./setup";

/**
 * Only running computers, without waking any. Each list, policy read and push has five seconds;
 * a healthy fleet's total time scales with its size. Serial delivery bounds the active work to one.
 *
 * NO COMPUTER RUNNING IS `idle`, NOT `not_checked`. Computers start the first time a Bot needs one,
 * so a fresh install that configured them correctly has none running. The list itself is the check:
 * it is an authenticated call to the computer service, so an answer means the address and the token
 * both work, and a wrong one throws (which the checklist reads as Needs setup). Reporting that as
 * "not checked" put the row's fix, "Set AGENT_COMPUTER_URL and COMPUTER_TOKEN, then restart", in
 * front of somebody who had already set both. There is no policy to deliver to a computer that is
 * not running; one that starts gets its policy then.
 */
export function createComputerCheck(input: {
  provider?: Pick<ComputerProvider, "list">;
  controls: () =>
    | { policyForBot: (botId: string) => Promise<EgressPolicy> }
    | undefined;
  token?: string;
  webBotAuth?: WebBotAuth;
  fetchImpl?: typeof fetch;
}): () => Promise<ComputerVerdict> {
  let inFlight: Promise<ComputerVerdict> | undefined;
  let operation: Promise<unknown> = Promise.resolve();
  const bounded = <T>(work: Promise<T>): Promise<T> => {
    operation = work;
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The computer check did not answer.")),
          5_000,
        );
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  };
  const check = async (): Promise<ComputerVerdict> => {
    if (!input.provider) return "needs_setup";
    const computers = await bounded(input.provider.list());
    const running = computers.filter(
      (computer) => computer.status === "running" && computer.url,
    );
    if (running.length === 0) return "idle";
    const controls = input.controls();
    if (!controls) return "not_checked";
    for (const computer of running) {
      if (!computer.url) continue;
      const policy = await bounded(controls.policyForBot(computer.botId));
      await bounded(
        pushEgressPolicy(computer.url, computer.botId, policy, input),
      );
    }
    return "ready";
  };
  return () => {
    inFlight ??= check().finally(() => {
      // A timed-out store/provider may not support cancellation. Keep its verdict until that
      // operation settles, so rechecks cannot stack more work behind a hung read or push.
      const release = () => {
        inFlight = undefined;
      };
      void operation.then(release, release);
    });
    return inFlight;
  };
}
