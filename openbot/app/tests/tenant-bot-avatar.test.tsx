import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import {
  AbstractAvatar,
  orbColourFor,
} from "@/components/agents/abstract-avatar";
import { ChannelAvatar } from "@/components/channels/avatar";
import { isTenantBot } from "@/lib/agents/primary-bot";
import { appConfig } from "@/lib/generated/application-config";
import {
  createApplicationConfiguration,
  loadTenantPackage,
} from "../../server/src/tenant-package";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

const OPENDUET = join(import.meta.dir, "../../examples/openduet");
const own = appConfig.brand.tenantId;

/** A copy of OpenDuet's tenant package with every YAML file passed through `rename`. */
async function renamedPackage(rename: (text: string) => string) {
  const directory = await mkdtemp(join(tmpdir(), "openduet-renamed-"));
  await cp(OPENDUET, directory, { recursive: true });
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".yaml")) continue;
    const path = join(directory, file);
    await writeFile(path, rename(await readFile(path, "utf8")));
  }
  return directory;
}

/** The ids of a package's Bots that the app built from it would draw as the mic orb. */
async function orbBots(directory: string) {
  const tenantPackage = await loadTenantPackage(directory);
  const { brand } = createApplicationConfiguration(tenantPackage);
  return tenantPackage.agents
    .filter((agent) => isTenantBot(agent.id, brand.tenantId))
    .map((agent) => agent.id);
}

describe("the tenant's own Bot", () => {
  test("is the Bot that shares the tenant's id, and no other", () => {
    expect(isTenantBot(own)).toBe(true);
    expect(isTenantBot("your-agent")).toBe(false);
    expect(isTenantBot("acme", "acme")).toBe(true);
    expect(isTenantBot(own, "acme")).toBe(false);
  });

  test("is declared by OpenDuet's package, once", async () => {
    expect(await orbBots(OPENDUET)).toEqual(["openduet"]);
  });

  test.each([
    [
      "its product name",
      (text: string) =>
        text.replace("product_name: OpenDuet", "product_name: Acme"),
      ["openduet"],
    ],
    [
      "its tenant and its Bot, everywhere the package says OpenDuet",
      (text: string) =>
        text.replaceAll("openduet", "acme").replaceAll("OpenDuet", "Acme"),
      ["acme"],
    ],
    // The tenant renamed without its Bot puts the orb on no Bot, rather than on some other one.
    [
      "its tenant alone",
      (text: string) =>
        text.replace("tenant:\n  id: openduet", "tenant:\n  id: acme"),
      [],
    ],
  ])(
    "is found again when a template renames %s",
    async (_name, rename, expected) => {
      const directory = await renamedPackage(rename);
      try {
        expect(await orbBots(directory)).toEqual(expected);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

const drawings = (element: Element) => ({
  orbs: element.querySelectorAll("canvas").length,
  discs: element.querySelectorAll("svg").length,
});

/** The orb colours drawn, in order: Ocean is the tenant's own Bot's, the rest another Bot's. */
const colours = (element: Element) =>
  Array.from(element.querySelectorAll("[data-colour]"), (orb) =>
    orb.getAttribute("data-colour"),
  );

describe("<AbstractAvatar>", () => {
  test("draws the tenant's own Bot as the mic orb, its glow unclipped", () => {
    const view = render(
      <AbstractAvatar id={own} name="OpenDuet" seed="anything" size={28} />,
    );
    const avatar = view.getByRole("img", { name: "OpenDuet" });
    expect(drawings(avatar)).toEqual({ orbs: 1, discs: 0 });
    expect(avatar.className).not.toContain("overflow-hidden");
    expect(avatar.style.width).toBe("28px");
  });

  test("draws every other Bot as the orb in another of its colours, even one seeded like the tenant's", () => {
    const view = render(
      <AbstractAvatar id="helper" name="Helper" seed={own} size={28} />,
    );
    const avatar = view.getByRole("img", { name: "Helper" });
    expect(drawings(avatar)).toEqual({ orbs: 1, discs: 0 });
    expect(colours(avatar)).toEqual([orbColourFor("helper")]);
    expect(colours(avatar)).not.toContain("ocean");
  });

  test("gives a Bot the same colour every time, and never Ocean", () => {
    for (const id of ["helper", "support-desk", "your-agent", "a", ""]) {
      expect(orbColourFor(id)).toBe(orbColourFor(id));
      expect(["ember", "lime", "graphite"]).toContain(orbColourFor(id));
    }
  });
});

describe("<ChannelAvatar>", () => {
  test("draws a conversation with the tenant's own Bot as the mic orb", () => {
    const view = render(<ChannelAvatar participantIds={[own]} />);
    expect(drawings(view.container)).toEqual({ orbs: 1, discs: 0 });
  });

  test("draws a conversation with another Bot as the orb in that Bot's colour", () => {
    const view = render(<ChannelAvatar participantIds={["helper"]} />);
    expect(drawings(view.container)).toEqual({ orbs: 1, discs: 0 });
    expect(colours(view.container)).toEqual([orbColourFor("helper")]);
  });

  test("draws the tenant's own Bot in Ocean among a group's faces, the others in theirs", () => {
    const view = render(
      <ChannelAvatar participantIds={["helper", own, "another"]} />,
    );
    expect(drawings(view.container)).toEqual({ orbs: 3, discs: 0 });
    expect(colours(view.container)).toEqual([
      orbColourFor("helper"),
      "ocean",
      orbColourFor("another"),
    ]);
  });
});
