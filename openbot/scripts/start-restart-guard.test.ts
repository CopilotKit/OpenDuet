import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function writeExecutable(path: string, contents: string) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

/**
 * How this run differs from the ordinary one, which is the whole vocabulary these tests need.
 *
 * `shell` IS A PARAMETER BECAUSE THE INVOCATION IS PART OF WHAT IS UNDER TEST. `bash` is the
 * supported one and the one the docs name; `sh` is the one somebody reaches for out of habit, and
 * what it produced was exit 1 with no output at all.
 *
 * `omitFromEnv` IS THE OTHER HALF. Every key below has a default in the script, so a `.env` without
 * one is an ordinary `.env` rather than a broken one — `.env.example` does not list `APP_PORT` at
 * all.
 */
type Run = {
  script?: "start" | "stop";
  worker?: "own" | "other";
  server?: "own" | "other";
  serverStops?: boolean;
  runningComputerToken?: string;
  computerStamp?: "current" | "missing" | "previous-process";
  repeatStart?: boolean;
  shell?: "bash" | "sh";
  omitFromEnv?: readonly string[];
  settings?: Record<string, string>;
  processEnvironment?: Record<string, string>;
  unavailableHealthPorts?: readonly number[];
};

async function runStartWithStaleServerProbe(
  status: 400 | 401 | 404,
  {
    script = "start",
    worker = "own",
    server = "own",
    serverStops = true,
    runningComputerToken,
    computerStamp = "current",
    repeatStart = false,
    shell = "bash",
    omitFromEnv = [],
    settings = {},
    processEnvironment = {},
    unavailableHealthPorts = [],
  }: Run = {},
) {
  const root =
    await Bun.$`mktemp -d ${tmpdir()}/openbot-start-guard-XXXXXX`.text();
  const directory = await realpath(root.trim());
  const fakeBin = join(directory, "bin");
  const scripts = join(directory, "scripts");
  const logPath = join(directory, "signals.log");
  const dockerLogPath = join(directory, "docker.log");
  const curlLogPath = join(directory, "curl.log");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(scripts, { recursive: true });
  await mkdir(join(directory, "server"));
  await mkdir(join(directory, ".logs"));
  const storedToken = (settings.COMPUTER_TOKEN ?? "computer-token")
    .replace(/^"(.*)"$/, "$1")
    .replace(/^'(.*)'$/, "$1");
  const runtimeToken = runningComputerToken ?? storedToken;
  await writeFile(join(directory, "server-computer-token"), runtimeToken);
  if (computerStamp !== "missing") {
    const fingerprint = createHash("sha256").update(runtimeToken).digest("hex");
    await writeFile(
      join(directory, ".logs/server-computer.state"),
      `v1\n${fingerprint}\n91000001\n${computerStamp === "previous-process" ? "previous-start" : "fixture-start"}\n`,
    );
  }
  await writeFile(
    join(directory, "bash-env"),
    `kill() {
  printf '%s\\n' "$*" >> "$SIGNAL_LOG"
  if [ "$SERVER_STOPS" = 1 ]; then
    case "$1" in 91000001|91000002) : > "$SERVER_STOPPED" ;; esac
  fi
}\n`,
  );
  const environment = [
    "APP_PORT=3010",
    "SERVER_PORT=3001",
    "COMPUTER_PORT=4100",
    "BOT_PORT=4200",
    "LANGGRAPH_PORT=4201",
    "SUPERVISOR_PORT=4500",
    "SUPERVISOR_TOKEN=supervisor-token",
    "COMPUTER_TOKEN=computer-token",
    "WORKER_SHARED_SECRET=worker-secret",
    "MANAGED_AGENT_TOKEN=managed-token",
    "AGENT_TOOL_TOKEN=agent-tool-token",
    "MANAGED_AGENT_AG_UI_URL=http://localhost:4201/ag-ui",
    "OPENBOT_ONE_COMPUTER_EACH=true",
    "DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot",
  ].filter(
    (line) =>
      ![...omitFromEnv, ...Object.keys(settings)].some((key) =>
        line.startsWith(`${key}=`),
      ),
  );
  environment.push(
    ...Object.entries(settings).map(([key, value]) => `${key}=${value}`),
  );
  await writeFile(join(directory, ".env"), `${environment.join("\n")}\n`);
  await writeFile(
    join(scripts, `${script}.sh`),
    await readFile(`scripts/${script}.sh`),
  );
  await chmod(join(scripts, `${script}.sh`), 0o755);
  // Copied beside it because `start.sh` sources it by its own directory, so a temp root without it
  // would fail on a missing file rather than on whatever the test is about.
  await writeFile(
    join(scripts, "require-bash.sh"),
    await readFile("scripts/require-bash.sh"),
  );
  await writeFile(
    join(scripts, "processes.sh"),
    await readFile("scripts/processes.sh"),
  );

  await writeExecutable(
    join(fakeBin, "lsof"),
    `#!/usr/bin/env bash
if [ "$1" = -a ]; then
  case "$3" in
    91000003) printf 'n%s/other/server\\n' "$STACK_ROOT" ;;
    91000005)
      if [ "$WORKER_OWNER" = own ] || [ -f "$WORKER_STARTED" ]; then
        printf 'n%s\\n' "$STACK_ROOT"
      else
        printf 'n%s/other\\n' "$STACK_ROOT"
      fi ;;
    *) printf 'n%s/server\\n' "$STACK_ROOT" ;;
  esac
elif [ "$STOP_ONLY" != 1 ] && [ "$1" = -t ]; then
  if [ -f "$SERVER_STARTED" ]; then echo 91000006
  elif [ "$SERVER_OWNER" = own ]; then echo 91000001
  else echo 91000003; fi
elif [ "$STOP_ONLY" != 1 ]; then
  printf 'p123\\ncbun\\nn*:3001\\n'
fi
`,
  );
  await writeExecutable(
    join(fakeBin, "curl"),
    `#!/usr/bin/env bash
args="$*"
printf '%s\\n' "$args" >> "$CURL_LOG"
for port in ${unavailableHealthPorts.join(" ")}; do
  if [[ "$args" == *"http://localhost:$port/health"* ]]; then exit 7; fi
done
if [[ "$args" == *"/internal/routines/run"* ]]; then
  printf '${status}'
  exit 0
fi
if [[ "$args" == *"/api/copilotkit/info"* ]]; then
  if [ -f "$SERVER_STOPPED" ] && [ ! -f "$SERVER_STARTED" ]; then exit 7; fi
  printf '{"licenseStatus":"valid","mode":"test","agents":{"analyst":{}}}'
  exit 0
fi
if [[ "$args" == *"http://localhost:3010/"* ]]; then
  printf '<title>OpenBot</title>'
  exit 0
fi
exit 0
`,
  );
  await writeExecutable(
    join(fakeBin, "docker"),
    `#!/usr/bin/env bash
args="$*"
printf '%s\\n' "$args" >> "$DOCKER_LOG"
if [[ "$args" == *"compose up"* ]]; then printf '%s' "$COMPUTER_TOKEN" > "$COMPOSE_COMPUTER_TOKEN"; fi
if [[ "$args" == *"to_regclass('public.agent_profiles')"* ]]; then echo agent_profiles; fi
if [[ "$args" == *"to_regclass('public.agent_preferences')"* ]]; then echo agent_preferences; fi
exit 0
`,
  );
  await writeExecutable(
    join(fakeBin, "pgrep"),
    `#!/usr/bin/env bash
if [[ "$*" == *worker/src/index.ts* ]]; then : > "$WORKER_CHECKED"; fi
if [ -f "$SERVER_STARTED" ]; then echo 91000006; else printf '%s\\n' 91000001 91000002; fi
printf '%s\\n' 91000003 91000004 91000005
`,
  );
  await writeExecutable(
    join(fakeBin, "ps"),
    `#!/usr/bin/env bash
case "$4" in
  lstart=) echo fixture-start ;;
  comm=) case "$2" in 91000004) echo /bin/bash ;; *) echo /opt/bun ;; esac ;;
  args=)
    case "$2" in
      91000006) printf 'bun --env-file=../.env %s/server/src/production-entry.ts\\n' "$STACK_ROOT" ;;
      91000001|91000003) echo 'bun --env-file=../.env src/production-entry.ts' ;;
      91000002) echo 'bun --env-file=../.env src/index.ts' ;;
      91000004) echo 'bash -c bun --env-file=../.env src/production-entry.ts' ;;
      91000005) echo 'bun worker/src/index.ts' ;;
    esac ;;
esac
`,
  );
  await writeExecutable(
    join(fakeBin, "powershell.exe"),
    `#!/usr/bin/env bash
if [ -n "\${OPENBOT_PID:-}" ]; then
  echo fixture-start
elif [ "\${OPENBOT_ACTION:-}" = unscoped ]; then
  if [ "\${LEGACY_WINDOWS_PROCESS:-}" = 1 ]; then echo 91000001; fi
elif [ "\${OPENBOT_ACTION:-}" = stop ] && [ "\${OPENBOT_CWD:-}" = "$STACK_ROOT/server" ]; then
  : > "$SERVER_STOPPED"
elif [ "\${OPENBOT_PATTERN:-}" = 'bun worker/src/index.ts' ]; then
  : > "$WORKER_CHECKED"
  if [ -f "$WORKER_STARTED" ]; then echo 91000005; fi
elif [ "\${OPENBOT_PATTERN:-}" = 'bun --env-file=../.env src/production-entry.ts' ]; then
  if [ -f "$SERVER_STARTED" ]; then echo 91000006; else echo 91000001; fi
fi
`,
  );
  await writeExecutable(
    join(fakeBin, "pkill"),
    '#!/usr/bin/env bash\nprintf "GLOBAL %s\\n" "$*" >> "$SIGNAL_LOG"\nexit 0\n',
  );
  await writeExecutable(
    join(fakeBin, "sleep"),
    `#!/usr/bin/env bash
# The first pause follows the signal, before the new API is launched. Later pauses wait for
# the fake background launch to acknowledge readiness, with a bounded fixture-only deadline.
if [ -f "$SERVER_STOPPED" ] && [ ! -f "$SERVER_STARTED" ]; then
  if [ -f "$SERVER_RESTART_PAUSED" ]; then
    for ((attempt=0; attempt<200; attempt++)); do
      [ -f "$SERVER_STARTED" ] && break
      /bin/sleep 0.01
    done
  else
    : > "$SERVER_RESTART_PAUSED"
  fi
fi
# The worker readiness check follows its launch immediately.
if [ -f "$WORKER_CHECKED" ] && [ ! -f "$WORKER_STARTED" ]; then
  for ((attempt=0; attempt<200; attempt++)); do
    [ -f "$WORKER_STARTED" ] && break
    /bin/sleep 0.01
  done
fi
`,
  );
  // The runtime health check is a script piped into `bun run -`, so that one invocation is the real
  // Bun: it is what decides whether the run carries on. Everything else Bun would start is faked.
  // The Learning container check answers with one line, which start.sh relays.
  await writeExecutable(
    join(fakeBin, "bun"),
    '#!/usr/bin/env bash\nif [[ "$2" == *server/src/production-entry.ts ]]; then printf "%s" "$COMPUTER_TOKEN" > "$SERVER_COMPUTER_TOKEN"; printf "%s\\n" "$*" > "$SERVER_STARTED"; fi\nif [[ "$1" == *worker/src/index.ts ]]; then printf "%s\\n" "$*" > "$WORKER_STARTED"; fi\nif [ "$1" = run ] && [ "$2" = - ]; then exec "$REAL_BUN" "$@"; fi\nif [ "$1" = scripts/setup-learning.ts ]; then echo "noise"; echo "LEARNING-CHECK $*"; fi\nexit 0\n',
  );
  // What `python3` is on a stock Windows machine: the Microsoft Store alias, which runs nothing. A
  // script that still needed it would stop at the health check in every test in this file.
  await writeExecutable(
    join(fakeBin, "python3"),
    '#!/usr/bin/env bash\necho "Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Apps > Advanced app settings > App execution aliases." >&2\nexit 49\n',
  );

  try {
    const spawnOptions = {
      cmd: [shell, `scripts/${script}.sh`],
      cwd: directory,
      env: {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        REAL_BUN: process.execPath,
        OS: "",
        STOP_ONLY: script === "stop" ? "1" : "0",
        BASH_ENV: join(directory, "bash-env"),
        STACK_ROOT: directory,
        WORKER_OWNER: worker,
        SERVER_OWNER: server,
        SERVER_STOPS: serverStops ? "1" : "0",
        SERVER_COMPUTER_TOKEN: join(directory, "server-computer-token"),
        COMPOSE_COMPUTER_TOKEN: join(directory, "compose-computer-token"),
        WORKER_STARTED: join(directory, "worker-started"),
        WORKER_CHECKED: join(directory, "worker-checked"),
        SERVER_STOPPED: join(directory, "server-stopped"),
        SERVER_STARTED: join(directory, "server-started"),
        SERVER_RESTART_PAUSED: join(directory, "server-restart-paused"),
        SIGNAL_LOG: logPath,
        DOCKER_LOG: dockerLogPath,
        CURL_LOG: curlLogPath,
        ...processEnvironment,
      },
      stdout: "pipe",
      stderr: "pipe",
    } as const;
    const child = Bun.spawn(spawnOptions);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const signalLog = await Bun.file(logPath)
      .text()
      .catch(() => "");
    const dockerLog = await Bun.file(dockerLogPath)
      .text()
      .catch(() => "");
    const curlLog = await Bun.file(curlLogPath)
      .text()
      .catch(() => "");
    const computerState = await Bun.file(
      join(directory, ".logs/server-computer.state"),
    )
      .text()
      .catch(() => "");
    let repeated:
      | { exitCode: number; stdout: string; stderr: string; signalLog: string }
      | undefined;
    if (repeatStart && exitCode === 0) {
      await writeFile(logPath, "");
      const next = Bun.spawn(spawnOptions);
      const [nextExitCode, nextStdout, nextStderr] = await Promise.all([
        next.exited,
        new Response(next.stdout).text(),
        new Response(next.stderr).text(),
      ]);
      repeated = {
        exitCode: nextExitCode,
        stdout: nextStdout,
        stderr: nextStderr,
        signalLog: await readFile(logPath, "utf8"),
      };
    }
    return {
      repeated,
      computerState,
      runtimeComputerToken: await readFile(
        join(directory, "server-computer-token"),
        "utf8",
      ),
      composeComputerToken: await Bun.file(
        join(directory, "compose-computer-token"),
      )
        .text()
        .catch(() => ""),
      exitCode,
      stdout,
      stderr,
      signalLog,
      dockerLog,
      curlLog,
      serverLaunch: await Bun.file(join(directory, "server-started"))
        .text()
        .catch(() => ""),
      workerLaunch: await Bun.file(join(directory, "worker-started"))
        .text()
        .catch(() => ""),
      directory,
      savedEnvironment: await Bun.file(join(directory, ".env")).text(),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("start.sh server restart guard", () => {
  function expectServerRestart(signalLog: string) {
    expect(signalLog).toBe("91000001\n91000002\n");
  }

  test.each([401, 404] as const)(
    "stops both current and legacy server launch patterns after handoff probe %s",
    async (status) => {
      const result = await runStartWithStaleServerProbe(status);

      expect({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        signalLog: result.signalLog,
      }).toMatchObject({ exitCode: 0, stderr: "" });
      expectServerRestart(result.signalLog);
    },
  );

  test("a changed computer token restarts a healthy server whose worker secret still matches", async () => {
    const result = await runStartWithStaleServerProbe(400, {
      processEnvironment: { COMPUTER_TOKEN: "new-development-token" },
    });

    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(result.savedEnvironment).toMatch(
      /^COMPUTER_TOKEN=new-development-token$/m,
    );
    expectServerRestart(result.signalLog);
    expect(result.serverLaunch).toBe(
      `--env-file=../.env ${result.directory}/server/src/production-entry.ts\n`,
    );
  });

  test.each(["true", "false"])(
    "an edited .env refreshes the running API's computer credential with a healthy worker probe (one computer each: %s)",
    async (oneComputerEach) => {
      const result = await runStartWithStaleServerProbe(400, {
        settings: {
          COMPUTER_TOKEN: "manually-edited-token",
          OPENBOT_ONE_COMPUTER_EACH: oneComputerEach,
        },
        runningComputerToken: "previous-runtime-token",
        repeatStart: true,
      });
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expectServerRestart(result.signalLog);
      expect(result.runtimeComputerToken).toBe("manually-edited-token");
      expect(result.composeComputerToken).toBe(result.runtimeComputerToken);
      expect(result.computerState).not.toContain("manually-edited-token");
      expect(result.stdout).not.toContain("manually-edited-token");
      expect(result.stdout).not.toContain("previous-runtime-token");
      expect(result.computerState).toBe(
        `v1\n${createHash("sha256").update("manually-edited-token").digest("hex")}\n91000006\nfixture-start\n`,
      );
      expect(result.repeated).toMatchObject({
        exitCode: 0,
        stderr: "",
        signalLog: "",
      });
    },
  );

  test("a server that remains alive is not stamped as having refreshed its computer credential", async () => {
    const result = await runStartWithStaleServerProbe(400, {
      serverStops: false,
      settings: { COMPUTER_TOKEN: "manually-edited-token" },
      runningComputerToken: "previous-runtime-token",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("old API is still answering");
    expect(result.serverLaunch).toBe("");
    expect(result.runtimeComputerToken).toBe("previous-runtime-token");
    expect(result.computerState).toContain(
      createHash("sha256").update("previous-runtime-token").digest("hex"),
    );
  });

  test.each(["missing", "previous-process"] as const)(
    "%s launch state conservatively refreshes only the owned API",
    async (computerStamp) => {
      const result = await runStartWithStaleServerProbe(400, {
        computerStamp,
        repeatStart: true,
      });
      expect(result.exitCode).toBe(0);
      expectServerRestart(result.signalLog);
      expect(result.repeated).toMatchObject({
        exitCode: 0,
        stderr: "",
        signalLog: "",
      });
    },
  );

  test("an API owned by another checkout is never restarted or stamped", async () => {
    const result = await runStartWithStaleServerProbe(400, {
      server: "other",
      computerStamp: "missing",
      settings: { COMPUTER_TOKEN: "manually-edited-token" },
      runningComputerToken: "previous-runtime-token",
    });
    expect(result.exitCode).toBe(1);
    expect(result.signalLog).toBe("");
    expect(result.serverLaunch).toBe("");
    expect(result.computerState).toBe("");
    expect(result.stdout).toContain("ownership");
  });

  test.each(["default", "process environment"])(
    "an unchanged resolved %s token leaves the API running",
    async (source) => {
      const token =
        source === "default" ? "openbot-dev-computer-token" : "process-token";
      const result = await runStartWithStaleServerProbe(400, {
        settings: { COMPUTER_TOKEN: "" },
        runningComputerToken: token,
        processEnvironment:
          source === "process environment" ? { COMPUTER_TOKEN: token } : {},
      });
      expect(result.exitCode).toBe(0);
      expect(result.signalLog).toBe("");
      expect(result.savedEnvironment).toContain(`COMPUTER_TOKEN=${token}\n`);
      expect(result.composeComputerToken).toBe(result.runtimeComputerToken);
    },
  );

  test.each([
    ["unquoted", "computer-token"],
    ["double-quoted", '"computer-token"'],
    ["single-quoted", "'computer-token'"],
    ["with an embedded quote", '"computer\'token"'],
  ])(
    "an unchanged computer token %s leaves a healthy server running",
    async (_, stored) => {
      const result = await runStartWithStaleServerProbe(400, {
        settings: { COMPUTER_TOKEN: stored },
      });

      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(result.savedEnvironment).toContain(`COMPUTER_TOKEN=${stored}\n`);
      expect(result.signalLog).toBe("");
      expect(result.serverLaunch).toBe("");
    },
  );
});

describe("start.sh deployment ownership", () => {
  test("another deployment's worker does not suppress this deployment's launch", async () => {
    const result = await runStartWithStaleServerProbe(400, { worker: "other" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("worker: started");
    expect(result.stdout).not.toContain("worker: did not stay up");
    expect(result.workerLaunch).toBe(
      `${result.directory}/worker/src/index.ts\n`,
    );
    expect(result.signalLog).toBe("");
  });

  test("an unchanged start reuses only this deployment's worker", async () => {
    const result = await runStartWithStaleServerProbe(400);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("worker: already running");
    expect(result.workerLaunch).toBe("");
    expect(result.signalLog).toBe("");
  });

  test("Windows launches identifiable absolute API and worker entry paths", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      processEnvironment: { OS: "Windows_NT" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.workerLaunch).toBe(
      `${result.directory}/worker/src/index.ts\n`,
    );
    expect(result.stdout).not.toContain("worker: did not stay up");
    expect(result.serverLaunch).toBe(
      `--env-file=../.env ${result.directory}/server/src/production-entry.ts\n`,
    );
  });

  test("Windows refuses ambiguous legacy processes with a manual restart instruction", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      processEnvironment: { OS: "Windows_NT", LEGACY_WINDOWS_PROCESS: "1" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("deployment cannot be verified");
    expect(result.stdout).toContain("Stop that process in Task Manager");
    expect(result.signalLog).toBe("");
    expect(result.workerLaunch).toBe("");
    expect(result.dockerLog).toBe("");
  });
});

describe("stop.sh deployment ownership", () => {
  test.each(["own", "other"] as const)(
    "stops only a worker owned by this deployment (%s)",
    async (worker) => {
      const result = await runStartWithStaleServerProbe(400, {
        script: "stop",
        worker,
      });
      expect(result.exitCode).toBe(0);
      expect(result.signalLog).toBe(worker === "own" ? "91000005\n" : "");
    },
  );
});

describe("start.sh runtime health", () => {
  /**
   * THE LICENCE IS CHECKED WITHOUT PYTHON.
   *
   * The check used to be a `python3` heredoc. On Windows `python3` is usually the Microsoft Store
   * alias, which exits 49, so `set -e` ended the run at "3/4 Runtime health" with the server and
   * worker already up and the app never started. The fake `python3` beside this file's other fakes
   * is that alias; the line below is only printed if the check ran, in Bun, and passed.
   */
  test("checks the licence and names the Bots without python3", async () => {
    const result = await runStartWithStaleServerProbe(401);

    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(result.stdout).toContain(
      "licence valid · mode test · Bots: analyst",
    );
  });
});

describe("start.sh under the wrong shell", () => {
  /**
   * THE WRONG INVOCATION SAYS SO, AND SAYING NOTHING IS THE DEFECT.
   *
   * CRITERION. `sh scripts/start.sh` exits non-zero having named bash and the command to run
   * instead, on stderr.
   *
   * REASON. The shebang says bash and `sh` overrides it. On macOS `sh` IS bash, in POSIX mode,
   * where a failed assignment inside a function is fatal instead of survivable — so the script died
   * at the first setting it read out of `.env` and printed NOTHING: no line number, no failing
   * command, no exit message. The whole of what somebody had to go on was `1`, which reads as "this
   * script is broken" rather than "run it the other way", and it cost an afternoon.
   *
   * THE SENTENCE NAMES THE FIX AND NOT ONLY THE FAULT, because "wrong shell" is not actionable to
   * somebody who typed the only invocation they knew.
   */
  test("sh refuses with a sentence naming bash, rather than exiting in silence", async () => {
    const result = await runStartWithStaleServerProbe(401, { shell: "sh" });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/bash/);
    expect(result.stderr).toMatch(/bash scripts\/start\.sh/);
    // On stderr rather than stdout, so it survives a caller that is reading the progress output.
    expect(result.stdout).toBe("");
  });
});

describe("start.sh settings with no line in .env", () => {
  /**
   * A KEY THIS SCRIPT HAS A DEFAULT FOR IS ALLOWED TO BE ABSENT, WHICH IS WHAT THE DEFAULT IS FOR.
   *
   * CRITERION. With no `APP_PORT` line in `.env` at all, the run completes exactly as it does with
   * one — the app is probed on 3010, the port the script falls back to.
   *
   * THIS ONE PASSED BEFORE THE CHANGE IT GUARDS, AND THAT IS SAID PLAINLY RATHER THAN DRESSED UP.
   * `setting` reads the key with a `grep` pipeline, `grep` finding nothing is an exit status of 1,
   * and `pipefail` makes it the pipeline's — but under bash that status does not escape the command
   * substitution, so the fallback won and this run was already green. It was fatal only under `sh`,
   * where the sibling test now keeps anybody from arriving at all. So there is no invocation left
   * that can watch this fail, and what it does instead is pin the CONTRACT: the second argument to
   * `setting` is the value an absent key takes, and nothing about which shell is reading the script
   * may decide otherwise.
   *
   * THE `|| true` IN THE SCRIPT IS WHAT MAKES THAT TRUE BY CONSTRUCTION rather than by a subtlety
   * of where `set -e` applies. Both halves are worth having: the refusal stops the invocation that
   * was silently fatal, and this stops the fallback depending on a detail nobody should have to
   * know to add a setting.
   *
   * `APP_PORT` IS THE ONE OMITTED BECAUSE IT IS THE REAL CASE. `.env.example` lists `PORT` and
   * `SERVER_PORT` and not this one, so every `.env` copied from it is missing exactly this key, and
   * it is the first setting the script reads — which is why the silent exit under `sh` happened
   * before any output at all.
   *
   * THE ASSERTION IS THE WHOLE RUN rather than a printed port: the faked `curl` answers the app
   * probe for `http://localhost:3010/` and nothing else, so a fallback that produced any other port
   * fails the run instead of quietly reporting a different number.
   */
  test("a .env with no APP_PORT still starts, on the default port", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      omitFromEnv: ["APP_PORT"],
    });

    expect({ exitCode: result.exitCode, stderr: result.stderr }).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    expect(result.stdout).toContain("http://localhost:3010");
  });
});

describe("start.sh one computer each", () => {
  /**
   * `OPENBOT_ONE_COMPUTER_EACH=false` IN `.env` TURNS THE SUPERVISOR OFF, AS THE DOCS SAY.
   *
   * The key was read from the environment alone, so a `.env` line was ignored: the supervisor was
   * still started and the server still told to use it. docs/configuration.md says to set it "in
   * `.env` or in the environment", and every other setting in this script is read that way.
   *
   * THE SUPERVISOR IS WHAT GIVES EACH BOT ITS OWN COMPUTER, so its absence from the services handed
   * to `docker compose up` is the observable half; the shared computer stays.
   */
  test("false in .env starts no supervisor", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      settings: { OPENBOT_ONE_COMPUTER_EACH: "false" },
    });

    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(result.dockerLog).toContain(
      "compose up -d --build postgres agent-computer agent-bot agent-langgraph",
    );
    expect(result.dockerLog).not.toContain("supervisor");
  });

  test("false in the process environment starts no supervisor either", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      settings: { OPENBOT_ONE_COMPUTER_EACH: "true" },
      processEnvironment: { OPENBOT_ONE_COMPUTER_EACH: "false" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.dockerLog).not.toContain("supervisor");
  });

  test("true, or absent, still starts it", async () => {
    for (const omitFromEnv of [[], ["OPENBOT_ONE_COMPUTER_EACH"]] as const) {
      const result = await runStartWithStaleServerProbe(401, { omitFromEnv });

      expect(result.exitCode).toBe(0);
      expect(result.dockerLog).toContain(
        "compose up -d --build postgres supervisor agent-computer agent-bot agent-langgraph",
      );
    }
  });
});

describe("start.sh Learning container check", () => {
  /**
   * The server assigns `openbot` once it exists, but its runtime key cannot create it. start.sh asks
   * the setup helper, without a browser or a prompt, to make sure it exists, and relays its last line.
   */
  test("runs the non-interactive check when a key is set and nothing is assigned", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      settings: { INTELLIGENCE_API_KEY: "cpk-synthetic" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "LEARNING-CHECK scripts/setup-learning.ts --non-interactive",
    );
    expect(result.stdout).not.toContain("noise");
  });

  test.each([
    [
      "a container is named",
      { CPK_INTELLIGENCE_LEARNING_CONTAINER_ID: "mine" },
    ],
    ["it is switched off", { OPENBOT_LEARNING_AUTO_ASSIGN: "false" }],
    ["it is switched off with 0", { OPENBOT_LEARNING_AUTO_ASSIGN: "0" }],
  ])("is skipped when %s", async (_, settings) => {
    const result = await runStartWithStaleServerProbe(401, {
      settings: { INTELLIGENCE_API_KEY: "cpk-synthetic", ...settings },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("LEARNING-CHECK");
  });

  test("is skipped without a runtime key", async () => {
    const result = await runStartWithStaleServerProbe(401);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("LEARNING-CHECK");
  });
});

describe("start.sh selected provider services", () => {
  test.each([".env", "process environment"])(
    "an Anthropic-only %s selection starts the managed Bot without the OpenAI-only sample",
    async (source) => {
      const selected = {
        BOT_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "synthetic-anthropic-key",
      };
      const result = await runStartWithStaleServerProbe(401, {
        settings: source === ".env" ? selected : { BOT_PROVIDER: "openai" },
        processEnvironment: source === "process environment" ? selected : {},
        unavailableHealthPorts: [4200],
      });
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(result.dockerLog).toContain(
        "compose up -d --build postgres supervisor agent-computer agent-langgraph",
      );
      expect(result.dockerLog).not.toContain("agent-bot");
      expect(result.dockerLog).toContain("compose run --rm --build migrate");
      expect(result.curlLog).toContain("http://localhost:4100/health");
      expect(result.curlLog).toContain("http://localhost:4201/health");
      expect(result.curlLog).not.toContain("http://localhost:4200/health");
      expect(result.stdout).toContain("agent-bot: skipped for Anthropic");
      expect(result.stdout).not.toContain("agent-bot ready");
      expect(result.stdout).toContain("agent-langgraph ready");
      expect(result.stdout).toContain(
        "managed coworker endpoint: http://localhost:4201/ag-ui",
      );
      expect(result.stdout).toContain("Ready. http://localhost:3010");
    },
  );

  test("the default OpenAI startup still starts and checks the legacy sample", async () => {
    const result = await runStartWithStaleServerProbe(401);
    expect(result.exitCode).toBe(0);
    expect(result.dockerLog).toContain(
      "compose up -d --build postgres supervisor agent-computer agent-bot agent-langgraph",
    );
    expect(result.curlLog).toContain("http://localhost:4200/health");
    expect(result.stdout).toContain("agent-bot ready");
    expect(result.stdout).not.toContain("agent-bot: skipped");
  });

  test("Anthropic startup still fails if its managed LangGraph Bot is unavailable", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      settings: {
        BOT_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "synthetic-anthropic-key",
      },
      unavailableHealthPorts: [4200, 4201],
    });
    expect(result.exitCode).toBe(1);
    expect(result.curlLog).not.toContain("http://localhost:4200/health");
    expect(result.curlLog).toContain("http://localhost:4201/health");
    expect(result.stdout).toContain("agent-langgraph never became ready");
    expect(result.stdout).not.toContain("Ready. http://localhost:3010");
  });
});

test("start persists the computer token for direct server restarts", async () => {
  const result = await runStartWithStaleServerProbe(401, {
    settings: { COMPUTER_TOKEN: "" },
  });
  expect(result.exitCode).toBe(0);
  expect(result.savedEnvironment).toMatch(/^COMPUTER_TOKEN=.+$/m);
});

test("start persists an overriding computer token for direct server restarts", async () => {
  const result = await runStartWithStaleServerProbe(401, {
    processEnvironment: { COMPUTER_TOKEN: "new-development-token" },
  });
  expect(result.exitCode).toBe(0);
  expect(result.savedEnvironment).toMatch(
    /^COMPUTER_TOKEN=new-development-token$/m,
  );
});
