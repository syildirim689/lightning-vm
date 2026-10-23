# Kurulum: betik ve tarayıcı sihirbazı

Kurulum iki katmandan oluşur:
1. Sunucuda `scripts/install.sh`: işletim sistemi ve kaynak kontrolleri, sırlar ve servisler.
2. Tarayıcıda `/setup`: uygulama ayarları ve ilk yönetici hesabı.

## 1. Kurulum betiği

```sh
sh scripts/install.sh [install|check|recover-setup|update] [--lang tr|en] [--install-docker] [--allow-unsupported-os]
```

| Mod | Ne yapar | Değişiklik yapar mı |
|---|---|---|
| `install` (varsayılan) | Ön kontrol, `.env`, derleme, başlatma, hazır olma kontrolü, kurulum anahtarı | Evet |
| `check` | Ön kontroller ve mevcut kurulumun durumu | **Hayır** |
| `recover-setup` | Tamamlanmış sihirbazı yönetici için yeniden açar | Yalnızca kurulum durumu |
| `update` | Henüz yok; kod 20 ile çıkar | Hayır |
| `domain`, `behind-proxy`, `local-only` | Erişim modunu değiştirir (docs/domain-https.md) | Yalnızca `.env` ve proxy |

**Yarıda kalan kurulum:** `install` tekrar çalıştırılarak devam ettirilir. Her adım tekrarlanabilir:
- `.env` yalnızca bir kez oluşturulur. Sonraki çalıştırmalar yalnızca eksik anahtarları ekler,
  var olan sır ve ayarları asla değiştirmez.
- Veritabanı, yönetici hesabı ve kalıcı veriler korunur.
- Yönetici varsa yeni kurulum anahtarı üretilmez.

Bu davranış test sunucusunda denendi: container'lar silinip betik yeniden çalıştırıldı;
`.env` aynı kaldı, kullanıcı sayısı değişmedi.

**Dokunulmayanlar:** güvenlik duvarı, SSH ayarları, mevcut Nginx/Caddy/Traefik ve sistem paketleri.
Tek istisna: Docker, yalnızca `--install-docker` verilirse ve yalnızca Docker'ın resmî apt
deposundan kurulur (docs.docker.com/engine/install/ubuntu).

**Sırlar:** `openssl rand` ile üretilir ve `.env` dosyasına `600` izinle yazılır. Terminale
yazdırılmaz. Tek istisna, 1 saat geçerli kurulum anahtarıdır; yönetici olmadığı sürece
yalnızca bir kez gösterilir.

### Ön kontroller
| Kod | Koşul | Sonuç |
|---|---|---|
| `E_OS_UNSUPPORTED` | Ubuntu 22.04 / 24.04 değil | Hata (`--allow-unsupported-os` ile uyarı) |
| `E_ARCH_UNSUPPORTED` | amd64/arm64 değil | Hata |
| `W_CPU_LOW` | < 2 vCPU | Uyarı |
| `E_RAM_LOW` / `W_RAM_LOW` | < 2 GB / < 4 GB | Hata / uyarı |
| `E_DISK_LOW` / `W_DISK_LOW` | < 10 GB / < 20 GB boş | Hata / uyarı |
| `E_TOOL_MISSING` | openssl veya curl yok | Hata |
| `E_DOCKER_MISSING`, `E_DOCKER_DENIED`, `E_COMPOSE_MISSING` | Docker Engine / erişim / Compose v2 | Hata |
| `E_PORT_IN_USE` | `LISTEN_ADDRESS:HTTP_PORT` başka süreçte (bizim proxy değil) | Hata |
| `W_DNS`, `W_OUTBOUND` | Docker Hub / npm çözümlenemiyor veya erişilemiyor | Uyarı |

Ön kontrollerden biri başarısız olursa betik dosya oluşturmadan durur (`E_PRECHECK`).

Çıkış kodları:

| Kod | Anlamı |
|---|---|
| 0 | Başarılı |
| 1 | Ön kontrol başarısız |
| 2 | Geçersiz argüman |
| 13 | Docker kurulamadı |
| 17 | Yapılandırma hatası |
| 18 | Servisler başlamadı veya kurtarma çalışmadı |
| 19 | API hazır değil |
| 20 | Henüz yok |

## 2. Tarayıcı sihirbazı (`/setup`)

### Erişim güvenliği
- **Yönetici oluşturulmadan önce:** sihirbaz yalnızca kurulum anahtarıyla açılır.
  - Anahtar `POST /api/setup/session` ile doğrulanır ve tarayıcıda `HttpOnly`, `SameSite=Strict`
    bir çerezde tutulur.
  - Anahtar URL'de taşınmaz.
  - Anahtarı yalnızca sunucuda komut çalıştırabilen kişi alabilir.
- **Yönetici oluşturulunca:** anahtar silinir ve sihirbaza yalnızca yönetici oturumuyla devam edilir.
- **Kurulum tamamlanınca:** `/api/setup/*` uç noktaları (`status` ve iç `probe` hariç)
  `409 SETUP_CLOSED` döner ve `/setup` sayfası `/login` sayfasına yönlendirir.
- **Yeniden açma:** sihirbaz yalnızca sunucuda şu komutla tekrar açılır:
  ```sh
  sh scripts/install.sh recover-setup
  ```
  Bu komut hesaplara ve verilere dokunmaz ve denetim kaydına yazılır.
- **Doğrulama:** tüm doğrulama sunucuda yapılır. Bir adım ancak kendi kontrolleri o anda
  geçiyorsa "tamamlandı" olarak kaydedilir.

### Adımlar
| # | Adım | Durum | Test |
|---|---|---|---|
| 1 | Dil | Zorunlu | – |
| 2 | Sistem ön kontrolleri | Zorunlu | PostgreSQL, Redis, migration'lar, worker sinyali |
| 3 | Erişim adresi | Zorunlu | Sunucu bu adresten kendine ulaşıyor mu (tek seferlik nonce) |
| 4 | Alan adı ve HTTPS | İsteğe bağlı | DNS, HTTP (80) ve sertifika (443) ayrı ayrı (docs/domain-https.md) |
| 5 | PostgreSQL ve Redis | Zorunlu | Gerçek bağlantı ve sürüm |
| 6 | Yönetici hesabı | Zorunlu | – |
| 7 | ESXi / vCenter | Şimdilik yalnızca atlanabilir | 6. aşama |
| 8 | Datastore ve ağ keşfi | Şimdilik yalnızca atlanabilir | 6. aşama |
| 9 | Kaynak havuzu ve IP planı | Şimdilik yalnızca atlanabilir | 8. aşama |
| 10 | İzleme | İsteğe bağlı | Prometheus, Grafana, Loki erişimi |
| 11 | Özet | – | Zorunlu adımlar ve uyarılar |

**İlerlemenin kalıcılığı:** ilerleme PostgreSQL'deki `setup_progress` tablosunda tutulur.
Sayfa yenilense veya servisler yeniden başlasa da sihirbaz ilk tamamlanmamış adımdan devam eder.

**Atlanan VMware adımları:** özet ekranında ve yönetim panelinde açıkça gösterilir.
Platform bu durumda sanal sunucu yönetemez.

### Erişim adresi testinin sonuçları
API, girilen adresin `/api/setup/probe/<nonce>` yoluna istek atar ve kendi ürettiği nonce'u geri
almayı bekler. Böylece "ulaşıldı ama başka bir sunucuya" durumu da yakalanır. Sonuç kodları:

| Kod | Anlamı |
|---|---|
| `OK` | Adres bu kuruluma ulaşıyor |
| `DNS_FAILED` | Ad çözümlenemedi |
| `CONNECTION_REFUSED` | Port kapalı veya iletilmiyor |
| `TIMEOUT` | Güvenlik duvarı veya NAT bağlantıyı düşürüyor |
| `TLS_ERROR` | Sertifika doğrulanamadı; doğrulama hiçbir zaman kapatılmaz |
| `HTTP_ERROR` | Proxy `/api` yolunu bu kuruluma iletmiyor |
| `WRONG_TARGET` | Yanıt başka bir sunucudan geliyor |
| `LOOPBACK_NOT_VERIFIABLE` | `127.0.0.1` veya `localhost` container içinden doğrulanamaz |

Adres doğrulanamasa da kaydedilebilir; özet ekranı bunu uyarı olarak gösterir. Bunun nedeni,
NAT arkasındaki bir sunucunun kendi genel adresine ulaşamayabilmesidir (hairpin NAT).

SSRF notu: bu test yalnızca kurulum yetkisi olan biri tarafından çalıştırılabilir.
Yalnızca `http`/`https` kabul eder, yönlendirmeleri izlemez ve 5 saniyede zaman aşımına uğrar.
Yanıt olarak yalnızca sonuç kodu döner.

## Testler
- `apps/api`, `npm run test:integration` (`setup-wizard.test.mjs`, gerçek PostgreSQL/Redis). Kapsam:
  - kurulum anahtarı kapısı;
  - sunucu tarafı adım doğrulaması;
  - worker sinyali yokken kontrolün geçmemesi;
  - erişim testinin DNS, kapalı port, yanlış hedef, yerel adres ve başarı durumlarını ayırması;
  - yönetici oluşunca anahtarın geçersiz olması;
  - eksik adımla tamamlamanın reddedilmesi;
  - kurulum tamamlanınca uç noktaların kapanması;
  - kurtarma.
- `apps/web`, `npm run test:e2e`: 11 adımın Türkçe olarak uçtan uca yürütülmesi, sayfa yenilenince
  kalınan adımdan devam edilmesi, hatalı adres doğrulaması ve tamamlanınca kurulumun kapanması.
- `shellcheck -s sh scripts/install.sh` ile betiğin statik kontrolü.
- `sh scripts/install.sh check`: hem kurulum öncesinde hem kurulum sonrasında çalıştırılır.
