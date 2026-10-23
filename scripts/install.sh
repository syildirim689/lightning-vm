#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null || { echo "Docker kurulmalı."; exit 1; }
docker compose version >/dev/null
command -v openssl >/dev/null || { echo "OpenSSL kurulmalı."; exit 1; }
if [ ! -f .env ]; then
  (umask 077
   printf 'POSTGRES_DB=lightning\nPOSTGRES_USER=lightning\nPOSTGRES_PASSWORD=%s\nREDIS_PASSWORD=%s\nGRAFANA_PASSWORD=%s\nLISTEN_ADDRESS=127.0.0.1\nHTTP_PORT=8080\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > .env)
fi
if grep -q CHANGE_ME .env; then
 echo '.env örnek parolalarını değiştirin veya yeni kurulumda dosyayı kaldırıp yeniden çalıştırın.'; exit 1
fi
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 240
# A one-hour token gates creation of the first admin; once an admin exists none is issued.
if token=$(docker compose exec -T api node dist/cli.js bootstrap-token 2>/dev/null); then
  echo 'İlk yönetici için kurulum anahtarı (1 saat geçerli) / Setup token for the first admin (valid 1 hour):'
  echo "  $token"
  echo 'http://127.0.0.1:8080/setup — yeni anahtar / new token: docker compose exec api node dist/cli.js bootstrap-token'
else
  echo 'Yönetici hesabı zaten var; kurulum anahtarı üretilmedi. / Admin already exists; no setup token issued.'
fi
echo 'Hazır / Ready: http://127.0.0.1:8080 — HTTPS yapılandırılmadan internete açmayın / do not expose without HTTPS.'
