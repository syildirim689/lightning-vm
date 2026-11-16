#!/bin/sh
# Runs the whole integration suite, also the half that is skipped without infrastructure: PostgreSQL, Redis, the
# simulated vCenter and ESXi (govmomi's vcsim, as in compose.simulator.yaml), the VMware adapter and a worker, all in
# Docker, then `npm run test:integration` on this machine against them, then removes everything again.
#
#   sh apps/api/test/integration/run.sh          (or: npm run test:integration:full, in apps/api)
#
# TEST ONLY. It never touches a running installation: its own compose project (lvm-it-<pid>), its own network and
# subnet, no named volumes (data lives in the containers and goes with them), ports bound to 127.0.0.1 only. The tests
# wipe the database and Redis DB they are given; these are the throw-away ones started here.
# Needs: docker with the compose plugin, openssl, node and npm (apps/api dependencies installed: npm ci).
# Ports and subnet can be moved when they are taken:
#   IT_PG_PORT (55432)  IT_REDIS_PORT (56379)  IT_VMWARE_PORT (58080)  IT_SUBNET (172.29.251; a /24 is made of it)
# KEEP=1 leaves the containers running afterwards (to look at logs); remove them with the printed command.
# Not started here: the console gateway (the one console test is skipped without CONSOLE_WS_URL), an LDAP server,
# a PowerDNS and an ISO storage (LDAP_TEST_URL, RDNS_TEST_URL/RDNS_TEST_KEY, ISO_TEST_HOST: those tests stay skipped).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
api=$(cd "$here/../.." && pwd)
root=$(cd "$api/../.." && pwd)
project="lvm-it-$$"
pg_port=${IT_PG_PORT:-55432}
redis_port=${IT_REDIS_PORT:-56379}
vmware_port=${IT_VMWARE_PORT:-58080}
subnet=${IT_SUBNET:-172.29.251}

for tool in docker openssl node npm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "run.sh: $tool is needed" >&2; exit 2; }
done
docker compose version >/dev/null 2>&1 || { echo "run.sh: the docker compose plugin is needed" >&2; exit 2; }

work=$(mktemp -d "${TMPDIR:-/tmp}/lvm-it.XXXXXX")
compose="$work/compose.yaml"
dc() { docker compose -p "$project" -f "$compose" "$@"; }
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "${KEEP:-0}" = 1 ]; then
    echo "run.sh: left running; remove with: docker compose -p $project -f $compose down -v --remove-orphans && rm -rf $work" >&2
  else
    [ -f "$compose" ] && dc down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$work"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Secrets of this run only: the master key (base64, 32 bytes) and the adapters' shared token, as scripts/install.sh makes them.
# Readable by the containers' users (the worker runs as "node"); the directory itself is private to this user.
openssl rand -base64 32 > "$work/master.key"
openssl rand -hex 32 > "$work/vmware.token"
chmod 644 "$work/master.key" "$work/vmware.token"
pg_password=$(openssl rand -hex 16)
redis_password=$(openssl rand -hex 16)

cat > "$compose" <<EOF
services:
  postgres:
    image: postgres:17-alpine
    environment: {POSTGRES_DB: lightning_test, POSTGRES_USER: lightning, POSTGRES_PASSWORD: "$pg_password"}
    ports: ["127.0.0.1:$pg_port:5432"]
    tmpfs: [/var/lib/postgresql/data]
    healthcheck: {test: [CMD-SHELL, "pg_isready -U lightning -d lightning_test"], interval: 2s, timeout: 3s, retries: 30}
  redis:
    image: redis:7-alpine
    command: [redis-server, --save, "", --appendonly, "no", --maxmemory-policy, noeviction, --requirepass, "$redis_password"]
    environment: {REDISCLI_AUTH: "$redis_password"}
    ports: ["127.0.0.1:$redis_port:6379"]
    healthcheck: {test: [CMD, redis-cli, ping], interval: 2s, timeout: 3s, retries: 30}
  vcsim-vcenter:
    build: {context: "$root/services/vmware", dockerfile: "$root/deploy/simulator/Dockerfile"}
    command: [-l, "0.0.0.0:8989", -username, sim-admin, -password, sim-password-1, -cluster, "1", -host, "1", -webmks, "$subnet.10:8443"]
    networks: {default: {ipv4_address: $subnet.10}}
  vcsim-esxi:
    build: {context: "$root/services/vmware", dockerfile: "$root/deploy/simulator/Dockerfile"}
    command: [-l, "0.0.0.0:8989", -esx, -username, sim-root, -password, sim-password-2]
    networks: {default: {ipv4_address: $subnet.11}}
  vmware:
    build: "$root/services/vmware"
    environment:
      VMWARE_SERVICE_TOKEN_FILE: /run/secrets/vmware_token
      # The adapter refuses Docker's own networks; only the two simulators are allowed. Not the whole subnet: the tests
      # expect the other containers on it (postgres) to stay blocked.
      VMWARE_ALLOW_NETWORKS: $subnet.10/32,$subnet.11/32
    volumes: ["$work/vmware.token:/run/secrets/vmware_token:ro"]
    ports: ["127.0.0.1:$vmware_port:8080"]
    depends_on: [vcsim-vcenter, vcsim-esxi]
  worker:
    build: "$root/apps/worker"
    environment:
      DATABASE_URL: postgresql://lightning:$pg_password@postgres:5432/lightning_test
      REDIS_HOST: redis
      REDIS_PASSWORD: "$redis_password"
      REDIS_DB: "15"
      MASTER_KEY_FILE: /run/secrets/master_key
      VMWARE_SERVICE_URL: http://vmware:8080
      VMWARE_SERVICE_TOKEN_FILE: /run/secrets/vmware_token
      APP_ENV: test
      WORKER_NAME: worker-test
      # Short waits: the tests poll for results for a minute or two at most.
      TASK_POLL_MS: "250"
      READINESS_POLL_MS: "250"
      SHUTDOWN_POLL_MS: "250"
      RECOVERY_SECONDS: "2"
      RECOVERY_STALE_SECONDS: "5"
    volumes: ["$work/master.key:/run/secrets/master_key:ro", "$work/vmware.token:/run/secrets/vmware_token:ro"]
    restart: on-failure
    depends_on:
      postgres: {condition: service_healthy}
      redis: {condition: service_healthy}
      vmware: {condition: service_started}
networks:
  default:
    ipam: {config: [{subnet: $subnet.0/24}]}
EOF

echo "run.sh: starting $project (first run builds the adapter, the simulator and the worker images)" >&2
dc up -d --build --wait postgres redis
dc up -d --build vcsim-vcenter vcsim-esxi vmware worker

# The adapter answers /healthz once it listens.
i=0
until node -e "fetch('http://127.0.0.1:$vmware_port/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || { echo "run.sh: the VMware adapter did not come up" >&2; dc logs --tail 50 vmware >&2; exit 1; }
  sleep 1
done

# What the test files read (each is named where it is read; see their first lines).
export TEST_DATABASE_URL="postgresql://lightning:$pg_password@127.0.0.1:$pg_port/lightning_test"
export REDIS_HOST=127.0.0.1 REDIS_PORT="$redis_port" REDIS_PASSWORD="$redis_password" REDIS_DB=15
export NODE_ENV=test APP_ENV=test
export MASTER_KEY_FILE="$work/master.key"
export VMWARE_SERVICE_URL="http://127.0.0.1:$vmware_port" VMWARE_SERVICE_TOKEN_FILE="$work/vmware.token"
# The simulators by the names the adapter resolves on its network (the API only ever reaches them through the adapter).
export VCSIM_VCENTER=vcsim-vcenter VCSIM_ESXI=vcsim-esxi VCSIM_VCENTER_IP="$subnet.10"
export WORKER_TEST=1

cd "$api"
status=0
npm run test:integration || status=$?
if [ "$status" -ne 0 ]; then
  echo "run.sh: tests failed; the worker's last lines:" >&2
  dc logs --tail 40 worker >&2 || true
fi
exit "$status"
