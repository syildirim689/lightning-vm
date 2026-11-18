#!/bin/sh
# Lightning VM installer.
#   sudo sh scripts/install.sh [install] [--domain panel.example.com] [--admin-email you@example.com]
#                                        does everything: Docker (if missing), services, HTTPS (your domain, or
#                                        <public-ip>.sslip.io when the server has a public IPv4), monitoring,
#                                        the first admin, daily backups; ends with a summary. Safe to run again.
#                                        --local (no public access), --setup-wizard (create the admin in the
#                                        browser with a token), --no-monitoring, --no-schedule
#   sh scripts/install.sh check          read-only: host pre-checks and state of an existing install
#   sh scripts/install.sh recover-setup  reopen the browser setup wizard (accounts and data are kept)
#   sh scripts/install.sh reset-password EMAIL [--disable-2fa]  lost password: a new one is shown once
#   sh scripts/install.sh monitoring on|off  start or stop Prometheus, Grafana, Loki and Alertmanager
#   sh scripts/install.sh terminal on|off    the administrators' browser terminal to this host (off by default)
#   sh scripts/install.sh backup         encrypted backup of the database, settings, keys and certificates
#   sh scripts/install.sh restore FILE [--yes-replace-data] [--no-safety-backup] [--allow-unsigned] [--no-hold]
#                                        restore a backup (without the flag it only checks and explains); the
#                                        current data is backed up first, and without that backup nothing is
#                                        restored unless --no-safety-backup says so. FILE.hmac must lie next to
#                                        FILE and FILE must keep its name; a backup made by an older version
#                                        (FILE.sha256 only) is restored only with --allow-unsigned.
#                                        The archive is copied once to a root-only work directory and that copy is
#                                        checked and used (it needs room in the temporary directory, TMPDIR or /tmp).
#                                        Afterwards everyone is signed out and the panel is ON HOLD: it does not act
#                                        by itself on the restored state until you release it. Check first:
#                                        servers created or deleted since the backup (Admin → System → findings
#                                        from reconcile), payments made since, and API tokens, bans and role
#                                        changes made since (they are back as they were at backup time). Release:
#                                        Admin → System, or: docker compose exec api node dist/cli.js release-restore-hold
#                                        --no-hold: no hold (for a backup taken moments ago); sessions still end
#   sh scripts/install.sh update [--to vX.Y.Z]
#                                        update a git checkout to the latest release of UPDATE_CHANNEL
#   sh scripts/install.sh releases       fetch and list available versions (data/maintenance/releases.json)
#   sh scripts/install.sh schedule on|off
#                                        hourly systemd timer: daily backup and the automatic update
#   sh scripts/install.sh agent on|off   systemd path unit that runs what the admin panel asks for
#                                        (check for updates, update, backup, automatic-update settings)
#   sh scripts/install.sh run-requests   process the panel's requests now (the agent runs this)
#   sh scripts/install.sh auto-update on|off [--channel stable|beta|edge] [--window 03:00-05:00]
#                                        edge follows the branch in UPDATE_BRANCH (default main), for testing
#   sh scripts/install.sh domain panel.example.com [--acme-staging | --tls custom --cert fullchain.pem --key key.pem]
#                                        serve the panel on that name with automatic HTTPS (ports 80/443)
#   sh scripts/install.sh behind-proxy --public-url https://panel.example.com [--port 8080] [--trusted-cidr CIDR]
#                                        plain HTTP on 127.0.0.1 for an existing Nginx/Caddy/Traefik in front.
#                                        --public-url is the address people open (scheme and host, no path): mailed
#                                        links use it (PANEL_PUBLIC_URL); required unless one is already stored.
#                                        --trusted-cidr: the proxy's address or network (several: "a b")
#   sh scripts/install.sh local-only     plain HTTP on 127.0.0.1:8080 only (SSH tunnel)
#   sh scripts/install.sh host [--hostname NAME] [--timezone Area/City] [--ntp a,b|default] [--dns ip,ip|default]
#                                        this server's name, time zone, time servers (systemd-timesyncd) and DNS
#                                        servers (systemd-resolved); without options it only records the current
#                                        values in data/maintenance/host.json for the panel
#   sh scripts/install.sh os check|upgrade|security|reboot|auto-on|auto-off|info
#                                        this server's operating system updates (apt): refresh the package lists,
#                                        install all or only security updates, restart the server, turn automatic
#                                        security updates on or off; the state is recorded in data/maintenance/os.json
#   sh scripts/install.sh uninstall [--purge-data]
#                                        stop the services and remove what this script wrote outside this directory
#                                        (systemd units and drop-ins, the apt setting, stored git credentials);
#                                        .env, secrets/, backups/ and data/ stay, and so do the Docker volumes
#                                        unless --purge-data is given
# Options: --lang tr|en  --install-docker  --allow-unsupported-os
# It never changes firewall, SSH or other web server settings, and never prints secrets.
# shellcheck disable=SC1091 # /etc/os-release exists only on the target host
set -eu
# Patterns mean the same on every server: [a-z] and [0-9] are ASCII whatever locale systemd or the shell passes on.
LC_ALL=C; export LC_ALL
cd "${LVM_ROOT:-$(dirname "$0")/..}"
# update checks out another version of this very file: run from a copy so sh never reads a changed script.
# Unset after use: run-requests starts this script again, and that child must not think it is the copy.
if [ -n "${LVM_REEXEC:-}" ]; then rm -f "$0"; unset LVM_REEXEC
else case " $* " in *" update "*|*" maintenance "*|*" run-requests "*)
  copy=$(mktemp); cp scripts/install.sh "$copy"; LVM_ROOT=$(pwd) LVM_REEXEC=1 exec sh "$copy" "$@" ;;
esac; fi

MODE=install INSTALL_DOCKER=0 ALLOW_OS=0 DOMAIN="" ACME_STAGING=0 PROXY_PORT=8080 TRUSTED_CIDR="" TLS_MODE="" CERT_FILE="" KEY_FILE=""
RESTORE_FILE="" YES=0 TO="" AUTO=0 SWITCH="" CHANNEL="" WINDOW="" BRANCH="" PURGE=0 NO_SAFETY=0 ALLOW_UNSIGNED=0 NO_HOLD=0
PUBLIC_URL=""
HOST_NAME="" HOST_TZ="" HOST_NTP="" HOST_DNS="" OS_ACT=""
LOCAL=0 WIZARD=0 MONITORING=1 SCHEDULE=1 ADMIN_EMAIL="" RESET_EMAIL="" DISABLE_2FA=""
case "${LANG:-}" in tr*) UI="tr" ;; *) UI="en" ;; esac
while [ $# -gt 0 ]; do
  case "$1" in
    install|check|recover-setup|update|behind-proxy|local-only|backup|maintenance|releases|run-requests|state|uninstall) MODE=$1 ;;
    restore) MODE=restore; if [ $# -gt 1 ]; then shift; RESTORE_FILE=$1; fi ;;
    reset-password) MODE=reset-password; if [ $# -gt 1 ]; then shift; RESET_EMAIL=$1; fi ;;
    --disable-2fa) DISABLE_2FA=--disable-2fa ;;
    schedule|auto-update|agent|monitoring|terminal) MODE=$1; if [ $# -gt 1 ]; then shift; SWITCH=$1; fi
      case "$SWITCH" in on|off) ;; *) echo "$MODE: on or off" >&2; exit 2 ;; esac ;;
    --yes-replace-data) YES=1 ;;
    --no-safety-backup) NO_SAFETY=1 ;;
    --allow-unsigned) ALLOW_UNSIGNED=1 ;;
    --no-hold) NO_HOLD=1 ;;
    --purge-data) PURGE=1 ;;
    --to) shift; TO=${1:-} ;;
    --auto) AUTO=1 ;;
    --channel) shift; CHANNEL=${1:-} ;;
    --branch) shift; BRANCH=${1:-}
      echo "$BRANCH" | grep -Eq '^[A-Za-z0-9._/-]{1,100}$' || { echo "invalid --branch" >&2; exit 2; } ;;
    --window) shift; WINDOW=${1:-} ;;
    domain) MODE=domain; if [ $# -gt 1 ]; then shift; DOMAIN=$1; fi ;;
    host) MODE=host ;;
    os) MODE=os; if [ $# -gt 1 ]; then shift; OS_ACT=$1; fi
      case "$OS_ACT" in check|upgrade|security|reboot|auto-on|auto-off|info) ;; *) echo "os: check, upgrade, security, reboot, auto-on, auto-off or info" >&2; exit 2 ;; esac ;;
    --hostname) shift; HOST_NAME=${1:-} ;;
    --timezone) shift; HOST_TZ=${1:-} ;;
    --ntp) shift; HOST_NTP=${1:-} ;;
    --dns) shift; HOST_DNS=${1:-} ;;
    --acme-staging) ACME_STAGING=1 ;;
    --tls) shift; TLS_MODE=${1:-} ;;
    --cert) shift; CERT_FILE=${1:-} ;;
    --key) shift; KEY_FILE=${1:-} ;;
    --domain) shift; DOMAIN=${1:-} ;;
    --local) LOCAL=1 ;;
    --admin-email) shift; ADMIN_EMAIL=${1:-} ;;
    --setup-wizard) WIZARD=1 ;;
    --no-monitoring) MONITORING=0 ;;
    --no-schedule) SCHEDULE=0 ;;
    --port) shift; PROXY_PORT=${1:-} ;;
    --trusted-cidr) shift; TRUSTED_CIDR=${1:-} ;;
    --public-url) shift; PUBLIC_URL=${1:-} ;;
    --lang) shift; UI=${1:-en} ;;
    --install-docker) INSTALL_DOCKER=1 ;;
    --allow-unsupported-os) ALLOW_OS=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
# The language also goes into the systemd units this script writes: only the two it knows.
case "$UI" in tr|en) ;; *) UI=en ;; esac

# msg LEVEL CODE "türkçe" "english"
msg() { if [ "$UI" = tr ]; then t=$3; else t=$4; fi; printf '%-5s %-22s %s\n' "$1" "$2" "$t"; }
FAILED=0
fail() { msg FAIL "$1" "$2" "$3"; FAILED=$((FAILED + 1)); }
die() { msg FAIL "$2" "$3" "$4"; exit "$1"; }

# What has to be undone when the script ends in the middle of a backup or a restore (a failed step, Ctrl-C,
# a kill): one EXIT handler for the whole script, so no function replaces another's trap. Each function sets
# its own variable here and empties it when it is done.
BACKUP_WORK="" RESTORE_WORK="" RESTORE_STAGE="" REQUEST_WORK="" PANEL_TMP="" LOCK_MINE=""
on_exit() {
  rc=$?; trap - EXIT
  # A snapshot for the panel that was not finished.
  [ -z "$PANEL_TMP" ] || rm -f "$PANEL_TMP"
  [ -z "$LOCK_MINE" ] || drop_lock
  # Plaintext copies of the database, .env and the encryption keys.
  [ -z "$BACKUP_WORK" ] || rm -rf "$BACKUP_WORK"
  [ -z "$RESTORE_WORK" ] || rm -rf "$RESTORE_WORK"
  # A panel request and, with it, an uploaded certificate and its key.
  [ -z "$REQUEST_WORK" ] || rm -rf "$REQUEST_WORK"
  # A restore that stopped the app services does not leave them down, and says which data they now run on.
  if [ -n "$RESTORE_STAGE" ]; then
    if [ "$RESTORE_STAGE" = replaced ]; then
      msg WARN RESTORE_STATE "Geri yükleme yarıda kaldı. Veritabanı artık YEDEKTEKİ veriyi içeriyor, ama anahtarlar ve sertifikalar geri konmamış olabilir: aynı restore komutunu yeniden çalıştırın" "The restore did not finish. The database now holds the BACKUP's data, but the keys and certificates may not be back yet: run the same restore command again"
    else
      msg WARN RESTORE_STATE "Geri yükleme yapılmadı: veritabanı DEĞİŞMEDİ, önceki veri yerinde" "Nothing was restored: the database is UNCHANGED, the previous data is in place"
    fi
    if docker compose up -d --wait --wait-timeout 300 >/dev/null 2>&1; then msg OK RESTARTED "Durdurulan servisler yeniden başlatıldı" "The stopped services were started again"
    else msg FAIL E_RESTORE_START "Durdurulan servisler başlatılamadı: docker compose up -d; docker compose logs" "The stopped services could not be started: docker compose up -d; docker compose logs"; fi
  fi
  exit "$rc"
}
# A signal ends the script through the same handler. Called again inside a subshell, where traps start empty.
arm_exit() { trap on_exit EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; }
arm_exit

env_value() { if [ -f .env ]; then sed -n "s/^$1=//p" .env | tail -n 1; fi; }
# Replaces or appends one setting. The value is written exactly as given: what sed would read as an instruction
# in it (\, & and the delimiter |) is escaped first. A value with a line break would add a second setting and is
# refused.
set_env() {
  case "$2" in *"
"*) die 2 E_ENV_VALUE ".env değeri satır sonu içeremez: $1" "A value in .env cannot contain a line break: $1" ;; esac
  if grep -q "^$1=" .env; then
    env_new=$(printf '%s\n' "$2" | sed 's/[\\&|]/\\&/g')
    sed -i "s|^$1=.*|$1=$env_new|" .env
  else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
load_settings() {
  LISTEN=$(env_value LISTEN_ADDRESS); LISTEN=${LISTEN:-127.0.0.1}
  PORT=$(env_value HTTP_PORT); PORT=${PORT:-8080}
  TLS_PORT=$(env_value HTTPS_PORT); TLS_PORT=${TLS_PORT:-8443}
  SITE=$(env_value PANEL_SITE); SITE=${SITE:-:80}
}
load_settings

# Requests the app through Caddy from this host. In domain mode Caddy only answers for that
# name over HTTPS, so the name is pinned to 127.0.0.1; -k because certificate trust is reported separately.
local_get() {
  case "$SITE" in
    :*) curl -fsS --max-time 5 "http://127.0.0.1:$PORT$1" ;;
    *) curl -fsS --max-time 5 -k --resolve "$SITE:$TLS_PORT:127.0.0.1" "https://$SITE:$TLS_PORT$1" ;;
  esac
}

# A port held by our own proxy container is not a conflict.
ports_free() {
  ours=$(docker compose ps -q --status running proxy 2>/dev/null || true)
  for p in "$@"; do
    if [ -z "$ours" ] && ss -Htln "sport = :$p" 2>/dev/null | grep -q .; then
      fail E_PORT_IN_USE "Port $p başka bir süreç tarafından kullanılıyor (ss -ltnp ile bakın; mevcut web sunucusu için: behind-proxy)" "Port $p is used by another process (inspect with ss -ltnp; for an existing web server: behind-proxy)"
    else msg OK PORT "$LISTEN:$p" "$LISTEN:$p"; fi
  done
}

host_checks() {
  os_id=$(. /etc/os-release 2>/dev/null && echo "${ID:-}"); os_ver=$(. /etc/os-release 2>/dev/null && echo "${VERSION_ID:-}")
  case "$os_id $os_ver" in
    "ubuntu 22.04"|"ubuntu 24.04"|"ubuntu 26.04") msg OK OS "Ubuntu $os_ver" "Ubuntu $os_ver" ;;
    *) if [ "$ALLOW_OS" = 1 ]; then msg WARN E_OS_UNSUPPORTED "Desteklenmeyen işletim sistemi: $os_id $os_ver (izin verildi)" "Unsupported OS: $os_id $os_ver (allowed)"
       else fail E_OS_UNSUPPORTED "Desteklenen: Ubuntu 22.04/24.04/26.04. Bulunan: $os_id $os_ver (--allow-unsupported-os)" "Supported: Ubuntu 22.04/24.04/26.04. Found: $os_id $os_ver (--allow-unsupported-os)"; fi ;;
  esac

  case "$(uname -m)" in
    x86_64|aarch64) msg OK ARCH "$(uname -m)" "$(uname -m)" ;;
    *) fail E_ARCH_UNSUPPORTED "Desteklenmeyen mimari: $(uname -m) (amd64 veya arm64 gerekir)" "Unsupported architecture: $(uname -m) (amd64 or arm64 required)" ;;
  esac

  cpus=$(nproc 2>/dev/null || echo 1)
  if [ "$cpus" -ge 2 ]; then msg OK CPU "$cpus vCPU" "$cpus vCPU"; else msg WARN W_CPU_LOW "$cpus vCPU; en az 2 önerilir" "$cpus vCPU; at least 2 recommended"; fi

  mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
  if [ "$mem_mb" -lt 1900 ]; then fail E_RAM_LOW "RAM ${mem_mb} MB; en az 2 GB gerekir" "RAM ${mem_mb} MB; at least 2 GB required"
  elif [ "$mem_mb" -lt 3800 ]; then msg WARN W_RAM_LOW "RAM ${mem_mb} MB; izleme profili için 4 GB önerilir" "RAM ${mem_mb} MB; 4 GB recommended for the monitoring profile"
  else msg OK RAM "${mem_mb} MB" "${mem_mb} MB"; fi

  disk_gb=$(df -Pk . | awk 'NR==2 {print int($4/1048576)}')
  if [ "$disk_gb" -lt 10 ]; then fail E_DISK_LOW "Boş disk ${disk_gb} GB; en az 10 GB gerekir" "Free disk ${disk_gb} GB; at least 10 GB required"
  elif [ "$disk_gb" -lt 20 ]; then msg WARN W_DISK_LOW "Boş disk ${disk_gb} GB; 20 GB önerilir" "Free disk ${disk_gb} GB; 20 GB recommended"
  else msg OK DISK "${disk_gb} GB boş" "${disk_gb} GB free"; fi

  for tool in openssl curl; do
    if command -v "$tool" >/dev/null; then msg OK TOOLS "$tool" "$tool"; else fail E_TOOL_MISSING "$tool gerekli: apt-get install $tool" "$tool required: apt-get install $tool"; fi
  done

  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then msg OK DOCKER "$(docker version --format '{{.Server.Version}}')" "$(docker version --format '{{.Server.Version}}')"
  elif command -v docker >/dev/null; then fail E_DOCKER_DENIED "Docker var ama erişilemiyor (root veya docker grubu gerekir)" "Docker present but not accessible (root or docker group needed)"
  else fail E_DOCKER_MISSING "Docker Engine yok. Resmî depodan kurmak için: --install-docker" "Docker Engine missing. To install from the official repository: --install-docker"; fi
  if docker compose version >/dev/null 2>&1; then msg OK COMPOSE "$(docker compose version --short)" "$(docker compose version --short)"
  elif command -v docker >/dev/null; then fail E_COMPOSE_MISSING "Docker Compose v2 eklentisi yok (docker-compose-plugin)" "Docker Compose v2 plugin missing (docker-compose-plugin)"; fi

  # Our own proxy holding the port is not a conflict.
  ports_free "$PORT" "$TLS_PORT"

  for host in registry-1.docker.io registry.npmjs.org; do
    if ! getent hosts "$host" >/dev/null 2>&1; then msg WARN W_DNS "$host çözümlenemedi" "$host did not resolve"
    elif ! curl -sS -o /dev/null --max-time 8 "https://$host/" 2>/dev/null; then msg WARN W_OUTBOUND "$host adresine HTTPS ile ulaşılamadı" "$host not reachable over HTTPS"
    else msg OK NET "$host" "$host"; fi
  done
}

install_docker() {
  [ "$(id -u)" = 0 ] || die 13 E_DOCKER_MISSING "Docker kurulumu için root gerekir" "Installing Docker requires root"
  msg INFO DOCKER_INSTALL "Docker resmî apt deposundan kuruluyor (docs.docker.com/engine/install/ubuntu)" "Installing Docker from the official apt repository (docs.docker.com/engine/install/ubuntu)"
  apt-get update -qq && apt-get install -y -qq ca-certificates curl >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq && apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
}

# Cloud images (Hetzner's, and others) let cloud-init react to a new network interface. A container's interface is
# virtual and not in the provider's metadata, yet its random address now and then matches the provider's rule
# (Hetzner: every address that starts with 86). cloud-init then fails on it and leaves cloud-init-hotplugd.service
# "failed", which Admin → System reports as something to look at. Virtual interfaces are skipped; real ones are
# handled as before. Written once, and only where the unit reads its arguments the way this replacement does.
quiet_hotplug() {
  { [ "$(id -u)" = 0 ] && command -v systemctl >/dev/null; } || return 0
  hp=/etc/systemd/system/cloud-init-hotplugd.service.d
  [ ! -f "$hp/10-lightning-vm.conf" ] || return 0
  systemctl cat cloud-init-hotplugd.service 2>/dev/null | grep -q 'read args <&3' || return 0
  mkdir -p "$hp"
  cat > "$hp/10-lightning-vm.conf" <<'EOF'
# Written by Lightning VM (scripts/install.sh). Container interfaces (Docker, Incus: /devices/virtual/net/veth*)
# are not in the cloud provider's metadata; cloud-init fails on them and this unit stays "failed".
# They are skipped here; real hardware is still handled. Remove this file to get the original behaviour back.
[Service]
ExecStart=
ExecStart=/bin/bash -c 'read args <&3; echo "args=$args"; case "$args" in *--devpath=/devices/virtual/*) exit 0;; esac; exec /usr/bin/cloud-init devel hotplug-hook $args'
EOF
  systemctl daemon-reload
  systemctl reset-failed cloud-init-hotplugd.service >/dev/null 2>&1 || true
  msg OK HOTPLUG_QUIET "cloud-init artık kapsayıcı ağ arayüzlerini atlıyor (cloud-init-hotplugd uyarısı)" "cloud-init now skips container network interfaces (the cloud-init-hotplugd warning)"
}

# Creates .env once and only appends missing keys later: existing secrets and settings are never replaced.
write_env() {
  (umask 077; touch .env)
  chmod 600 .env
  for key in POSTGRES_PASSWORD REDIS_PASSWORD GRAFANA_PASSWORD; do
    grep -q "^$key=" .env || printf '%s=%s\n' "$key" "$(openssl rand -hex 24)" >> .env
  done
  grep -q '^POSTGRES_DB=' .env || echo 'POSTGRES_DB=lightning' >> .env
  grep -q '^POSTGRES_USER=' .env || echo 'POSTGRES_USER=lightning' >> .env
  grep -q '^LISTEN_ADDRESS=' .env || echo 'LISTEN_ADDRESS=127.0.0.1' >> .env
  grep -q '^HTTP_PORT=' .env || echo 'HTTP_PORT=8080' >> .env
  if grep -q CHANGE_ME .env; then die 17 E_ENV_PLACEHOLDER ".env örnek parola (CHANGE_ME) içeriyor; değiştirin" ".env contains a placeholder password (CHANGE_ME); replace it"; fi
}

# Encryption key for stored VMware credentials and the API<->adapter token. Created once, never
# replaced: a new master key would make every stored VMware password unreadable. Containers run as
# uid 1000, so the files belong to that uid and nobody else can read them. Back them up (docs/vmware.md).
write_secrets() {
  (umask 077; mkdir -p secrets)
  chmod 700 secrets
  [ -s secrets/master.key ] || (umask 077; openssl rand -base64 32 > secrets/master.key)
  [ -s secrets/vmware.token ] || (umask 077; openssl rand -hex 32 > secrets/vmware.token)
  # Backups are encrypted with this key; it stays with the installing user, containers never read it.
  if [ ! -s secrets/backup.key ]; then
    (umask 077; openssl rand -base64 48 > secrets/backup.key); chmod 400 secrets/backup.key
    msg WARN BACKUP_KEY "secrets/backup.key oluşturuldu: bu sunucunun dışında güvenli bir yere kopyalayın, o olmadan yedekler açılamaz" "secrets/backup.key created: copy it somewhere safe off this server, backups cannot be opened without it"
  fi
  if [ "$(id -u)" = 0 ]; then chown 1000:1000 secrets/master.key secrets/vmware.token
  elif [ "$(id -u)" != 1000 ]; then die 17 E_SECRETS_OWNER "secrets/ dosyaları uid 1000'e ait olmalı; kurulumu sudo ile çalıştırın" "secrets/ files must belong to uid 1000; run the installer with sudo"; fi
  chmod 400 secrets/master.key secrets/vmware.token
}

install_state() {
  if [ ! -f .env ]; then msg INFO STATE "Kurulum yok (.env bulunmadı)" "Not installed (.env not found)"; return; fi
  perms=$(stat -c %a .env)
  if [ "$perms" = 600 ]; then msg OK ENV_FILE ".env (600)" ".env (600)"; else msg WARN W_ENV_PERMS ".env izinleri $perms; 600 olmalı" ".env permissions $perms; should be 600"; fi
  if ! docker compose ps >/dev/null 2>&1; then return; fi
  running=$(docker compose ps --status running --format '{{.Service}}' 2>/dev/null | sort | tr '\n' ' ')
  msg INFO SERVICES "Çalışan: ${running:-yok}" "Running: ${running:-none}"
  if local_get /api/ready >/dev/null 2>&1; then msg OK READY "/api/ready" "/api/ready"
  else msg WARN W_NOT_READY "API hazır değil; devam etmek için: sh scripts/install.sh" "API not ready; to resume: sh scripts/install.sh"; fi
  status=$(local_get /api/setup/status 2>/dev/null || true)
  case "$status" in
    *'"completed":true'*) msg OK SETUP "Kurulum sihirbazı tamamlandı" "Setup wizard completed" ;;
    *'"adminCreated":true'*) msg INFO SETUP "Yönetici var; sihirbaz tamamlanmadı (/setup)" "Admin exists; wizard not finished (/setup)" ;;
    *'"adminCreated":false'*) msg INFO SETUP "Yönetici yok; kurulum anahtarı için: sh scripts/install.sh" "No admin yet; for a setup token run: sh scripts/install.sh" ;;
  esac
}

# Separate results: a resolving name says nothing about HTTP reachability or the certificate.
dns_report() {
  v4=$(getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')
  v6=$(getent ahostsv6 "$1" 2>/dev/null | awk '$1 !~ /^::ffff:/ {print $1}' | sort -u | tr '\n' ' ')
  local4=$(ip -4 -o addr show scope global 2>/dev/null | awk '{sub(/\/.*/, "", $4); print $4}' | tr '\n' ' ')
  if [ -z "$v4" ]; then fail E_DNS_NO_A "DNS: $1 için A kaydı yok" "DNS: no A record for $1"
  else
    matched=0; for a in $v4; do case " $local4 " in *" $a "*) matched=1 ;; esac; done
    if [ "$matched" = 1 ]; then msg OK DNS "$1 -> $v4" "$1 -> $v4"
    else msg WARN W_DNS_NOT_LOCAL "DNS: $1 -> $v4; bu sunucunun adresleri: $local4 (NAT ise port yönlendirmesi gerekir)" "DNS: $1 -> $v4; this server's addresses: $local4 (behind NAT, forward the ports)"; fi
  fi
  if [ -n "$v6" ] && ! ip -6 -o addr show scope global 2>/dev/null | grep -q .; then
    msg WARN W_AAAA_NO_IPV6 "DNS: AAAA kaydı var ($v6) ama sunucuda genel IPv6 yok; AAAA kaydını kaldırın" "DNS: AAAA record exists ($v6) but the server has no global IPv6; remove the AAAA record"
  fi
}

web_report() {
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://$1/" 2>/dev/null || true)
  case "$code" in
    30[1278]) msg OK HTTP "http://$1 -> HTTPS yönlendirmesi ($code)" "http://$1 -> HTTPS redirect ($code)" ;;
    2??) msg OK HTTP "http://$1 ($code)" "http://$1 ($code)" ;;
    *) fail E_HTTP_UNREACHABLE "HTTP: http://$1 erişilemiyor (kod ${code:-yok}); 80 portu dışarıdan açık mı?" "HTTP: http://$1 unreachable (code ${code:-none}); is port 80 open from outside?" ;;
  esac
  if curl -fsS -o /dev/null --max-time 10 "https://$1/api/ready" 2>/dev/null; then
    msg OK CERT "https://$1: geçerli sertifika" "https://$1: valid certificate"
  elif issuer=$(echo | openssl s_client -connect "$1:443" -servername "$1" 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null) && [ -n "$issuer" ]; then
    case "$issuer" in
      *STAGING*) msg WARN W_CERT_STAGING "Sertifika: Let's Encrypt staging (tarayıcılar güvenmez; test için doğru)" "Certificate: Let's Encrypt staging (browsers do not trust it; expected for testing)" ;;
      *) fail E_CERT_INVALID "Sertifika doğrulanamadı: $issuer" "Certificate could not be verified: $issuer" ;;
    esac
  else fail E_CERT_MISSING "Sertifika alınamadı; docker compose logs proxy" "No certificate yet; docker compose logs proxy"; fi
}

# ---- Backup, restore and update -------------------------------------------------------------------
# Results go to data/maintenance/history.jsonl (one JSON line each). The admin panel and Prometheus
# read that file through a read-only mount, so it is written even when the API is down.

# The checkout often belongs to the user who cloned it while this runs with sudo; trust only this directory.
git() { command git -c safe.directory="$(pwd)" "$@"; }

app_version() {
  git describe --tags --always 2>/dev/null || sed -n 's/^  "version": "\(.*\)",$/v\1/p' apps/api/package.json | head -n 1
}

# Snapshots of this server for the panel (service logs, processes, packages, what a request printed): for root
# and the API container's user (gid 1000, as for the request directory), not for every local account.
panel_file() { # file
  if [ "$(id -u)" = 0 ] && chgrp 1000 "$1" 2>/dev/null; then chmod 640 "$1"; else chmod 644 "$1"; fi
}
# A snapshot is never readable by more than that, not for a moment, and never written through a name that is
# already there (a link under that name would send root's write, and the chgrp and chmod above, to another
# file). panel_new makes an empty file next to the final name that only its maker can open (mktemp: created
# exclusively, mode 600, a name nobody can prepare); the caller fills it; panel_put gives it its group and
# mode and renames it onto the final name, which replaces whatever is there without opening it. A directory
# under the final name is refused: mv would put the file inside it.
panel_new() { # final name
  # What a run that was killed left behind (an hour old: no snapshot takes that long).
  find "${1%/*}" -maxdepth 1 -type f -name "${1##*/}.??????" -mmin +60 -exec rm -f {} + 2>/dev/null || true
  PANEL_TMP=$(mktemp "$1.XXXXXX")
}
panel_put() { # final name
  if [ -d "$1" ]; then rm -f "$PANEL_TMP"; PANEL_TMP=""; return 1; fi
  panel_file "$PANEL_TMP"; mv -f "$PANEL_TMP" "$1"; PANEL_TMP=""
}

# data/maintenance is where root writes for the panel, by name. Root does that only in a directory that is
# its own: a real directory (not a link), root's, that group and others cannot write. Otherwise whoever can
# write there puts a link, a FIFO or a directory under a name root is about to write, and root's write lands
# in any file on this server, waits forever, or the lock below is not a lock. A directory that a run without
# root made earlier (or anybody else) is taken over first: every directory in it from the top down, then
# everything that is neither a plain file nor a directory goes, and so does a file with a second name.
maint_dir() { # [directory]
  md=${1:-data/maintenance}
  if [ "$(id -u)" != 0 ]; then (umask 022; mkdir -p "$md"); return 0; fi
  [ ! -L "$md" ] || die 21 E_MAINT_DIR "$md bir bağlantı; gerçek bir dizin olmalı (kaldırın ve yeniden deneyin)" "$md is a link; it must be a real directory (remove it and try again)"
  (umask 022; mkdir -p "$md")
  [ -n "$(find "$md" -maxdepth 0 \( ! -user 0 -o -perm /022 \) 2>/dev/null)" ] || return 0
  msg WARN W_MAINT_DIR "$md root'a ait değildi ya da başkaları yazabiliyordu: sahipliği alındı, içindeki bağlantılar ve özel dosyalar silindi" "$md was not root's or others could write it: taken over, links and special files in it removed"
  find "$md" -xdev -type d -exec chown -h 0 {} \; -exec chmod go-w {} \;
  find "$md" -xdev \( ! -type f ! -type d -o -type f -links +1 \) -exec rm -f {} +
  find "$md" -xdev -type f -exec chown -h 0 {} +
  [ -z "$(find "$md" -maxdepth 0 \( ! -user 0 -o -perm /022 \) 2>/dev/null)" ] ||
    die 21 E_MAINT_DIR "$md root'a ait yapılamadı" "$md could not be made root's"
}

record() { # kind status code [extra JSON fields, each starting with a comma]
  maint_dir
  printf '{"time":"%s","kind":"%s","status":"%s","code":"%s","version":"%s"%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" "$(app_version)" "${4:-}" >> data/maintenance/history.jsonl
  tail -n 500 data/maintenance/history.jsonl > data/maintenance/history.tmp && mv data/maintenance/history.tmp data/maintenance/history.jsonl
  chmod 644 data/maintenance/history.jsonl
}

write_settings() {
  if [ -n "$(env_value BACKUP_COPY_TO)" ]; then copy=on; else copy=off; fi
  if [ -f /etc/systemd/system/lightning-vm-maintenance.timer ]; then timer=on; else timer=off; fi
  if [ -f /etc/systemd/system/lightning-vm-requests.path ]; then agent=on; else agent=off; fi
  b=$(env_value BACKUP_SCHEDULE); k=$(env_value BACKUP_KEEP); a=$(env_value AUTO_UPDATE); c=$(env_value UPDATE_CHANNEL); w=$(env_value UPDATE_WINDOW); br=$(env_value UPDATE_BRANCH)
  maint_dir
  site=$(env_value PANEL_SITE); tlsm=$(env_value PANEL_TLS_MODE)
  printf '{"schedule":"%s","backupSchedule":"%s","backupKeep":"%s","backupCopy":"%s","autoUpdate":"%s","updateChannel":"%s","updateWindow":"%s","updateBranch":"%s","agent":"%s","site":"%s","tlsMode":"%s"}\n' \
    "$timer" "${b:-daily}" "${k:-7}" "$copy" "${a:-off}" "${c:-stable}" "${w:-03:00-05:00}" "${br:-main}" "$agent" "${site:-:80}" "${tlsm:-}" > data/maintenance/settings.json
  request_dir
}

# The panel (API container, user node = uid 1000) drops requests here; only that user and root can write.
request_dir() {
  mkdir -p data/maintenance-requests
  if [ "$(id -u)" = 0 ]; then chown 1000:1000 data/maintenance-requests; chmod 700 data/maintenance-requests; fi
}

# JSON string from stdin: escapes \ and ", turns newlines into \n and drops other control characters.
json_str() { awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/[[:cntrl:]]/, " "); if (NR > 1) print "\\n"; print }'; }

# Operator-owned monitoring settings live in data/observability, outside git, so editing them never
# blocks an update. Existing files are kept.
write_observability() {
  (umask 022; mkdir -p data/observability)
  [ -f data/observability/alertmanager.yml ] || cp deploy/observability/alertmanager.example.yml data/observability/alertmanager.yml
}

# COMPOSE_PROFILES in .env lists every profile that is on (observability,terminal): this is the list without one.
profiles_without() { env_value COMPOSE_PROFILES | tr ',' '\n' | grep -vx "$1" | grep -v '^$' | paste -sd, - || true; }

psql_value() { docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"$1\""; }
# SQL from standard input with two values of the caller as the psql variables v1 and v2: :'v1' in the SQL is that
# value as a literal, whatever characters it holds. The values travel as the container's environment, never as
# part of the SQL text or of a shell command. Stops at the first statement that fails.
psql_script() { # v1 v2
  docker compose exec -T -e LVM_V1="$1" -e LVM_V2="$2" postgres sh -c 'psql -q -At -v ON_ERROR_STOP=1 -v v1="$LVM_V1" -v v2="$LVM_V2" -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}

# One maintenance job at a time: a backup, update or restore started by hand waits for the hourly timer or a
# panel request to finish (and they for it). The timer and run-requests already hold the lock when they get
# here or start this script again (LVM_LOCKED): waiting for it then would be waiting for ourselves.
# The lock file is its maker's alone, from the moment it exists (mode 600, made under umask 077): whoever can
# open it, even only to read, can hold the lock and keep every backup and update waiting. So only a plain file
# with one name, the caller's own and closed to everyone else is a lock; anything else under that name (a link,
# a FIFO that would block the open, a directory, a file an older version left readable) is removed and made
# anew. Made in a subshell: a redirection that fails on exec ends the whole script.
LOCK=data/maintenance/.lock
lock_file() {
  if [ -L "$LOCK" ] || { [ -e "$LOCK" ] && [ ! -f "$LOCK" ]; }; then rm -rf "$LOCK" 2>/dev/null || return 1; fi
  if [ -f "$LOCK" ] && [ -z "$(find "$LOCK" -maxdepth 0 -user "$(id -u)" -perm 600 -links 1 2>/dev/null)" ]; then
    rm -f "$LOCK" 2>/dev/null || return 1
  fi
  (umask 077; : >> "$LOCK") 2>/dev/null || return 1
}
lock_id() { stat -Lc %d:%i "$1" 2>/dev/null || true; }
# Process id of this very shell ($$ is the main script's also inside a subshell).
self_pid() { exec sh -c 'echo "$PPID"'; }
# Opens the lock as descriptor 9 and takes it: "wait" waits for the job that holds it, "try" returns 1 then.
# 2: the lock file could not be made. The lock is the file the name stands for at the moment it is held: a job
# removes the file when it ends (drop_lock), so after waiting the name is compared with what was locked and,
# when it moved on, the new file is taken instead.
hold_lock() { # wait|try
  while :; do
    lock_file || return 2
    lock_umask=$(umask); umask 077; exec 9>> "$LOCK"; umask "$lock_umask"
    if ! flock -n 9; then
      if [ "$1" = try ]; then exec 9>&-; return 1; fi
      msg INFO LOCK_WAIT "Başka bir bakım işi (yedek, güncelleme veya panel isteği) çalışıyor; bitmesi bekleniyor" "Another maintenance job (backup, update or a panel request) is running; waiting for it to finish"
      flock 9
    fi
    lock_held=$(lock_id "/proc/$$/fd/9")
    if [ -z "$lock_held" ] || [ "$lock_held" = "$(lock_id "$LOCK")" ]; then break; fi
    exec 9>&-
  done
  LOCK_MINE=$(self_pid)
  LVM_LOCKED=1; export LVM_LOCKED
}
# The lock file goes with the job that held it (only that shell removes it, not a subshell of it and not a
# script it started, and only while the name still stands for the file it locked). The next job makes its own
# file, so a descriptor somebody opened on an earlier one, when it was readable, holds nothing any more.
drop_lock() {
  [ -n "$LOCK_MINE" ] && [ "$LOCK_MINE" = "$(self_pid)" ] || return 0
  lock_held=$(lock_id "/proc/$$/fd/9")
  if [ -n "$lock_held" ] && [ "$lock_held" = "$(lock_id "$LOCK")" ]; then rm -f "$LOCK"; fi
  LOCK_MINE=""
}
take_lock() {
  [ -z "${LVM_LOCKED:-}" ] || return 0
  command -v flock >/dev/null || return 0
  maint_dir
  # Without root the lock may be root's and closed to this user: the job runs unlocked, as before. Root's own
  # jobs never run without it.
  hold_lock wait || { [ "$(id -u)" != 0 ] || die 21 E_LOCK "Bakım kilidi alınamadı ($LOCK)" "Could not take the maintenance lock ($LOCK)"; }
}

# A backup is proven with the backup key, not with a checksum anybody can recompute: NAME.tar.enc.hmac holds an
# HMAC-SHA256 (RFC 2104) over the file's own name and the encrypted archive, keyed with a key derived from
# secrets/backup.key. The name carries the time of the backup and is part of what is signed, so an older
# backup renamed as a newer one does not pass. openssl would compute this only with the key on its command
# line, where every local account can read it in the process list; here the key stays in shell variables,
# printf (a builtin of sh) and pipes into sha256sum.
hex_bytes() { # hex digits, number: the bytes those digits stand for, each XORed with the number
  hb=$1
  while [ -n "$hb" ]; do
    hb_rest=${hb#??}
    # shellcheck disable=SC2059 # the format is the byte itself, as an octal escape
    printf "\\$(printf '%03o' $((0x${hb%"$hb_rest"} ^ $2)))"
    hb=$hb_rest
  done
}
backup_mac() { # file: prints its HMAC under its own name; fails when the key or the file cannot be read
  { [ -s secrets/backup.key ] && [ -r "$1" ]; } || return 1
  # Captured with its errors: sha256sum's "<64 hex digits>  -" and nothing else, or something could not be read.
  mac_key=$({ { printf 'lightning-vm backup mac v1\n'; cat secrets/backup.key; } | sha256sum; } 2>&1) || return 1
  [ ${#mac_key} = 67 ] || return 1
  # HMAC's key block is 64 bytes: the 32 of the key, then zeros. 54 and 92 are its two pads (0x36, 0x5c).
  mac_key=${mac_key%% *}; mac_zero=0000000000000000000000000000000000000000000000000000000000000000
  mac_in=$({ { hex_bytes "$mac_key" 54; hex_bytes "$mac_zero" 54; printf '%s\n' "${1##*/}"; cat "$1"; } | sha256sum; } 2>&1) || return 1
  [ ${#mac_in} = 67 ] || return 1
  mac_out=$({ hex_bytes "$mac_key" 92; hex_bytes "$mac_zero" 92; hex_bytes "${mac_in%% *}" 0; } | sha256sum) || return 1
  mac_key=""
  echo "${mac_out%% *}"
}
backup_signed() { # file: true when FILE.hmac holds this installation's HMAC for that file under that name
  sig_want=$(backup_mac "$1") || return 1
  sig_got=$(sed -n '1s/ .*//p' "$1.hmac" 2>/dev/null) || return 1
  [ ${#sig_want} = 64 ] && [ "$sig_want" = "$sig_got" ]
}

# PostgreSQL (custom-format dump), .env, the encryption keys, Caddy's certificates and your own certificate
# (custom TLS), in one tar encrypted with secrets/backup.key and signed with it (NAME.tar.enc.hmac).
# Redis is not included: it holds only queue copies and sessions; open operations are queued again from PostgreSQL.
# Its variables are prefixed or private to it: restore calls it while holding its own.
# Every caller runs it in a `||` list, where `set -e` does not apply: each step is checked here, and a step
# that fails ends the backup with nothing half-written left behind and nothing older deleted.
do_backup() { # reason
  reason=$1; BACKUP_FILE=""
  dir=$(env_value BACKUP_DIR); dir=${dir:-backups}
  keep=$(env_value BACKUP_KEEP); keep=${keep:-7}
  [ -s secrets/backup.key ] || { record backup failed E_BACKUP_KEY_MISSING ",\"reason\":\"$reason\""; die 21 E_BACKUP_KEY_MISSING "secrets/backup.key yok; önce: sh scripts/install.sh" "secrets/backup.key missing; run first: sh scripts/install.sh"; }
  name="lightning-$(date -u +%Y%m%dT%H%M%SZ)"; bwork="$dir/.work-$$"; bout="$dir/$name.tar.enc"
  backup_failed() { # code
    rm -rf "$bwork"; BACKUP_WORK=""; rm -f "$bout" "$bout.hmac"; record backup failed "$1" ",\"reason\":\"$reason\""
  }
  # The work directory holds the database, .env and the keys unencrypted: it goes away however this ends,
  # and what a run that was killed outright left behind (its process is gone) goes away now.
  BACKUP_WORK=$bwork; arm_exit
  for stale in "$dir"/.work-*; do
    [ -d "$stale" ] || continue
    { [ "$stale" != "$bwork" ] && kill -0 "${stale##*/.work-}" 2>/dev/null; } || rm -rf "$stale"
  done
  { (umask 077; mkdir -p "$dir") && (umask 077; mkdir "$bwork"); } || {
    backup_failed E_BACKUP_WRITE; msg FAIL E_BACKUP_WRITE "Yedek klasörüne yazılamadı: $dir (disk dolu olabilir)" "Could not write to the backup directory: $dir (the disk may be full)"; return 1; }
  if ! docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$bwork/db.dump" 2>/dev/null || [ ! -s "$bwork/db.dump" ]; then
    backup_failed E_BACKUP_DB; msg FAIL E_BACKUP_DB "Veritabanı yedeği alınamadı; postgres çalışıyor mu?" "Database dump failed; is postgres running?"; return 1
  fi
  {
    psql_value 'SELECT version FROM schema_migrations ORDER BY 1' > "$bwork/migrations" && [ -s "$bwork/migrations" ] &&
    app_version > "$bwork/version" &&
    cp .env "$bwork/env" && cp secrets/master.key secrets/vmware.token "$bwork/" &&
    { [ ! -f data/observability/alertmanager.yml ] || cp data/observability/alertmanager.yml "$bwork/"; } &&
    # Your own certificate (domain --tls custom) exists nowhere else; Caddy's own ones are in caddy_data.tgz.
    { [ ! -f data/tls/cert.pem ] || { cp data/tls/cert.pem "$bwork/tls_cert.pem" && cp data/tls/key.pem "$bwork/tls_key.pem"; }; }
  } || {
    backup_failed E_BACKUP_WRITE; msg FAIL E_BACKUP_WRITE "Yedeğe girecek dosyalar toplanamadı (disk dolu olabilir)" "The files for the backup could not be collected (the disk may be full)"; return 1; }
  docker compose exec -T proxy tar -C /data -czf - . > "$bwork/caddy_data.tgz" 2>/dev/null || rm -f "$bwork/caddy_data.tgz"
  # Named one by one: the archive then holds them in this order, which the comparison below relies on.
  bfiles=$(cd "$bwork" && ls)
  # shellcheck disable=SC2086 # one argument per file; the names are ours and have no spaces
  tar -C "$bwork" -cf - $bfiles | (umask 077; openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass file:secrets/backup.key -out "$bout") || {
    backup_failed E_BACKUP_WRITE; msg FAIL E_BACKUP_WRITE "Yedek dosyası yazılamadı (disk dolu olabilir)" "The backup file could not be written (the disk may be full)"; return 1; }
  # Read it back before calling it a backup, and before anything older is deleted: what comes out of the
  # encrypted file must be every byte that went in. Listing it is not enough, a cut-off archive still lists.
  # shellcheck disable=SC2086
  bwant=$(cd "$bwork" && cat $bfiles | sha256sum)
  bgot=$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:secrets/backup.key -in "$bout" 2>/dev/null | tar -xOf - 2>/dev/null | sha256sum)
  # e3b0c442…: the checksum of nothing at all, which two failed reads would agree on.
  case "$bwant" in ''|e3b0c44298fc1c14*) bgot=unreadable ;; esac
  if [ "$bwant" != "$bgot" ]; then
    backup_failed E_BACKUP_VERIFY
    msg FAIL E_BACKUP_VERIFY "Yedek dosyası geri okunamadı (disk dolu olabilir)" "The backup file could not be read back (the disk may be full)"; return 1
  fi
  rm -rf "$bwork"; BACKUP_WORK=""
  # The signature, and proof that restore will accept it: a backup whose signature does not verify is no backup.
  { bmac=$(backup_mac "$bout") && [ ${#bmac} = 64 ] && (umask 077; printf '%s  %s\n' "$bmac" "$name.tar.enc" > "$bout.hmac") && backup_signed "$bout"; } || {
    backup_failed E_BACKUP_WRITE; msg FAIL E_BACKUP_WRITE "İmza dosyası yazılamadı (disk dolu olabilir)" "The signature file could not be written (the disk may be full)"; return 1; }
  # Retention: the newest $keep local backups stay; the external copy keeps its own policy. Skipped before a
  # restore: the backup being restored may be the oldest one here and must outlive its own restore.
  if [ "$reason" != pre-restore ]; then
    set -- "$dir"/lightning-*.tar.enc # glob order is name order, and the names are UTC timestamps
    while [ $# -gt "$keep" ]; do rm -f "$1" "$1.hmac" "$1.sha256"; shift; done # .sha256: backups of older versions
  fi
  bytes=$(stat -c %s "$bout"); copied=false; copy_to=$(env_value BACKUP_COPY_TO)
  BACKUP_FILE=$bout
  if [ -n "$copy_to" ]; then
    if rsync -a "$bout" "$bout.hmac" "$copy_to/" 2>/dev/null; then copied=true
    else
      record backup failed E_BACKUP_COPY ",\"reason\":\"$reason\",\"file\":\"$name.tar.enc\",\"bytes\":$bytes,\"copied\":false"
      msg WARN E_BACKUP_COPY "Yedek yerelde alındı ama $copy_to hedefine kopyalanamadı" "Backup written locally but not copied to $copy_to"
      return 1
    fi
  fi
  record backup ok - ",\"reason\":\"$reason\",\"file\":\"$name.tar.enc\",\"bytes\":$bytes,\"copied\":$copied"
  msg OK BACKUP "$bout ($bytes bayt)" "$bout ($bytes bytes)"
}

# A restored database is older than the hypervisors, the payment providers and the people it describes. Before any
# service starts on it, every session is ended (someone signed out since the backup is not signed in again) and,
# unless --no-hold was given, the panel is put on hold: the API and the worker read the 'restore_hold' row and do
# nothing by themselves until an administrator releases it. One transaction; prints what it did, and
# LVM_HOLD_DONE only when all of it is committed. A backup from before the hold existed has no table for it yet.
restore_hold() { # backup file name, 1 (hold) or 0 (--no-hold)
  psql_script "$1" "$2" 2>/dev/null <<'SQL'
BEGIN;
SELECT to_regclass('public.maintenance_state') IS NOT NULL AS has_hold, to_regclass('public.auth_sessions') IS NOT NULL AS has_sessions \gset
\if :has_sessions
DELETE FROM public.auth_sessions;
\echo LVM_SESSIONS_ENDED
\endif
\if :v2
\if :has_hold
INSERT INTO public.maintenance_state (key, value) VALUES ('restore_hold', jsonb_build_object('backup', :'v1', 'restored_at', now()))
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = now();
\echo LVM_HOLD_SET
\else
\echo LVM_HOLD_NO_TABLE
\endif
\endif
COMMIT;
\echo LVM_HOLD_DONE
SQL
}

# What the operator has to know after a restore; printed whether or not the services came up.
restore_notes() { # what restore_hold printed
  case "$1" in *LVM_SESSIONS_ENDED*)
    msg INFO RESTORE_SESSIONS "Tüm oturumlar kapatıldı: herkes yeniden giriş yapar" "Every session was ended: everyone signs in again" ;;
  esac
  case "$1" in
    *LVM_HOLD_SET*)
      msg WARN RESTORE_HOLD "Panel BEKLEMEDE: siz serbest bırakana kadar geri yüklenen duruma göre kendiliğinden hiçbir şey yapmaz (açık işlemler, ödenmemiş siparişler, zamanlanmış silmeler ve ödeme hatırlatmaları bekler). Serbest bırakmadan önce şunlara bakın:" "The panel is ON HOLD: until you release it, it does nothing by itself from the restored state (open operations, unpaid orders, scheduled deletions and payment reminders wait). Before you release it, check:" ;;
    *LVM_HOLD_NO_TABLE*)
      msg WARN W_RESTORE_NO_HOLD "Bu yedek, bekletme özelliğinden önceki bir sürümden ve şeması önceden güncellenemedi: panel eski duruma göre HEMEN işlem yapar (açık işlemler yeniden çalışır, ödenmemiş siparişler iptal edilir, zamanlanmış silmeler yapılır). Şimdi şunlara bakın:" "This backup is from before the restore hold existed and its schema could not be brought up to date first: the panel acts on the old state AT ONCE (open operations run again, unpaid orders are cancelled, scheduled deletions are carried out). Check now:" ;;
    *)
      msg WARN W_RESTORE_NO_HOLD "--no-hold: panel bekletilmedi, geri yüklenen duruma göre hemen işlem yapar. Şunlara bakın:" "--no-hold: the panel is not on hold and acts on the restored state at once. Check:" ;;
  esac
  msg INFO RESTORE_CHECK "1. Yedekten sonra oluşturulan veya silinen sunucular: panel onları yedekteki haliyle bilir. Yönetim → Sistem, mutabakatın (reconcile) bulduklarını listeler" "1. Servers created or deleted since the backup: the panel knows them as they were then. Admin → System lists what reconcile found"
  msg INFO RESTORE_CHECK "2. Yedekten sonra yapılan ödemeler geri yüklenen veride yok: ödeme sağlayıcınızla karşılaştırıp kaydedin, yoksa ödedikleri sipariş ve faturalar ödenmemiş sayılır" "2. Payments made since the backup are not in the restored data: compare with your payment provider and record them, or the orders and invoices they paid count as unpaid"
  msg INFO RESTORE_CHECK "3. Yedekten sonra silinen API anahtarları, yasaklar, kapatılan hesaplar, rol ve parola değişiklikleri yedek anındaki haline döndü: yeniden silin, yasaklayın, değiştirin" "3. API tokens deleted, bans, disabled accounts, role and password changes made since the backup are back as they were at backup time: delete, ban and change them again"
  case "$1" in *LVM_HOLD_SET*)
    msg INFO RESTORE_RELEASE "Serbest bırakmak için: Yönetim → Sistem, ya da: docker compose exec api node dist/cli.js release-restore-hold" "To release: Admin → System, or: docker compose exec api node dist/cli.js release-restore-hold" ;;
  esac
}

do_restore() {
  file=$RESTORE_FILE
  take_lock
  [ -f "$file" ] || die 2 E_RESTORE_FILE "Yedek dosyası bulunamadı: '$file'" "Backup file not found: '$file'"
  [ -s secrets/backup.key ] || die 21 E_BACKUP_KEY_MISSING "secrets/backup.key yok; yedeğin anahtarını oraya koyun" "secrets/backup.key missing; put the backup's key there"
  # One read of the archive. It is copied, under its own name (the name is part of what is signed) and with its
  # signature, into a work directory only root can open, and from here on only that copy is checked, decrypted
  # and unpacked: whoever can write where the backup is kept cannot put other bytes under the name between the
  # check and the use. The copy goes away however this ends (on_exit).
  work=$(mktemp -d); RESTORE_WORK=$work
  rin="$work/in/$(basename "$file")"
  { (umask 077; mkdir "$work/in") && cp -- "$file" "$rin"; } 2>/dev/null ||
    die 22 E_RESTORE_COPY "Yedek, çalışma klasörüne kopyalanamadı ($work; yer var mı?). Hiçbir şey değiştirilmedi" "The backup could not be copied to the work directory ($work; is there room for it?). Nothing was changed"
  for ext in hmac sha256; do
    [ ! -f "$file.$ext" ] || cp -- "$file.$ext" "$rin.$ext" 2>/dev/null ||
      die 22 E_RESTORE_COPY "$file.$ext çalışma klasörüne kopyalanamadı. Hiçbir şey değiştirilmedi" "$file.$ext could not be copied to the work directory. Nothing was changed"
  done
  # The signature comes before anything else: nothing of a file that this installation's key did not sign is
  # decrypted or unpacked. A signature that is there is always checked, whatever the flags say.
  if [ -f "$rin.hmac" ]; then
    backup_signed "$rin" || die 22 E_RESTORE_SIGNATURE "İmza tutmuyor: bu yedek bu secrets/backup.key ile yazılmamış ya da sonradan değiştirilmiş veya yeniden adlandırılmış (yedek, yazıldığı dosya adını korumalıdır). Hiçbir şey değiştirilmedi" "The signature does not match: this backup was not written with this secrets/backup.key, or it was changed or renamed afterwards (a backup must keep the file name it was written with). Nothing was changed"
  elif [ "$ALLOW_UNSIGNED" = 1 ]; then
    # A backup of an older version: only a checksum, which anyone who can write where it was kept can recompute.
    [ -f "$rin.sha256" ] || die 22 E_RESTORE_CHECKSUM "Sağlama dosyası yok: $file.sha256" "Checksum file missing: $file.sha256"
    (cd "$work/in" && sha256sum -c --quiet "$(basename "$file").sha256" >/dev/null 2>&1) || die 22 E_RESTORE_CHECKSUM "Sağlama tutmuyor; dosya bozuk veya değiştirilmiş" "Checksum mismatch; the file is damaged or was changed"
    msg WARN W_RESTORE_UNSIGNED "--allow-unsigned: bu yedeğin imzası yok; yalnızca sağlaması denetlendi, bu da dosyanın değiştirilmediğini kanıtlamaz" "--allow-unsigned: this backup has no signature; only its checksum was checked, which does not prove the file is unchanged"
  else
    die 22 E_RESTORE_UNSIGNED "İmza dosyası yok: $file.hmac. Eski sürümlerin aldığı yedeklerde yalnızca sağlama dosyası bulunur; onu yedek deposuna yazabilen herkes yeniden hesaplayabilir. Dosyanın saklandığı yere güveniyorsanız --allow-unsigned ekleyin. Hiçbir şey değiştirilmedi" "Signature file missing: $file.hmac. Backups made by older versions have only a checksum, which anyone who can write to the backup storage can recompute. If you trust where this file was kept, add --allow-unsigned. Nothing was changed"
  fi
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:secrets/backup.key -in "$rin" 2>/dev/null | tar -C "$work" -xf - 2>/dev/null; then
    rm -rf "$work"; die 22 E_RESTORE_DECRYPT "Yedek açılamadı: secrets/backup.key bu yedeğin anahtarı değil" "Backup could not be opened: secrets/backup.key is not this backup's key"
  fi
  rm -rf "$work/in" # unpacked: the copy has done its work
  for f in db.dump master.key vmware.token migrations; do
    [ -s "$work/$f" ] || { rm -rf "$work"; die 22 E_RESTORE_INCOMPLETE "Yedekte $f yok" "$f missing from the backup"; }
  done
  # The code must know every migration recorded in the backup: no restoring a newer schema into older code.
  while read -r v; do
    [ -f "apps/api/migrations/$v.sql" ] || { rm -rf "$work"; die 22 E_RESTORE_NEWER "Yedek daha yeni bir sürümden ($(cat "$work/version" 2>/dev/null)); önce o sürüme güncelleyin" "The backup is from a newer version ($(cat "$work/version" 2>/dev/null)); update to that version first"; }
  done < "$work/migrations"
  msg WARN RESTORE_PLAN "Şunlar DEĞİŞTİRİLECEK: tüm veritabanı, secrets/master.key, secrets/vmware.token ve sertifikalar ($(cat "$work/version" 2>/dev/null) yedeği)" "This REPLACES: the whole database, secrets/master.key, secrets/vmware.token and the certificates (backup of $(cat "$work/version" 2>/dev/null))"
  if [ "$YES" != 1 ]; then
    rm -rf "$work"
    msg INFO CONFIRM "Hiçbir şey değiştirilmedi. Onaylamak için --yes-replace-data ekleyin" "Nothing was changed. Add --yes-replace-data to confirm"
    exit 3
  fi
  # Nothing is stopped or dropped before the database answers and pg_restore itself has read the dump's
  # table of contents.
  docker compose exec -T postgres pg_isready -q >/dev/null 2>&1 || die 22 E_RESTORE_DB_DOWN "Veritabanı yanıt vermiyor; hiçbir şey değiştirilmedi. Önce: docker compose up -d postgres" "The database does not answer; nothing was changed. First: docker compose up -d postgres"
  docker compose exec -T postgres pg_restore -l < "$work/db.dump" >/dev/null 2>&1 || die 22 E_RESTORE_DUMP "Yedekteki veritabanı dökümü okunamıyor (pg_restore -l); hiçbir şey değiştirilmedi" "The database dump in the backup cannot be read (pg_restore -l); nothing was changed"
  safety=""
  if [ "$NO_SAFETY" = 1 ]; then
    msg WARN W_NO_SAFETY_BACKUP "--no-safety-backup: mevcut verinin yedeği ALINMIYOR; bu geri yükleme geri alınamaz" "--no-safety-backup: the current data is NOT backed up; this restore cannot be undone"
  else
    msg INFO SAFETY_BACKUP "Önce mevcut verinin yedeği alınıyor" "Backing up the current data first"
    do_backup pre-restore || true
    safety=${BACKUP_FILE:-}
    [ -n "$safety" ] || die 22 E_RESTORE_NO_SAFETY "Mevcut verinin yedeği alınamadı; geri yükleme yapılmadı. Yedeksiz devam etmek (geri dönüşü yoktur) için: --no-safety-backup" "The current data could not be backed up; nothing was restored. To go on without that backup (no way back): --no-safety-backup"
  fi
  # From here on the script does not end with the services down: see on_exit.
  RESTORE_STAGE=stopped
  docker compose stop api worker web console vmware proxmox xcpng ovirt hyperv libvirt incus proxy >/dev/null 2>&1 || true
  # One transaction: the old schema goes and the dump comes in, or nothing changes at all. psql ends quietly
  # when its input stops short, so COMMIT and the marker are sent only after pg_restore wrote the whole dump.
  restored=$(docker compose exec -T postgres sh -c '{ echo "BEGIN; DROP SCHEMA public CASCADE; CREATE SCHEMA public;"; pg_restore --no-owner -f - && printf "%s\n" "COMMIT;" "\\echo LVM_RESTORE_COMMITTED"; } | psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$work/db.dump" 2>/dev/null || true)
  case "$restored" in
    *LVM_RESTORE_COMMITTED*) ;;
    *) record restore failed E_RESTORE_DB ",\"file\":\"$(basename "$file")\""
      msg FAIL E_RESTORE_DB "Veritabanı geri yüklenemedi; işlem geri alındı${safety:+. Mevcut verinin yedeği: $safety}" "The database could not be restored; the transaction was rolled back${safety:+. Backup of the current data: $safety}"
      exit 22 ;;
  esac
  RESTORE_STAGE=replaced
  # First of all, before anything can start on the restored rows: sessions end and the panel goes on hold.
  rlabel=$(basename "$file" | tr -cd 'A-Za-z0-9._-' | cut -c 1-200)
  if [ "$NO_HOLD" = 1 ]; then rhold=0; else rhold=1; fi
  held=$(restore_hold "$rlabel" "$rhold" || true)
  case "$held" in *LVM_HOLD_NO_TABLE*)
    # A backup from before the hold existed: its schema is brought up to date now (the services would do the
    # same when they start), and then there is a table to write the hold to.
    if docker compose run --rm -T migrate </dev/null >/dev/null 2>&1; then held=$(restore_hold "$rlabel" "$rhold" || true); fi ;;
  esac
  case "$held" in
    *LVM_HOLD_DONE*) ;;
    *)
      if [ "$NO_HOLD" = 1 ]; then
        msg WARN W_RESTORE_SESSIONS "Oturumlar kapatılamadı: yedekteki oturumlar yeniden geçerli. Servisler açıldıktan sonra kullanıcıların oturumlarını panelden kapatın" "The sessions could not be ended: the sessions in the backup are valid again. End them from the panel once the services are up"
      else
        # The one case in which the services stay down: started now, they would act on the old state at once.
        RESTORE_STAGE=""
        record restore failed E_RESTORE_HOLD ",\"file\":\"$rlabel\""
        die 22 E_RESTORE_HOLD "Veritabanı artık YEDEKTEKİ veriyi içeriyor ama panel beklemeye alınamadı; eski duruma göre işlem yapmasın diye servisler BAŞLATILMADI (anahtarlar ve sertifikalar da henüz geri konmadı). Aynı restore komutunu yeniden çalıştırın; yine burada kalırsa --no-hold ekleyin ve paneli kendiniz denetleyin${safety:+. Önceki veri: $safety}" "The database now holds the BACKUP's data, but the panel could not be put on hold; so that it does not act on the old state, the services were NOT started (and the keys and certificates are not back yet). Run the same restore command again; if it stops here again, add --no-hold and review the panel yourself${safety:+. Previous data: $safety}"
      fi ;;
  esac
  # Redis still holds the newer state: queued jobs, locks, caches, one-time tickets. None of it belongs to the
  # restored database and all of it is made again (sessions are in PostgreSQL; open operations are queued again
  # from there), so the app's Redis database is emptied before anything starts.
  redis_db=$(env_value REDIS_DB)
  docker compose exec -T redis redis-cli -n "${redis_db:-0}" FLUSHDB >/dev/null 2>&1 ||
    msg WARN W_RESTORE_REDIS "Redis boşaltılamadı; eski kuyruk işleri kalmış olabilir: docker compose exec redis redis-cli FLUSHDB" "Redis could not be emptied; old queue jobs may remain: docker compose exec redis redis-cli FLUSHDB"
  # The stored VMware passwords are encrypted with the backup's master key: both keys come back with the data.
  for f in master.key vmware.token; do
    rm -f "secrets/$f"; cp "$work/$f" "secrets/$f"
    if [ "$(id -u)" = 0 ]; then chown 1000:1000 "secrets/$f"; fi
    chmod 400 "secrets/$f"
  done
  (umask 077; cp "$work/env" .env.from-backup)
  # Your own certificate comes back next to the current one, like .env: the domain step below puts it in place.
  tls_note=""
  if [ -s "$work/tls_cert.pem" ] && [ -s "$work/tls_key.pem" ]; then
    (umask 077; mkdir -p data/tls.from-backup; cp "$work/tls_cert.pem" data/tls.from-backup/cert.pem; cp "$work/tls_key.pem" data/tls.from-backup/key.pem)
    tls_note=" --tls custom --cert data/tls.from-backup/cert.pem --key data/tls.from-backup/key.pem"
  fi
  # The address the backup was served on, for the hint after the restore (the current .env is not changed).
  old_site=$(sed -n 's/^PANEL_SITE=//p' "$work/env" | tail -n 1)
  echo "$old_site" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' || old_site=""
  if [ -z "$tls_note" ] && [ "$(sed -n 's/^PANEL_TLS_MODE=//p' "$work/env" | tail -n 1)" = staging ]; then tls_note=" --tls staging"; fi
  if [ -f "$work/alertmanager.yml" ]; then cp "$work/alertmanager.yml" data/observability/alertmanager.yml.from-backup; fi
  if [ -s "$work/caddy_data.tgz" ]; then
    docker compose run --rm --no-deps -T --entrypoint sh proxy -c 'find /data -mindepth 1 -delete && tar -xzf - -C /data' < "$work/caddy_data.tgz" >/dev/null 2>&1 \
      || msg WARN W_RESTORE_CERTS "Sertifikalar geri yüklenemedi; Caddy yenilerini alır" "Certificates not restored; Caddy will request new ones"
  fi
  rm -rf "$work"; RESTORE_WORK=""; RESTORE_STAGE=""
  if docker compose up -d --wait --wait-timeout 300 >/dev/null 2>&1 && local_get /api/ready >/dev/null 2>&1; then
    record restore ok - ",\"file\":\"$(basename "$file")\""
    msg OK RESTORED "Geri yüklendi. Yedekteki ayarlar: .env.from-backup ve data/observability/alertmanager.yml.from-backup (geçerli ayarlar değiştirilmedi). Önceki veri: ${safety:--}" "Restored. Settings from the backup: .env.from-backup and data/observability/alertmanager.yml.from-backup (the current settings were kept). Previous data: ${safety:--}"
    # The address and the certificate mode live in .env, which a restore never replaces.
    if [ -n "$old_site" ] && [ "$old_site" != "$SITE" ]; then
      msg INFO NEXT "Yedek $old_site adresinde çalışıyordu, bu kurulum o adreste değil. Aynı adres için (DNS bu sunucuyu gösterdikten sonra): sudo sh scripts/install.sh domain $old_site$tls_note" "The backup was served on $old_site and this installation is not. For the same address (once DNS points to this server): sudo sh scripts/install.sh domain $old_site$tls_note"
    elif [ -n "$old_site" ] && [ "$tls_note" != "${tls_note#* custom }" ]; then
      msg INFO NEXT "Yedekteki kendi sertifikanız data/tls.from-backup altında; geçerli sertifika değiştirilmedi. Onu kullanmak için: sudo sh scripts/install.sh domain $old_site$tls_note" "Your own certificate from the backup is in data/tls.from-backup; the current certificate was kept. To use it: sudo sh scripts/install.sh domain $old_site$tls_note"
    fi
    restore_notes "$held"
  else
    record restore failed E_RESTORE_START ",\"file\":\"$(basename "$file")\""
    restore_notes "$held"
    die 22 E_RESTORE_START "Veri geri yüklendi ama servisler hazır değil: docker compose logs" "Data restored but services are not ready: docker compose logs"
  fi
}

# The timer starts in the first minutes of every hour (OnCalendar=hourly plus a random delay of up to five
# minutes), and a backup may run before the update is looked at. A window that holds no full hour followed by
# ten minutes (03:30-04:00, say) would never update, and nothing would say so.
window_fires() { # HH:MM-HH:MM
  echo "$1" | awk -F'[:-]' '{ s = $1 * 60 + $2; e = $3 * 60 + $4
    for (h = 0; h < 24; h++) { a = h * 60; b = a + 10
      if (s < e ? (a >= s && b < e) : (s > e && (a >= s || b < e))) exit 0 }
    exit 1 }'
}

in_window() { # HH:MM-HH:MM in local time, may wrap past midnight
  w=${1:-03:00-05:00}; now=$(date +%H%M); s=$(echo "${w%-*}" | tr -d :); e=$(echo "${w#*-}" | tr -d :)
  if [ "$s" -le "$e" ]; then [ "$now" -ge "$s" ] && [ "$now" -lt "$e" ]; else [ "$now" -ge "$s" ] || [ "$now" -lt "$e" ]; fi
}

tag_pattern() { # stable: vX.Y.Z only; beta: also vX.Y.Z-rc.1 and similar
  if [ "$1" = beta ]; then echo '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'; else echo '^v[0-9]+\.[0-9]+\.[0-9]+$'; fi
}
latest_tag() { git -c versionsort.suffix=- tag -l 'v[0-9]*' --sort=-v:refname | grep -E "$(tag_pattern "$1")" | head -n 1 || true; }
# edge: the tip of UPDATE_BRANCH on the remote (for test servers; not a release).
edge_ref() { b=$(env_value UPDATE_BRANCH); echo "$(git remote | head -n 1)/${b:-main}"; }
target_for() { if [ "$1" = edge ]; then git rev-parse -q --verify "$(edge_ref)^{commit}" 2>/dev/null || true; else latest_tag "$1"; fi; }

up_and_ready() {
  docker compose up -d --build --wait --wait-timeout 600 >/dev/null 2>&1 || return 1
  i=0; until local_get /api/ready >/dev/null 2>&1 || [ $i -ge 12 ]; do sleep 5; i=$((i + 1)); done
  local_get /api/ready >/dev/null 2>&1
}

# Source installs follow released git tags. Containers can be rolled back; the database cannot be
# rolled back automatically, so a backup is taken first and named in every failure message.
do_update() {
  # The hourly service comes through here whether or not automatic updates are on: with them off, or outside
  # the window, it ends before any check that can fail (no git checkout, a file edited by hand).
  if [ "$AUTO" = 1 ]; then
    [ "$(env_value AUTO_UPDATE)" = on ] || exit 0
    in_window "$(env_value UPDATE_WINDOW)" || exit 0
  fi
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die 20 E_UPDATE_NO_GIT "Güncelleme, git ile alınmış kaynak gerektirir (git clone)" "Updating needs a source checkout made with git clone"
  [ -f .env ] || die 17 E_NOT_INSTALLED "Önce kurulum yapın: sh scripts/install.sh" "Install first: sh scripts/install.sh"
  quiet_hotplug # servers installed before this fix get it with their next update
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die 20 E_UPDATE_LOCAL_CHANGES "Kaynakta yerel değişiklikler var (git status); güncelleme yapılmadı" "The source has local changes (git status); not updating"
  channel=$(env_value UPDATE_CHANNEL); channel=${channel:-stable}
  take_lock
  if [ -n "$(git remote)" ]; then
    git fetch --quiet --tags --force "$(git remote | head -n 1)" 2>/dev/null || { record update failed E_UPDATE_FETCH; die 20 E_UPDATE_FETCH "Sürümler alınamadı (git fetch)" "Could not fetch releases (git fetch)"; }
  fi
  current=$(git rev-parse HEAD); current_name=$(app_version)
  if [ -n "$TO" ]; then target=$TO; else target=$(target_for "$channel"); fi
  [ -n "$target" ] || die 20 E_UPDATE_NO_RELEASE "Yayımlanmış sürüm etiketi (vX.Y.Z) yok" "No released version tag (vX.Y.Z)"
  git rev-parse -q --verify "$target^{commit}" >/dev/null || die 20 E_UPDATE_UNKNOWN_VERSION "Bilinmeyen sürüm: $target" "Unknown version: $target"
  if [ "$(git rev-parse "$target^{commit}")" = "$current" ]; then msg OK UP_TO_DATE "Güncel: $current_name" "Up to date: $current_name"; exit 0; fi
  # The channel's newest version is behind the running one: nothing to update (an explicit --to may still go there,
  # and the migration check below refuses what the database cannot run).
  if [ -z "$TO" ] && ! git merge-base --is-ancestor "$current" "$target" 2>/dev/null; then
    msg OK UP_TO_DATE "Güncel: $current_name, kanalın son sürümü ($target) bundan eski" "Up to date: $current_name; the channel's newest version ($target) is older"; exit 0
  fi
  # A version that failed is not tried again by the timer, hour after hour and night after night (a backup, a
  # stop, a build and a rollback each time): it waits for the next version or for an update started by hand.
  if [ "$AUTO" = 1 ]; then
    prev=$(grep -E '"kind":"update","status":"(ok|failed)"' data/maintenance/history.jsonl 2>/dev/null | tail -n 1 || true)
    case "$prev" in *'"status":"failed"'*"\"to\":\"$target\""*)
      msg INFO UPDATE_SKIPPED "$target sürümüne güncelleme daha önce başarısız oldu; otomatik olarak yeniden denenmiyor. Elle denemek için: sudo sh scripts/install.sh update" "The update to $target failed before; it is not tried again automatically. To try by hand: sudo sh scripts/install.sh update"; exit 0 ;;
    esac
  fi
  applied=$(psql_value 'SELECT version FROM schema_migrations ORDER BY 1') || die 20 E_UPDATE_DB "Veritabanına ulaşılamadı" "Database not reachable"
  for v in $applied; do
    git cat-file -e "$target:apps/api/migrations/$v.sql" 2>/dev/null || {
      record update failed E_UPDATE_INCOMPATIBLE ",\"from\":\"$current_name\",\"to\":\"$target\""
      die 20 E_UPDATE_INCOMPATIBLE "$target, uygulanmış $v migration'ını içermiyor (veritabanı geri alınamaz)" "$target does not contain the applied migration $v (the database cannot be downgraded)"; }
  done
  open=$(psql_value "SELECT count(*) FROM operations WHERE status IN ('pending', 'running')")
  if [ "${open:-0}" -gt 0 ]; then
    if [ "$AUTO" = 1 ]; then
      record update postponed W_UPDATE_BUSY ",\"from\":\"$current_name\",\"to\":\"$target\""
      msg INFO W_UPDATE_BUSY "$open açık işlem var; otomatik güncelleme sonraya bırakıldı" "$open open operations; automatic update postponed"; exit 0
    fi
    msg WARN W_UPDATE_BUSY "$open açık işlem var; worker durdurulacak, yeni sürümde kaldığı adımdan sürer" "$open open operations; the worker stops and the new version continues them from their last step"
  fi
  msg INFO UPDATE "$current_name -> $target" "$current_name -> $target"
  do_backup pre-update || die 21 E_BACKUP_COPY "Güncelleme öncesi yedek tamamlanmadı; güncelleme yapılmadı" "The pre-update backup did not complete; not updating"
  pre=$BACKUP_FILE
  msg INFO DRAINING "Worker durduruluyor (çalışan adımın bitmesi en çok 120 sn beklenir)" "Stopping the worker (waits up to 120 s for the running step)"
  docker compose stop -t 120 worker >/dev/null 2>&1 || true
  update_rollback() { # code: back to the version that was running, services up again, the failure in the history
    # Forced: local changes were refused above, so only what the failed step left half done is discarded.
    git -c advice.detachedHead=false checkout -q -f --detach "$current" 2>/dev/null || true
    set_env APP_VERSION "$current_name"
    if up_and_ready; then rb=true; else rb=false; fi
    record update failed "$1" ",\"from\":\"$current_name\",\"to\":\"$target\",\"rolledBack\":$rb"
  }
  # The worker is down from here on: a checkout that fails (full disk, damaged repository) must not end the
  # script with it stopped.
  if ! git -c advice.detachedHead=false checkout -q --detach "$target" 2>/dev/null; then
    msg FAIL E_UPDATE_CHECKOUT "$target kaynağına geçilemedi (git checkout; disk dolu olabilir); $current_name sürümüne geri dönülüyor" "Could not switch the source to $target (git checkout; the disk may be full); going back to $current_name"
    update_rollback E_UPDATE_CHECKOUT
    msg WARN UPDATE_ROLLED_BACK "Güncelleme yapılmadı; $current_name yeniden başlatıldı (çalışıyor: $rb). Veritabanı değişmedi" "Not updated; $current_name was started again (running: $rb). The database was not changed"
    exit 23
  fi
  set_env APP_VERSION "$(app_version)"
  if up_and_ready; then
    record update ok - ",\"from\":\"$current_name\",\"to\":\"$target\""
    # Every build leaves layers behind; on a server that updates often they fill the disk. What is older than
    # a week is dropped (the next build only gets a little slower); images in use are never touched.
    (docker builder prune -f --filter until=168h; docker image prune -f) >/dev/null 2>&1 || true
    msg OK UPDATED "$target çalışıyor" "$target is running"; exit 0
  fi
  msg FAIL E_UPDATE_FAILED "$target hazır olmadı; $current_name sürümüne geri dönülüyor" "$target did not become ready; rolling back to $current_name"
  update_rollback E_UPDATE_FAILED
  msg WARN DB_NOT_ROLLED_BACK "Container'lar geri alındı (çalışıyor: $rb). Veritabanı otomatik geri alınmaz; eski sürüm sorun çıkarırsa: sh scripts/install.sh restore $pre --yes-replace-data" "Containers rolled back (running: $rb). The database is not rolled back automatically; if the old version misbehaves: sh scripts/install.sh restore $pre --yes-replace-data"
  exit 23
}

# Hourly systemd timer: a daily backup (when the last good one is older than 23 h) and, when
# enabled, the automatic update inside the maintenance window.
do_maintenance() {
  # Never alongside something the panel asked for (same lock as run_requests).
  hold_lock try || { [ $? = 1 ] && exit 0; die 21 E_LOCK "Bakım kilidi alınamadı ($LOCK)" "Could not take the maintenance lock ($LOCK)"; }
  if [ "$(env_value BACKUP_SCHEDULE)" != off ]; then
    last=$(grep '"kind":"backup","status":"ok"' data/maintenance/history.jsonl 2>/dev/null | tail -n 1 | sed 's/^{"time":"\([^"]*\)".*/\1/')
    age=$(( $(date +%s) - $(date -d "${last:-1970-01-01T00:00:00Z}" +%s) ))
    if [ "$age" -gt 82800 ]; then (do_backup scheduled) || true; fi
  fi
  (os_info) >/dev/null 2>&1 || true
  (do_state) >/dev/null 2>&1 || true
  AUTO=1; do_update
}

set_schedule() {
  [ "$(id -u)" = 0 ] || die 13 E_NEEDS_ROOT "Zamanlayıcı için root gerekir (sudo)" "The timer needs root (sudo)"
  unit=/etc/systemd/system/lightning-vm-maintenance
  if [ "$SWITCH" = on ]; then
    printf '[Unit]\nDescription=Lightning VM scheduled backup and automatic update\n\n[Service]\nType=oneshot\nExecStart=/bin/sh %s/scripts/install.sh maintenance --lang %s\n' "$(pwd)" "$UI" > "$unit.service"
    printf '[Unit]\nDescription=Lightning VM maintenance, hourly\n\n[Timer]\nOnCalendar=hourly\nRandomizedDelaySec=300\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n' > "$unit.timer"
    systemctl daemon-reload; systemctl enable --now lightning-vm-maintenance.timer >/dev/null 2>&1 || die 18 E_TIMER "systemd zamanlayıcısı etkinleştirilemedi" "Could not enable the systemd timer"
    grep -q '^BACKUP_SCHEDULE=' .env || echo 'BACKUP_SCHEDULE=daily' >> .env
    msg OK SCHEDULE "Saatlik bakım: günlük yedek$( [ "$(env_value AUTO_UPDATE)" = on ] && echo ' ve otomatik güncelleme')" "Hourly maintenance: daily backup$( [ "$(env_value AUTO_UPDATE)" = on ] && echo ' and automatic update')"
  else
    systemctl disable --now lightning-vm-maintenance.timer >/dev/null 2>&1 || true
    rm -f "$unit.service" "$unit.timer"; systemctl daemon-reload
    msg OK SCHEDULE "Zamanlanmış bakım kapatıldı" "Scheduled maintenance disabled"
  fi
  write_settings
}

set_auto_update() {
  case "$CHANNEL" in ''|stable|beta|edge) ;; *) die 2 E_CHANNEL_INVALID "Kanal stable, beta veya edge olmalı" "Channel must be stable, beta or edge" ;; esac
  if [ -n "$WINDOW" ] && ! echo "$WINDOW" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$'; then
    die 2 E_WINDOW_INVALID "Bakım penceresi SS:DD-SS:DD olmalı (örnek 03:00-05:00)" "The maintenance window must be HH:MM-HH:MM (example 03:00-05:00)"
  fi
  if [ -n "$WINDOW" ] && ! window_fires "$WINDOW"; then
    die 2 E_WINDOW_NEVER "Bakım zamanlayıcısı saat başlarında çalışır: pencere bir saat başını ve ardından gelen 10 dakikayı içermeli ($WINDOW içermiyor; örnek 03:00-05:00)" "The maintenance timer runs on the hour: the window must hold a full hour and the 10 minutes after it ($WINDOW does not; example 03:00-05:00)"
  fi
  set_env AUTO_UPDATE "$SWITCH"
  [ -z "$CHANNEL" ] || set_env UPDATE_CHANNEL "$CHANNEL"
  [ -z "$WINDOW" ] || set_env UPDATE_WINDOW "$WINDOW"
  [ -z "$BRANCH" ] || set_env UPDATE_BRANCH "$BRANCH"
  write_settings
  c=$(env_value UPDATE_CHANNEL); w=$(env_value UPDATE_WINDOW)
  msg OK AUTO_UPDATE "Otomatik güncelleme: $SWITCH (kanal ${c:-stable}, pencere ${w:-03:00-05:00})" "Automatic update: $SWITCH (channel ${c:-stable}, window ${w:-03:00-05:00})"
  [ -f /etc/systemd/system/lightning-vm-maintenance.timer ] || [ "$SWITCH" = off ] || msg WARN W_NO_TIMER "Zamanlayıcı kurulu değil: sudo sh scripts/install.sh schedule on" "The timer is not installed: sudo sh scripts/install.sh schedule on"
}

# ---- Updates from the admin panel ------------------------------------------------------------------
# The panel cannot (and must not) run anything on the host. It drops a small request file into
# data/maintenance-requests; a systemd path unit (agent) runs `run-requests`, which accepts only a fixed
# set of actions with validated values and runs this script for them. Progress and results are written to
# data/maintenance (read-only for the panel), so the panel can follow an update that restarts it.

# Available versions for the configured channel: data/maintenance/releases.json.
do_releases() {
  maint_dir
  out=data/maintenance/releases.json
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  channel=$(env_value UPDATE_CHANNEL); channel=${channel:-stable}
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf '{"checkedAt":"%s","channel":"%s","current":"%s","error":"E_UPDATE_NO_GIT","releases":[]}\n' "$now" "$channel" "$(app_version)" > "$out"
    die 20 E_UPDATE_NO_GIT "Güncelleme, git ile alınmış kaynak gerektirir (git clone)" "Updating needs a source checkout made with git clone"
  fi
  err=""
  if [ -n "$(git remote)" ]; then git fetch --quiet --tags --force "$(git remote | head -n 1)" 2>/dev/null || err=E_UPDATE_FETCH; fi
  target=$(target_for "$channel")
  available=false
  # Only a version that comes after the running one is an update: a checkout ahead of the newest tag (a branch
  # build, say) is never offered that older tag.
  if [ -n "$target" ] && [ "$(git rev-parse "$target^{commit}")" != "$(git rev-parse HEAD)" ] && git merge-base --is-ancestor HEAD "$target" 2>/dev/null; then available=true; fi
  # Newest first: tags of the channel, or for edge the commits on the branch that are not here yet.
  list=""
  if [ "$channel" = edge ]; then
    for c in $(git log --format=%H -n 20 "HEAD..$(edge_ref)" 2>/dev/null || true); do
      list="$list,{\"version\":\"$(git rev-parse --short "$c")\",\"date\":\"$(git log -1 --format=%cI "$c")\",\"notes\":\"$(git log -1 --format=%B "$c" | head -c 2000 | json_str)\"}"
    done
  else
    for t in $(git -c versionsort.suffix=- tag -l 'v[0-9]*' --sort=-v:refname | grep -E "$(tag_pattern "$channel")" | head -n 10); do
      notes=$(git tag -l --format='%(contents)' "$t"); [ -n "$notes" ] || notes=$(git log -1 --format=%B "$t")
      if git merge-base --is-ancestor HEAD "$t" 2>/dev/null && [ "$(git rev-parse "$t^{commit}")" != "$(git rev-parse HEAD)" ]; then newer=true; else newer=false; fi
      list="$list,{\"version\":\"$t\",\"date\":\"$(git log -1 --format=%cI "$t")\",\"notes\":\"$(printf '%s' "$notes" | head -c 2000 | json_str)\",\"newer\":$newer}"
    done
  fi
  latest=""; [ -z "$target" ] || latest=$(git describe --tags --always "$target")
  printf '{"checkedAt":"%s","channel":"%s","branch":"%s","current":"%s","commit":"%s","latest":"%s","updateAvailable":%s,"error":"%s","releases":[%s]}\n' \
    "$now" "$channel" "$(env_value UPDATE_BRANCH)" "$(app_version)" "$(git rev-parse --short HEAD)" "$latest" "$available" "$err" "${list#,}" > "$out.tmp"
  chmod 644 "$out.tmp"; mv "$out.tmp" "$out"
  if [ -n "$err" ]; then die 20 E_UPDATE_FETCH "Sürümler alınamadı (git fetch)" "Could not fetch releases (git fetch)"; fi
  if [ "$available" = true ]; then msg OK UPDATE_AVAILABLE "Yeni sürüm: $latest" "New version: $latest"; else msg OK UP_TO_DATE "Güncel: $(app_version)" "Up to date: $(app_version)"; fi
}

set_agent() {
  [ "$(id -u)" = 0 ] || die 13 E_NEEDS_ROOT "Ajan için root gerekir (sudo)" "The agent needs root (sudo)"
  command -v systemctl >/dev/null || die 18 E_NO_SYSTEMD "systemd yok; panel istekleri için cron ile çalıştırın: sh scripts/install.sh run-requests" "No systemd; run sh scripts/install.sh run-requests from cron to serve panel requests"
  unit=/etc/systemd/system/lightning-vm-requests
  if [ "$SWITCH" = on ]; then
    request_dir
    printf '[Unit]\nDescription=Lightning VM: run what the admin panel asked for\n\n[Service]\nType=oneshot\nExecStart=/bin/sh %s/scripts/install.sh run-requests --lang %s\nTimeoutStartSec=3h\n' "$(pwd)" "$UI" > "$unit.service"
    printf '[Unit]\nDescription=Lightning VM: watch for admin panel requests\n\n[Path]\nPathExistsGlob=%s/data/maintenance-requests/*.req\nMakeDirectory=yes\n\n[Install]\nWantedBy=multi-user.target\n' "$(pwd)" > "$unit.path"
    systemctl daemon-reload; systemctl enable --now lightning-vm-requests.path >/dev/null 2>&1 || die 18 E_AGENT "Panel ajanı etkinleştirilemedi" "Could not enable the panel agent"
    msg OK AGENT "Panel ajanı açık: güncelleme ve yedek panelden başlatılabilir" "Panel agent on: updates and backups can be started from the panel"
  else
    systemctl disable --now lightning-vm-requests.path >/dev/null 2>&1 || true
    rm -f "$unit.service" "$unit.path"; systemctl daemon-reload
    msg OK AGENT "Panel ajanı kapatıldı" "Panel agent off"
  fi
  write_settings
}

# Each request is a few key=value lines. Everything is validated here: the panel is not trusted with the host.
run_requests() {
  [ -d data/maintenance-requests ] || exit 0
  maint_dir; maint_dir data/maintenance/runs
  hold_lock wait || die 21 E_LOCK "Bakım kilidi alınamadı ($LOCK)" "Could not take the maintenance lock ($LOCK)"
  # The API queues one request at a time, so the order of several (should it happen) does not matter.
  for f in data/maintenance-requests/*.req; do
    # The request directory belongs to the API container's user, so a name in it may be a link to any file on
    # this server. A link is removed, never read.
    if [ -L "$f" ]; then rm -f "$f"; continue; fi
    # Neither is anything else that is not a plain file (a directory, a FIFO): left there, it would start this
    # run again and again through the path unit.
    if [ ! -f "$f" ]; then rm -rf "$f"; continue; fi
    id=$(basename "$f" .req)
    case "$id" in *[!0-9a-f-]*) rm -f "$f"; continue ;; esac # also a name with a line break in it
    echo "$id" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || { rm -f "$f"; continue; }
    # The request is first moved out of that user's reach (a link moves as a link, it is not followed) and read
    # only there, when it is a regular file of at most 1024 bytes: of anything else not one value is read.
    rq=$(mktemp -d); REQUEST_WORK=$rq
    ok=1
    action="" to="" channel="" window="" switch="" by="" domain="" tls="" hname="" htz="" hntp="" hdns="" act=""
    if mv "$f" "$rq/req" 2>/dev/null && [ ! -L "$rq/req" ] && [ -f "$rq/req" ] && [ "$(wc -c < "$rq/req")" -le 1024 ]; then
      val() { sed -n "s/^$1=//p" "$rq/req" | head -n 1; }
      action=$(val action); to=$(val to); channel=$(val channel); window=$(val window); switch=$(val switch); by=$(val by); domain=$(val domain); tls=$(val tls)
      hname=$(val hostname); htz=$(val timezone); hntp=$(val ntp); hdns=$(val dns); act=$(val act)
    else ok=0; fi
    rm -f "$f" "$rq/req"
    echo "$by" | grep -Eq '^[0-9a-f-]{36}$' || by=""
    set -- --lang "$UI"
    case "$action" in
      check) set -- releases "$@" ;;
      backup) set -- backup "$@" ;;
      update) set -- update "$@"
        if [ -n "$to" ]; then echo "$to" | grep -Eq '^(v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?|[0-9a-f]{7,40})$' && set -- "$@" --to "$to" || ok=0; fi ;;
      domain) d=$domain
        echo "$d" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' || ok=0
        set -- domain "$d" "$@"
        case "$tls" in
          acme) ;;
          staging) set -- "$@" --tls staging ;;
          custom)
            # Like the request itself, the certificate and its key may be links to any file on this server. Both
            # are first moved out of the directory's reach (a link moves as a link, it is not followed), accepted
            # only as regular files, and their content goes into files root creates itself. What is in them
            # (a certificate in date whose key this is) is checked by the domain command they are handed to.
            c=$rq/in.cert; k=$rq/in.key
            if mv "data/maintenance-requests/$id.cert" "$c" 2>/dev/null && mv "data/maintenance-requests/$id.key" "$k" 2>/dev/null &&
              [ ! -L "$c" ] && [ ! -L "$k" ] && [ -f "$c" ] && [ -f "$k" ] && [ -s "$c" ] && [ -s "$k" ] &&
              [ "$(wc -c < "$c")" -le 65536 ] && [ "$(wc -c < "$k")" -le 16384 ] &&
              (umask 077; cat "$c" > "$rq/cert.pem" && cat "$k" > "$rq/key.pem"); then
              set -- "$@" --tls custom --cert "$rq/cert.pem" --key "$rq/key.pem"
            else ok=0; fi ;;
          *) ok=0 ;;
        esac ;;
      host) set -- host "$@"
        if [ -n "$hname" ]; then valid_hostname "$hname" && set -- "$@" --hostname "$hname" || ok=0; fi
        if [ -n "$htz" ]; then valid_timezone "$htz" && set -- "$@" --timezone "$htz" || ok=0; fi
        if [ -n "$hntp" ]; then valid_list "$hntp" name && set -- "$@" --ntp "$hntp" || ok=0; fi
        if [ -n "$hdns" ]; then valid_list "$hdns" ip && set -- "$@" --dns "$hdns" || ok=0; fi ;;
      monitoring|terminal) case "$switch" in on|off) set -- "$action" "$switch" "$@" ;; *) ok=0 ;; esac ;;
      os) case "$act" in check|upgrade|security|reboot|auto-on|auto-off) set -- os "$act" "$@" ;; *) ok=0 ;; esac ;;
      state) set -- state "$@" ;;
      auto-update) case "$switch" in on|off) set -- auto-update "$switch" "$@" ;; *) ok=0 ;; esac
        case "$channel" in '') ;; stable|beta|edge) set -- "$@" --channel "$channel" ;; *) ok=0 ;; esac
        if [ -n "$window" ]; then echo "$window" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$' && set -- "$@" --window "$window" || ok=0; fi ;;
      *) ok=0 ;;
    esac
    started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    status() { # state exit code
      printf '{"id":"%s","action":"%s","by":"%s","state":"%s","startedAt":"%s","finishedAt":"%s","exitCode":%s,"code":"%s"}\n' \
        "$id" "$(printf '%s' "$action" | tr -cd 'a-z-')" "$by" "$1" "$started" "$( [ "$1" = running ] || date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" "$3" > data/maintenance/status.tmp
      chmod 644 data/maintenance/status.tmp; mv data/maintenance/status.tmp data/maintenance/status.json
    }
    # A certificate and key travel next to their request; never left behind.
    rm -f "data/maintenance-requests/$id.cert" "data/maintenance-requests/$id.key"
    if [ "$ok" = 0 ]; then status rejected 2 E_REQUEST_INVALID; rm -rf "$rq"; REQUEST_WORK=""; continue; fi
    status running null ""
    log=data/maintenance/runs/$id.log
    # Made anew and closed to others from its first moment (the panel follows it while the request runs).
    rm -rf "$log"
    if ! { (umask 027; set -C; : > "$log") 2>/dev/null && panel_file "$log"; }; then
      status failed 1 E_REQUEST_LOG; rm -rf "$rq"; REQUEST_WORK=""; continue
    fi
    if sh "$(pwd)/scripts/install.sh" "$@" > "$log" 2>&1; then rc=0; else rc=$?; fi # LVM_LOCKED: the lock is held here
    code=$(awk 'NF >= 2 { c = $2 } END { print c }' "$log" | tr -cd 'A-Z0-9_')
    if [ "$rc" = 0 ]; then status succeeded 0 "$code"; else status failed "$rc" "$code"; fi
    rm -rf "$rq"; REQUEST_WORK=""
    # After an update the version list describes the old version: refresh it (best effort, quietly).
    if [ "$action" = update ]; then sh "$(pwd)/scripts/install.sh" releases --lang "$UI" >/dev/null 2>&1 || true; fi
    find data/maintenance/runs -name '*.log' -type f -printf '%T@ %p\n' | sort -rn | tail -n +21 | cut -d' ' -f2- | xargs -r rm -f
  done
  # What never became a request: a certificate or key whose .req did not come, a request the API did not finish
  # writing. Five minutes old, so nothing that is still on its way is taken.
  find data/maintenance-requests -maxdepth 1 ! -type d \( -name '*.cert' -o -name '*.key' -o -name '.*.tmp' \) -mmin +5 -exec rm -f {} + 2>/dev/null || true
}

# ---- This server's own settings (name, time, time servers, DNS) ------------------------------------
# The same checks run in the API; here they decide, since the panel is not trusted with the host.
valid_hostname() { [ ${#1} -le 253 ] && echo "$1" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'; }
valid_timezone() { case "$1" in *..*) return 1 ;; esac; echo "$1" | grep -Eq '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$' && [ -f "/usr/share/zoneinfo/$1" ]; }
valid_ipv4() { # a.b.c.d with every part 0 to 255
  echo "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || return 1
  ip_rest=$1.
  while [ -n "$ip_rest" ]; do
    [ "${ip_rest%%.*}" -le 255 ] || return 1
    ip_rest=${ip_rest#*.}
  done
}
valid_ipv6() { case "$1" in *:*) echo "$1" | grep -Eq '^[0-9a-fA-F:]{2,39}$' ;; *) return 1 ;; esac; }
# A comma-separated list of up to 4 entries (ip: IP addresses only; name: host names or IP addresses), or "default".
# The whole value is checked first (letters, digits and . : , - only: no blank, no line break, no wildcard) and
# then split on commas with file-name expansion off. A name follows valid_hostname and is not made of digits and
# dots alone (that is an address that did not pass, like 999.1.1.1, or a bare number). In a subshell: the split
# changes IFS and the expansion setting for itself only.
valid_list() (
  [ "$1" != default ] || exit 0
  case "$1" in ''|*[!A-Za-z0-9.:,-]*|,*|*,|*,,*) exit 1 ;; esac
  set -f; IFS=,
  # shellcheck disable=SC2086 # split on commas, on purpose; nothing in it can expand (set -f, and the check above)
  vl_n=0; for vl_item in $1; do
    vl_n=$((vl_n + 1)); [ "$vl_n" -le 4 ] || exit 1
    if valid_ipv4 "$vl_item" || valid_ipv6 "$vl_item"; then continue; fi
    [ "$2" = name ] || exit 1
    case "$vl_item" in *[!0-9.]*) valid_hostname "$vl_item" || exit 1 ;; *) exit 1 ;; esac
  done
  [ "$vl_n" -ge 1 ]
)
# One or more addresses or networks (10.0.0.1, 10.0.0.0/8, 2001:db8::/32), separated by single blanks.
valid_cidrs() (
  case "$1" in ''|*[!0-9A-Fa-f.:/\ ]*|\ *|*\ |*\ \ *) exit 1 ;; esac
  set -f
  # shellcheck disable=SC2086 # split on blanks, on purpose; nothing in it can expand (set -f, and the check above)
  for vc_item in $1; do
    case "$vc_item" in
      */*) vc_bits=${vc_item#*/}; case "$vc_bits" in ''|*[!0-9]*|????*) exit 1 ;; esac ;;
      *) vc_bits=0 ;;
    esac
    if valid_ipv4 "${vc_item%%/*}"; then [ "$vc_bits" -le 32 ] || exit 1
    elif valid_ipv6 "${vc_item%%/*}"; then [ "$vc_bits" -le 128 ] || exit 1
    else exit 1; fi
  done
)
# The panel's public address as people open it: scheme and host (and a port), nothing after it. Prints it in lower
# case without a closing slash; fails on anything else.
public_url() {
  case "$1" in ''|*[!A-Za-z0-9.:/-]*) return 1 ;; esac
  pu=$(printf '%s' "${1%/}" | tr '[:upper:]' '[:lower:]')
  echo "$pu" | grep -Eq '^https?://[a-z0-9.-]+(:[0-9]{1,5})?$' || return 1
  pu_host=${pu#*://}
  valid_hostname "${pu_host%:*}" || return 1
  echo "$pu"
}
# Writes (or with "default" removes) a systemd drop-in: $1 file, $2 section, $3 key, $4 the list.
drop_in() {
  if [ "$4" = default ]; then rm -f "$1"; else mkdir -p "$(dirname "$1")"; printf '# Written by Lightning VM (Admin → System)\n[%s]\n%s=%s\n' "$2" "$3" "$(echo "$4" | tr ',' ' ')" > "$1"; fi
}

host_info() {
  maint_dir
  td() { timedatectl show -p "$1" --value 2>/dev/null || true; }
  conf() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | tr ' ' ',' || true; }
  os=$( (. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-}") || true)
  resolvers=$(grep -E '^nameserver ' /etc/resolv.conf 2>/dev/null | awk '{ print $2 }' | paste -sd, - || true)
  panel_new data/maintenance/host.json
  printf '{"checkedAt":"%s","time":%s,"hostname":"%s","fqdn":"%s","timezone":"%s","ntp":"%s","ntpSynced":"%s","ntpServers":"%s","dnsServers":"%s","resolvers":"%s","timesyncd":%s,"resolved":%s,"os":"%s","kernel":"%s","uptime":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(date +%s)" "$(hostname | json_str)" "$( (hostname -f 2>/dev/null || hostname) | json_str)" "$(td Timezone | json_str)" "$(td NTP)" "$(td NTPSynchronized)" \
    "$(conf /etc/systemd/timesyncd.conf.d/lightning-vm.conf NTP | json_str)" "$(conf /etc/systemd/resolved.conf.d/lightning-vm.conf DNS | json_str)" "$(printf '%s' "$resolvers" | json_str)" \
    "$(systemctl is-active --quiet systemd-timesyncd 2>/dev/null && echo true || echo false)" "$(systemctl is-active --quiet systemd-resolved 2>/dev/null && echo true || echo false)" \
    "$(printf '%s' "$os" | json_str)" "$(uname -r | json_str)" "$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)" > "$PANEL_TMP"
  panel_put data/maintenance/host.json
}

do_host() {
  if [ -n "$HOST_NAME$HOST_TZ$HOST_NTP$HOST_DNS" ]; then
    [ "$(id -u)" = 0 ] || die 13 E_NEEDS_ROOT "Sunucu ayarları için root gerekir (sudo)" "Server settings need root (sudo)"
    command -v timedatectl >/dev/null && command -v hostnamectl >/dev/null || die 18 E_NO_SYSTEMD "systemd (hostnamectl, timedatectl) yok" "systemd (hostnamectl, timedatectl) is missing"
  fi
  if [ -n "$HOST_NAME" ]; then
    valid_hostname "$HOST_NAME" || die 2 E_HOSTNAME_INVALID "Geçersiz sunucu adı: '$HOST_NAME' (küçük harf, rakam, tire ve nokta)" "Invalid host name: '$HOST_NAME' (lowercase letters, digits, hyphens and dots)"
    hostnamectl set-hostname "$HOST_NAME" || die 21 E_HOSTNAME "Sunucu adı değiştirilemedi" "Could not change the host name"
    # The name resolves on this machine too (127.0.1.1), as Debian and Ubuntu set it up.
    short=${HOST_NAME%%.*}
    if grep -q '^127\.0\.1\.1[[:space:]]' /etc/hosts; then sed -i "s/^127\.0\.1\.1[[:space:]].*/127.0.1.1\t$HOST_NAME $short/" /etc/hosts
    else printf '127.0.1.1\t%s %s\n' "$HOST_NAME" "$short" >> /etc/hosts; fi
    msg OK HOSTNAME "Sunucu adı: $HOST_NAME" "Host name: $HOST_NAME"
  fi
  if [ -n "$HOST_TZ" ]; then
    valid_timezone "$HOST_TZ" || die 2 E_TIMEZONE_INVALID "Bilinmeyen saat dilimi: '$HOST_TZ'" "Unknown time zone: '$HOST_TZ'"
    timedatectl set-timezone "$HOST_TZ" || die 21 E_TIMEZONE "Saat dilimi değiştirilemedi" "Could not change the time zone"
    msg OK TIMEZONE "Saat dilimi: $HOST_TZ" "Time zone: $HOST_TZ"
  fi
  if [ -n "$HOST_NTP" ]; then
    valid_list "$HOST_NTP" name || die 2 E_NTP_INVALID "Geçersiz zaman sunucusu listesi" "Invalid time server list"
    [ -x /lib/systemd/systemd-timesyncd ] || [ -x /usr/lib/systemd/systemd-timesyncd ] || die 18 E_NO_TIMESYNCD "systemd-timesyncd kurulu değil (chrony veya ntpd kendi ayarıyla çalışır)" "systemd-timesyncd is not installed (chrony or ntpd keep their own settings)"
    drop_in /etc/systemd/timesyncd.conf.d/lightning-vm.conf Time NTP "$HOST_NTP"
    timedatectl set-ntp true || true
    systemctl restart systemd-timesyncd || die 21 E_NTP "Zaman eşitleme yeniden başlatılamadı" "Could not restart time synchronization"
    msg OK NTP "Zaman sunucuları: $HOST_NTP" "Time servers: $HOST_NTP"
  fi
  if [ -n "$HOST_DNS" ]; then
    valid_list "$HOST_DNS" ip || die 2 E_DNS_INVALID "Geçersiz DNS sunucusu listesi (yalnızca IP adresleri)" "Invalid DNS server list (IP addresses only)"
    systemctl is-active --quiet systemd-resolved || die 18 E_NO_RESOLVED "systemd-resolved çalışmıyor; DNS bu sunucuda başka bir yolla yönetiliyor" "systemd-resolved is not running; DNS is managed another way on this server"
    drop_in /etc/systemd/resolved.conf.d/lightning-vm.conf Resolve DNS "$HOST_DNS"
    systemctl restart systemd-resolved || die 21 E_DNS "DNS çözümleyici yeniden başlatılamadı" "Could not restart the DNS resolver"
    msg OK DNS "DNS sunucuları: $HOST_DNS" "DNS servers: $HOST_DNS"
  fi
  host_info
  msg OK HOST_INFO "Sunucu bilgileri güncellendi" "Server details recorded"
}

# Log copies the panel shows hold no usable secret: what travels in a URL (the password-reset token in the path;
# token, code, state and session_id in the query string, also where a log writes & as \u0026) and the CAPTCHA
# answer among the proxy's request headers are replaced. The proxy and the collector mask the same
# (deploy/caddy/Caddyfile, deploy/observability/otel.yaml); this covers every service's lines, whoever wrote them.
mask_secrets() {
  sed -E -e 's#(/reset-password/)[^/?&"\\[:space:]]+#\1***#g' \
    -e 's#(([?&]|\\u0026)(token|code|state|session_id)=)[^&"\\[:space:]]+#\1***#g' \
    -e 's#("[Xx]-[Cc]aptcha-[Rr]esponse":\[")[^"]*#\1***#g'
}

# ---- This server's state for the panel (Admin → System → Server state) -----------------------------
# A snapshot the panel cannot take from inside its container: the stack's services with their CPU and memory,
# file systems, the busiest processes, failed systemd units, Docker's disk use, and the last log lines of every
# service and of the system journal (warnings and worse). Read-only: nothing on the server changes.
do_state() {
  out=${STATE_DIR:-data/maintenance}
  maint_dir "$out"; maint_dir "$out/logs"
  # One JSON string per field; fields arrive separated by "|".
  rows() { # $1: comma-separated key names (a trailing "#" makes the value a number)
    awk -F'|' -v keys="$1" 'BEGIN { n = split(keys, k, ","); printf "[" }
      function esc(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); gsub(/[[:cntrl:]]/, " ", s); return s }
      NF { printf "%s{", (c++ ? "," : "")
        for (i = 1; i <= n; i++) { key = k[i]; num = sub(/#$/, "", key); v = $i
          if (num) { gsub(/[^0-9.]/, "", v); if (v == "") v = 0; printf "%s\"%s\":%s", (i > 1 ? "," : ""), key, v }
          else printf "%s\"%s\":\"%s\"", (i > 1 ? "," : ""), key, esc(v) }
        printf "}" }
      END { printf "]" }'
  }
  services='[]'; docker_disk='[]'
  if docker compose ps >/dev/null 2>&1; then
    stats=$(timeout 20 docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}' 2>/dev/null || true)
    services=$(docker compose ps -a --format '{{.Service}}|{{.Name}}|{{.State}}|{{.Health}}|{{.Status}}' 2>/dev/null | sort | while IFS='|' read -r svc name state health status; do
      [ -n "$svc" ] || continue
      line=$(printf '%s\n' "$stats" | awk -F'|' -v n="$name" '$1 == n { print $2 "|" $3 "|" $4; exit }')
      cpu=$(printf '%s' "$line" | cut -d'|' -f1); mem=$(printf '%s' "$line" | cut -d'|' -f2 | sed 's| /.*||'); memp=$(printf '%s' "$line" | cut -d'|' -f3)
      restarts=$(docker inspect -f '{{.RestartCount}}' "$name" 2>/dev/null || echo 0)
      started=$(docker inspect -f '{{.State.StartedAt}}' "$name" 2>/dev/null || true)
      printf '%s|%s|%s|%s|%s|%s|%s|%s|%s\n' "$svc" "$state" "$health" "$status" "${cpu:-0}" "$mem" "${memp:-0}" "$restarts" "$started"
    done | rows 'service,state,health,status,cpu#,memory,memoryPercent#,restarts#,startedAt')
    docker_disk=$(timeout 30 docker system df --format '{{.Type}}|{{.Size}}|{{.Reclaimable}}' 2>/dev/null | rows 'type,size,reclaimable' || echo '[]')
    # The last lines of every service (the panel shows them; rotated by Docker, nothing is kept here beyond this).
    rm -f "$out"/logs/*.log
    for svc in $(docker compose ps -a --format '{{.Service}}' 2>/dev/null | sort -u); do
      echo "$svc" | grep -Eq '^[a-z0-9][a-z0-9_-]{0,40}$' || continue
      panel_new "$out/logs/$svc.log"
      { timeout 20 docker compose logs --no-color --no-log-prefix --timestamps --tail 300 "$svc" 2>&1 || true; } | mask_secrets > "$PANEL_TMP" || true
      panel_put "$out/logs/$svc.log"
    done
  fi
  if command -v journalctl >/dev/null 2>&1; then
    panel_new "$out/logs/system.log"
    { timeout 20 journalctl -p warning -n 200 --no-pager -o short-iso 2>/dev/null || true; } | mask_secrets > "$PANEL_TMP" || true
    panel_put "$out/logs/system.log"
  fi
  disks=$(df -P -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs 2>/dev/null | awk 'NR > 1 { print $6 "|" $1 "|" $2 "|" $3 "|" $4 }' | head -n 12 | rows 'mount,device,total#,used#,free#')
  inodes=$(df -P -i / 2>/dev/null | awk 'NR == 2 { gsub(/%/, "", $5); print $5 + 0 }')
  processes=$(ps -eo pid=,pcpu=,pmem=,rss=,comm= --sort=-pcpu 2>/dev/null | head -n 8 | awk '{ print $1 "|" $2 "|" $3 "|" $4 * 1024 "|" $5 }' | rows 'pid#,cpu#,memory#,rss#,name')
  failed=$(systemctl --failed --no-legend --plain 2>/dev/null | awk '{ print $1 }' | head -n 10 | rows 'unit' || echo '[]')
  addresses=$(ip -o -4 addr show scope global 2>/dev/null | awk '{ print $2 "|" $4 }' | head -n 8 | rows 'interface,address' || echo '[]')
  net=$(awk -F'[: ]+' 'NR > 2 && $2 != "lo" && $2 !~ /^(veth|br-|docker)/ { print $2 "|" $3 "|" $11 }' /proc/net/dev 2>/dev/null | head -n 6 | rows 'interface,rx#,tx#')
  panel_new "$out/state.json"
  printf '{"checkedAt":"%s","services":%s,"disks":%s,"inodesPercent":%s,"processes":%s,"failedUnits":%s,"addresses":%s,"network":%s,"dockerDisk":%s,"docker":"%s","users":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${services:-[]}" "${disks:-[]}" "${inodes:-0}" "${processes:-[]}" "${failed:-[]}" "${addresses:-[]}" "${net:-[]}" "${docker_disk:-[]}" \
    "$(docker version --format '{{.Server.Version}}' 2>/dev/null | json_str || true)" "$(who 2>/dev/null | wc -l | tr -d ' ')" > "$PANEL_TMP"
  panel_put "$out/state.json"
}

# ---- This server's operating system updates (apt: Debian and Ubuntu) -------------------------------
# What waits, what of it is a security update, whether a restart is needed, and whether security updates
# install themselves. The panel only reads data/maintenance/os.json; it never talks to apt.
os_info() {
  maint_dir
  mgr=none; total=0; sec=0; pk=""; auto=false; held=0; lists=""; changed=""
  stamp() { [ -e "$1" ] && date -u -d "@$(stat -c %Y "$1")" +%Y-%m-%dT%H:%M:%SZ || true; }
  if command -v apt-get >/dev/null 2>&1; then
    mgr=apt
    list=$(LC_ALL=C apt list --upgradable 2>/dev/null | grep -F '[upgradable from:' || true)
    total=$(printf '%s\n' "$list" | awk 'NF { n++ } END { print n + 0 }')
    sec=$(printf '%s\n' "$list" | awk 'NF { split($1, a, "/"); if (a[2] ~ /-security/) n++ } END { print n + 0 }')
    # Security updates first; at most 150 rows (the counts above are complete).
    pk=$(printf '%s\n' "$list" | awk 'NF { split($1, a, "/"); s = (a[2] ~ /-security/) ? "true" : "false"; from = $NF; sub(/\]$/, "", from)
      gsub(/[^A-Za-z0-9.+:~_-]/, "", a[1]); to = $2; gsub(/[^A-Za-z0-9.+:~_-]/, "", to); gsub(/[^A-Za-z0-9.+:~_-]/, "", from)
      printf "%s {\"name\":\"%s\",\"to\":\"%s\",\"from\":\"%s\",\"security\":%s}\n", (s == "true" ? 0 : 1), a[1], to, from, s }' | sort -s -k1,1n | head -n 150 | cut -d' ' -f2- | paste -sd, -)
    if dpkg -s unattended-upgrades >/dev/null 2>&1 && [ "$(apt-config dump APT::Periodic::Unattended-Upgrade 2>/dev/null | sed -n 's/.*"\(.*\)";/\1/p')" = 1 ]; then auto=true; fi
    held=$(apt-mark showhold 2>/dev/null | awk 'NF { n++ } END { print n + 0 }')
    lists=$(stamp /var/lib/apt/periodic/update-success-stamp); [ -n "$lists" ] || lists=$(stamp /var/lib/apt/lists)
    changed=$(stamp /var/log/dpkg.log)
  fi
  if [ -f /var/run/reboot-required ]; then reboot=true; else reboot=false; fi
  rpk=$( (sort -u /var/run/reboot-required.pkgs 2>/dev/null || true) | head -n 20 | tr -cd 'A-Za-z0-9.+:~_\n-' | paste -sd, -)
  panel_new data/maintenance/os.json
  printf '{"checkedAt":"%s","manager":"%s","total":%s,"security":%s,"held":%s,"packages":[%s],"rebootRequired":%s,"rebootPackages":"%s","autoSecurity":%s,"listsAt":"%s","changedAt":"%s","bootId":"%s","kernel":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$mgr" "$total" "$sec" "$held" "$pk" "$reboot" "$rpk" "$auto" "$lists" "$changed" \
    "$(tr -cd 'a-f0-9-' < /proc/sys/kernel/random/boot_id 2>/dev/null || true)" "$(uname -r | json_str)" > "$PANEL_TMP"
  panel_put data/maintenance/os.json
}

do_os() {
  if [ "$OS_ACT" != info ]; then [ "$(id -u)" = 0 ] || die 13 E_NEEDS_ROOT "İşletim sistemi güncellemeleri için root gerekir (sudo)" "Operating system updates need root (sudo)"; fi
  case "$OS_ACT" in info|reboot) ;; *)
    command -v apt-get >/dev/null 2>&1 || die 18 E_OS_UNSUPPORTED "Bu sunucuda apt yok; güncellemeler yalnız Debian ve Ubuntu'da panelden yönetilir" "No apt on this server; updates are managed from the panel on Debian and Ubuntu only" ;;
  esac
  # Never asks a question: configuration files that were changed by hand are kept; another apt run is waited for.
  aptg() { DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a timeout 3600 apt-get -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"; }
  refresh() { aptg update -q || die 21 E_OS_LISTS "Paket listeleri yenilenemedi (ağ ya da depo sorunu)" "Could not refresh the package lists (network or repository problem)"; }
  case "$OS_ACT" in
    check) refresh
      msg OK OS_LISTS "Paket listeleri yenilendi" "Package lists refreshed" ;;
    upgrade) refresh
      aptg -y --with-new-pkgs upgrade || die 21 E_OS_UPGRADE "Güncellemeler kurulamadı; ayrıntı yukarıdaki satırlarda" "The updates could not be installed; see the lines above"
      msg OK OS_UPGRADED "Tüm güncellemeler kuruldu" "All updates installed" ;;
    security) refresh
      names=$(LC_ALL=C apt list --upgradable 2>/dev/null | awk -F/ '/\[upgradable from:/ { split($2, b, " "); if (b[1] ~ /-security/) print $1 }' | tr -cd 'A-Za-z0-9.+:~_\n-')
      if [ -z "$names" ]; then msg OK OS_NO_SECURITY "Bekleyen güvenlik güncellemesi yok" "No security updates are waiting"
      else
        # shellcheck disable=SC2086 # one argument per package name
        aptg -y install --only-upgrade $names || die 21 E_OS_UPGRADE "Güvenlik güncellemeleri kurulamadı; ayrıntı yukarıdaki satırlarda" "The security updates could not be installed; see the lines above"
        msg OK OS_SECURITY "Güvenlik güncellemeleri kuruldu" "Security updates installed"
      fi ;;
    auto-on)
      dpkg -s unattended-upgrades >/dev/null 2>&1 || { refresh; aptg -y install unattended-upgrades || die 21 E_OS_AUTO "unattended-upgrades kurulamadı" "Could not install unattended-upgrades"; }
      printf '// Written by Lightning VM (Admin → System)\nAPT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/52lightning-vm-auto
      msg OK OS_AUTO "Otomatik güvenlik güncellemeleri açık" "Automatic security updates on" ;;
    auto-off)
      printf '// Written by Lightning VM (Admin → System)\nAPT::Periodic::Unattended-Upgrade "0";\n' > /etc/apt/apt.conf.d/52lightning-vm-auto
      msg OK OS_AUTO "Otomatik güvenlik güncellemeleri kapalı" "Automatic security updates off" ;;
    reboot)
      # One minute from now, so this request's result is written before the server goes down.
      shutdown -r +1 "Lightning VM: restart requested from the panel" >/dev/null 2>&1 || die 21 E_OS_REBOOT "Yeniden başlatma zamanlanamadı" "Could not schedule the restart"
      msg OK OS_REBOOT "Sunucu bir dakika içinde yeniden başlayacak" "The server restarts in one minute" ;;
    info) ;;
  esac
  os_info
  [ "$OS_ACT" = reboot ] || msg OK OS_INFO "Güncelleme durumu kaydedildi" "Update state recorded"
}

# The host's own public IPv4 (no outside service is asked); empty behind NAT or on a private network.
public_ipv4() {
  addr=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
  case "$addr" in
    ''|10.*|127.*|169.254.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) return 1 ;;
  esac
  echo "$addr"
}

revert_local_settings() {
  set_env PANEL_SITE :80; set_env LISTEN_ADDRESS 127.0.0.1; set_env HTTP_PORT 8080; set_env HTTPS_PORT 8443
  set_env TRUSTED_PROXY_CIDRS 127.0.0.1/32; set_env PANEL_PROBE_URL ""; set_env PANEL_TLS 0; set_env PANEL_PUBLIC_URL ""
  load_settings
}

# Serves the panel on $1 with automatic HTTPS. Returns 1 when the ports, DNS or the certificate fail;
# the caller decides whether that is fatal.
configure_domain() {
  d=$1
  echo "$d" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' || die 2 E_DOMAIN_INVALID "Geçersiz alan adı: '$d' (örnek: panel.example.com, şema veya yol olmadan)" "Invalid domain: '$d' (example: panel.example.com, no scheme or path)"
  LISTEN=0.0.0.0; FAILED=0; ports_free 80 443
  [ "$FAILED" -eq 0 ] || return 1
  dns_report "$d"
  [ -n "${v4:-}" ] || return 1
  FAILED=0
  if [ "$ACME_STAGING" = 1 ]; then ca=https://acme-staging-v02.api.letsencrypt.org/directory; else ca=https://acme-v02.api.letsencrypt.org/directory; fi
  set_env PANEL_SITE "$d"; set_env LISTEN_ADDRESS 0.0.0.0; set_env HTTP_PORT 80; set_env HTTPS_PORT 443; set_env ACME_CA "$ca"
  set_env TRUSTED_PROXY_CIDRS 127.0.0.1/32
  set_env PANEL_PROBE_URL "https://$d/api/health"; set_env PANEL_TLS 1
  set_env PANEL_PUBLIC_URL "https://$d" # the address in mailed links
  if [ "$TLS_MODE" = custom ]; then write_tls custom || return 1; set_env PANEL_TLS_MODE custom
  else write_tls auto; if [ "$ACME_STAGING" = 1 ]; then set_env PANEL_TLS_MODE staging; else set_env PANEL_TLS_MODE acme; fi; fi
  load_settings
  # Not restart_proxy: a proxy that does not start (a bad certificate, say) must leave the caller room to roll back.
  proxy_apply || { fail E_PROXY_FAILED "Proxy yeni ayarla başlamadı: docker compose logs proxy" "The proxy did not start with the new settings: docker compose logs proxy"; return 1; }
  [ "$TLS_MODE" = custom ] || msg INFO ACME "Sertifika isteniyor (en fazla 2 dk)" "Requesting certificate (up to 2 min)"
  i=0; until local_get /api/ready >/dev/null 2>&1 || [ $i -ge 24 ]; do sleep 5; i=$((i + 1)); done
  if [ "$TLS_MODE" = custom ]; then custom_report "$d"; else web_report "$d"; fi
  write_settings
  [ "$FAILED" -eq 0 ]
}

# Starts the proxy with the current .env (recreated when it changed) and reloads its configuration: a changed
# TLS snippet alone does not recreate the container. Fails on an invalid certificate or configuration.
proxy_apply() {
  docker compose up -d --wait --wait-timeout 120 proxy >/dev/null 2>&1 &&
    docker compose exec -T proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
}

# Caddy's per-site TLS snippet (data/tls/site.caddy, imported in the site block): your own certificate and
# key, or nothing (automatic HTTPS for a domain, plain HTTP otherwise). Only root reads the key.
write_tls() { # custom | auto
  (umask 077; mkdir -p data/tls)
  if [ "$1" = custom ]; then
    cp "$CERT_FILE" data/tls/cert.pem && cp "$KEY_FILE" data/tls/key.pem && chmod 600 data/tls/cert.pem data/tls/key.pem || return 1
    printf 'tls /etc/caddy/site.d/cert.pem /etc/caddy/site.d/key.pem\n' > data/tls/site.caddy
  else
    rm -f data/tls/cert.pem data/tls/key.pem
    printf '# automatic HTTPS (ACME) for a domain, plain HTTP otherwise\n' > data/tls/site.caddy
  fi
  chmod 644 data/tls/site.caddy
}

# Your own certificate, before it is put in place. The API checks the same when it takes the upload; this is the
# check that decides. The first certificate in the file parses and is inside its validity dates, and its public
# key is the private key's. Returns 0, or 1 (one of the two cannot be read; a key with a passphrase cannot),
# 2 (not valid yet, or expired), 3 (the key is not this certificate's).
cert_pair() { # cert key
  openssl x509 -in "$1" -noout >/dev/null 2>&1 || return 1
  openssl x509 -in "$1" -noout -checkend 0 >/dev/null 2>&1 || return 2
  # notBefore=Nov 17 10:00:00 2026 GMT; a date this server's date(1) cannot read is not held against the file.
  cp_from=$(openssl x509 -in "$1" -noout -startdate 2>/dev/null | sed 's/^notBefore=//')
  cp_from=$(date -u -d "$cp_from" +%s 2>/dev/null || true)
  [ -z "$cp_from" ] || [ "$cp_from" -le "$(date -u +%s)" ] || return 2
  cp_cert=$(openssl x509 -in "$1" -noout -pubkey 2>/dev/null) || return 1
  cp_key=$(openssl pkey -in "$2" -pubout -passin pass: 2>/dev/null) || return 1
  { [ -n "$cp_cert" ] && [ "$cp_cert" = "$cp_key" ]; } || return 3
}

# Your own certificate: port 80 answers and port 443 serves exactly the uploaded certificate.
custom_report() {
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://$1/" 2>/dev/null || true)
  case "$code" in 30[1278]|2??) msg OK HTTP "http://$1 ($code)" "http://$1 ($code)" ;;
    *) msg WARN W_HTTP_UNREACHABLE "HTTP: http://$1 erişilemiyor (kod ${code:-yok})" "HTTP: http://$1 unreachable (code ${code:-none})" ;; esac
  want=$(openssl x509 -in data/tls/cert.pem -noout -fingerprint -sha256 2>/dev/null)
  got=$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$1" 2>/dev/null | openssl x509 -noout -fingerprint -sha256 2>/dev/null)
  if [ -n "$want" ] && [ "$want" = "$got" ]; then msg OK CERT "https://$1: yüklenen sertifika sunuluyor" "https://$1: the uploaded certificate is served"
  else fail E_CERT_NOT_SERVED "https://$1: yüklenen sertifika sunulmuyor; docker compose logs proxy" "https://$1: the uploaded certificate is not served; docker compose logs proxy"; fi
}

restart_proxy() {
  docker compose up -d --wait --wait-timeout 120 proxy >/dev/null 2>&1 || die 18 E_START_FAILED "Proxy başlamadı: docker compose logs proxy" "Proxy did not start: docker compose logs proxy"
}

# Takes the installation off this server without touching what cannot be made again: the settings, the keys,
# the backups and (unless --purge-data) the database stay, so `sh scripts/install.sh` brings it back.
do_uninstall() {
  [ "$(id -u)" = 0 ] || die 13 E_NEEDS_ROOT "Kaldırma için root gerekir (sudo)" "Uninstalling needs root (sudo)"
  take_lock
  if command -v systemctl >/dev/null; then
    (SWITCH=off; set_schedule) || true
    (SWITCH=off; set_agent) || true
  fi
  # Everything this script wrote outside the project directory.
  restart=""
  [ ! -f /etc/systemd/timesyncd.conf.d/lightning-vm.conf ] || restart="$restart systemd-timesyncd"
  [ ! -f /etc/systemd/resolved.conf.d/lightning-vm.conf ] || restart="$restart systemd-resolved"
  hp=/etc/systemd/system/cloud-init-hotplugd.service.d
  for f in /etc/systemd/timesyncd.conf.d/lightning-vm.conf /etc/systemd/resolved.conf.d/lightning-vm.conf \
    /etc/apt/apt.conf.d/52lightning-vm-auto "$hp/10-lightning-vm.conf" /root/.lightning-vm-git-credentials; do
    [ -e "$f" ] || continue
    rm -f "$f"; msg OK REMOVED "$f" "$f"
  done
  rmdir "$hp" /etc/systemd/timesyncd.conf.d /etc/systemd/resolved.conf.d 2>/dev/null || true # only when empty
  if command -v systemctl >/dev/null; then
    systemctl daemon-reload || true
    # shellcheck disable=SC2086 # one argument per service
    [ -z "$restart" ] || systemctl try-restart $restart || true
  fi
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    # Every profile, whether it is on in .env or not.
    if [ "$PURGE" = 1 ]; then
      COMPOSE_PROFILES=observability,terminal docker compose down --remove-orphans --volumes >/dev/null 2>&1 || fail E_UNINSTALL_DOWN "Container'lar ve veri birimleri kaldırılamadı: docker compose down --volumes" "The containers and data volumes could not be removed: docker compose down --volumes"
      [ "$FAILED" -ne 0 ] || msg WARN PURGED "Container'lar ve Docker veri birimleri (veritabanı, sertifikalar, izleme verisi) SİLİNDİ" "The containers and the Docker data volumes (database, certificates, monitoring data) were DELETED"
    else
      COMPOSE_PROFILES=observability,terminal docker compose down --remove-orphans >/dev/null 2>&1 || fail E_UNINSTALL_DOWN "Container'lar durdurulamadı: docker compose down" "The containers could not be stopped: docker compose down"
      [ "$FAILED" -ne 0 ] || msg OK STOPPED "Container'lar durduruldu ve kaldırıldı" "The containers were stopped and removed"
      msg INFO KEPT "Docker veri birimleri (veritabanı dahil) duruyor; silmek için: sudo sh scripts/install.sh uninstall --purge-data" "The Docker data volumes (the database among them) were kept; to delete them: sudo sh scripts/install.sh uninstall --purge-data"
    fi
  fi
  msg INFO KEPT "$(pwd) altında duranlar: .env, secrets/ (yedek anahtarı dahil), yedekler, data/ ve kaynak. Tamamen silmek için bu klasörü kendiniz silin" "Kept in $(pwd): .env, secrets/ (the backup key among them), the backups, data/ and the source. To remove everything, delete this directory yourself"
  msg INFO KEPT "Dokunulmayanlar: Docker Engine ve imajları, sunucu adı, saat dilimi ve /etc/hosts satırı" "Not touched: Docker Engine and its images, the host name, the time zone and the /etc/hosts line"
  [ "$FAILED" -eq 0 ] || exit 1
}

case "$MODE" in
  uninstall) do_uninstall; exit 0 ;;
  domain)
    [ -f .env ] || die 17 E_NOT_INSTALLED "Önce kurulum yapın: sh scripts/install.sh" "Install first: sh scripts/install.sh"
    case "$TLS_MODE" in
      ''|acme) TLS_MODE="" ;;
      staging) ACME_STAGING=1; TLS_MODE="" ;;
      custom) { [ -s "$CERT_FILE" ] && [ -s "$KEY_FILE" ] && grep -q 'BEGIN CERTIFICATE' "$CERT_FILE" && grep -q 'PRIVATE KEY' "$KEY_FILE"; } ||
          die 2 E_CERT_FILES "Sertifika ve anahtar için PEM dosyaları gerekli: --cert FILE --key FILE" "PEM files are required for the certificate and key: --cert FILE --key FILE"
        cert_pair "$CERT_FILE" "$KEY_FILE" || case $? in
          2) die 2 E_CERT_DATES "Sertifika geçerlilik tarihleri içinde değil (henüz geçerli değil ya da süresi dolmuş). Hiçbir şey değiştirilmedi" "The certificate is not inside its validity dates (not valid yet, or expired). Nothing was changed" ;;
          3) die 2 E_CERT_KEY_MISMATCH "Özel anahtar bu sertifikanın anahtarı değil. Hiçbir şey değiştirilmedi" "The private key is not this certificate's key. Nothing was changed" ;;
          *) die 2 E_CERT_UNREADABLE "Sertifika ya da anahtar okunamadı (openssl; parolalı anahtar kullanılamaz). Hiçbir şey değiştirilmedi" "The certificate or the key cannot be read (openssl; a key with a passphrase cannot be used). Nothing was changed" ;;
        esac ;;
      *) die 2 E_TLS_MODE "--tls: acme, staging veya custom" "--tls: acme, staging or custom" ;;
    esac
    # A failed change puts the previous address and certificate back, so the panel stays reachable.
    cp .env .env.before-domain; rm -rf data/tls.before; if [ -d data/tls ]; then cp -a data/tls data/tls.before; fi
    if ! configure_domain "$DOMAIN"; then
      msg WARN W_ROLLBACK "Önceki adres ve sertifika geri yükleniyor" "Restoring the previous address and certificate"
      # Contents only: the proxy bind-mounts data/tls, and a replaced directory would no longer be the one it sees.
      mv .env.before-domain .env; (umask 077; mkdir -p data/tls); rm -f data/tls/*; if [ -d data/tls.before ]; then cp -a data/tls.before/. data/tls/; rm -rf data/tls.before; fi
      load_settings; proxy_apply || true; write_settings
      die 1 E_DOMAIN_FAILED "HTTPS kurulamadı; yukarıdaki satırlara bakın" "HTTPS could not be set up; see the lines above"
    fi
    rm -rf .env.before-domain data/tls.before
    msg OK READY "https://$DOMAIN" "https://$DOMAIN"
    msg INFO NEXT "Mevcut oturumlar yeni adreste geçerli olmaz; yeniden giriş yapın" "Existing sessions do not carry over to the new address; sign in again"
    exit 0 ;;
  behind-proxy|local-only)
    [ -f .env ] || die 17 E_NOT_INSTALLED "Önce kurulum yapın: sh scripts/install.sh" "Install first: sh scripts/install.sh"
    case "$PROXY_PORT" in *[!0-9]*) die 2 E_PORT_INVALID "Geçersiz port" "Invalid port" ;; esac
    echo "$PROXY_PORT" | grep -Eq '^[0-9]{2,5}$' || die 2 E_PORT_INVALID "Geçersiz port: $PROXY_PORT" "Invalid port: $PROXY_PORT"
    # Everything given on the command line is checked before the first setting is written.
    if [ "$MODE" = behind-proxy ]; then
      [ -z "$TRUSTED_CIDR" ] || valid_cidrs "$TRUSTED_CIDR" ||
        die 2 E_CIDR_INVALID "Geçersiz --trusted-cidr (örnek: 172.18.0.1/32; birden çoksa aralarında birer boşluk)" "Invalid --trusted-cidr (example: 172.18.0.1/32; several are separated by single blanks)"
      # Behind another proxy the panel cannot know its own address: the request's Host is whatever that proxy
      # passes on. Mailed links (password reset, sign-in) are built from this address instead.
      if [ -n "$PUBLIC_URL" ]; then
        PUBLIC_URL=$(public_url "$PUBLIC_URL") || die 2 E_PUBLIC_URL_INVALID "Geçersiz --public-url (örnek: https://panel.example.com; yol olmadan)" "Invalid --public-url (example: https://panel.example.com; no path)"
      else
        PUBLIC_URL=$(env_value PANEL_PUBLIC_URL)
        [ -n "$PUBLIC_URL" ] || die 2 E_PUBLIC_URL_MISSING "Panelin dış adresi gerekli: --public-url https://panel.example.com (e-postayla gönderilen bağlantılar bu adresi kullanır). Hiçbir şey değiştirilmedi" "The panel's public address is required: --public-url https://panel.example.com (mailed links use it). Nothing was changed"
      fi
    else PUBLIC_URL=""; fi
    set_env PANEL_PUBLIC_URL "$PUBLIC_URL"
    set_env PANEL_SITE :80; set_env LISTEN_ADDRESS 127.0.0.1; set_env HTTP_PORT "$PROXY_PORT"; set_env HTTPS_PORT 8443
    set_env PANEL_PROBE_URL "" # no public address known; Prometheus probes the API from inside
    # behind-proxy: the outer proxy is expected to serve HTTPS, so session cookies are Secure (PANEL_TLS=0 in .env for plain HTTP).
    if [ "$MODE" = behind-proxy ]; then set_env PANEL_TLS 1; else set_env PANEL_TLS 0; fi
    if [ "$MODE" = behind-proxy ]; then
      # The host proxy reaches Caddy through Docker's port publishing, so Caddy sees the network gateway.
      if [ -z "$TRUSTED_CIDR" ]; then
        gw=$(docker network inspect lightning-vm_default -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true) # project name is fixed in compose.yaml
        [ -n "$gw" ] || die 18 E_GATEWAY_UNKNOWN "Docker ağ geçidi bulunamadı; --trusted-cidr verin" "Docker gateway not found; pass --trusted-cidr"
        TRUSTED_CIDR="$gw/32"
      fi
      set_env TRUSTED_PROXY_CIDRS "$TRUSTED_CIDR"
    else
      set_env TRUSTED_PROXY_CIDRS 127.0.0.1/32
    fi
    write_tls auto; set_env PANEL_TLS_MODE none
    load_settings; restart_proxy; proxy_apply || true; write_settings
    local_get /api/ready >/dev/null 2>&1 || die 19 E_NOT_READY "API hazır değil: docker compose logs proxy api" "API is not ready: docker compose logs proxy api"
    msg OK READY "http://127.0.0.1:$PORT" "http://127.0.0.1:$PORT"
    if [ "$MODE" = behind-proxy ]; then
      msg INFO TRUSTED "X-Forwarded-* yalnızca $TRUSTED_CIDR kaynağından kabul edilir" "X-Forwarded-* accepted only from $TRUSTED_CIDR"
      msg INFO PUBLIC_URL "E-postayla gönderilen bağlantılar $PUBLIC_URL adresini kullanır (değiştirmek için: --public-url)" "Mailed links use $PUBLIC_URL (to change it: --public-url)"
      msg INFO NEXT "Proxy'nizde: proxy_pass http://127.0.0.1:$PORT; Host, X-Forwarded-Host, X-Forwarded-For, X-Forwarded-Proto ve WebSocket Upgrade başlıklarını iletin (docs/domain-https.md)" "In your proxy: proxy_pass http://127.0.0.1:$PORT; forward Host, X-Forwarded-Host, X-Forwarded-For, X-Forwarded-Proto and WebSocket Upgrade headers (docs/domain-https.md)"
    fi
    exit 0 ;;
  backup)
    [ -f .env ] || die 17 E_NOT_INSTALLED "Önce kurulum yapın: sh scripts/install.sh" "Install first: sh scripts/install.sh"
    take_lock
    do_backup manual || exit 21
    exit 0 ;;
  restore) [ -f .env ] || die 17 E_NOT_INSTALLED "Önce kurulum yapın: sh scripts/install.sh" "Install first: sh scripts/install.sh"
    do_restore; exit 0 ;;
  update) do_update ;;
  maintenance) maint_dir; do_maintenance ;;
  releases) do_releases; exit 0 ;;
  run-requests) run_requests; exit 0 ;;
  host) do_host; exit 0 ;;
  os) do_os; exit 0 ;;
  state) do_state; exit 0 ;;
  agent) set_agent; exit 0 ;;
  schedule) set_schedule; exit 0 ;;
  auto-update) [ -f .env ] || die 17 E_NOT_INSTALLED "Önce kurulum yapın: sh scripts/install.sh" "Install first: sh scripts/install.sh"
    set_auto_update; exit 0 ;;
  monitoring|terminal)
    [ -f .env ] || die 17 E_NOT_INSTALLED "Önce kurulum yapın: sh scripts/install.sh" "Install first: sh scripts/install.sh"
    if [ "$MODE" = monitoring ]; then profile=observability; else profile=terminal; fi
    # Only the services of this compose profile are touched, on and off: the panel's own services keep
    # running exactly as they are (no recreate, whatever compose files they were started with).
    all=$(mktemp); base=$(mktemp)
    COMPOSE_PROFILES=$profile docker compose config --services 2>/dev/null | sort > "$all"
    COMPOSE_PROFILES= docker compose config --services 2>/dev/null | sort > "$base"
    extra=$(comm -23 "$all" "$base" | tr '\n' ' '); rm -f "$all" "$base"
    [ -n "$extra" ] || die 18 E_PROFILE "Compose dosyasında $profile servisi yok" "No $profile services in the compose file"
    others=$(profiles_without "$profile")
    if [ "$SWITCH" = on ]; then
      [ "$profile" = observability ] && write_observability
      set_env COMPOSE_PROFILES "$(printf '%s\n%s\n' "$others" "$profile" | grep -v '^$' | paste -sd, -)"
      # shellcheck disable=SC2086
      COMPOSE_PROFILES=$profile docker compose up -d --no-deps --build --wait $extra >/dev/null 2>&1 ||
        die 18 E_PROFILE "$profile bileşenleri başlatılamadı (docker compose ps ile bakın)" "$profile could not be started (see docker compose ps)"
      if [ "$profile" = observability ]; then msg OK MONITORING "İzleme açık: Prometheus, Grafana, Loki ve Alertmanager çalışıyor" "Monitoring on: Prometheus, Grafana, Loki and Alertmanager are running"
      else msg OK TERMINAL "Yönetici terminali açık" "Administrator terminal on"; fi
    else
      set_env COMPOSE_PROFILES "$others"
      # shellcheck disable=SC2086
      COMPOSE_PROFILES=$profile docker compose rm -sf $extra >/dev/null 2>&1 || true
      if [ "$profile" = observability ]; then msg OK MONITORING "İzleme kapatıldı (veriler korunur)" "Monitoring off (its data is kept)"
      else msg OK TERMINAL "Yönetici terminali kapatıldı" "Administrator terminal off"; fi
    fi
    exit 0 ;;
  reset-password)
    [ -n "$RESET_EMAIL" ] || die 2 E_USAGE "Kullanım: sh scripts/install.sh reset-password E-POSTA [--disable-2fa]" "Usage: sh scripts/install.sh reset-password EMAIL [--disable-2fa]"
    new_password=$(docker compose exec -T api node dist/cli.js reset-password "$RESET_EMAIL" $DISABLE_2FA 2>/dev/null) && [ -n "$new_password" ] ||
      die 18 E_RESET_FAILED "Şifre sıfırlanamadı: bu e-postayla bir hesap yok veya servisler çalışmıyor" "Password not reset: no account with this e-mail, or the services are not running"
    msg OK PASSWORD_RESET "Yeni şifre (yalnızca şimdi gösterilir; tüm oturumlar kapatıldı):" "New password (shown only now; every session was signed out):"
    printf '\n    %s\n    %s\n\n' "$RESET_EMAIL" "$new_password"
    exit 0 ;;
  recover-setup)
    docker compose exec -T api node dist/cli.js recover-setup >/dev/null 2>&1 || die 18 E_RECOVER_FAILED "Kurtarma çalışmadı; servisler çalışıyor mu?" "Recovery failed; are the services running?"
    msg OK SETUP_REOPENED "Sihirbaz yeniden açıldı: yönetici olarak giriş yapıp /setup adresine gidin" "Wizard reopened: sign in as an administrator and open /setup"
    exit 0 ;;
  check)
    host_checks; install_state
    case "$SITE" in :*) ;; *) dns_report "$SITE"; web_report "$SITE" ;; esac
    [ "$FAILED" -eq 0 ] || exit 1
    exit 0 ;;
esac

# install (also resumes an interrupted install: every step below is safe to repeat)
if ! command -v docker >/dev/null && { [ "$INSTALL_DOCKER" = 1 ] || [ "$(id -u)" = 0 ]; }; then install_docker; fi
quiet_hotplug
host_checks
[ "$FAILED" -eq 0 ] || die 1 E_PRECHECK "Ön kontroller başarısız; yukarıdaki FAIL satırlarını düzeltin" "Pre-checks failed; fix the FAIL lines above"
write_env
write_secrets
write_observability
set_env APP_VERSION "$(app_version)"
# Where updates come from (scripts/get.sh passes these): released versions, or a branch for test servers.
case "$CHANNEL" in ''|stable|beta|edge) ;; *) die 2 E_CHANNEL_INVALID "Kanal stable, beta veya edge olmalı" "Channel must be stable, beta or edge" ;; esac
[ -z "$CHANNEL" ] || set_env UPDATE_CHANNEL "$CHANNEL"
[ -z "$BRANCH" ] || set_env UPDATE_BRANCH "$BRANCH"
# Monitoring runs by default where it fits (4 GB RAM); COMPOSE_PROFILES in .env applies to every compose command.
if [ "$MONITORING" = 1 ] && ! grep -q '^COMPOSE_PROFILES=' .env && [ "${mem_mb:-0}" -ge 3800 ]; then set_env COMPOSE_PROFILES observability; fi
# --no-monitoring takes only the monitoring profile off the list; the terminal, if it is on, stays on.
[ "$MONITORING" = 1 ] || set_env COMPOSE_PROFILES "$(profiles_without observability)"
[ "$LOCAL" = 1 ] && revert_local_settings
# Installs from before PANEL_TLS: derive it from the access mode already configured.
if ! grep -q '^PANEL_TLS=' .env; then case "$SITE" in :*) set_env PANEL_TLS 0 ;; *) set_env PANEL_TLS 1 ;; esac; fi
# Installs from before PANEL_PUBLIC_URL: a domain this installation serves is its public address. Behind another
# proxy it has to be told: sh scripts/install.sh behind-proxy --public-url https://panel.example.com
if ! grep -q '^PANEL_PUBLIC_URL=' .env; then case "$SITE" in :*) ;; *) set_env PANEL_PUBLIC_URL "https://$SITE" ;; esac; fi
write_settings
docker compose config --quiet || die 17 E_COMPOSE_INVALID "Compose yapılandırması geçersiz" "Compose configuration is invalid"
msg INFO STARTING "Servisler derleniyor ve başlatılıyor (birkaç dakika sürebilir)" "Building and starting services (may take a few minutes)"
docker compose up -d --build --wait --wait-timeout 600 >/dev/null 2>&1 || die 18 E_START_FAILED "Servisler başlamadı: docker compose ps; docker compose logs" "Services did not start: docker compose ps; docker compose logs"
i=0; until local_get /api/ready >/dev/null 2>&1 || [ $i -ge 12 ]; do sleep 5; i=$((i + 1)); done
local_get /api/ready >/dev/null 2>&1 || die 19 E_NOT_READY "API hazır değil: docker compose logs api" "API is not ready: docker compose logs api"
# Grafana takes its admin password only on first start; keep it equal to .env when its volume is older.
if grep -Eq '^COMPOSE_PROFILES=(.*,)?observability(,|$)' .env; then
  # On standard input: an argument would show in the process list, the container's processes included.
  env_value GRAFANA_PASSWORD | docker compose exec -T grafana grafana cli admin reset-admin-password --password-from-stdin >/dev/null 2>&1 || msg WARN W_GRAFANA "Grafana parolası eşitlenemedi" "Could not sync the Grafana password"
fi

# Access: an explicit --domain; on a first install with a public IPv4, <ip>.sslip.io (a public DNS name that
# resolves to that IP) with a real certificate; otherwise local only. A failed attempt falls back to local.
site_target=""
if [ -n "$DOMAIN" ] && [ "$DOMAIN" != "$SITE" ]; then site_target=$DOMAIN
elif [ -z "$(env_value PANEL_SITE)" ] && ip4=$(public_ipv4) && [ -n "$ip4" ]; then
  site_target="$(echo "$ip4" | tr . -).sslip.io"
  msg INFO AUTO_DOMAIN "Genel IP $ip4 bulundu; HTTPS için $site_target kullanılacak (kendi alan adınız için: --domain)" "Public IP $ip4 found; using $site_target for HTTPS (for your own name: --domain)"
fi
if [ -n "$site_target" ] && ! configure_domain "$site_target"; then
  msg WARN W_DOMAIN_FALLBACK "$site_target için HTTPS kurulamadı; panel yalnızca yerelde açık (80/443 dışarıdan açık mı?)" "HTTPS could not be set up for $site_target; the panel is local only (are 80/443 open from outside?)"
  revert_local_settings; restart_proxy
fi
[ -n "$(env_value PANEL_SITE)" ] || set_env PANEL_SITE :80
load_settings

# The first admin: created here with a generated password unless --setup-wizard asks for the browser wizard.
admin_email="" admin_password=""
if [ "$WIZARD" = 1 ]; then
  if token=$(docker compose exec -T api node dist/cli.js bootstrap-token 2>/dev/null); then
    msg INFO SETUP_TOKEN "Kurulum anahtarı (1 saat geçerli, yalnızca burada gösterilir):" "Setup token (valid 1 hour, shown only here):"
    echo "      $token"
  fi
else
  case "$SITE" in :*) admin_email=${ADMIN_EMAIL:-admin@lightning.local} ;; *) admin_email=${ADMIN_EMAIL:-admin@$SITE} ;; esac
  if admin_password=$(docker compose exec -T api node dist/cli.js create-admin "$admin_email" "$UI" 2>/dev/null) && [ -n "$admin_password" ]; then
    (umask 077; printf 'email=%s\npassword=%s\n' "$admin_email" "$admin_password" > secrets/initial-admin.txt)
  else admin_email=""; fi
fi

# Daily backups (hourly timer) and a first backup right away.
if [ "$SCHEDULE" = 1 ] && [ "$(id -u)" = 0 ] && command -v systemctl >/dev/null && [ ! -f /etc/systemd/system/lightning-vm-maintenance.timer ]; then
  (SWITCH=on; set_schedule) >/dev/null 2>&1 || msg WARN W_TIMER "Zamanlanmış yedek kurulamadı: sh scripts/install.sh schedule on" "Scheduled backups not set up: sh scripts/install.sh schedule on"
fi
# Updates and backups from the admin panel (the agent runs on the host, not in a container).
if [ "$(id -u)" = 0 ] && command -v systemctl >/dev/null && [ ! -f /etc/systemd/system/lightning-vm-requests.path ]; then
  (SWITCH=on; set_agent) >/dev/null 2>&1 || msg WARN W_AGENT "Panel ajanı kurulamadı: sudo sh scripts/install.sh agent on" "Panel agent not set up: sudo sh scripts/install.sh agent on"
fi
(do_backup install) >/dev/null 2>&1 || msg WARN W_BACKUP "İlk yedek alınamadı: sh scripts/install.sh backup" "The first backup failed: sh scripts/install.sh backup"
write_settings

# Summary: everything needed to start, in one place.
row() { if [ "$UI" = tr ]; then printf '  %-12s %s\n' "$1" "$3"; else printf '  %-12s %s\n' "$2" "$3"; fi; }
host_ip=$(public_ipv4 || true); host_ip=${host_ip:-SUNUCU_IP}
echo
msg OK DONE "Lightning VM hazır" "Lightning VM is ready"
case "$SITE" in
  :*) row "Panel" "Panel" "http://127.0.0.1:$PORT  (uzaktan: ssh -L $PORT:127.0.0.1:$PORT root@$host_ip)" ;;
  *) row "Panel" "Panel" "https://$SITE" ;;
esac
if [ -n "$admin_email" ]; then
  row "E-posta" "E-mail" "$admin_email"
  row "Parola" "Password" "$admin_password"
  row "" "" "$(if [ "$UI" = tr ]; then echo 'secrets/initial-admin.txt dosyasında da var; saklayıp silin'; else echo 'also in secrets/initial-admin.txt; store it and delete the file'; fi)"
elif [ "$WIZARD" != 1 ]; then
  row "Hesap" "Admin" "$(if [ "$UI" = tr ]; then echo 'zaten var (mevcut hesabınızla girin)'; else echo 'already exists (sign in with your account)'; fi)"
else
  row "Kurulum" "Setup" "/setup"
fi
if grep -Eq '^COMPOSE_PROFILES=(.*,)?observability(,|$)' .env; then
  row "Grafana" "Grafana" "http://127.0.0.1:3001  (ssh -L 3001:127.0.0.1:3001 root@$host_ip), admin / .env GRAFANA_PASSWORD"
fi
if [ -f /etc/systemd/system/lightning-vm-maintenance.timer ]; then row "Yedek" "Backups" "$(if [ "$UI" = tr ]; then echo 'her gün'; else echo daily; fi) -> backups/"
else row "Yedek" "Backups" "$(if [ "$UI" = tr ]; then echo 'elle: sh scripts/install.sh backup'; else echo 'manual: sh scripts/install.sh backup'; fi)"; fi
msg INFO NEXT "Panelde: Yönetim → Bağlantılar → vCenter ekleyin, sonra Katalog'dan havuz, şablon, IP havuzu ve paket oluşturun" "In the panel: Admin → Connections → add vCenter, then create a pool, template, IP pool and package in Catalog"
msg WARN BACKUP_KEY "secrets/backup.key dosyasını sunucu dışında saklayın; o olmadan yedekler açılamaz" "Keep a copy of secrets/backup.key off this server; backups cannot be opened without it"
