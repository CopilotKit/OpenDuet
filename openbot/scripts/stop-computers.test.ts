import { afterAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `stop.sh` REMOVES THIS DEPLOYMENT'S BOT COMPUTERS AND NOBODY ELSE'S.
 *
 * It used to remove every container on the Docker host labelled `openbot.supervisor=true`, which is
 * every computer any OpenBot supervisor there made, so stopping one install took the signed-in
 * browsers of every other. Each computer also carries its deployment's `COMPUTER_NAMESPACE` in
 * `openbot.namespace`, and one made before that label existed counts as the default, `openbot`,
 * exactly as the supervisor reads it.
 *
 * Docker is faked: `ps` prints the rows below, `rm` is only recorded, so nothing here can touch a
 * real container.
 */

// What `docker ps --format '{{.ID}} {{.Label "openbot.namespace"}}'` prints. `old` has no label.
const ROWS = [
  "mine1 openbot",
  "old1 ",
  "other1 second-install",
  "mine2 openbot",
];

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true })),
  );
});

async function run(options: { env?: string; args?: string[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-stop-computers-"));
  directories.push(directory);
  const scripts = join(directory, "scripts");
  const fakeBin = join(directory, "bin");
  await mkdir(scripts);
  await mkdir(fakeBin);
  for (const name of ["stop.sh", "require-bash.sh", "processes.sh"]) {
    await writeFile(join(scripts, name), await readFile(`scripts/${name}`));
  }
  if (options.env !== undefined) {
    await writeFile(join(directory, ".env"), options.env);
  }
  const dockerLog = join(directory, "docker.log");
  const fake = async (name: string, body: string) => {
    await writeFile(join(fakeBin, name), `#!/usr/bin/env bash\n${body}\n`);
    await chmod(join(fakeBin, name), 0o755);
  };
  await fake(
    "docker",
    `printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "$1" = ps ]; then printf '%s\\n' ${ROWS.map((row) => `'${row}'`).join(" ")}; fi`,
  );
  // Nothing listens on the ports below, and no worker runs.
  await fake("lsof", "exit 0");
  await fake("pgrep", "exit 1");

  const child = Bun.spawn(
    ["bash", "scripts/stop.sh", ...(options.args ?? [])],
    {
      cwd: directory,
      env: {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        DOCKER_LOG: dockerLog,
        OS: "",
        // Unused ports, so no real process is ever a candidate.
        APP_PORT: "39910",
        SERVER_PORT: "39911",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  const log = await readFile(dockerLog, "utf8").catch(() => "");
  const removed = log
    .split("\n")
    .filter((line) => line.startsWith("rm "))
    .join("\n");
  return { exitCode, stdout, removed };
}

describe("stop.sh Bot computers", () => {
  test("by default removes the default namespace, including a computer with no label", async () => {
    const result = await run();
    expect(result.exitCode).toBe(0);
    expect(result.removed).toBe("rm -f mine1 old1 mine2");
    expect(result.stdout).toContain("Bot computers: removed (3)");
  });

  test("COMPUTER_NAMESPACE in .env picks that install's computers and no others", async () => {
    const result = await run({ env: "COMPUTER_NAMESPACE=second-install\n" });
    expect(result.exitCode).toBe(0);
    expect(result.removed).toBe("rm -f other1");
  });

  test("a namespace with no computers removes nothing", async () => {
    const result = await run({ env: "COMPUTER_NAMESPACE=nobody\n" });
    expect(result.exitCode).toBe(0);
    expect(result.removed).toBe("");
    expect(result.stdout).toContain("none running for namespace nobody");
  });

  test("--keep-computers removes nothing", async () => {
    const result = await run({ args: ["--keep-computers"] });
    expect(result.exitCode).toBe(0);
    expect(result.removed).toBe("");
    expect(result.stdout).toContain("left running (3)");
  });
});
