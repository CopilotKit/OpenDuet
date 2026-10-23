import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { DuetIcon } from "@/components/duet/icons";
import {
  Row,
  STATUS_WORDS,
  Segmented,
  StatusLine,
} from "@/components/duet/kit";
import { settleReactWork } from "./settle-react-work";

/**
 * The shared pieces every screen is drawn from (parity-spec Part 2): the list row, the status line
 * and the segmented control.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

describe("Row", () => {
  test("a row that does something is one button holding its title, its line and its status", () => {
    let pressed = 0;
    const view = render(
      <Row
        detail={<StatusLine status="working">Reading your mail</StatusLine>}
        leading={<DuetIcon name="mail" />}
        onClick={() => pressed++}
        title="Reply to Priya about the VAT return"
        trailing="2"
      />,
    );
    const row = view.getByRole("button");
    expect(row.textContent).toContain("Reply to Priya about the VAT return");
    expect(row.textContent).toContain("Working");
    expect(row.textContent).toContain("Reading your mail");
    fireEvent.click(row);
    expect(pressed).toBe(1);
    // Tall enough for a finger whatever it holds, and it answers a press.
    expect(row.className).toContain("min-h-[66px]");
    expect(row.className).toContain("active:bg-duet-tile");
  });

  test("a row that goes somewhere is drawn as the link the caller builds, with a chevron", () => {
    const view = render(
      <Row
        chevron
        link={({ className, children }) => (
          <a className={className} href="/connections">
            {children}
          </a>
        )}
        size="nav"
        title="Connections"
      />,
    );
    const link = view.getByRole("link", { name: "Connections" });
    expect(link.getAttribute("href")).toBe("/connections");
    expect(link.querySelector("svg")).toBeTruthy();
    expect(link.querySelector(".type-nav")).toBeTruthy();
    expect(link.className).toContain("min-h-[50px]");
  });

  test("a row that only states something is not a control, and never a white card", () => {
    const view = render(<Row title="Gmail" trailing="Connected" />);
    expect(view.queryByRole("button")).toBeNull();
    expect(view.queryByRole("link")).toBeNull();
    const row = view.container.firstElementChild as HTMLElement;
    expect(row.className).not.toContain("bg-duet-card");
    expect(row.className).not.toContain("shadow");
  });

  test("the current row sits on the filled capsule", () => {
    const view = render(<Row current title="Everything" />);
    expect(
      (view.container.firstElementChild as HTMLElement).className,
    ).toContain("bg-duet-tile");
  });
});

describe("StatusLine", () => {
  test("names the four states as Duet does", () => {
    expect(STATUS_WORDS).toEqual({
      done: "Ready for review",
      needs: "Needs input",
      working: "Working",
      problem: "Couldn't finish",
    });
  });

  test("colours the word with its status, and only the word", () => {
    const view = render(<StatusLine status="needs">Which deck?</StatusLine>);
    const word = view.getByText("Needs input");
    expect(word.className).toContain("text-duet-status-needs");
    expect(view.getByText("Which deck?").className).not.toContain(
      "text-duet-status",
    );
  });
});

describe("Segmented", () => {
  const OPTIONS = [
    { value: "system", label: "Match phone" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ] as const;

  function Appearance() {
    const [value, setValue] = useState<"system" | "light" | "dark">("system");
    return (
      <Segmented
        label="Appearance"
        onChange={setValue}
        options={OPTIONS}
        value={value}
      />
    );
  }

  test("is a radio group of three, the chosen one checked", () => {
    const view = render(<Appearance />);
    expect(view.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();
    const radios = view.getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent)).toEqual([
      "Match phone",
      "Light",
      "Dark",
    ]);
    expect(radios[0]?.getAttribute("aria-checked")).toBe("true");
    // Each is a 44px target.
    for (const radio of radios) expect(radio.className).toContain("min-h-11");
  });

  test("a tap or an arrow key moves the choice", () => {
    const view = render(<Appearance />);
    fireEvent.click(view.getByRole("radio", { name: "Dark" }));
    expect(
      view.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.keyDown(view.getByRole("radio", { name: "Dark" }), {
      key: "ArrowRight",
    });
    expect(
      view
        .getByRole("radio", { name: "Match phone" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});
