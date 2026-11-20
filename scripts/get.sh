#!/bin/sh
# Lightning VM: install on a fresh server with one command. Gets the source with git, so the installation
# can update itself later (from the admin panel or `sh scripts/install.sh update`).
# Run again on a server that is already installed, it updates that installation the way `install.sh update`
# does (backup first, rollback on failure) and leaves its update channel as it is.
#
#   curl -fsSL https://lightningvm.app/install.sh | sudo sh -s -- [options] [-- install options]
#
# Options:
#   --lang tr|en      language of this script and of the installer. Without it, on a terminal, the script asks
#                     once before anything else (1 Türkçe, 2 English; Enter or 30 s of silence take the default
#                     from LC_ALL/LC_MESSAGES/LANG). With no terminal (cloud-init, CI, a pipe as output) nothing
#                     is ever asked and the default applies. Answers are read from /dev/tty: standard input is
#                     this script when it is piped into sh.
#   --yes, -y         do not ask "continue?" after the installer's pre-flight report (asked only on a terminal)
#   --repo URL        git repository (default: the one below; SSH URLs work with a deploy key)
#   --dir DIR         where the source goes (default /opt/lightning-vm)
#   --version vX.Y.Z  a released version (default: the latest stable release)
#   --branch NAME     a branch instead of releases; updates then follow it (channel "edge", test servers)
#   --token-file FILE read-only access token for a private repository, read from FILE (its first line), or
#                     GIT_TOKEN in the environment (export GIT_TOKEN; ... | sudo --preserve-env=GIT_TOKEN sh);
#                     kept in a root-only credential file so later updates can fetch too
#   --token TOKEN     the same on the command line. It works, but every local account can read it in the
#                     process list for as long as the installation runs: prefer the two ways above
#   --help, -h        this list, in Turkish or English
# Everything after "--" goes to scripts/install.sh, for example: -- --domain panel.example.com
#
# Output: on a terminal a short banner, three numbered steps with a spinner, then the installer's own screens.
# Not on a terminal the lines are "LEVEL text" with no colours, carriage returns or cursor codes. NO_COLOR and
# TERM=dumb are respected; a locale without UTF-8 gets ASCII marks. What git and apt print goes to a root-only
# temporary file that is shown and kept when a step fails and removed otherwise.
# The software is free and open source under the Apache License 2.0 (LICENSE in the repository).
set -eu

LOCALE_MSG=${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}; LOCALE_CTYPE=${LC_ALL:-${LC_CTYPE:-${LANG:-}}}
REPO=${LVM_REPO:-https://github.com/syildirim689/lightning-vm.git}
DIR=/opt/lightning-vm VERSION="" BRANCH="" TOKEN=${GIT_TOKEN:-} TOKEN_FILE="" cred=""
UI="" YES=0 HELP=0
case "$LOCALE_MSG" in tr*) UI_DEFAULT="tr" ;; *) UI_DEFAULT="en" ;; esac
# Not handed on in the environment of git, apt or the installer started below.
unset GIT_TOKEN
# tx "türkçe" "english": the one in the chosen language (before the choice: the locale's).
tx() { if [ "${UI:-$UI_DEFAULT}" = tr ]; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi; }
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) shift; REPO=${1:-} ;;
    --dir) shift; DIR=${1:-} ;;
    --version) shift; VERSION=${1:-} ;;
    --branch) shift; BRANCH=${1:-} ;;
    --token) shift; TOKEN=${1:-} ;;
    --token-file) shift; TOKEN_FILE=${1:-} ;;
    --lang) shift; UI=${1:-} ;;
    --yes|-y) YES=1 ;;
    --help|-h) HELP=1 ;;
    --) shift; break ;;
    *) tx "bilinmeyen seçenek: $1 (kurulum seçenekleri -- işaretinden sonra yazılır; yardım: --help)" "unknown option: $1 (install options go after --; help: --help)" >&2; exit 2 ;;
  esac
  shift
done
# The language may also stand among the install options, as it always could: -- --lang tr
prev=""
for arg in "$@"; do
  if [ "$prev" = --lang ] && [ -z "$UI" ]; then UI=$arg; fi
  prev=$arg
done
case "$UI" in ''|tr|en) ;; *) tx "--lang: tr ya da en" "--lang: tr or en" >&2; exit 2 ;; esac

usage() {
  if [ "${UI:-$UI_DEFAULT}" = tr ]; then cat <<'EOF'
Lightning VM: tek komutla kurulum (beta; ücretsiz, açık kaynak: Apache-2.0)

  curl -fsSL https://lightningvm.app/install.sh | sudo sh -s -- [seçenekler] [-- kurulum seçenekleri]

Kaynağı git ile indirir, sürümü seçer ve scripts/install.sh betiğini çalıştırır. Kurulu bir sunucuda yeniden
çalıştırılırsa yeniden kurmaz: o kurulumu günceller (önce yedek, olmazsa geri dönüş; güncelleme kanalı değişmez).

Seçenekler
  --lang tr|en       Dil. Verilmezse uçbirimde bir kez sorulur (Enter ya da 30 sn sessizlik yereldeki dili seçer);
                     uçbirim yoksa (cloud-init, CI, çıktı bir dosyaya gidiyorsa) hiçbir şey sorulmaz
  --yes, -y          Kurulumun ön kontrol raporundan sonra "Devam edilsin mi?" diye sorma
  --repo URL         git deposu (varsayılan: https://github.com/syildirim689/lightning-vm.git)
  --dir DİZİN        kaynağın konacağı yer (varsayılan /opt/lightning-vm)
  --version vX.Y.Z   belirli bir sürüm (varsayılan: son kararlı sürüm)
  --branch DAL       sürümler yerine bir dal; güncellemeler onu izler (edge kanalı, test sunucuları)
  --token-file DOSYA özel depo için salt-okunur erişim anahtarı, dosyanın ilk satırından; ya da GIT_TOKEN
                     ortam değişkeni (sudo --preserve-env=GIT_TOKEN sh)
  --token ANAHTAR    aynısı komut satırında (süreç listesinde görünür: yukarıdaki iki yolu yeğleyin)
  --help, -h         bu metin
"--" işaretinden sonrası scripts/install.sh betiğine gider; en sık kullanılanlar:
  --domain panel.example.com   kendi alan adınız ve HTTPS        --local          dışarıya açma
  --admin-email siz@example.com                                  --setup-wizard   yöneticiyi tarayıcıda oluştur
  --no-monitoring              izleme bileşenlerini kurma        --no-schedule    yedek zamanlayıcısını kurma
Tümü: sh scripts/install.sh help. Belgeler: https://lightningvm.app, https://github.com/syildirim689/lightning-vm
EOF
  else cat <<'EOF'
Lightning VM: install with one command (beta; free and open source: Apache-2.0)

  curl -fsSL https://lightningvm.app/install.sh | sudo sh -s -- [options] [-- install options]

Gets the source with git, picks the version and runs scripts/install.sh. Run again on an installed server it
does not install again: it updates that installation (backup first, rollback on failure; the channel is kept).

Options
  --lang tr|en       Language. Without it the script asks once on a terminal (Enter or 30 s of silence take the
                     locale's language); with no terminal (cloud-init, CI, output going to a file) nothing is asked
  --yes, -y          Do not ask "Continue?" after the installer's pre-flight report
  --repo URL         git repository (default: https://github.com/syildirim689/lightning-vm.git)
  --dir DIR          where the source goes (default /opt/lightning-vm)
  --version vX.Y.Z   a released version (default: the latest stable release)
  --branch NAME      a branch instead of releases; updates follow it (channel edge, test servers)
  --token-file FILE  read-only access token for a private repository, from the file's first line; or GIT_TOKEN
                     in the environment (sudo --preserve-env=GIT_TOKEN sh)
  --token TOKEN      the same on the command line (visible in the process list: prefer the two ways above)
  --help, -h         this text
Everything after "--" goes to scripts/install.sh; the ones used most:
  --domain panel.example.com   your own name with HTTPS          --local          no public access
  --admin-email you@example.com                                  --setup-wizard   create the admin in the browser
  --no-monitoring              no monitoring components          --no-schedule    no backup timer
All of them: sh scripts/install.sh help. Docs: https://lightningvm.app, https://github.com/syildirim689/lightning-vm
EOF
  fi
}
if [ "$HELP" = 1 ]; then usage; exit 0; fi

# ---- Output: the terminal form, or plain lines where programs read them -----------------------------
UI_TTY=0 UI_UTF=0
C_0="" C_B="" C_DIM="" C_RED="" C_GRN="" C_YEL="" C_CYA=""
if [ -t 1 ] && [ "${TERM:-dumb}" != dumb ]; then
  UI_TTY=1
  case "$LOCALE_CTYPE" in *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) UI_UTF=1 ;; esac
  if [ -z "${NO_COLOR:-}" ]; then
    C_0=$(printf '\033[0m'); C_B=$(printf '\033[1m'); C_DIM=$(printf '\033[2m')
    C_RED=$(printf '\033[31m'); C_GRN=$(printf '\033[32m'); C_YEL=$(printf '\033[33m'); C_CYA=$(printf '\033[36m')
  fi
fi
if [ "$UI_UTF" = 1 ]; then
  M_OK='✓' M_FAIL='✗' M_WARN='!' M_INFO='•'
  M_RULE='────────────────────────────────────────────────────────────────'
else
  M_OK='[ok]' M_FAIL='[xx]' M_WARN='[!!]' M_INFO='[..]'
  M_RULE='----------------------------------------------------------------'
fi
LOG="" BUSY="" BUSY_T0=0 SPIN_PID="" SPIN_PAUSED=0 TTY_SAVED="" STEP_N=0 TICK=""

# say LEVEL "türkçe" "english"
say() {
  if [ "$UI_TTY" != 1 ]; then printf '%-5s %s\n' "$1" "$(tx "$2" "$3")"; return; fi
  case "$1" in
    OK) s_c=$C_GRN s_m=$M_OK ;; WARN) s_c=$C_YEL s_m=$M_WARN ;; FAIL) s_c=$C_RED s_m=$M_FAIL ;; *) s_c=$C_CYA s_m=$M_INFO ;;
  esac
  if [ -n "$SPIN_PID" ]; then spin_stop; SPIN_PAUSED=1; fi
  printf '  %s%s%s %s\n' "$s_c" "$s_m" "$C_0" "$(tx "$2" "$3")"
  if [ "$SPIN_PAUSED" = 1 ]; then SPIN_PAUSED=0; spin_start; fi
}
fmt_dur() { if [ "$1" -ge 60 ]; then tx "$(($1 / 60)) dk $(($1 % 60)) sn" "$(($1 / 60))m $(($1 % 60))s"; else tx "$1 sn" "$1s"; fi; }
# The spinner is the only child process: the commands run in this shell, so their exit codes are theirs. It
# ends with this script whatever happens (idle, die, the EXIT handler; and it looks for this script every turn).
spin_start() {
  { [ "$UI_TTY" = 1 ] && [ -n "$BUSY" ] && [ -z "$SPIN_PID" ]; } || return 0
  if [ -z "$TICK" ]; then if sleep 0.1 2>/dev/null; then TICK=0.1; else TICK=1; fi; fi
  printf '\033[?25l\033[?7l'
  (
    set +e; i=0
    # Its own sleep goes with it.
    s=""; trap 'kill "$s" 2>/dev/null; exit 0' TERM
    while kill -0 "$$" 2>/dev/null; do
      if [ "$UI_UTF" = 1 ]; then
        case $((i % 10)) in 0) f='⠋' ;; 1) f='⠙' ;; 2) f='⠹' ;; 3) f='⠸' ;; 4) f='⠼' ;; 5) f='⠴' ;; 6) f='⠦' ;; 7) f='⠧' ;; 8) f='⠇' ;; *) f='⠏' ;; esac
      else
        case $((i % 4)) in 0) f='[|]' ;; 1) f='[/]' ;; 2) f='[-]' ;; *) f='[\]' ;; esac
      fi
      printf '\r  %s%s%s %s %s%s%s\033[K' "$C_CYA" "$f" "$C_0" "$BUSY" "$C_DIM" "$(fmt_dur $(($(date +%s) - BUSY_T0)))" "$C_0"
      sleep "$TICK" & s=$!
      wait "$s"; i=$((i + 1))
    done
  ) &
  SPIN_PID=$!
}
spin_stop() {
  [ -n "$SPIN_PID" ] || return 0
  kill "$SPIN_PID" 2>/dev/null || true
  wait "$SPIN_PID" 2>/dev/null || true
  SPIN_PID=""
  printf '\r\033[K\033[?7h\033[?25h'
}
# step "başlık" "title" "ne ve neden" "what and why": one of the three numbered steps begins.
step() {
  STEP_N=$((STEP_N + 1)); BUSY=$(tx "$1" "$2"); BUSY_T0=$(date +%s)
  if [ "$UI_TTY" = 1 ]; then
    printf '\n%s[%s/3]%s %s%s%s\n' "$C_CYA" "$STEP_N" "$C_0" "$C_B" "$BUSY" "$C_0"
    printf '%s' "$C_DIM"; tx "$3" "$4" | fold -s -w 76 | sed 's/^/      /'; printf '%s' "$C_0"
  else
    say INFO "[$STEP_N/3] $1: $3" "[$STEP_N/3] $2: $4"
  fi
  [ -z "$LOG" ] || printf '== [%s/3] %s\n' "$STEP_N" "$BUSY" >> "$LOG"
  spin_start
}
# idle ok|fail "sonuç" "result": the step is over.
idle() {
  [ -n "$BUSY" ] || return 0
  spin_stop
  id_d=$(fmt_dur $(($(date +%s) - BUSY_T0)))
  if [ "$UI_TTY" = 1 ]; then
    if [ "$1" = ok ]; then printf '  %s%s%s %s %s(%s)%s\n' "$C_GRN" "$M_OK" "$C_0" "$(tx "$2" "$3")" "$C_DIM" "$id_d" "$C_0"
    else printf '  %s%s%s %s %s(%s)%s\n' "$C_RED" "$M_FAIL" "$C_0" "$BUSY" "$C_DIM" "$id_d" "$C_0"; fi
  elif [ "$1" = ok ]; then say OK "$2" "$3"; fi
  BUSY=""
}
# The end of what the failed command printed, and where all of it is. Escape codes never leave the log.
log_tail() {
  { [ -n "$LOG" ] && [ -s "$LOG" ]; } || return 0
  lt=$(tr -d '\033\r' < "$LOG" | grep -v -e '^[[:space:]]*$' -e '^== ' | tail -n 20) || true
  if [ -n "$lt" ]; then
    say INFO "Başarısız adımın son satırları:" "The last lines of the step that failed:"
    printf '%s\n' "$lt" | sed 's/^/      | /'
  fi
  say INFO "Tam kayıt (yalnızca root okur): $LOG" "Full log (root only): $LOG"
  KEEP_LOG=1
}
KEEP_LOG=0 DIED=0
# die "türkçe" "english" ["ne yapmalı" "what to do"]
die() {
  DIED=1; d_busy=$BUSY
  idle fail
  [ "$UI_TTY" != 1 ] || say FAIL "$1" "$2"
  if [ -n "$d_busy" ]; then log_tail; fi
  if [ $# -ge 4 ]; then say INFO "$3" "$4"; fi
  [ "$UI_TTY" = 1 ] || say FAIL "$1" "$2"
  exit 1
}
on_exit() {
  rc=$?; trap - EXIT
  if [ -n "$TTY_SAVED" ]; then stty "$TTY_SAVED" < /dev/tty 2>/dev/null || true; fi
  if [ "$rc" != 0 ] && [ "$DIED" != 1 ]; then
    ue_busy=$BUSY
    if [ "$UI_TTY" = 1 ]; then idle fail; else spin_stop; fi
    case "$rc" in
      129|130|143) if [ "$UI_TTY" = 1 ]; then printf '\n'; fi; say WARN "Yarıda kesildi. Aynı komut yeniden çalıştırılabilir" "Interrupted. The same command can be run again" ;;
      *) if [ -n "$ue_busy" ]; then log_tail; say FAIL "Adım tamamlanamadı (çıkış kodu $rc): $ue_busy" "The step did not finish (exit code $rc): $ue_busy"; fi ;;
    esac
  fi
  spin_stop
  if [ -n "$LOG" ] && [ "$KEEP_LOG" != 1 ]; then rm -f "$LOG"; fi
  exit "$rc"
}
trap on_exit EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM

# ---- The language, asked once and before anything else is said ------------------------------------
# Only when a person can answer: the output is a terminal and the controlling terminal can be opened. The
# answer is one key read from /dev/tty; standard input is this script itself under `curl ... | sudo sh`.
if [ -z "$UI" ]; then
  UI=$UI_DEFAULT
  if [ "$UI_TTY" = 1 ] && (: < /dev/tty) 2>/dev/null; then
    if [ "$UI" = tr ]; then def=1; else def=2; fi
    printf '\n  %sLightning VM%s\n\n  Dil / Language\n    1) Türkçe\n    2) English\n\n  Seçiminiz / Your choice [%s]: ' "$C_B" "$C_0" "$def"
    key=""
    if TTY_SAVED=$(stty -g < /dev/tty 2>/dev/null) && [ -n "$TTY_SAVED" ]; then
      # No line editing, no echo, and a read gives up after a second: thirty of them, then the default.
      stty -icanon -echo min 0 time 10 < /dev/tty
      left=30
      while [ "$left" -gt 0 ]; do
        key=$(dd bs=1 count=1 2>/dev/null < /dev/tty | od -An -tx1 | tr -d ' \n')
        [ -z "$key" ] || break
        left=$((left - 1))
      done
      stty "$TTY_SAVED" < /dev/tty; TTY_SAVED=""
    else
      # No stty: a whole line, without a time limit.
      TTY_SAVED=""; line=""; IFS= read -r line < /dev/tty || true
      case "$line" in 1*) key=31 ;; 2*) key=32 ;; esac
    fi
    case "$key" in 31) UI="tr" ;; 32) UI="en" ;; esac
    if [ "$UI" = tr ]; then printf 'Türkçe\n'; else printf 'English\n'; fi
  fi
fi

if [ "$UI_TTY" = 1 ]; then
  printf '\n  %sLightning VM%s  %sbeta%s\n' "$C_B" "$C_0" "$C_YEL" "$C_0"
  tx "  Sunucu satış ve yönetim paneli: ücretsiz, açık kaynak (Apache-2.0)" "  Server sales and management panel: free and open source (Apache-2.0)"
  printf '  %s%s%s\n' "$C_DIM" "$M_RULE" "$C_0"
  tx "  Bu betik kaynağı indirir ve sürümü seçer; kurulumun kendisini, ön kontrol raporu ve" "  This script downloads the source and picks the version; the installation itself, with its"
  tx "  yapılacakların listesiyle birlikte, ardından scripts/install.sh yapar." "  pre-flight report and its plan, is then done by scripts/install.sh."
  printf '  %-10s %s\n' "$(tx Kaynak Source)" "$REPO"
  printf '  %-10s %s\n' "$(tx Dizin Directory)" "$DIR"
  printf '  %-10s %s\n' "$(tx Versiyon Version)" "${VERSION:-${BRANCH:+$(tx "dal" "branch") $BRANCH}}${VERSION:+ }$( [ -n "$VERSION$BRANCH" ] || tx "son kararlı sürüm (0.x: beta)" "the latest stable release (0.x: beta)")"
else
  say INFO "Lightning VM (beta): kaynak $REPO adresinden $DIR dizinine alınır, sonra scripts/install.sh çalışır" "Lightning VM (beta): the source comes from $REPO to $DIR, then scripts/install.sh runs"
fi

[ "$(id -u)" = 0 ] || die "root olarak çalıştırın (sudo)" "run as root (sudo)"
[ -z "$VERSION" ] || echo "$VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || die "--version v1.2.3 biçiminde olmalı" "--version must look like v1.2.3"
[ -z "$BRANCH" ] || echo "$BRANCH" | grep -Eq '^[A-Za-z0-9._/-]{1,100}$' || die "geçersiz --branch" "invalid --branch"
[ -z "$VERSION" ] || [ -z "$BRANCH" ] || die "--version ya da --branch; ikisi birlikte olmaz" "use --version or --branch, not both"
if [ -n "$TOKEN_FILE" ]; then
  [ -r "$TOKEN_FILE" ] || die "--token-file: $TOKEN_FILE okunamıyor" "--token-file: cannot read $TOKEN_FILE"
  IFS= read -r TOKEN < "$TOKEN_FILE" || true
  [ -n "$TOKEN" ] || die "--token-file: $TOKEN_FILE boş" "--token-file: $TOKEN_FILE is empty"
fi
# What git and apt print: a file only root can read, removed when everything went well.
LOG=$(mktemp "${TMPDIR:-/tmp}/lightning-vm-get.XXXXXX") || LOG=""
[ "$UI_TTY" != 1 ] || [ -z "$LOG" ] || printf '  %-10s %s\n' "$(tx Log Log)" "$LOG ($(tx "yalnızca hata olursa saklanır" "kept only when something fails"))"
out() { if [ -n "$LOG" ]; then cat >> "$LOG"; else cat > /dev/null; fi; }

step "git" "git" \
  "Kaynak git ile alınır: kurulum sonradan kendini aynı yoldan güncelleyebilsin diye (panelden ya da install.sh update ile)." \
  "The source is fetched with git, so that the installation can update itself the same way later (from the panel or with install.sh update)."
if ! command -v git >/dev/null; then
  say INFO "git kuruluyor" "installing git"
  if command -v apt-get >/dev/null; then { DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git ca-certificates; } < /dev/null 2>&1 | out
  elif command -v dnf >/dev/null; then dnf install -y -q git < /dev/null 2>&1 | out
  fi
  command -v git >/dev/null || die "git kurulamadı" "git could not be installed" "Elle kurun (apt-get install git ya da dnf install git) ve aynı komutu yeniden çalıştırın" "Install it by hand (apt-get install git or dnf install git) and run the same command again"
  idle ok "git kuruldu ($(git --version | sed 's/^git version //'))" "git installed ($(git --version | sed 's/^git version //'))"
else
  idle ok "git $(git --version | sed 's/^git version //') kurulu" "git $(git --version | sed 's/^git version //') is present"
fi

git_() { git -c safe.directory="$DIR" "$@"; }
# A private repository: the token goes to a root-only credential store, never into the remote URL.
if [ -n "$TOKEN" ]; then
  cred=/root/.lightning-vm-git-credentials
  host=$(echo "$REPO" | sed -n 's#^https://\([^/]*\)/.*#\1#p')
  [ -n "$host" ] || die "--token yalnızca https depo adresleriyle çalışır" "--token works with https repository URLs"
  (umask 077; printf 'https://x-access-token:%s@%s\n' "$TOKEN" "$host" > "$cred")
  # From here on only the file knows it.
  TOKEN=""
fi
gitc() { if [ -n "$cred" ]; then git_ -c "credential.helper=store --file=$cred" "$@"; else git_ "$@"; fi; }
# git's own messages go to the log; its exit code decides.
quiet() { if [ -n "$LOG" ]; then "$@" >> "$LOG" 2>&1 < /dev/null; else "$@" > /dev/null 2>&1 < /dev/null; fi; }

if [ -d "$DIR/.git" ]; then
  step "Kaynağın güncellenmesi" "Updating the source" \
    "$DIR dizininde bir git kopyası var: yeni sürümler depodan çekilir, çalışan dosyalara henüz dokunulmaz." \
    "$DIR holds a git checkout already: new versions are fetched from the repository, the files in use are not touched yet."
  [ "$UI_TTY" = 1 ] || say INFO "$DIR dizinindeki kaynak güncelleniyor" "updating the source in $DIR"
  quiet gitc -C "$DIR" fetch --quiet --tags --force origin || die "git fetch başarısız ($REPO adresine erişim var mı?)" "git fetch failed (access to $REPO?)" \
    "Ağı ve depoya erişimi denetleyin; özel depoda erişim anahtarının süresi dolmuş olabilir (--token-file)" "Check the network and the access to the repository; in a private repository the token may have expired (--token-file)"
  idle ok "Sürümler çekildi" "Versions fetched"
else
  [ ! -e "$DIR" ] || [ -z "$(ls -A "$DIR" 2>/dev/null)" ] || die "$DIR var ve bir git kopyası değil; başka bir --dir seçin" "$DIR exists and is not a git checkout; choose another --dir"
  step "Kaynağın indirilmesi" "Downloading the source" \
    "Depo $DIR dizinine kopyalanır (git clone); hangi sürümün kurulacağı bir sonraki adımda seçilir." \
    "The repository is cloned to $DIR (git clone); which version gets installed is chosen in the next step."
  [ "$UI_TTY" = 1 ] || say INFO "$REPO, $DIR dizinine indiriliyor" "downloading $REPO to $DIR"
  # No checkout here: the version to install is checked out below.
  quiet gitc clone --quiet --no-checkout "$REPO" "$DIR" || die "git clone başarısız (özel depo mu? --token-file ya da deploy key'li bir SSH adresi kullanın)" "git clone failed (private repository? use --token-file or an SSH URL with a deploy key)" \
    "Ağı denetleyin: git ls-remote $REPO; sonra aynı komutu yeniden çalıştırın" "Check the network: git ls-remote $REPO; then run the same command again"
  idle ok "Kaynak indirildi" "Source downloaded"
fi
[ -z "$cred" ] || git_ -C "$DIR" config credential.helper "store --file=$cred"

cd "$DIR"
# Hands over to the installer: no spinner, no log and no changed terminal stay behind, and its standard input
# is not the rest of this script.
hand_over() {
  spin_stop
  if [ -n "$LOG" ] && [ "$KEEP_LOG" != 1 ]; then rm -f "$LOG"; fi
  trap - EXIT
  exec sh scripts/install.sh "$@" < /dev/null
}
if [ -f .env ]; then
  # Something is installed here already. Checking out another version under it and running `install` would
  # skip the backup, the migration check and the rollback, and would put a server that follows a branch back
  # on the stable channel, on older code than its database.
  if [ -s data/maintenance/history.jsonl ]; then
    # A finished installation (its first backup is in the history): `update` does this safely and follows the
    # channel this server already has. Of the install options only the language means anything to it.
    [ -z "$BRANCH" ] || say WARN "--branch kurulu bir sisteme uygulanmaz; bir dalı izlemek için: sh scripts/install.sh auto-update on|off --channel edge --branch $BRANCH" "--branch is not applied to an existing installation; to follow a branch: sh scripts/install.sh auto-update on|off --channel edge --branch $BRANCH"
    say INFO "$DIR dizininde bir kurulum var: güncelleniyor (önce yedek, olmazsa geri dönüş; güncelleme kanalı korunur)" "an installation exists in $DIR: updating it (backup first, rollback on failure; its update channel is kept)"
    set -- update
    [ -z "$VERSION" ] || set -- "$@" --to "$VERSION"
    hand_over "$@" --lang "$UI"
  elif [ -z "$VERSION" ] && [ -z "$BRANCH" ] && git_ rev-parse -q --verify HEAD >/dev/null; then
    # An installation that was interrupted: it continues with the version it started with and the channel
    # already written to .env.
    say INFO "$DIR dizinindeki yarım kalmış kurulum sürdürülüyor ($(git_ describe --tags --always))" "continuing the interrupted installation in $DIR ($(git_ describe --tags --always))"
    [ "$YES" != 1 ] || set -- --yes "$@"
    hand_over install --lang "$UI" "$@"
  fi
fi
step "Sürümün seçilmesi" "Choosing the version" \
  "Varsayılan, son kararlı sürüm etiketidir (vX.Y.Z); 1.0 öncesi sürümler beta sayılır. --version belirli bir sürümü, --branch bir dalı seçer." \
  "The default is the newest stable release tag (vX.Y.Z); versions before 1.0 are beta. --version picks a given release, --branch a branch."
if [ -n "$BRANCH" ]; then
  target="origin/$BRANCH"; extra="--channel edge --branch $BRANCH"
elif [ -n "$VERSION" ]; then
  target=$VERSION; extra="--channel stable"
else
  target=$(git_ -c versionsort.suffix=- tag -l 'v[0-9]*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)
  extra="--channel stable"
  if [ -z "$target" ]; then
    branch=$(git_ symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##'); branch=${branch:-main}
    say WARN "henüz yayımlanmış sürüm yok; $branch dalı kuruluyor (güncellemeler onu izler)" "no released version yet; installing the $branch branch (updates follow it)"
    target="origin/$branch"; extra="--channel edge --branch $branch"
  fi
fi
git_ rev-parse -q --verify "$target^{commit}" >/dev/null || die "bilinmeyen sürüm ya da dal: $target" "unknown version or branch: $target" \
  "Yayımlanmış sürümler: git -C $DIR tag -l 'v*'" "Released versions: git -C $DIR tag -l 'v*'"
quiet git_ -c advice.detachedHead=false checkout -q --detach "$target" || die "kaynak $target sürümüne alınamadı (git checkout)" "could not check out $target (git checkout)"
if [ "$UI_TTY" = 1 ]; then idle ok "Kaynak: $(git_ describe --tags --always)" "Source: $(git_ describe --tags --always)"
else BUSY=""; say OK "kaynak: $(git_ describe --tags --always)" "source at $(git_ describe --tags --always)"; fi
# Only options the installer of every released version knows are added here; --yes is passed on when given.
[ "$YES" != 1 ] || set -- --yes "$@"
# shellcheck disable=SC2086 # extra holds separate arguments on purpose
hand_over install $extra --lang "$UI" "$@"
