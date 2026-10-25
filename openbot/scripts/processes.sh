# Find and stop this deployment's processes, sourced after `require-bash.sh`.
# Port inspection uses lsof (PowerShell on Windows without it). Background process ownership
# requires an exact Bun command plus this checkout's physical working directory on POSIX.
# New launches use absolute entry paths so Windows, which does not expose cwd through CIM,
# can prove ownership too. Never signal or reuse a process from a global relative-pattern match.

# `type -P` rather than `command -v`: only a program on PATH counts, not a shell function or alias of
# the same name that happens to be defined.
openbot_windows_without() {
  [ "${OS:-}" = "Windows_NT" ] && ! type -P "$1" >/dev/null 2>&1
}

# PowerShell writes CRLF. A trailing `\r` would make an empty answer non-empty and a pid unusable.
openbot_powershell() {
  powershell.exe -NoProfile -NonInteractive -Command "$1" 2>/dev/null | tr -d '\r' || true
}

# What is listening on a TCP port, as "name (address)", or nothing when the port is free.
holder() {
  if openbot_windows_without lsof; then
    OPENBOT_PORT="$1" openbot_powershell '
      Get-NetTCPConnection -State Listen -LocalPort $env:OPENBOT_PORT -ErrorAction SilentlyContinue |
        Select-Object -First 1 |
        ForEach-Object { "{0} ({1}:{2})" -f (Get-Process -Id $_.OwningProcess).ProcessName, $_.LocalAddress, $_.LocalPort }'
    return 0
  fi
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fcn 2>/dev/null | awk '/^c/{c=substr($0,2)} /^n/{print c" ("substr($0,2)")"; exit}' || true
}

# The ids of whatever is listening on a TCP port, one per line.
port_pids() {
  if openbot_windows_without lsof; then
    OPENBOT_PORT="$1" openbot_powershell '
      Get-NetTCPConnection -State Listen -LocalPort $env:OPENBOT_PORT -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique'
    return 0
  fi
  lsof -t -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

# `kill [-9] <pids>`, for ids from `port_pids`. Windows has no SIGTERM to send a console process, so
# there both forms stop it outright. A stopped process takes a moment to go, so this waits for it,
# up to five seconds, rather than let the next check see it still there.
kill_pids() {
  if openbot_windows_without lsof; then
    OPENBOT_PIDS="$*" openbot_powershell '
      $ids = @($env:OPENBOT_PIDS -split " " | Where-Object { $_ -match "^[0-9]+$" })
      if ($ids) {
        Stop-Process -Force -Id $ids -ErrorAction SilentlyContinue
        Wait-Process -Id $ids -Timeout 5 -ErrorAction SilentlyContinue
      }' >/dev/null
    return 0
  fi
  kill "$@" 2>/dev/null || true
}

# Windows command lines retain quotes and native path separators. Match the complete arguments,
# not a substring; an absolute entry path is the ownership proof. `unscoped` only reports legacy
# relative launches so start.sh can explain why it cannot safely adopt or stop them.
openbot_windows_matching() {
  local cwd="$2"
  if type -P cygpath >/dev/null 2>&1; then
    cwd="$(cygpath -m "$cwd")" || return 1
  fi
  OPENBOT_PATTERN="$1" OPENBOT_CWD="$cwd" OPENBOT_ACTION="${3:-}" openbot_powershell '
    $name, $relative = $env:OPENBOT_PATTERN -split " ", 2
    $split = $relative.LastIndexOf(" ") + 1
    $prefix = $relative.Substring(0, $split)
    $script = $env:OPENBOT_CWD.Replace("\", "/").TrimEnd("/") + "/" + $relative.Substring($split)
    $absolute = @("$prefix$script", "$prefix`"$script`"")
    $ids = @(Get-CimInstance Win32_Process |
      Where-Object {
        if ($_.Name -ne "$name.exe" -or !$_.CommandLine) { return $false }
        $arguments = ($_.CommandLine.Trim() -replace "^(?:`"[^`"]*`"|\S+)\s+", "").Replace("\", "/")
        if ($env:OPENBOT_ACTION -eq "unscoped") { return $arguments -eq $relative }
        $absolute -contains $arguments
      } | ForEach-Object { $_.ProcessId })
    if ($ids -and $env:OPENBOT_ACTION -eq "stop") {
      Stop-Process -Force -Id $ids -ErrorAction SilentlyContinue
      Wait-Process -Id $ids -Timeout 5 -ErrorAction SilentlyContinue
    }
    $ids'
}

openbot_process_cwd() {
  if [ -d "/proc/$1" ]; then
    readlink "/proc/$1/cwd" 2>/dev/null
  else
    lsof -a -p "$1" -d cwd -Fn 2>/dev/null | while IFS= read -r line; do
      case "$line" in n*) printf '%s\n' "${line#n}"; break ;; esac
    done
  fi
}

# pgrep supplies candidates only. Verify the executable, full arguments and cwd, including when
# rechecking immediately before a signal. Literal comparisons avoid regex metacharacters in paths.
openbot_process_matches() {
  local pid="$1" pattern="$2" cwd="$3" executable command args absolute
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  [ "$pid" -gt 1 ] || return 1
  executable="$(ps -p "$pid" -o comm= 2>/dev/null)" || return 1
  case "${executable##*/}" in bun|bun.exe) ;; *) return 1 ;; esac
  command="$(ps -p "$pid" -o args= -ww 2>/dev/null)" || return 1
  args="${pattern#* }"
  absolute="${pattern% *} $cwd/${pattern##* }"
  case "$command" in
    "$pattern"|"$executable $args"|"$absolute"|"$executable ${absolute#* }") ;;
    *) return 1 ;;
  esac
  [ "$(openbot_process_cwd "$pid")" = "$cwd" ]
}

openbot_matching_pids() {
  local pattern="$1" cwd="${2:-}" pid
  # Missing or inaccessible ownership information is never permission to match globally.
  [ -n "$cwd" ] && cwd="$(cd "$cwd" 2>/dev/null && pwd -P)" || return 0
  if [ "${OS:-}" = Windows_NT ]; then
    openbot_windows_matching "$pattern" "$cwd"
    return
  fi
  while IFS= read -r pid; do
    if openbot_process_matches "$pid" "$pattern" "$cwd"; then
      printf '%s\n' "$pid"
    fi
  done < <(pgrep -f "${pattern##* }" 2>/dev/null || true)
}

# Both helpers require the command AND its owning working directory.
running() {
  [ -n "$(openbot_matching_pids "$1" "${2:-}")" ]
}

stop_matching() {
  local pattern="$1" cwd="${2:-}" pid
  [ -n "$cwd" ] && cwd="$(cd "$cwd" 2>/dev/null && pwd -P)" || return 0
  if [ "${OS:-}" = Windows_NT ]; then
    openbot_windows_matching "$pattern" "$cwd" stop >/dev/null
    return
  fi
  while IFS= read -r pid; do
    if openbot_process_matches "$pid" "$pattern" "$cwd"; then
      kill "$pid" 2>/dev/null || true # The verified process may already have exited.
    fi
  done < <(openbot_matching_pids "$pattern" "$cwd")
}
