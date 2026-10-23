#!/bin/sh
# Lightning VM installer.
#   sh scripts/install.sh [install]      first install, or resume/repair an existing one (idempotent)
#   sh scripts/install.sh check          read-only: host pre-checks and state of an existing install
#   sh scripts/install.sh recover-setup  reopen the browser setup wizard (accounts and data are kept)
#   sh scripts/install.sh update         not available yet
#   sh scripts/install.sh domain panel.example.com [--acme-staging]
#                                        serve the panel on that name with automatic HTTPS (ports 80/443)
#   sh scripts/install.sh behind-proxy [--port 8080] [--trusted-cidr CIDR]
#                                        plain HTTP on 127.0.0.1 for an existing Nginx/Caddy/Traefik in front
#   sh scripts/install.sh local-only     plain HTTP on 127.0.0.1:8080 only (SSH tunnel)
# Options: --lang tr|en  --install-docker  --allow-unsupported-os
# It never changes firewall, SSH or other web server settings, and never prints secrets.
# shellcheck disable=SC1091 # /etc/os-release exists only on the target host
set -eu
cd "$(dirname "$0")/.."

MODE=install INSTALL_DOCKER=0 ALLOW_OS=0 DOMAIN="" ACME_STAGING=0 PROXY_PORT=8080 TRUSTED_CIDR=""
case "${LANG:-}" in tr*) UI="tr" ;; *) UI="en" ;; esac
while [ $# -gt 0 ]; do
  case "$1" in
    install|check|recover-setup|update|behind-proxy|local-only) MODE=$1 ;;
    domain) MODE=domain; if [ $# -gt 1 ]; then shift; DOMAIN=$1; fi ;;
    --acme-staging) ACME_STAGING=1 ;;
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
    "ubuntu 22.04"|"ubuntu 24.04") msg OK OS "Ubuntu $os_ver" "Ubuntu $os_ver" ;;
    *) if [ "$ALLOW_OS" = 1 ]; then msg WARN E_OS_UNSUPPORTED "Desteklenmeyen işletim sistemi: $os_id $os_ver (izin verildi)" "Unsupported OS: $os_id $os_ver (allowed)"
       else fail E_OS_UNSUPPORTED "Desteklenen: Ubuntu 22.04/24.04. Bulunan: $os_id $os_ver (--allow-unsupported-os)" "Supported: Ubuntu 22.04/24.04. Found: $os_id $os_ver (--allow-unsupported-os)"; fi ;;
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

restart_proxy() {
  docker compose up -d --wait --wait-timeout 120 proxy >/dev/null 2>&1 || die 18 E_START_FAILED "Proxy başlamadı: docker compose logs proxy" "Proxy did not start: docker compose logs proxy"
}

case "$MODE" in
  domain)
    [ -f .env ] || die 17 E_NOT_INSTALLED "Önce kurulum yapın: sh scripts/install.sh" "Install first: sh scripts/install.sh"
    echo "$DOMAIN" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' || die 2 E_DOMAIN_INVALID "Geçersiz alan adı: '$DOMAIN' (örnek: panel.example.com, şema veya yol olmadan)" "Invalid domain: '$DOMAIN' (example: panel.example.com, no scheme or path)"
    LISTEN=0.0.0.0; ports_free 80 443
    [ "$FAILED" -eq 0 ] || die 1 E_PRECHECK "Ön kontroller başarısız" "Pre-checks failed"
    dns_report "$DOMAIN"
    if [ -z "${v4:-}" ]; then die 1 E_DNS_NO_A "Önce A kaydını oluşturun; sertifika alınamaz" "Create the A record first; a certificate cannot be issued"; fi
    FAILED=0
    if [ "$ACME_STAGING" = 1 ]; then ca=https://acme-staging-v02.api.letsencrypt.org/directory; else ca=https://acme-v02.api.letsencrypt.org/directory; fi
    set_env PANEL_SITE "$DOMAIN"; set_env LISTEN_ADDRESS 0.0.0.0; set_env HTTP_PORT 80; set_env HTTPS_PORT 443; set_env ACME_CA "$ca"
    set_env TRUSTED_PROXY_CIDRS 127.0.0.1/32
    load_settings; restart_proxy
    msg INFO ACME "Sertifika isteniyor (en fazla 2 dk)" "Requesting certificate (up to 2 min)"
    i=0; until local_get /api/ready >/dev/null 2>&1 || [ $i -ge 24 ]; do sleep 5; i=$((i + 1)); done
    dns_report "$DOMAIN"; web_report "$DOMAIN"
    msg INFO NEXT "Panel adresini sihirbazda veya yönetimde https://$DOMAIN olarak güncelleyin; mevcut oturumlar yeni adreste geçerli olmaz" "Update the panel address to https://$DOMAIN in the wizard or admin; existing sessions do not carry over to the new address"
    [ "$FAILED" -eq 0 ] || exit 1
    exit 0 ;;
  behind-proxy|local-only)
    [ -f .env ] || die 17 E_NOT_INSTALLED "Önce kurulum yapın: sh scripts/install.sh" "Install first: sh scripts/install.sh"
    echo "$PROXY_PORT" | grep -Eq '^[0-9]{2,5}$' || die 2 E_PORT_INVALID "Geçersiz port: $PROXY_PORT" "Invalid port: $PROXY_PORT"
    set_env PANEL_SITE :80; set_env LISTEN_ADDRESS 127.0.0.1; set_env HTTP_PORT "$PROXY_PORT"; set_env HTTPS_PORT 8443
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
  update)
    die 20 E_NOT_IMPLEMENTED "Güncelleme henüz yok (yayımlanmış sürüm ve güncelleyici sonraki aşamada)" "Update is not available yet (released versions and the updater come in a later phase)" ;;
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
if [ "$INSTALL_DOCKER" = 1 ] && ! command -v docker >/dev/null; then install_docker; fi
host_checks
[ "$FAILED" -eq 0 ] || die 1 E_PRECHECK "Ön kontroller başarısız; yukarıdaki FAIL satırlarını düzeltin" "Pre-checks failed; fix the FAIL lines above"
write_env
docker compose config --quiet || die 17 E_COMPOSE_INVALID "Compose yapılandırması geçersiz" "Compose configuration is invalid"
msg INFO STARTING "Servisler derleniyor ve başlatılıyor (birkaç dakika sürebilir)" "Building and starting services (may take a few minutes)"
docker compose up -d --build --wait --wait-timeout 300 >/dev/null 2>&1 || die 18 E_START_FAILED "Servisler başlamadı: docker compose ps; docker compose logs" "Services did not start: docker compose ps; docker compose logs"
i=0; until local_get /api/ready >/dev/null 2>&1 || [ $i -ge 12 ]; do sleep 5; i=$((i + 1)); done
local_get /api/ready >/dev/null 2>&1 || die 19 E_NOT_READY "API hazır değil: docker compose logs api" "API is not ready: docker compose logs api"
case "$SITE" in :*) msg OK READY "http://$LISTEN:$PORT" "http://$LISTEN:$PORT" ;; *) msg OK READY "https://$SITE" "https://$SITE" ;; esac

# A one-hour token gates creation of the first admin; once an admin exists none is issued.
if token=$(docker compose exec -T api node dist/cli.js bootstrap-token 2>/dev/null); then
  msg INFO SETUP_TOKEN "Kurulum anahtarı (1 saat geçerli, yalnızca burada gösterilir):" "Setup token (valid 1 hour, shown only here):"
  echo "      $token"
  msg INFO SETUP_URL "Tarayıcıda /setup açın. Yeni anahtar: docker compose exec api node dist/cli.js bootstrap-token" "Open /setup in a browser. New token: docker compose exec api node dist/cli.js bootstrap-token"
else
  msg INFO SETUP "Yönetici hesabı zaten var; kurulum anahtarı üretilmedi" "Admin account already exists; no setup token issued"
fi
case "$SITE" in
  :*) msg WARN W_NO_HTTPS "HTTPS yok; uzak erişim için SSH tüneli: ssh -L $PORT:127.0.0.1:$PORT KULLANICI@SUNUCU. Alan adı için: sh scripts/install.sh domain panel.example.com" "No HTTPS; for remote access use an SSH tunnel: ssh -L $PORT:127.0.0.1:$PORT USER@SERVER. For a domain: sh scripts/install.sh domain panel.example.com" ;;
esac
