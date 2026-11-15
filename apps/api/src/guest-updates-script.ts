// The update reporter that runs inside a customer's server (Linux: apt, dnf or yum). It tells the panel which
// updates wait and whether a restart is needed, and installs what the server's policy or its owner asks for.
// Served as plain text at GET /guest/updates.sh; written without ${...} and backticks so it can live in a template.
export const guestScript = String.raw`#!/bin/sh
# Lightning VM update reporter.
# Install: curl -fsSL PANEL/api/guest/updates.sh | sudo sh -s -- PANEL SERVER_ID TOKEN
# Remove:  turn it off on the server's page in the panel (the reporter removes itself on its next run).
set -u
CONF=/etc/lightning-updates.conf
SELF=/usr/local/sbin/lightning-updates
if [ "$#" -eq 0 ] || [ "$1" != run ]; then
  [ "$(id -u)" = 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
  [ "$#" -eq 3 ] || { echo "Usage: sh -s -- PANEL_URL SERVER_ID TOKEN" >&2; exit 2; }
  command -v curl >/dev/null 2>&1 || { echo "curl is needed." >&2; exit 1; }
  umask 077
  printf 'URL=%s\nID=%s\nTOKEN=%s\n' "$1" "$2" "$3" > "$CONF"
  curl -fsSL "$1/api/guest/updates.sh" -o "$SELF.tmp" && mv "$SELF.tmp" "$SELF" && chmod 700 "$SELF" || { echo "Could not download the reporter." >&2; exit 1; }
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    printf '[Unit]\nDescription=Lightning VM update reporter\n[Service]\nType=oneshot\nExecStart=%s run\n' "$SELF" > /etc/systemd/system/lightning-updates.service
    printf '[Unit]\nDescription=Lightning VM update reporter\n[Timer]\nOnBootSec=3min\nOnUnitActiveSec=10min\nRandomizedDelaySec=60\n[Install]\nWantedBy=timers.target\n' > /etc/systemd/system/lightning-updates.timer
    chmod 644 /etc/systemd/system/lightning-updates.service /etc/systemd/system/lightning-updates.timer
    systemctl daemon-reload
    systemctl enable --now lightning-updates.timer >/dev/null 2>&1
  else
    printf '*/10 * * * * root %s run >/dev/null 2>&1\n' "$SELF" > /etc/cron.d/lightning-updates
    chmod 644 /etc/cron.d/lightning-updates
  fi
  "$SELF" run && echo "Lightning VM update reporter installed; the first report was sent."
  exit 0
fi

[ -r "$CONF" ] || exit 0
URL=$(sed -n 's/^URL=//p' "$CONF" | head -n 1)
ID=$(sed -n 's/^ID=//p' "$CONF" | head -n 1)
TOKEN=$(sed -n 's/^TOKEN=//p' "$CONF" | head -n 1)
# One run at a time (a long upgrade outlasts the timer).
if command -v flock >/dev/null 2>&1; then exec 9>/run/lightning-updates.lock; flock -n 9 || exit 0; fi
OS=$( (. /etc/os-release 2>/dev/null && printf '%s' "$PRETTY_NAME") | tr -cd 'A-Za-z0-9 ._()/-' | cut -c1-80)
if command -v apt-get >/dev/null 2>&1; then MGR=apt
elif command -v dnf >/dev/null 2>&1; then MGR=dnf
elif command -v yum >/dev/null 2>&1; then MGR=yum
else MGR=none; fi
# Never asks a question; configuration files changed by hand are kept.
aptg() { DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"; }
STAMP=/var/lib/lightning-updates.stamp

gather() {
  TOTAL=0; SEC=0; PK=""; REBOOT=false
  case "$MGR" in
    apt)
      # The package lists are refreshed at most every six hours.
      if [ -z "$(find "$STAMP" -mmin -360 2>/dev/null)" ]; then aptg update -qq >/dev/null 2>&1; touch "$STAMP"; fi
      LIST=$(LC_ALL=C apt list --upgradable 2>/dev/null | grep -F '[upgradable from:')
      TOTAL=$(printf '%s\n' "$LIST" | awk 'NF { n++ } END { print n + 0 }')
      SEC=$(printf '%s\n' "$LIST" | awk 'NF { split($1, a, "/"); if (a[2] ~ /-security/) n++ } END { print n + 0 }')
      PK=$(printf '%s\n' "$LIST" | awk 'NF { split($1, a, "/"); s = (a[2] ~ /-security/) ? "true" : "false"; to = $2
        gsub(/[^A-Za-z0-9.+:~_-]/, "", a[1]); gsub(/[^A-Za-z0-9.+:~_-]/, "", to)
        printf "%s {\"name\":\"%s\",\"to\":\"%s\",\"security\":%s}\n", (s == "true" ? 0 : 1), a[1], to, s }' | sort -s -k1,1n | head -n 100 | cut -d' ' -f2- | paste -sd, -)
      if [ -f /var/run/reboot-required ]; then REBOOT=true; fi ;;
    dnf|yum)
      LIST=$($MGR -q check-update 2>/dev/null | awk 'NF == 3 && $1 ~ /\./ { print $1, $2 }')
      TOTAL=$(printf '%s\n' "$LIST" | awk 'NF { n++ } END { print n + 0 }')
      SEC=$($MGR -q updateinfo list --security 2>/dev/null | awk 'NF >= 3 { print $NF }' | sort -u | awk 'NF { n++ } END { print n + 0 }')
      PK=$(printf '%s\n' "$LIST" | awk 'NF { name = $1; sub(/\.[^.]*$/, "", name); to = $2
        gsub(/[^A-Za-z0-9.+:~_-]/, "", name); gsub(/[^A-Za-z0-9.+:~_-]/, "", to)
        printf "{\"name\":\"%s\",\"to\":\"%s\",\"security\":false}\n", name, to }' | head -n 100 | paste -sd, -)
      if command -v needs-restarting >/dev/null 2>&1; then needs-restarting -r >/dev/null 2>&1 || REBOOT=true; fi ;;
  esac
}

report() { # $1: nothing, or a ,"run":{...} fragment
  OUT=$(mktemp)
  CODE=$(printf '{"id":"%s","token":"%s","os":"%s","manager":"%s","total":%s,"security":%s,"rebootRequired":%s,"packages":[%s]%s}' "$ID" "$TOKEN" "$OS" "$MGR" "$TOTAL" "$SEC" "$REBOOT" "$PK" "$1" \
    | curl -sS -m 60 --retry 2 -o "$OUT" -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'x-lightning-csrf: 1' --data-binary @- "$URL/api/guest/updates/report" 2>/dev/null)
  RESP=$(cat "$OUT" 2>/dev/null); rm -f "$OUT"
}
field() { printf '%s' "$RESP" | sed -n 's/.*"'"$1"'":"\{0,1\}\([^",}]*\).*/\1/p'; }

gather
report ""
# Turned off in the panel (or the server is gone): the reporter removes itself.
if [ "$CODE" = 404 ] || [ "$CODE" = 410 ]; then
  systemctl disable --now lightning-updates.timer >/dev/null 2>&1
  rm -f /etc/systemd/system/lightning-updates.service /etc/systemd/system/lightning-updates.timer /etc/cron.d/lightning-updates "$CONF" "$STAMP" "$SELF"
  exit 0
fi
[ "$CODE" = 200 ] || exit 0
POLICY=$(field policy); ACTION=$(field action); AUTOR=$(field autoReboot); HOUR=$(field rebootHour)
AUTO=false
if [ -z "$ACTION" ]; then
  if [ "$POLICY" = all ] && [ "$TOTAL" -gt 0 ]; then ACTION=upgrade; AUTO=true
  elif [ "$POLICY" = security ] && [ "$SEC" -gt 0 ]; then ACTION=security; AUTO=true; fi
fi
case "$ACTION" in
  security|upgrade)
    LOG=$(mktemp); OK=true
    case "$MGR:$ACTION" in
      apt:upgrade) aptg update -qq >"$LOG" 2>&1; touch "$STAMP"; aptg -y --with-new-pkgs upgrade >>"$LOG" 2>&1 || OK=false ;;
      apt:security)
        NAMES=$(LC_ALL=C apt list --upgradable 2>/dev/null | awk -F/ '/\[upgradable from:/ { split($2, b, " "); if (b[1] ~ /-security/) print $1 }' | tr -cd 'A-Za-z0-9.+:~_\n-')
        # shellcheck disable=SC2086
        if [ -n "$NAMES" ]; then aptg -y install --only-upgrade $NAMES >"$LOG" 2>&1 || OK=false; fi ;;
      dnf:upgrade|yum:upgrade) $MGR -y upgrade >"$LOG" 2>&1 || OK=false ;;
      dnf:security|yum:security) $MGR -y upgrade --security >"$LOG" 2>&1 || OK=false ;;
      *) OK=false; echo "no supported package manager" >"$LOG" ;;
    esac
    MSG=$(tail -n 3 "$LOG" | tr '\n' ' ' | tr -cd 'A-Za-z0-9 .,:;()/_=+-' | cut -c1-300); rm -f "$LOG"
    gather
    report ",\"run\":{\"action\":\"$ACTION\",\"ok\":$OK,\"auto\":$AUTO,\"message\":\"$MSG\"}" ;;
  reboot)
    report ",\"run\":{\"action\":\"reboot\",\"ok\":true,\"auto\":false,\"message\":\"\"}"
    shutdown -r +1 "Lightning VM: restart requested from the panel" >/dev/null 2>&1
    exit 0 ;;
esac
# A restart the updates need, by itself, only in the hour the owner chose.
if [ "$AUTOR" = true ] && [ "$REBOOT" = true ] && [ "$(date +%H | sed 's/^0//')" = "$HOUR" ]; then
  report ",\"run\":{\"action\":\"reboot\",\"ok\":true,\"auto\":true,\"message\":\"\"}"
  shutdown -r +1 "Lightning VM: restart for installed updates" >/dev/null 2>&1
fi
exit 0
`;
