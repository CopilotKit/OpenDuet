import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { FIRST_DAY_REQUEST, FirstDay } from "@/components/shell/first-day";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

describe("Chat's first day", () => {
  test("offers to start by getting to know the person, named after the Bot", () => {
    const view = render(
      <FirstDay busy={false} name="OpenDuet" onStart={() => {}} />,
    );
    expect(
      view.getByRole("heading", { name: "Let's get to know each other" }),
    ).toBeTruthy();
    expect(view.getByText(/OpenDuet reads your connected mail/)).toBeTruthy();
    expect(view.getByText("Or ask anything below.")).toBeTruthy();
  });

  test("Get to know me starts it, and waits while the conversation is being made", () => {
    const onStart = mock(() => {});
    const view = render(
      <FirstDay busy={false} name="OpenDuet" onStart={onStart} />,
    );
    fireEvent.click(view.getByRole("button", { name: "Get to know me" }));
    expect(onStart).toHaveBeenCalledTimes(1);

    view.rerender(<FirstDay busy name="OpenDuet" onStart={onStart} />);
    const button = view.getByRole("button", {
      name: "Get to know me",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  test("what it sends asks for mail and calendar, and invites a correction", () => {
    expect(FIRST_DAY_REQUEST).toMatch(/^Get to know me\./);
    expect(FIRST_DAY_REQUEST).toContain("mail");
    expect(FIRST_DAY_REQUEST).toContain("calendar");
    expect(FIRST_DAY_REQUEST).toContain("three ways");
    expect(FIRST_DAY_REQUEST).toContain("correct");
  });
});
