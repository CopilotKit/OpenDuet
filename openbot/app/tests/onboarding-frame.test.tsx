import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import { settleReactWork } from "./settle-react-work";

/**
 * The frame every onboarding step sits in: Back at the top left except on the first step, the steps
 * as dashes across the top, and one button pinned to the bottom that says Next until the last step.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const STEPS = [
  { id: "one", render: () => <h1>One</h1> },
  { id: "two", render: () => <h1>Two</h1> },
  { id: "three", render: () => <h1>Three</h1> },
];

function draw(
  props: Partial<Parameters<typeof OnboardingWizard>[0]> = {},
): ReturnType<typeof render> & { finished: () => number } {
  let finished = 0;
  const view = render(
    <OnboardingWizard
      finishLabel="Start using OpenDuet"
      onFinish={() => {
        finished += 1;
      }}
      steps={STEPS}
      {...props}
    />,
  );
  return Object.assign(view, { finished: () => finished });
}

const progress = (view: ReturnType<typeof render>) =>
  view.getByRole("progressbar", { name: "Onboarding progress" });

const dashes = (view: ReturnType<typeof render>) =>
  Array.from(progress(view).querySelectorAll("span"));

/** The pinned button: the only button in the frame's footer. */
const primary = (view: ReturnType<typeof render>) => {
  const footer = view.container.querySelector("footer");
  if (!footer) throw new Error("no footer");
  const buttons = Array.from(footer.querySelectorAll("button"));
  expect(buttons).toHaveLength(1);
  return buttons[0] as HTMLButtonElement;
};

test("the first step has no Back, and the dashes say step 1", () => {
  const view = draw();

  expect(view.queryByRole("button", { name: "Back" })).toBeNull();
  expect(progress(view).getAttribute("aria-valuetext")).toBe("Step 1 of 3");
  expect(dashes(view)).toHaveLength(3);
  expect(dashes(view).map((dash) => dash.hasAttribute("data-current"))).toEqual(
    [true, false, false],
  );
});

test("Back sits in the top bar and the button is pinned below the step", () => {
  const view = draw({ initialStepId: "two" });

  const back = view.getByRole("button", { name: "Back" });
  expect(back.closest("header")).not.toBeNull();
  expect(progress(view).closest("header")).not.toBeNull();
  expect(primary(view).textContent).toBe("Next");
  // Below the step's content in document order, which is where it sits on screen.
  const heading = view.getByRole("heading", { name: "Two" });
  expect(
    heading.compareDocumentPosition(primary(view)) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  // No step here is optional, so nothing offers to skip it.
  expect(view.queryByRole("button", { name: "Not now" })).toBeNull();
});

test("Next moves on, the dashes follow, and focus lands on the new heading", async () => {
  const view = draw();

  fireEvent.click(primary(view));

  const heading = await view.findByRole("heading", { name: "Two" });
  expect(progress(view).getAttribute("aria-valuetext")).toBe("Step 2 of 3");
  expect(dashes(view).map((dash) => dash.hasAttribute("data-current"))).toEqual(
    [false, true, false],
  );
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(view.getByRole("button", { name: "Back" })).not.toBeNull();
});

test("Back returns, and hides again on the first step", async () => {
  const view = draw({ initialStepId: "two" });

  fireEvent.click(view.getByRole("button", { name: "Back" }));

  await view.findByRole("heading", { name: "One" });
  expect(progress(view).getAttribute("aria-valuetext")).toBe("Step 1 of 3");
  expect(view.queryByRole("button", { name: "Back" })).toBeNull();
});

test("the last step's button finishes, in its own words", () => {
  const view = draw({ initialStepId: "three" });

  expect(primary(view).textContent).toBe("Start using OpenDuet");
  fireEvent.click(primary(view));
  expect(view.finished()).toBe(1);
});

test("while the finish is saving, the button says so and waits", () => {
  const view = draw({ initialStepId: "three", finishing: true });

  expect(primary(view).textContent).toBe("Saving…");
  expect(primary(view).disabled).toBe(true);
});

test("a step that joins the list later does not move somebody off theirs", () => {
  const view = draw({ initialStepId: "two" });

  view.rerender(
    <OnboardingWizard
      finishLabel="Start using OpenDuet"
      onFinish={() => {}}
      steps={[
        ...STEPS.slice(0, 2),
        { id: "local", render: () => <h1>Local</h1> },
        ...STEPS.slice(2),
      ]}
    />,
  );

  expect(view.getByRole("heading", { name: "Two" })).not.toBeNull();
  expect(progress(view).getAttribute("aria-valuetext")).toBe("Step 2 of 4");
});

/** Every button in the frame's footer, top to bottom. */
const footerButtons = (view: ReturnType<typeof render>) => {
  const footer = view.container.querySelector("footer");
  if (!footer) throw new Error("no footer");
  return Array.from(footer.querySelectorAll("button"));
};

/** Two steps where the second is optional, the way Connect your apps is. */
const OPTIONAL = [
  { id: "one", render: () => <h1>One</h1> },
  {
    id: "apps",
    render: () => <h1>Connect your apps</h1>,
    primaryLabel: "Continue",
    secondary: { label: "Not now" },
    footnote: "You can connect more apps later.",
  },
  { id: "three", render: () => <h1>Three</h1> },
];

test("an optional step says its own action, with Not now under it, the same size", () => {
  const view = draw({ initialStepId: "apps", steps: OPTIONAL });

  const [continueButton, notNow] = footerButtons(view);
  expect(footerButtons(view)).toHaveLength(2);
  expect(continueButton?.textContent).toBe("Continue");
  expect(notNow?.textContent).toBe("Not now");
  // Under the primary, in the same column, and drawn the same height and shape.
  expect(continueButton?.parentElement).toBe(notNow?.parentElement ?? null);
  expect(
    continueButton &&
      notNow &&
      continueButton.compareDocumentPosition(notNow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  for (const shape of ["h-[52px]", "w-full", "rounded-full"]) {
    expect(continueButton?.className).toContain(shape);
    expect(notNow?.className).toContain(shape);
  }
});

test("the footnote sits just above the primary", () => {
  const view = draw({ initialStepId: "apps", steps: OPTIONAL });

  const footnote = view.getByText("You can connect more apps later.");
  expect(footnote.closest("footer")).not.toBeNull();
  const [continueButton] = footerButtons(view);
  expect(
    continueButton &&
      footnote.compareDocumentPosition(continueButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("Continue and Not now both move on", async () => {
  const continued = draw({ initialStepId: "apps", steps: OPTIONAL });
  fireEvent.click(continued.getByRole("button", { name: "Continue" }));
  expect(await continued.findByRole("heading", { name: "Three" })).toBeTruthy();
  cleanup();

  const skipped = draw({ initialStepId: "apps", steps: OPTIONAL });
  fireEvent.click(skipped.getByRole("button", { name: "Not now" }));
  expect(await skipped.findByRole("heading", { name: "Three" })).toBeTruthy();
});

test("a step's own action decides when to move on", async () => {
  let handed: (() => void) | null = null;
  const view = draw({
    initialStepId: "apps",
    steps: [
      OPTIONAL[0],
      {
        ...OPTIONAL[1],
        primaryLabel: "Turn on notifications",
        onPrimary: (next: () => void) => {
          handed = next;
        },
      },
      OPTIONAL[2],
    ] as never,
  });

  fireEvent.click(view.getByRole("button", { name: "Turn on notifications" }));
  // Nothing moved: the step holds the move until its own action is done.
  expect(view.getByRole("heading", { name: "Connect your apps" })).toBeTruthy();
  (handed as unknown as () => void)();
  expect(await view.findByRole("heading", { name: "Three" })).toBeTruthy();
});

test("a move handed out on one step does nothing once somebody has left it", async () => {
  let handed: (() => void) | null = null;
  const steps = [
    OPTIONAL[0],
    {
      ...OPTIONAL[1],
      onPrimary: (next: () => void) => {
        handed = next;
      },
    },
    OPTIONAL[2],
  ] as never;
  const view = draw({ initialStepId: "apps", steps });

  fireEvent.click(view.getByRole("button", { name: "Continue" }));
  fireEvent.click(view.getByRole("button", { name: "Back" }));
  await view.findByRole("heading", { name: "One" });
  (handed as unknown as () => void)();
  await settleReactWork();
  expect(view.getByRole("heading", { name: "One" })).toBeTruthy();
});

test("a done primary reads green with a check", () => {
  const view = draw({
    initialStepId: "apps",
    steps: [
      OPTIONAL[0],
      {
        id: "apps",
        render: () => <h1>Get notified</h1>,
        primaryLabel: "Notifications on",
        primaryDone: true,
      },
      OPTIONAL[2],
    ],
  });

  const [done] = footerButtons(view);
  expect(footerButtons(view)).toHaveLength(1);
  expect(done?.textContent).toBe("Notifications on");
  expect(done?.hasAttribute("data-done")).toBe(true);
  expect(done?.className).toContain("bg-duet-green-soft");
});

test("an optional step keeps Not now's place when it goes, so the primary doesn't drop", () => {
  const view = draw({
    initialStepId: "apps",
    steps: [
      OPTIONAL[0],
      {
        id: "apps",
        render: () => <h1>Get notified</h1>,
        primaryLabel: "Notifications on",
        primaryDone: true,
        optional: true,
      },
      OPTIONAL[2],
    ],
  });

  expect(footerButtons(view)).toHaveLength(1);
  const slot = view.container.querySelector(
    "footer [data-onboarding-secondary-slot]",
  );
  expect(slot?.className).toContain("h-[52px]");
  expect(slot?.getAttribute("aria-hidden")).toBe("true");
});

test("a waiting primary shows a spinner, says it is busy, and can't be pressed again", () => {
  const view = draw({
    initialStepId: "apps",
    steps: [
      OPTIONAL[0],
      {
        id: "apps",
        render: () => <h1>Get notified</h1>,
        primaryLabel: "Turn on notifications",
        primaryPending: true,
        secondary: { label: "Not now" },
      },
      OPTIONAL[2],
    ],
  });

  const [waiting] = footerButtons(view);
  expect(waiting?.getAttribute("aria-busy")).toBe("true");
  expect(waiting?.disabled).toBe(true);
  expect(waiting?.querySelector(".animate-spin")).not.toBeNull();
});

test("held by its caller, it asks to move and draws whatever step it is handed", async () => {
  const asked: Array<[string, string]> = [];
  const steps = OPTIONAL.map((step) => ({ ...step }));
  const view = render(
    <OnboardingWizard
      finishLabel="Start using OpenDuet"
      onFinish={() => {}}
      onMove={(to, way) => asked.push([to, way])}
      stepId="apps"
      steps={steps}
    />,
  );

  fireEvent.click(view.getByRole("button", { name: "Continue" }));
  fireEvent.click(view.getByRole("button", { name: "Back" }));
  expect(asked).toEqual([
    ["three", "forward"],
    ["one", "back"],
  ]);
  // Nothing moved until the caller said so.
  expect(view.getByRole("heading", { name: "Connect your apps" })).toBeTruthy();

  view.rerender(
    <OnboardingWizard
      finishLabel="Start using OpenDuet"
      onFinish={() => {}}
      onMove={(to, way) => asked.push([to, way])}
      stepId="one"
      steps={steps}
    />,
  );
  const heading = await view.findByRole("heading", { name: "One" });
  await waitFor(() => expect(document.activeElement).toBe(heading));
});
