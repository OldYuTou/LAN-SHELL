#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-${PORT:-6273}}"
PIDFILE="${PIDFILE:-/tmp/codex-server.pid}"
ESCALATED="${CODEX_STOP_ESCALATED:-}"

say() { printf '%s\n' "$*"; }

port_is_listening() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :${PORT}" 2>/dev/null | awk 'NR>1{found=1} END{exit(found?0:1)}'
    return $?
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  return 2
}

maybe_escalate_with_sudo() {
  if [[ "${EUID}" -eq 0 ]]; then
    return 1
  fi
  if [[ -n "${ESCALATED}" ]]; then
    return 1
  fi

  # Prefer sudo when we have a TTY (so it can prompt for a password).
  if command -v sudo >/dev/null 2>&1 && [[ -t 0 && -t 1 ]]; then
    say "[info] need higher privileges to stop the listener on port ${PORT}; retrying with sudo..."
    exec sudo -E env CODEX_STOP_ESCALATED=1 "$0" "$@"
  fi

  # If we don't have a TTY (e.g. launched from a GUI button), pkexec can show a GUI auth prompt.
  if command -v pkexec >/dev/null 2>&1; then
    say "[info] need higher privileges to stop the listener on port ${PORT}; retrying with pkexec..."
    exec pkexec env CODEX_STOP_ESCALATED=1 PORT="${PORT}" PIDFILE="${PIDFILE}" bash "$0" "$@"
  fi

  return 1
}

show_port_owner_hint() {
  say "[info] port ${PORT} still appears to be in use."

  if command -v lsof >/dev/null 2>&1; then
    say "[info] lsof (may hide other-user PIDs without sudo):"
    lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true
  fi
  if command -v ss >/dev/null 2>&1; then
    say "[info] ss:"
    ss -lptn "sport = :${PORT}" 2>/dev/null || ss -ltn "sport = :${PORT}" 2>/dev/null || true
  fi

  say "[info] possible matching processes:"
  ps -ef | rg -n "npm start|node .*server\\.js" || true

  cat <<EOF
[hint] If the listener belongs to root/another user, you must stop it with elevated permissions:
  sudo lsof -nP -iTCP:${PORT} -sTCP:LISTEN
  sudo fuser -k ${PORT}/tcp
  # or:
  sudo pkill -f "node server\\.js"

[hint] Or start on a different port:
  PORT=6174 npm start
EOF
}

kill_one() {
  local pid="$1"
  if [[ -z "${pid}" ]] || ! [[ "${pid}" =~ ^[0-9]+$ ]]; then
    return 0
  fi
  if ! kill -0 "${pid}" 2>/dev/null; then
    return 0
  fi

  say "[info] stopping PID=${pid} ..."
  if ! kill "${pid}" 2>/dev/null; then
    say "[warn] failed to kill PID=${pid} (permission?)"
    return 0
  fi

  for _ in {1..20}; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      say "[ok] stopped PID=${pid}"
      return 0
    fi
    sleep 0.2
  done

  say "[warn] PID=${pid} still running, sending SIGKILL..."
  kill -9 "${pid}" 2>/dev/null || true
  if kill -0 "${pid}" 2>/dev/null; then
    say "[warn] PID=${pid} still running after SIGKILL (permission?)"
  else
    say "[ok] killed PID=${pid}"
  fi
}

# 0) If a PID file exists, stop it first.
if [[ -f "${PIDFILE}" ]]; then
  pid="$(tr -d '[:space:]' < "${PIDFILE}" || true)"
  if [[ -n "${pid}" ]]; then
    kill_one "${pid}"
  fi
  rm -f "${PIDFILE}" 2>/dev/null || true
fi

# 1) Try killing port listeners (best effort; may require sudo to see other-user PIDs).
if command -v lsof >/dev/null 2>&1; then
  pids="$(lsof -ti :"${PORT}" 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    say "[info] killing processes on port ${PORT}: ${pids}"
    for p in ${pids}; do kill_one "${p}"; done
  fi
fi

if command -v ss >/dev/null 2>&1; then
  pids="$(ss -lptn 2>/dev/null | awk -v p=":${PORT}" '
    $0 ~ p {
      line=$0
      while (match(line, /pid=[0-9]+/)) {
        pid=substr(line, RSTART+4, RLENGTH-4)
        print pid
        line=substr(line, RSTART+RLENGTH)
      }
    }' | sort -u)"
  if [[ -n "${pids}" ]]; then
    say "[info] killing processes from ss on port ${PORT}: ${pids}"
    for p in ${pids}; do kill_one "${p}"; done
  fi
fi

if command -v fuser >/dev/null 2>&1; then
  say "[info] trying fuser on ${PORT}/tcp ..."
  fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
fi

# 2) Also kill any server.js in this repo (helps when port scan tools are missing/limited).
SCRIPT_DIR="$(cd -- "$(dirname "$0")" && pwd)"
if [[ -f "${SCRIPT_DIR}/server.js" ]]; then
  say "[info] stopping any matching '${SCRIPT_DIR}/server.js' processes..."
  pids="$(ps -ef | rg -n -o "^[^ ]+ +([0-9]+) .*node ${SCRIPT_DIR//\//\\/}/server\\.js" -r '$1' | sort -u || true)"
  if [[ -n "${pids}" ]]; then
    for p in ${pids}; do kill_one "${p}"; done
  fi

  # Common case: started from this repo with relative path "node server.js" (npm start).
  if command -v pgrep >/dev/null 2>&1; then
    pids="$(pgrep -u "$(id -u)" -f "node( .*)?server\\.js" 2>/dev/null | sort -u || true)"
    if [[ -n "${pids}" ]]; then
      say "[info] stopping current-user server.js processes: ${pids}"
      for p in ${pids}; do kill_one "${p}"; done
    fi
    pids="$(pgrep -u "$(id -u)" -f "^npm start$|npm start" 2>/dev/null | sort -u || true)"
    if [[ -n "${pids}" ]]; then
      say "[info] stopping current-user npm start processes: ${pids}"
      for p in ${pids}; do kill_one "${p}"; done
    fi
  fi
fi

if port_is_listening; then
  # If another user (often root) owns the listener, try auto-escalation so you
  # can just run ./关闭服务.sh once.
  maybe_escalate_with_sudo "$@" || true

  show_port_owner_hint
  exit 1
fi

say "[ok] port ${PORT} is free."
