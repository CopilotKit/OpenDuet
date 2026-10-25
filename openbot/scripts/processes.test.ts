import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * `scripts/processes.sh` on a Windows host that has no `lsof`, `pgrep` or `pkill`, run anywhere.
 *
 * PATH holds only the fakes below and `tr`, so a Linux machine with the real tools installed still
 * takes the Windows path, and the fake `powershell.exe` records what it was asked. It answers with
 * CRLF line endings, as the real one does. The fakes are `#!/bin/sh` because a `#!` line cannot hold
 * the space in Windows' `C:\Program Files\Git\...\bash.exe`.
 */

const processesScript = resolve("scripts/processes.sh");
const bash = Bun.which("bash") as string;
const realTr = Bun.which("tr") as string;

let directory: string;
let bin: string;
let log: string;

async function writeExecutable(path: string, contents: string) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openbot-processes-"));
  bin = join(directory, "bin");
  log = join(directory, "calls.log");
  await Bun.$`mkdir -p ${bin}`;
  await writeExecutable(join(bin, "tr"), `#!/bin/sh\nexec "${realTr}" "$@"\n`);
  await writeExecutable(
    join(bin, "powershell.exe"),
    `#!/bin/sh
printf 'argv=%s|port=%s|pattern=%s|stop=%s|pids=%s|cwd=%s\\n' "$*" "\${OPENBOT_PORT:-}" "\${OPENBOT_PATTERN:-}" "\${OPENBOT_ACTION:-}" "\${OPENBOT_PIDS:-}" "\${OPENBOT_CWD:-}" >> "$CALLS"
case "$*" in
  *ProcessName*) printf 'bun (127.0.0.1:%s)\\r\\n' "$OPENBOT_PORT" ;;
  *-Unique*|*Win32_Process*) printf '4242\\r\\n' ;;
esac
`,
  );
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

// `OS` is always passed: Git Bash restores `OS=Windows_NT` from Windows when it is merely left out.
async function run(expression: string, os = "Windows_NT") {
  const child = Bun.spawn({
    cmd: [bash, "-c", `. "${processesScript}"; ${expression}`],
    env: { PATH: bin, CALLS: log, OS: os, OWN: directory },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  const calls = await Bun.file(log)
    .text()
    .catch(() => "");
  return { exitCode, stdout, calls };
}

describe("processes.sh on Windows without lsof, pgrep or pkill", () => {
  test("holder names the listener, with the port in the environment and no CR", async () => {
    const result = await run('printf "[%s]" "$(holder 3001)"');

    expect(result.stdout).toBe("[bun (127.0.0.1:3001)]");
    expect(result.calls).toContain("|port=3001|");
    expect(result.calls).not.toContain("argv=3001");
  });

  test("port_pids and kill_pids hand Windows ids to PowerShell", async () => {
    const result = await run('kill_pids -9 $(port_pids 3001); echo "exit=$?"');

    expect(result.stdout).toBe("exit=0\n");
    expect(result.calls).toContain("|pids=-9 4242");
  });

  test("running finds the worker without its pattern on PowerShell's command line", async () => {
    const result = await run(
      'running "bun worker/src/index.ts" "$OWN" && echo yes || echo no',
    );

    expect(result.stdout).toBe("yes\n");
    expect(result.calls).toContain("|pattern=bun worker/src/index.ts|stop=|");
    expect(result.calls).toContain(`|cwd=${await realpath(directory)}`);
    expect(result.calls.split("|port=")[0]).not.toContain(
      "worker/src/index.ts",
    );
  });

  test("stop_matching asks PowerShell to stop what matches", async () => {
    const result = await run(
      'stop_matching "bun --env-file=../.env src/production-entry.ts" "$OWN"; echo "exit=$?"',
    );

    expect(result.stdout).toBe("exit=0\n");
    expect(result.calls).toContain(
      "|pattern=bun --env-file=../.env src/production-entry.ts|stop=stop|",
    );
  });
});

describe("processes.sh where the POSIX tools are the answer", () => {
  test("Windows keeps lsof for ports but always uses scoped CIM matching", async () => {
    for (const tool of ["lsof", "pgrep", "pkill"]) {
      await writeExecutable(
        join(bin, tool),
        `#!/bin/sh\nprintf '%s %s\\n' "${tool}" "$*" >> "$CALLS"\n`,
      );
    }

    const result = await run(
      'holder 3001; running "bun worker/src/index.ts" "$OWN"; stop_matching "bun worker/src/index.ts" "$OWN"',
    );

    expect(result.calls).toContain("Win32_Process");
    expect(result.calls).toContain("lsof -nP -iTCP:3001 -sTCP:LISTEN -Fcn");
    expect(result.calls).not.toContain("pgrep -f");
    expect(result.calls).not.toContain("pkill -f");
  });

  test("off Windows, a missing lsof is still an empty answer, as before", async () => {
    const result = await run('printf "[%s]" "$(holder 3001)"', "");

    expect(result.stdout).toBe("[]");
    expect(result.calls).toBe("");
  });
});

// Fake OS process tables: no real pgrep, ps, lsof, pkill or kill can touch a user stack.
describe("deployment process ownership", () => {
  async function fixture() {
    const deployment = join(directory, "deployment [one]");
    const other = join(directory, "deployment two");
    await mkdir(deployment);
    await mkdir(other);
    const own = await realpath(deployment);
    const elsewhere = await realpath(other);
    await writeExecutable(
      join(bin, "pgrep"),
      `#!/bin/sh
printf '%s\\n' 91000001 91000002 91000003 91000004 91000005 91000006
`,
    );
    await writeExecutable(
      join(bin, "ps"),
      `#!/bin/sh
case "$4" in
  comm=) case "$2" in 91000005) echo /bin/bash ;; *) echo /opt/bun ;; esac ;;
  args=)
    case "$2" in
      91000001)
        if [ "$ABSOLUTE" = 1 ]; then
          printf '/opt/bun --env-file=../.env %s/src/production-entry.ts\\n' "$OWN"
        else
          echo 'bun --env-file=../.env src/production-entry.ts'
        fi ;;
      91000002) echo 'bun --env-file=../.env src/production-entry.ts' ;;
      91000003) echo 'bun --env-file=../.env src/index.ts' ;;
      91000004)
        if [ "$ABSOLUTE" = 1 ]; then
          printf '/opt/bun %s/worker/src/index.ts\\n' "$OWN"
        else
          echo 'bun worker/src/index.ts'
        fi ;;
      91000005) echo 'bash -c bun --env-file=../.env src/production-entry.ts' ;;
      91000006) echo 'bun worker/src/index.ts --unrelated' ;;
    esac ;;
esac
`,
    );
    await writeExecutable(
      join(bin, "lsof"),
      `#!/bin/sh
if [ "$CHANGING_CWD" = 1 ] && [ "$3" = 91000001 ]; then
  if [ -f "$SEEN" ]; then printf 'n%s\\n' "$OTHER"; else printf 'n%s\\n' "$OWN"; : > "$SEEN"; fi
  exit 0
fi
if [ "$UNKNOWN_CWD" = 1 ]; then exit 1; fi
case "$3" in
  91000002) printf 'n%s\\n' "$OTHER" ;;
  *) printf 'n%s\\n' "$OWN" ;;
esac
`,
    );
    await writeExecutable(
      join(bin, "pkill"),
      '#!/bin/sh\nprintf "GLOBAL %s\\n" "$*" >> "$CALLS"\n',
    );
    return { own, elsewhere };
  }

  async function runOwned(
    expression: string,
    env: Record<string, string> = {},
  ) {
    const { own, elsewhere } = await fixture();
    const child = Bun.spawn({
      cmd: [
        bash,
        "-c",
        `. "${processesScript}"; kill() { printf 'kill %s\\n' "$*" >> "$CALLS"; }; ${expression}`,
      ],
      env: {
        PATH: bin,
        CALLS: log,
        OS: "",
        OWN: own,
        OTHER: elsewhere,
        SEEN: join(directory, "seen"),
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      exitCode,
      stdout,
      stderr,
      calls: await Bun.file(log)
        .text()
        .catch(() => ""),
    };
  }

  test("restarting one deployment stops its current and legacy APIs only", async () => {
    const result =
      await runOwned(`stop_matching "bun --env-file=../.env src/production-entry.ts" "$OWN";
stop_matching "bun --env-file=../.env src/index.ts" "$OWN"`);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.calls).toBe("kill 91000001\nkill 91000003\n");
  });

  test("a worker in another deployment does not suppress startup here", async () => {
    const result = await runOwned(
      `running "bun worker/src/index.ts" "$OTHER" && echo reused || echo start`,
    );
    expect(result.stdout).toBe("start\n");
    expect(result.calls).toBe("");
  });

  test("the owned worker is reused and stopping it leaves other processes alone", async () => {
    const result =
      await runOwned(`running "bun worker/src/index.ts" "$OWN" && echo reused;
stop_matching "bun worker/src/index.ts" "$OWN"`);
    expect(result.stdout).toBe("reused\n");
    expect(result.calls).toBe("kill 91000004\n");
  });

  test("absolute entry paths work with spaces and regex characters in the checkout path", async () => {
    const result = await runOwned(
      `running "bun worker/src/index.ts" "$OWN" && echo reused;
stop_matching "bun --env-file=../.env src/production-entry.ts" "$OWN";
stop_matching "bun worker/src/index.ts" "$OWN"`,
      { ABSOLUTE: "1" },
    );
    expect(result.stdout).toBe("reused\n");
    expect(result.calls).toBe("kill 91000001\nkill 91000004\n");
  });

  test("a PID whose ownership changes before signaling is left alone", async () => {
    const result = await runOwned(
      `stop_matching "bun --env-file=../.env src/production-entry.ts" "$OWN"`,
      { CHANGING_CWD: "1" },
    );
    expect(result.calls).toBe("");
  });

  test("an unreadable process cwd never permits stopping or reusing it", async () => {
    const result = await runOwned(
      `stop_matching "bun --env-file=../.env src/production-entry.ts" "$OWN";
running "bun worker/src/index.ts" "$OWN" && echo reused || echo unowned`,
      { UNKNOWN_CWD: "1" },
    );
    expect(result.stdout).toBe("unowned\n");
    expect(result.calls).toBe("");
  });

  test("missing ownership never permits a global stop or reuse", async () => {
    const result = await runOwned(`stop_matching "bun worker/src/index.ts";
running "bun worker/src/index.ts" && echo reused || echo unowned`);
    expect(result.stdout).toBe("unowned\n");
    expect(result.calls).toBe("");
  });
});
