# Doğrulama kayıtları

## Geliştirme makinesi — 2026-10-23
Windows Server 2025, Node 24.21, npm 11.19 (Docker yok).
- `npm ci` (api, web, worker): lock dosyalarıyla tutarlı.
- API `npm test`: 3/3 geçti — bağımlılık yokken `/health` 200; PostgreSQL ve Redis
  erişilemezken `/ready` 503; PostgreSQL erişilemezken `/system` 503.
- Web `npm run build` (Next.js 16.4.3, TypeScript strict): başarılı.
- Worker `npm run check`: başarılı.
- `npm audit --omit=dev`: üç uygulamada 0 açık. API'de Nest'in getirdiği eski fastify
  `overrides` ile 5.12.7'ye sabitlendi.

## Docker test sunucusu — 2026-10-23
Ubuntu 24.04.5 LTS, aarch64, 8 vCPU, 15 GiB RAM. Docker Engine 29.9.2,
Compose v5.6.1 (resmî Docker apt deposundan kuruldu).

Gerçekten çalıştırılanlar:
- Boş veriyle `sh scripts/install.sh`: başarılı; tüm servisler healthy.
- `/api/ready` 200, `/admin` 200, `/api/metrics` dışarıdan 404, iç ağdan `api:4000/metrics` 200.
- `/api/system`: worker heartbeat'i `healthy: true`.
- İkinci `install.sh` çalıştırması: `.env` değişmedi (sha256 aynı), izin 600.
- Redis durdurulunca `/api/ready` 503; PostgreSQL durdurulunca `/api/ready` ve
  `/api/system` 503; servisler geri gelince `/api/ready` 200.
- `operations` kuyruğuna eklenen iş worker tarafından reddedildi (failed sayısı 1, log `operation_failed`).
- api+worker `stop` süresi 1 sn (SIGTERM ile düzgün kapanış).
- `--profile observability`: Prometheus API'yi kazıyor (`up=1`), `LightningApiUnavailable`
  kuralı yüklü, Grafana sağlıklı, OTLP HTTP ile gönderilen test logu Loki'de sorgulandı.

Bu testlerde bulunan ve düzeltilen hatalar:
- Worker hiç çalışmıyordu: BullMQ 6 `ioredis`'i isteğe bağlı yaptı; ESM'de hazır istemci
  verilmesi gerekiyor. `ioredis` eklendi ve istemci BullMQ'ya verildi.
- Heartbeat hep başarısızdı: `worker.client` BullMQ 6'da yok; Redis doğrudan ping'leniyor.
- `/system` PostgreSQL kesintisinde 500 dönüyordu; artık 503.

Doğrulanmayanlar:
- API ve worker logları henüz Loki'ye gönderilmiyor (Collector → Loki hattı çalışıyor).
- Alarm bildirimi (Alertmanager) yok.
- GitHub Actions iş akışları henüz GitHub üzerinde çalışmadı.
- amd64 imajları yalnızca CI'da derlenecek; sunucu testleri arm64'te yapıldı.
- VMware ve konsol henüz uygulanmadığı için gerçek ESXi/vCenter testi yapılmadı.
