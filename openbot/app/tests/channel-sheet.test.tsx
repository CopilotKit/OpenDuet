import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ChannelSheet,
  channelDraftReady,
  NEW_CHANNEL_LOOK,
  PURPOSE_QUESTION,
} from "@/components/shell/channel-sheet";
import type { DuetChannel } from "@/lib/duet-channels/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * New channel: Cancel, the title and Create along the top; a big preview of the channel's icon in
 * its colour that changes the moment a person taps; Change icon with three rows of eight line icons,
 * stroked in the chosen colour, and nine dots; then a name and an optional purpose. The same sheet
 * edits a channel, with Archive at its foot.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const kiln: DuetChannel = {
  id: "c-kiln",
  name: "Kiln move",
  purpose: "Moving the studio's kiln to the new space by March.",
  icon: "home",
  colour: "green",
  dressed: true,
  archivedAt: null,
  agentIds: ["openduet"],
  lastMessageAt: null,
  createdAt: "2026-10-22T09:00:00Z",
};

const sent: { method: string; path: string; body: unknown }[] = [];
function serving(answer: (path: string, body: unknown) => Response) {
  sent.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method: init?.method ?? "GET", path, body });
    return answer(path, body);
  }) as unknown as typeof fetch;
}

function draw(props: Partial<Parameters<typeof ChannelSheet>[0]> = {}) {
  const saved: DuetChannel[] = [];
  const archived: DuetChannel[] = [];
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ChannelSheet
        botId="openduet"
        onArchived={(channel) => archived.push(channel)}
        onClose={() => {}}
        onSaved={(channel) => saved.push(channel)}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { view, saved, archived };
}

const preview = (dialog: HTMLElement) =>
  dialog.querySelector('[data-testid="channel-preview"] [data-channel-icon]');

test("a name is needed and a purpose is not, each within its length", () => {
  expect(channelDraftReady({ name: "Kiln move", purpose: "By March." })).toBe(
    true,
  );
  expect(channelDraftReady({ name: "Kiln move", purpose: " " })).toBe(true);
  expect(channelDraftReady({ name: "  ", purpose: "By March." })).toBe(false);
  expect(
    channelDraftReady({ name: "x".repeat(41), purpose: "By March." }),
  ).toBe(false);
  expect(
    channelDraftReady({ name: "Kiln move", purpose: "x".repeat(501) }),
  ).toBe(false);
});

test("the preview follows every icon and colour tapped, live", async () => {
  serving(() => Response.json({}));
  const user = userEvent.setup({ document });
  const { view } = draw();
  const dialog = await view.findByRole("dialog", { name: "New channel" });
  expect(preview(dialog)?.getAttribute("data-channel-icon")).toBe(
    NEW_CHANNEL_LOOK.icon,
  );
  expect(preview(dialog)?.getAttribute("data-channel-colour")).toBe(
    NEW_CHANNEL_LOOK.colour,
  );

  // The grid and the dots are folded under Change icon until it is pressed.
  const change = within(dialog).getByRole("button", { name: "Change icon" });
  expect(change.getAttribute("aria-expanded")).toBe("false");
  await user.click(change);
  expect(change.getAttribute("aria-expanded")).toBe("true");
  const icons = within(dialog).getByRole("group", { name: "Icon" });
  const colours = within(dialog).getByRole("group", { name: "Colour" });
  expect(within(icons).getAllByRole("radio")).toHaveLength(24);
  expect(within(colours).getAllByRole("radio")).toHaveLength(9);

  await user.click(within(icons).getByRole("radio", { name: "Home" }));
  expect(preview(dialog)?.getAttribute("data-channel-icon")).toBe("home");
  expect(
    (within(icons).getByRole("radio", { name: "Home" }) as HTMLInputElement)
      .checked,
  ).toBe(true);

  await user.click(within(colours).getByRole("radio", { name: "Green" }));
  expect(preview(dialog)?.getAttribute("data-channel-colour")).toBe("green");
  expect(preview(dialog)?.getAttribute("data-channel-icon")).toBe("home");
  // Every glyph in the grid is stroked in the chosen colour, so the grid recolours with it.
  for (const cell of within(icons).getAllByRole("radio"))
    expect((cell.closest("label") as HTMLElement).style.color).toBe(
      "var(--duet-ch-green)",
    );
  // Nothing was sent: the preview is the sheet's own.
  expect(sent).toEqual([]);
});

test("Create waits for a name, then makes the channel with its look and purpose", async () => {
  serving((path) =>
    path === "/api/openduet/channels"
      ? Response.json({ channel: kiln }, { status: 201 })
      : Response.json({}),
  );
  const user = userEvent.setup({ document });
  const { view, saved } = draw();
  const dialog = await view.findByRole("dialog", { name: "New channel" });
  // Cancel, the title and Create along the top.
  expect(
    within(dialog)
      .getAllByRole("button")
      .slice(0, 2)
      .map((button) => button.textContent),
  ).toEqual(["Cancel", "Create"]);
  const create = within(dialog).getByRole("button", { name: "Create" });
  expect((create as HTMLButtonElement).disabled).toBe(true);
  expect(
    (within(dialog).getByLabelText("Name") as HTMLInputElement).placeholder,
  ).toBe("Q4 planning");
  expect(
    (within(dialog).getByLabelText("Purpose") as HTMLTextAreaElement)
      .placeholder,
  ).toBe(PURPOSE_QUESTION);

  await user.type(within(dialog).getByLabelText("Name"), "   ");
  expect((create as HTMLButtonElement).disabled).toBe(true);
  await user.clear(within(dialog).getByLabelText("Name"));
  await user.type(within(dialog).getByLabelText("Name"), "  Kiln move ");
  // A name alone is enough.
  expect((create as HTMLButtonElement).disabled).toBe(false);
  // Return in the name moves on to the purpose rather than creating it.
  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(within(dialog).getByLabelText("Purpose"));
  expect(sent).toEqual([]);
  await user.type(
    within(dialog).getByLabelText("Purpose"),
    "Moving the studio's kiln to the new space by March.",
  );

  await user.click(within(dialog).getByRole("button", { name: "Change icon" }));
  await user.click(within(dialog).getByRole("radio", { name: "Home" }));
  await user.click(within(dialog).getByRole("radio", { name: "Green" }));
  await user.click(create);

  await waitFor(() => expect(saved).toEqual([kiln]));
  expect(sent).toEqual([
    {
      method: "POST",
      path: "/api/openduet/channels",
      body: {
        botId: "openduet",
        name: "Kiln move",
        purpose: "Moving the studio's kiln to the new space by March.",
        icon: "home",
        colour: "green",
      },
    },
  ]);
});

test("a refusal from the server is said in the sheet, and the draft stays", async () => {
  serving(() =>
    Response.json(
      { error: "Give the channel a name, in at most 40 characters." },
      { status: 400 },
    ),
  );
  const user = userEvent.setup({ document });
  const { view, saved } = draw();
  const dialog = await view.findByRole("dialog", { name: "New channel" });
  await user.type(within(dialog).getByLabelText("Name"), "Kiln move");
  await user.type(within(dialog).getByLabelText("Purpose"), "Moving the kiln.");
  await user.click(within(dialog).getByRole("button", { name: "Create" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "Give the channel a name, in at most 40 characters.",
  );
  expect(saved).toEqual([]);
  expect(
    (within(dialog).getByLabelText("Name") as HTMLInputElement).value,
  ).toBe("Kiln move");
});

test("editing a channel starts from it, saves only what changed, and can archive it", async () => {
  serving((path, body) => {
    if (path === "/api/openduet/channels/c-kiln")
      return Response.json({ channel: { ...kiln, ...(body as object) } });
    if (path === "/api/openduet/channels/c-kiln/archive")
      return Response.json({
        channel: { ...kiln, archivedAt: "2026-10-22T10:00:00Z" },
      });
    return Response.json({});
  });
  const user = userEvent.setup({ document });
  const { view, saved, archived } = draw({ channel: kiln });
  const dialog = await view.findByRole("dialog", { name: "Edit channel" });
  expect(preview(dialog)?.getAttribute("data-channel-icon")).toBe("home");
  expect(
    (within(dialog).getByLabelText("Name") as HTMLInputElement).value,
  ).toBe("Kiln move");

  await user.click(within(dialog).getByRole("button", { name: "Change icon" }));
  await user.click(within(dialog).getByRole("radio", { name: "Berry" }));
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  // Saved, the sheet sinks away first, and the screen hears of it once it has gone.
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(sent[0]).toEqual({
    method: "PATCH",
    path: "/api/openduet/channels/c-kiln",
    body: { colour: "berry" },
  });
  cleanup();

  const again = draw({ channel: kiln });
  const reopened = await again.view.findByRole("dialog", {
    name: "Edit channel",
  });
  await user.click(
    within(reopened).getByRole("button", { name: "Archive channel" }),
  );
  await waitFor(() => expect(again.archived).toHaveLength(1));
  expect(archived).toHaveLength(0);
  expect(sent.at(-1)).toMatchObject({
    method: "POST",
    path: "/api/openduet/channels/c-kiln/archive",
  });
});

describe("Escape closes only the innermost thing, and never drops what was typed", () => {
  test("with the icon picker open, Escape folds the picker and keeps the sheet and its fields", async () => {
    serving(() => Response.json({}));
    const user = userEvent.setup({ document });
    let closed = 0;
    const { view } = draw({ onClose: () => closed++ });
    const dialog = await view.findByRole("dialog", { name: "New channel" });
    await user.type(within(dialog).getByLabelText("Name"), "Kiln move");
    const change = within(dialog).getByRole("button", { name: "Change icon" });
    await user.click(change);
    await user.click(
      within(within(dialog).getByRole("group", { name: "Icon" })).getByRole(
        "radio",
        { name: "Home" },
      ),
    );

    await user.keyboard("{Escape}");

    expect(closed).toBe(0);
    expect(change.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(change);
    expect(
      (within(dialog).getByLabelText("Name") as HTMLInputElement).value,
    ).toBe("Kiln move");
    expect(preview(dialog)?.getAttribute("data-channel-icon")).toBe("home");
  });

  test("with something typed, Escape asks first; Keep editing keeps it, Discard closes", async () => {
    serving(() => Response.json({}));
    const user = userEvent.setup({ document });
    let closed = 0;
    const { view } = draw({ onClose: () => closed++ });
    const dialog = await view.findByRole("dialog", { name: "New channel" });
    await user.type(
      within(dialog).getByLabelText("Purpose"),
      "Moving the kiln by March.",
    );

    await user.keyboard("{Escape}");
    expect(closed).toBe(0);
    expect(within(dialog).getByText("Discard this channel?")).toBeTruthy();
    // Keep editing is focused, so a second Escape or a Return keeps the draft.
    const keep = within(dialog).getByRole("button", { name: "Keep editing" });
    expect(document.activeElement).toBe(keep);

    await user.keyboard("{Escape}");
    expect(closed).toBe(0);
    expect(within(dialog).queryByText("Discard this channel?")).toBeNull();
    expect(
      (within(dialog).getByLabelText("Purpose") as HTMLTextAreaElement).value,
    ).toBe("Moving the kiln by March.");

    await user.keyboard("{Escape}");
    await user.click(within(dialog).getByRole("button", { name: "Discard" }));
    expect(closed).toBe(1);
  });

  test("with nothing typed, Escape simply closes", async () => {
    serving(() => Response.json({}));
    const user = userEvent.setup({ document });
    let closed = 0;
    const { view } = draw({ onClose: () => closed++ });
    await view.findByRole("dialog", { name: "New channel" });

    await user.keyboard("{Escape}");
    expect(closed).toBe(1);
  });

  test("editing asks about changes only once something differs", async () => {
    serving(() => Response.json({}));
    const user = userEvent.setup({ document });
    let closed = 0;
    const { view } = draw({ channel: kiln, onClose: () => closed++ });
    const dialog = await view.findByRole("dialog", { name: "Edit channel" });

    await user.click(within(dialog).getByLabelText("Name"));
    await user.keyboard("{Escape}");
    expect(closed).toBe(1);

    cleanup();
    const again = draw({ channel: kiln, onClose: () => closed++ });
    const edited = await again.view.findByRole("dialog", {
      name: "Edit channel",
    });
    await user.type(within(edited).getByLabelText("Name"), " soon");
    await user.keyboard("{Escape}");
    expect(within(edited).getByText("Discard your changes?")).toBeTruthy();
    expect(closed).toBe(1);
  });
});
