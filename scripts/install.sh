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
#   sh scripts/install.sh backup         encrypted backup of the database, settings, keys and certificates
#   sh scripts/install.sh restore FILE [--yes-replace-data]
#                                        restore a backup (without the flag it only checks and explains)
#   sh scripts/install.sh update [--to vX.Y.Z]
#                                        update a git checkout to the latest release of UPDATE_CHANNEL
#   sh scripts/install.sh schedule on|off
#                                        hourly systemd timer: daily backup and the automatic update
#   sh scripts/install.sh auto-update on|off [--channel stable|beta] [--window 03:00-05:00]
#   sh scripts/install.sh domain panel.example.com [--acme-staging]
#                                        serve the panel on that name with automatic HTTPS (ports 80/443)
#   sh scripts/install.sh behind-proxy [--port 8080] [--trusted-cidr CIDR]
#                                        plain HTTP on 127.0.0.1 for an existing Nginx/Caddy/Traefik in front
#   sh scripts/install.sh local-only     plain HTTP on 127.0.0.1:8080 only (SSH tunnel)
# Options: --lang tr|en  --install-docker  --allow-unsupported-os
# It never changes firewall, SSH or other web server settings, and never prints secrets.
# shellcheck disable=SC1091 # /etc/os-release exists only on the target host
set -eu
cd "${LVM_ROOT:-$(dirname "$0")/..}"
# update checks out another version of this very file: run from a copy so sh never reads a changed script.
if [ -n "${LVM_REEXEC:-}" ]; then rm -f "$0"
else case " $* " in *" update "*|*" maintenance "*)
  copy=$(mktemp); cp scripts/install.sh "$copy"; LVM_ROOT=$(pwd) LVM_REEXEC=1 exec sh "$copy" "$@" ;;
esac; fi

MODE=install INSTALL_DOCKER=0 ALLOW_OS=0 DOMAIN="" ACME_STAGING=0 PROXY_PORT=8080 TRUSTED_CIDR=""
RESTORE_FILE="" YES=0 TO="" AUTO=0 SWITCH="" CHANNEL="" WINDOW=""
LOCAL=0 WIZARD=0 MONITORING=1 SCHEDULE=1 ADMIN_EMAIL=""
case "${LANG:-}" in tr*) UI="tr" ;; *) UI="en" ;; esac
while [ $# -gt 0 ]; do
  case "$1" in
    install|check|recover-setup|update|behind-proxy|local-only|backup|maintenance) MODE=$1 ;;
    restore) MODE=restore; if [ $# -gt 1 ]; then shift; RESTORE_FILE=$1; fi ;;
    schedule|auto-update) MODE=$1; if [ $# -gt 1 ]; then shift; SWITCH=$1; fi
      case "$SWITCH" in on|off) ;; *) echo "$MODE: on or off" >&2; exit 2 ;; esac ;;
    --yes-replace-data) YES=1 ;;
    --to) shift; TO=${1:-} ;;
    --auto) AUTO=1 ;;
    --channel) shift; CHANNEL=${1:-} ;;
    --window) shift; WINDOW=${1:-} ;;
    domain) MODE=domain; if [ $# -gt 1 ]; then shift; DOMAIN=$1; fi ;;
    --acme-staging) ACME_STAGING=1 ;;
    --domain) shift; DOMAIN=${1:-} ;;
    --local) LOCAL=1 ;;
    --admin-email) shift; ADMIN_EMAIL=${1:-} ;;
    --setup-wizard) WIZARD=1 ;;
    --no-monitoring) MONITORING=0 ;;
    --no-schedule) SCHEDULE=0 ;;
    --port) shift; PROXY_PORT=${1:-} ;;
    --trusted-cidr) shift; TRUSTED_CIDR=${1:-} ;;
    --lang) shift; UI=${1:-en} ;;
    --install-docker) INSTALL_DOCKER=1 ;;
    --allow-unsupported-os) ALLOW_OS=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

# msg LEVEL CODE "türkçe" "english"
msg() { if [ "$UI" = tr ]; then t=$3; else t=$4; fi; printf '%-5s %-22s %s\n' "$1" "$2" "$t"; }
FAILED=0
fail() { msg FAIL "$1" "$2" "$3"; FAILED=$((FAILED + 1)); }
die() { msg FAIL "$2" "$3" "$4"; exit "$1"; }

env_value() { if [ -f .env ]; then sed -n "s/^$1=//p" .env | tail -n 1; fi; }
# Replaces or appends one setting; used only when the operator asks for an access-mode change.
set_env() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi; }
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

record() { # kind status code [extra JSON fields, each starting with a comma]
  (umask 022; mkdir -p data/maintenance)
  printf '{"time":"%s","kind":"%s","status":"%s","code":"%s","version":"%s"%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" "$(app_version)" "${4:-}" >> data/maintenance/history.jsonl
  tail -n 500 data/maintenance/history.jsonl > data/maintenance/history.tmp && mv data/maintenance/history.tmp data/maintenance/history.jsonl
  chmod 644 data/maintenance/history.jsonl
}

write_settings() {
  if [ -n "$(env_value BACKUP_COPY_TO)" ]; then copy=on; else copy=off; fi
  if [ -f /etc/systemd/system/lightning-vm-maintenance.timer ]; then timer=on; else timer=off; fi
  b=$(env_value BACKUP_SCHEDULE); k=$(env_value BACKUP_KEEP); a=$(env_value AUTO_UPDATE); c=$(env_value UPDATE_CHANNEL); w=$(env_value UPDATE_WINDOW)
  (umask 022; mkdir -p data/maintenance)
  printf '{"schedule":"%s","backupSchedule":"%s","backupKeep":"%s","backupCopy":"%s","autoUpdate":"%s","updateChannel":"%s","updateWindow":"%s"}\n' \
    "$timer" "${b:-daily}" "${k:-7}" "$copy" "${a:-off}" "${c:-stable}" "${w:-03:00-05:00}" > data/maintenance/settings.json
}

# Operator-owned monitoring settings live in data/observability, outside git, so editing them never
# blocks an update. Existing files are kept.
write_observability() {
  (umask 022; mkdir -p data/observability)
  [ -f data/observability/alertmanager.yml ] || cp deploy/observability/alertmanager.example.yml data/observability/alertmanager.yml
}

psql_value() { docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"$1\""; }

# PostgreSQL (custom-format dump), .env, the encryption keys and Caddy's certificates, in one tar
# encrypted with secrets/backup.key. Redis is not included: it holds only queue copies and
# sessions; open operations are queued again from PostgreSQL.
# Its variables are prefixed or private to it: restore calls it while holding its own.
do_backup() { # reason
  reason=$1
  dir=$(env_value BACKUP_DIR); dir=${dir:-backups}
  keep=$(env_value BACKUP_KEEP); keep=${keep:-7}
  [ -s secrets/backup.key ] || { record backup failed E_BACKUP_KEY_MISSING ",\"reason\":\"$reason\""; die 21 E_BACKUP_KEY_MISSING "secrets/backup.key yok; önce: sh scripts/install.sh" "secrets/backup.key missing; run first: sh scripts/install.sh"; }
  (umask 077; mkdir -p "$dir")
  name="lightning-$(date -u +%Y%m%dT%H%M%SZ)"; bwork="$dir/.work-$$"
  (umask 077; mkdir "$bwork")
  if ! docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$bwork/db.dump" 2>/dev/null || [ ! -s "$bwork/db.dump" ]; then
    rm -rf "$bwork"; record backup failed E_BACKUP_DB ",\"reason\":\"$reason\""
    die 21 E_BACKUP_DB "Veritabanı yedeği alınamadı; postgres çalışıyor mu?" "Database dump failed; is postgres running?"
  fi
  psql_value 'SELECT version FROM schema_migrations ORDER BY 1' > "$bwork/migrations"
  app_version > "$bwork/version"
  cp .env "$bwork/env"; cp secrets/master.key secrets/vmware.token "$bwork/"
  if [ -f data/observability/alertmanager.yml ]; then cp data/observability/alertmanager.yml "$bwork/"; fi
  docker compose exec -T proxy tar -C /data -czf - . > "$bwork/caddy_data.tgz" 2>/dev/null || rm -f "$bwork/caddy_data.tgz"
  out="$dir/$name.tar.enc"
  tar -C "$bwork" -cf - . | (umask 077; openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass file:secrets/backup.key -out "$out")
  rm -rf "$bwork"
  # Read it back before calling it a backup.
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:secrets/backup.key -in "$out" 2>/dev/null | tar -tf - 2>/dev/null | grep -q 'db.dump'; then
    rm -f "$out"; record backup failed E_BACKUP_VERIFY ",\"reason\":\"$reason\""
    die 21 E_BACKUP_VERIFY "Yedek dosyası geri okunamadı (disk dolu olabilir)" "The backup file could not be read back (the disk may be full)"
  fi
  (cd "$dir" && sha256sum "$name.tar.enc" > "$name.tar.enc.sha256" && chmod 600 "$name.tar.enc.sha256")
  # Retention: the newest $keep local backups stay; the external copy keeps its own policy.
  set -- "$dir"/lightning-*.tar.enc # glob order is name order, and the names are UTC timestamps
  while [ $# -gt "$keep" ]; do rm -f "$1" "$1.sha256"; shift; done
  bytes=$(stat -c %s "$out"); copied=false; copy_to=$(env_value BACKUP_COPY_TO)
  BACKUP_FILE=$out
  if [ -n "$copy_to" ]; then
    if rsync -a "$out" "$out.sha256" "$copy_to/" 2>/dev/null; then copied=true
    else
      record backup failed E_BACKUP_COPY ",\"reason\":\"$reason\",\"file\":\"$name.tar.enc\",\"bytes\":$bytes,\"copied\":false"
      msg WARN E_BACKUP_COPY "Yedek yerelde alındı ama $copy_to hedefine kopyalanamadı" "Backup written locally but not copied to $copy_to"
      return 1
    fi
  fi
  record backup ok - ",\"reason\":\"$reason\",\"file\":\"$name.tar.enc\",\"bytes\":$bytes,\"copied\":$copied"
  msg OK BACKUP "$out ($bytes bayt)" "$out ($bytes bytes)"
}

do_restore() {
  file=$RESTORE_FILE
  [ -f "$file" ] || die 2 E_RESTORE_FILE "Yedek dosyası bulunamadı: '$file'" "Backup file not found: '$file'"
  [ -f "$file.sha256" ] || die 22 E_RESTORE_CHECKSUM "Sağlama dosyası yok: $file.sha256" "Checksum file missing: $file.sha256"
  (cd "$(dirname "$file")" && sha256sum -c --quiet "$(basename "$file").sha256" >/dev/null 2>&1) || die 22 E_RESTORE_CHECKSUM "Sağlama tutmuyor; dosya bozuk veya değiştirilmiş" "Checksum mismatch; the file is damaged or was changed"
  work=$(mktemp -d)
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:secrets/backup.key -in "$file" 2>/dev/null | tar -C "$work" -xf - 2>/dev/null; then
    rm -rf "$work"; die 22 E_RESTORE_DECRYPT "Yedek açılamadı: secrets/backup.key bu yedeğin anahtarı değil" "Backup could not be opened: secrets/backup.key is not this backup's key"
  fi
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
  safety=""
  if docker compose exec -T postgres pg_isready -q >/dev/null 2>&1; then
    msg INFO SAFETY_BACKUP "Önce mevcut verinin yedeği alınıyor" "Backing up the current data first"
    do_backup pre-restore || true
    safety=${BACKUP_FILE:-}
    [ -n "$safety" ] || die 22 E_RESTORE_NO_SAFETY "Mevcut verinin yedeği alınamadı; geri yükleme yapılmadı" "The current data could not be backed up; nothing was restored"
  fi
  docker compose stop api worker web console vmware proxy >/dev/null 2>&1 || true
  if ! docker compose exec -T postgres sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" && pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < "$work/db.dump" >/dev/null 2>&1; then
    rm -rf "$work"; record restore failed E_RESTORE_DB ",\"file\":\"$(basename "$file")\""
    die 22 E_RESTORE_DB "Veritabanı geri yüklenemedi; uygulama servisleri durduruldu. Önceki veri: $safety" "Database restore failed; the app services are stopped. Previous data: $safety"
  fi
  # The stored VMware passwords are encrypted with the backup's master key: both keys come back with the data.
  for f in master.key vmware.token; do
    rm -f "secrets/$f"; cp "$work/$f" "secrets/$f"
    if [ "$(id -u)" = 0 ]; then chown 1000:1000 "secrets/$f"; fi
    chmod 400 "secrets/$f"
  done
  (umask 077; cp "$work/env" .env.from-backup)
  if [ -f "$work/alertmanager.yml" ]; then cp "$work/alertmanager.yml" data/observability/alertmanager.yml.from-backup; fi
  if [ -s "$work/caddy_data.tgz" ]; then
    docker compose run --rm --no-deps -T --entrypoint sh proxy -c 'find /data -mindepth 1 -delete && tar -xzf - -C /data' < "$work/caddy_data.tgz" >/dev/null 2>&1 \
      || msg WARN W_RESTORE_CERTS "Sertifikalar geri yüklenemedi; Caddy yenilerini alır" "Certificates not restored; Caddy will request new ones"
  fi
  rm -rf "$work"
  if docker compose up -d --wait --wait-timeout 300 >/dev/null 2>&1 && local_get /api/ready >/dev/null 2>&1; then
    record restore ok - ",\"file\":\"$(basename "$file")\""
    msg OK RESTORED "Geri yüklendi. Yedekteki ayarlar: .env.from-backup ve data/observability/alertmanager.yml.from-backup (geçerli ayarlar değiştirilmedi). Önceki veri: $safety" "Restored. Settings from the backup: .env.from-backup and data/observability/alertmanager.yml.from-backup (the current settings were kept). Previous data: $safety"
  else
    record restore failed E_RESTORE_START ",\"file\":\"$(basename "$file")\""
    die 22 E_RESTORE_START "Veri geri yüklendi ama servisler hazır değil: docker compose logs" "Data restored but services are not ready: docker compose logs"
  fi
}

in_window() { # HH:MM-HH:MM in local time, may wrap past midnight
  w=${1:-03:00-05:00}; now=$(date +%H%M); s=$(echo "${w%-*}" | tr -d :); e=$(echo "${w#*-}" | tr -d :)
  if [ "$s" -le "$e" ]; then [ "$now" -ge "$s" ] && [ "$now" -lt "$e" ]; else [ "$now" -ge "$s" ] || [ "$now" -lt "$e" ]; fi
}

latest_tag() { # stable: vX.Y.Z only; beta: also vX.Y.Z-rc.1 and similar
  if [ "$1" = beta ]; then re='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'; else re='^v[0-9]+\.[0-9]+\.[0-9]+$'; fi
  git -c versionsort.suffix=- tag -l 'v[0-9]*' --sort=-v:refname | grep -E "$re" | head -n 1
}

up_and_ready() {
  docker compose up -d --build --wait --wait-timeout 600 >/dev/null 2>&1 || return 1
  i=0; until local_get /api/ready >/dev/null 2>&1 || [ $i -ge 12 ]; do sleep 5; i=$((i + 1)); done
  local_get /api/ready >/dev/null 2>&1
}

# Source installs follow released git tags. Containers can be rolled back; the database cannot be
# rolled back automatically, so a backup is taken first and named in every failure message.
do_update() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die 20 E_UPDATE_NO_GIT "Güncelleme, git ile alınmış kaynak gerektirir (git clone)" "Updating needs a source checkout made with git clone"
  [ -f .env ] || die 17 E_NOT_INSTALLED "Önce kurulum yapın: sh scripts/install.sh" "Install first: sh scripts/install.sh"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die 20 E_UPDATE_LOCAL_CHANGES "Kaynakta yerel değişiklikler var (git status); güncelleme yapılmadı" "The source has local changes (git status); not updating"
  channel=$(env_value UPDATE_CHANNEL); channel=${channel:-stable}
  if [ "$AUTO" = 1 ]; then
    [ "$(env_value AUTO_UPDATE)" = on ] || exit 0
    in_window "$(env_value UPDATE_WINDOW)" || exit 0
  fi
  if [ -n "$(git remote)" ]; then
    git fetch --quiet --tags --force "$(git remote | head -n 1)" 2>/dev/null || { record update failed E_UPDATE_FETCH; die 20 E_UPDATE_FETCH "Sürümler alınamadı (git fetch)" "Could not fetch releases (git fetch)"; }
  fi
  current=$(git rev-parse HEAD); current_name=$(app_version)
  if [ -n "$TO" ]; then target=$TO; else target=$(latest_tag "$channel"); fi
  [ -n "$target" ] || die 20 E_UPDATE_NO_RELEASE "Yayımlanmış sürüm etiketi (vX.Y.Z) yok" "No released version tag (vX.Y.Z)"
  git rev-parse -q --verify "$target^{commit}" >/dev/null || die 20 E_UPDATE_UNKNOWN_VERSION "Bilinmeyen sürüm: $target" "Unknown version: $target"
  if [ "$(git rev-parse "$target^{commit}")" = "$current" ]; then msg OK UP_TO_DATE "Güncel: $current_name" "Up to date: $current_name"; exit 0; fi
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
  git -c advice.detachedHead=false checkout -q --detach "$target"
  set_env APP_VERSION "$(app_version)"
  if up_and_ready; then
    record update ok - ",\"from\":\"$current_name\",\"to\":\"$target\""
    msg OK UPDATED "$target çalışıyor" "$target is running"; exit 0
  fi
  msg FAIL E_UPDATE_FAILED "$target hazır olmadı; $current_name sürümüne geri dönülüyor" "$target did not become ready; rolling back to $current_name"
  git -c advice.detachedHead=false checkout -q --detach "$current"
  set_env APP_VERSION "$current_name"
  if up_and_ready; then rb=true; else rb=false; fi
  record update failed E_UPDATE_FAILED ",\"from\":\"$current_name\",\"to\":\"$target\",\"rolledBack\":$rb"
  msg WARN DB_NOT_ROLLED_BACK "Container'lar geri alındı (çalışıyor: $rb). Veritabanı otomatik geri alınmaz; eski sürüm sorun çıkarırsa: sh scripts/install.sh restore $pre --yes-replace-data" "Containers rolled back (running: $rb). The database is not rolled back automatically; if the old version misbehaves: sh scripts/install.sh restore $pre --yes-replace-data"
  exit 23
}

# Hourly systemd timer: a daily backup (when the last good one is older than 23 h) and, when
# enabled, the automatic update inside the maintenance window.
do_maintenance() {
  if [ "$(env_value BACKUP_SCHEDULE)" != off ]; then
    last=$(grep '"kind":"backup","status":"ok"' data/maintenance/history.jsonl 2>/dev/null | tail -n 1 | sed 's/^{"time":"\([^"]*\)".*/\1/')
    age=$(( $(date +%s) - $(date -d "${last:-1970-01-01T00:00:00Z}" +%s) ))
    if [ "$age" -gt 82800 ]; then (do_backup scheduled) || true; fi
  fi
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
  case "$CHANNEL" in ''|stable|beta) ;; *) die 2 E_CHANNEL_INVALID "Kanal stable veya beta olmalı" "Channel must be stable or beta" ;; esac
  if [ -n "$WINDOW" ] && ! echo "$WINDOW" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$'; then
    die 2 E_WINDOW_INVALID "Bakım penceresi SS:DD-SS:DD olmalı (örnek 03:00-05:00)" "The maintenance window must be HH:MM-HH:MM (example 03:00-05:00)"
  fi
  set_env AUTO_UPDATE "$SWITCH"
  [ -z "$CHANNEL" ] || set_env UPDATE_CHANNEL "$CHANNEL"
  [ -z "$WINDOW" ] || set_env UPDATE_WINDOW "$WINDOW"
  write_settings
  c=$(env_value UPDATE_CHANNEL); w=$(env_value UPDATE_WINDOW)
  msg OK AUTO_UPDATE "Otomatik güncelleme: $SWITCH (kanal ${c:-stable}, pencere ${w:-03:00-05:00})" "Automatic update: $SWITCH (channel ${c:-stable}, window ${w:-03:00-05:00})"
  [ -f /etc/systemd/system/lightning-vm-maintenance.timer ] || [ "$SWITCH" = off ] || msg WARN W_NO_TIMER "Zamanlayıcı kurulu değil: sudo sh scripts/install.sh schedule on" "The timer is not installed: sudo sh scripts/install.sh schedule on"
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
  set_env TRUSTED_PROXY_CIDRS 127.0.0.1/32; set_env PANEL_PROBE_URL ""; set_env PANEL_TLS 0
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
  load_settings; restart_proxy
  msg INFO ACME "Sertifika isteniyor (en fazla 2 dk)" "Requesting certificate (up to 2 min)"
  i=0; until local_get /api/ready >/dev/null 2>&1 || [ $i -ge 24 ]; do sleep 5; i=$((i + 1)); done
  web_report "$d"
  [ "$FAILED" -eq 0 ]
}

restart_proxy() {
  docker compose up -d --wait --wait-timeout 120 proxy >/dev/null 2>&1 || die 18 E_START_FAILED "Proxy başlamadı: docker compose logs proxy" "Proxy did not start: docker compose logs proxy"
}

case "$MODE" in
  domain)
    [ -f .env ] || die 17 E_NOT_INSTALLED "Önce kurulum yapın: sh scripts/install.sh" "Install first: sh scripts/install.sh"
    configure_domain "$DOMAIN" || die 1 E_DOMAIN_FAILED "HTTPS kurulamadı; yukarıdaki satırlara bakın" "HTTPS could not be set up; see the lines above"
    msg OK READY "https://$DOMAIN" "https://$DOMAIN"
    msg INFO NEXT "Mevcut oturumlar yeni adreste geçerli olmaz; yeniden giriş yapın" "Existing sessions do not carry over to the new address; sign in again"
    exit 0 ;;
  behind-proxy|local-only)
    [ -f .env ] || die 17 E_NOT_INSTALLED "Önce kurulum yapın: sh scripts/install.sh" "Install first: sh scripts/install.sh"
    echo "$PROXY_PORT" | grep -Eq '^[0-9]{2,5}$' || die 2 E_PORT_INVALID "Geçersiz port: $PROXY_PORT" "Invalid port: $PROXY_PORT"
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
    load_settings; restart_proxy
    local_get /api/ready >/dev/null 2>&1 || die 19 E_NOT_READY "API hazır değil: docker compose logs proxy api" "API is not ready: docker compose logs proxy api"
    msg OK READY "http://127.0.0.1:$PORT" "http://127.0.0.1:$PORT"
    if [ "$MODE" = behind-proxy ]; then
      msg INFO TRUSTED "X-Forwarded-* yalnızca $TRUSTED_CIDR kaynağından kabul edilir" "X-Forwarded-* accepted only from $TRUSTED_CIDR"
      msg INFO NEXT "Proxy'nizde: proxy_pass http://127.0.0.1:$PORT; Host, X-Forwarded-For, X-Forwarded-Proto ve WebSocket Upgrade başlıklarını iletin (docs/domain-https.md)" "In your proxy: proxy_pass http://127.0.0.1:$PORT; forward Host, X-Forwarded-For, X-Forwarded-Proto and WebSocket Upgrade headers (docs/domain-https.md)"
    fi
    exit 0 ;;
  backup)
    [ -f .env ] || die 17 E_NOT_INSTALLED "Önce kurulum yapın: sh scripts/install.sh" "Install first: sh scripts/install.sh"
    do_backup manual || exit 21
    exit 0 ;;
  restore) [ -f .env ] || die 17 E_NOT_INSTALLED "Önce kurulum yapın: sh scripts/install.sh" "Install first: sh scripts/install.sh"
    do_restore; exit 0 ;;
  update) do_update ;;
  maintenance) do_maintenance ;;
  schedule) set_schedule; exit 0 ;;
  auto-update) [ -f .env ] || die 17 E_NOT_INSTALLED "Önce kurulum yapın: sh scripts/install.sh" "Install first: sh scripts/install.sh"
    set_auto_update; exit 0 ;;
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
host_checks
[ "$FAILED" -eq 0 ] || die 1 E_PRECHECK "Ön kontroller başarısız; yukarıdaki FAIL satırlarını düzeltin" "Pre-checks failed; fix the FAIL lines above"
write_env
write_secrets
write_observability
set_env APP_VERSION "$(app_version)"
# Monitoring runs by default where it fits (4 GB RAM); COMPOSE_PROFILES in .env applies to every compose command.
if [ "$MONITORING" = 1 ] && ! grep -q '^COMPOSE_PROFILES=' .env && [ "${mem_mb:-0}" -ge 3800 ]; then set_env COMPOSE_PROFILES observability; fi
[ "$MONITORING" = 1 ] || set_env COMPOSE_PROFILES ""
[ "$LOCAL" = 1 ] && revert_local_settings
# Installs from before PANEL_TLS: derive it from the access mode already configured.
if ! grep -q '^PANEL_TLS=' .env; then case "$SITE" in :*) set_env PANEL_TLS 0 ;; *) set_env PANEL_TLS 1 ;; esac; fi
write_settings
docker compose config --quiet || die 17 E_COMPOSE_INVALID "Compose yapılandırması geçersiz" "Compose configuration is invalid"
msg INFO STARTING "Servisler derleniyor ve başlatılıyor (birkaç dakika sürebilir)" "Building and starting services (may take a few minutes)"
docker compose up -d --build --wait --wait-timeout 600 >/dev/null 2>&1 || die 18 E_START_FAILED "Servisler başlamadı: docker compose ps; docker compose logs" "Services did not start: docker compose ps; docker compose logs"
i=0; until local_get /api/ready >/dev/null 2>&1 || [ $i -ge 12 ]; do sleep 5; i=$((i + 1)); done
local_get /api/ready >/dev/null 2>&1 || die 19 E_NOT_READY "API hazır değil: docker compose logs api" "API is not ready: docker compose logs api"
# Grafana takes its admin password only on first start; keep it equal to .env when its volume is older.
if grep -q '^COMPOSE_PROFILES=observability' .env; then
  docker compose exec -T grafana grafana cli admin reset-admin-password "$(env_value GRAFANA_PASSWORD)" >/dev/null 2>&1 || msg WARN W_GRAFANA "Grafana parolası eşitlenemedi" "Could not sync the Grafana password"
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
if grep -q '^COMPOSE_PROFILES=observability' .env; then
  row "Grafana" "Grafana" "http://127.0.0.1:3001  (ssh -L 3001:127.0.0.1:3001 root@$host_ip), admin / .env GRAFANA_PASSWORD"
fi
if [ -f /etc/systemd/system/lightning-vm-maintenance.timer ]; then row "Yedek" "Backups" "$(if [ "$UI" = tr ]; then echo 'her gün'; else echo daily; fi) -> backups/"
else row "Yedek" "Backups" "$(if [ "$UI" = tr ]; then echo 'elle: sh scripts/install.sh backup'; else echo 'manual: sh scripts/install.sh backup'; fi)"; fi
msg INFO NEXT "Panelde: Yönetim → Bağlantılar → vCenter ekleyin, sonra Katalog'dan havuz, şablon, IP havuzu ve paket oluşturun" "In the panel: Admin → Connections → add vCenter, then create a pool, template, IP pool and package in Catalog"
msg WARN BACKUP_KEY "secrets/backup.key dosyasını sunucu dışında saklayın; o olmadan yedekler açılamaz" "Keep a copy of secrets/backup.key off this server; backups cannot be opened without it"
