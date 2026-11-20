# Kurulum: betik ve tarayıcı sihirbazı

Varsayılan kurulum tek komuttur ve sonunda çalışan bir panel verir:
```sh
sudo sh scripts/install.sh
```
Betik sırasıyla şunları yapar:
1. Ön kontrol raporu: işletim sistemi, mimari, işlemci, bellek, disk, portlar, Docker, saat eşitlemesi, alan adının
   DNS kaydı ve bu dizinde zaten bir kurulum olup olmadığı. Ardından yapılacakların listesi. Buraya kadar hiçbir
   şey kurulmaz ve hiçbir dosya yazılmaz; uçbirimde "Devam edilsin mi?" diye sorulur (`--yes` sormaz; uçbirim
   yoksa hiç sorulmaz).
2. Docker yoksa Docker'ın resmî apt deposundan kurar; sırları ve `.env`'i oluşturur, imajları derler, servisleri
   başlatır ve hazır olmasını bekler.
3. Erişim: `--domain` verildiyse o ad; sunucunun genel bir IPv4 adresi varsa
   `<ip-tireli>.sslip.io` (ör. `49-12-109-190.sslip.io`). İki durumda da Caddy Let's Encrypt
   sertifikası alır. Genel IP yoksa veya `--local` verildiyse panel yalnızca
   `127.0.0.1:8080`'de açılır (SSH tüneli).
4. RAM 3.8 GB veya üstündeyse izleme yığınını (Prometheus, Grafana, Loki) açar.
5. İlk yöneticiyi rastgele parolayla oluşturur (docs/auth.md).
6. Günlük yedek zamanlayıcısını kurar ve ilk yedeği alır.
7. Özet: panel adresi, yönetici e-postası ve parolası, Grafana bilgileri, sürümler, verinin, yedeklerin ve
   kayıtların yeri, en sık gereken komutlar, toplam süre, belge ve sorun bildirme bağlantıları.

Bu sekiz iş uçbirimde numaralı adımlar olarak görünür (`[3/8] İmajların derlenmesi`); her adım ne yaptığını ve
nedenini bir iki cümleyle söyler, beklerken geçen süreyi ve ilerlemeyi gösterir (kaç imaj derlendi, kaç servis hazır,
hangisi bekleniyor) ve `✓` ya da `✗` ile, süresiyle biter. Ayrıntı: [Dil, çıktı ve kayıt](#dil-çıktı-ve-kayıt).

| Seçenek | Etki |
|---|---|
| `--domain panel.example.com` | Kendi alan adınız (A kaydı sunucuyu göstermeli, 80/443 açık olmalı) |
| `--local` | Dışarıya açma; yalnızca SSH tüneliyle eriş |
| `--admin-email you@example.com` | Yönetici e-postası |
| `--setup-wizard` | Yöneticiyi betik değil tarayıcı sihirbazı oluşturur (kurulum anahtarıyla) |
| `--no-monitoring` | İzleme yığınını açma |
| `--no-schedule` | Yedek zamanlayıcısını kurma |
| `--lang tr\|en` | Çıktı dili (her komutta). Verilmezse `install` uçbirimde bir kez sorar |
| `--yes`, `-y` | Ön kontrol raporundan sonra "Devam edilsin mi?" diye sorma |
| `--plain` | Uçbirimde de renksiz, animasyonsuz, satır satır çıktı |
| `help`, `--help`, `-h` | Bütün komutlar ve seçenekler, seçilen dilde |

Betiği tekrar çalıştırmak güvenlidir: mevcut yönetici, sırlar ve veriler korunur.

## 1. Kurulum betiği

```sh
sh scripts/install.sh [install|check|recover-setup|update|...] [--lang tr|en] [--install-docker] [--allow-unsupported-os] [--yes] [--plain]
sh scripts/install.sh help          # bütün komutlar ve seçenekler (Türkçe ya da İngilizce)
```

| Mod | Ne yapar | Değişiklik yapar mı |
|---|---|---|
| `install` (varsayılan) | Yukarıdaki tam kurulum | Evet |
| `check` | Ön kontroller ve mevcut kurulumun durumu | **Hayır** |
| `recover-setup` | Tamamlanmış sihirbazı yönetici için yeniden açar | Yalnızca kurulum durumu |
| `reset-password E-POSTA [--disable-2fa]` | Unutulan şifre yerine yeni bir şifre üretir ve bir kez gösterir | Yalnızca o hesabın şifresi ve oturumları |
| `backup`, `restore`, `update`, `schedule`, `auto-update` | İşletim (docs/operations.md). `restore` arşivi önce root'a özel bir klasöre kopyalar, herkesin oturumunu kapatır ve paneli **beklemeye** alır; Yönetim → Sistem'den ya da `docker compose exec api node dist/cli.js release-restore-hold` ile serbest bırakılır (`--no-hold` yalnızca bekletmeyi atlar) | Evet |
| `domain`, `behind-proxy`, `local-only` | Erişim modunu değiştirir (docs/domain-https.md). `behind-proxy` panelin dış adresini ister: `--public-url https://panel.example.com` (`.env` içinde `PANEL_PUBLIC_URL` zaten varsa gerekmez) | Yalnızca `.env` ve proxy |

**Yarıda kalan kurulum:** `install` tekrar çalıştırılarak devam ettirilir. Her adım tekrarlanabilir:
- `.env` yalnızca bir kez oluşturulur. Sonraki çalıştırmalar yalnızca eksik anahtarları ekler,
  var olan sır ve ayarları asla değiştirmez.
- Veritabanı, yönetici hesabı ve kalıcı veriler korunur.
- Yönetici varsa yeni kurulum anahtarı üretilmez.

Bu davranış test sunucusunda denendi: container'lar silinip betik yeniden çalıştırıldı;
`.env` aynı kaldı, kullanıcı sayısı değişmedi.

**Dokunulmayanlar:** güvenlik duvarı, SSH ayarları, mevcut Nginx/Caddy/Traefik ve sistem paketleri.
Tek istisna: Docker yoksa (root ile ya da `--install-docker` ile) yalnızca Docker'ın resmî apt
deposundan kurulur (docs.docker.com/engine/install/ubuntu).

**Sırlar:** `openssl rand` ile üretilir ve `.env` dosyasına `600` izinle yazılır. Terminale
yazdırılmaz. İstisnalar: ilk yönetici parolası (kurulum özetinde bir kez gösterilir ve
`secrets/initial-admin.txt`'e `600` izinle yazılır) ve `--setup-wizard` ile 1 saat geçerli
kurulum anahtarı.

### Ön kontroller
| Kod | Koşul | Sonuç |
|---|---|---|
| `E_OS_UNSUPPORTED` | Ubuntu 22.04 / 24.04 / 26.04 değil | Hata (`--allow-unsupported-os` ile uyarı) |
| `E_ARCH_UNSUPPORTED` | amd64/arm64 değil | Hata |
| `W_CPU_LOW` | < 2 vCPU | Uyarı |
| `E_RAM_LOW` / `W_RAM_LOW` | < 2 GB / < 4 GB | Hata / uyarı |
| `E_DISK_LOW` / `W_DISK_LOW` | < 10 GB / < 20 GB boş | Hata / uyarı |
| `E_TOOL_MISSING` | openssl veya curl yok | Hata |
| `E_DOCKER_MISSING`, `E_DOCKER_DENIED`, `E_COMPOSE_MISSING` | Docker Engine / erişim / Compose v2 | Hata |
| `E_PORT_IN_USE` | `LISTEN_ADDRESS:HTTP_PORT` başka süreçte (bizim proxy değil) | Hata |
| `W_DNS`, `W_OUTBOUND` | Docker Hub / npm çözümlenemiyor veya erişilemiyor | Uyarı |
| `W_TIME_UNSYNCED` | Sunucu saati NTP ile eşitlenmemiş (`timedatectl`) | Uyarı |
| `W_DNS_NO_A` | Panelin alacağı adın (`--domain` ya da `<ip>.sslip.io`) A kaydı yok | Uyarı: HTTPS kurulamaz, panel yalnızca yerelde açılır |
| `W_PORT_IN_USE` | O ad için gereken 80 ya da 443 başka bir süreçte | Uyarı: aynı sonuç (`behind-proxy` ile mevcut web sunucusunun arkasına alınabilir) |

Son üçü yalnızca `install` raporunda görünür (`check` çıktısı değişmedi). Ön kontrollerden biri başarısız olursa
betik hiçbir şey kurmadan ve dosya oluşturmadan durur (`E_PRECHECK`); Docker da ancak kontroller geçtikten sonra
kurulur. Rapor ayrıca bu dizinde ne bulduğunu söyler (`STATE`): kurulum yok (sıfırdan kurulur), yarıda kalmış
(kaldığı yerden sürer) ya da tamamlanmış (ayarlar ve veriler korunur, servisler yeniden derlenip başlatılır; sürüm
yükseltmek için `update` kullanılır).

### Dil, çıktı ve kayıt

**Dil.** `--lang tr|en` verilirse o dil kullanılır. Verilmezse:
- `install` (ve tek komutla kurulumda `get.sh`) **uçbirimde** bir kez, her şeyden önce sorar:
  `1) Türkçe  2) English`. Varsayılan `LC_ALL`, `LC_MESSAGES`, `LANG` sırasıyla yereldeki dildir; Enter ya da
  30 saniye sessizlik varsayılanı seçer. Yanıt tek tuştur ve `/dev/tty`'den okunur: `curl … | sudo sh` biçiminde
  standart girdi betiğin kendisidir.
- **Uçbirim yoksa hiçbir şey sorulmaz**: cloud-init, CI, systemd, panelin ajanı, çıktısı bir dosyaya ya da boruya
  giden çalıştırmalar varsayılan dili kullanır ve onay beklemeden sürer. `TERM=dumb` ve `--plain` de böyle sayılır.
- Diğer komutlar (`update`, `backup`, `domain`…) hiçbir zaman dil sormaz; yereldeki dili ya da `--lang` değerini
  kullanır. Zamanlayıcı ve ajan, kuruldukları andaki dille çalışır.

**Uçbirimde çıktı.** Başlık (sürüm, kanal, dizin, kayıtların yeri, beta notu), ön kontrol raporu, yapılacaklar,
numaralı adımlar ve özet. Uzun beklemelerde süreyi gösteren bir dönen işaret vardır; `update`, `backup`, `restore`,
`domain`, `behind-proxy`, `monitoring`, `terminal` ve `uninstall` komutlarının uzun adımları da aynı işareti
kullanır. `NO_COLOR` renkleri kapatır; UTF-8 olmayan yerelde işaretler ASCII olur (`[ok]`, `[xx]`, `[!!]`, `[..]`).
Ctrl-C imleci geri getirir, dönen işareti durdurur ve kaydın yerini yazar.

**Uçbirim değilse** her satır eskiden olduğu gibi `DÜZEY KOD metin` biçimindedir; satır başı karakteri, imleç ya da
renk kodu yazılmaz. `install` ve `update` çıktısına yeni satırlar eklendi: `INFO INSTALLER`, `INFO PLAN`,
`INFO STEP`, `OK STEP_DONE`, `INFO PROGRESS` (ilerleme değiştikçe), bir adım başarısız olursa `INFO LOG_TAIL` ile
başarısız komutun son satırları (`      | ` ile başlar), `INFO HINT` ve `INFO LOG`. Hata her zaman **son satırdır**;
`backup`, `check`, `releases` ve bir hatayla hemen biten komutların çıktısı bayt bayt aynıdır.

**Kayıt.** Betiğin çalıştırdığı komutların (apt, docker compose, git) çıktısı ekrana değil
`data/logs/<komut>-<UTC zamanı>-<pid>.log` dosyasına yazılır (izin `600`, klasör `700`; en yeni 30 dosya tutulur).
Bir adım başarısız olursa son 20 satırı kendiliğinden gösterilir, yanında hata kodu, ne yapılacağı ve dosyanın
tam yolu. Bir adım kendi hata iletisi olmadan biterse (örneğin Docker kurulurken apt hata verirse) `install`
`E_STEP_FAILED` yazar ve o komutun çıkış koduyla biter.

Çıkış kodları:

| Kod | Anlamı |
|---|---|
| 0 | Başarılı (güncelleme için: güncel olduğu için bir şey yapılmadıysa da 0) |
| 1 | Ön kontrol başarısız (`E_PRECHECK`); alan adı ayarlanamadı (`E_DOMAIN_FAILED`); `uninstall` bir adımı tamamlayamadı |
| 2 | Geçersiz argüman ya da değer (bilinmeyen seçenek, geçersiz alan adı, port, saat dilimi, güncelleme penceresi, yedek dosyası yok; sertifika: `E_CERT_FILES`, `E_CERT_UNREADABLE`, `E_CERT_DATES`, `E_CERT_KEY_MISMATCH`; `behind-proxy`: `E_PUBLIC_URL_MISSING`, `E_PUBLIC_URL_INVALID`, `E_CIDR_INVALID`) |
| 3 | `restore` onaysız çalıştırıldı: yalnızca denetledi, hiçbir şeyi değiştirmedi (`--yes-replace-data` ekleyin); `install` uçbirimde "Devam edilsin mi?" sorusuna hayır yanıtı aldı: hiçbir şey kurulmadı |
| 13 | Yetki ya da Docker: root gerekli (`E_NEEDS_ROOT`), Docker yok ya da kurulamadı (`E_DOCKER_MISSING`) |
| 17 | Yapılandırma hatası: `.env` örnek parola içeriyor, Compose dosyası geçersiz, sırların sahibi yanlış, henüz kurulmamış (`E_NOT_INSTALLED`) |
| 18 | Servisler başlamadı; kurtarma ya da parola sıfırlama çalışmadı; host ajanı, zamanlayıcı, profil ya da host ayarı için gereken sistem parçası yok (systemd, timesyncd, resolved, desteklenmeyen işletim sistemi) |
| 19 | API süresinde hazır olmadı (`E_NOT_READY`) |
| 20 | Güncelleme yapılamadı: git ile alınmamış kaynak, yerel değişiklik, sürümler alınamadı, yayımlanmış sürüm yok, bilinmeyen sürüm, veritabanına ulaşılamadı, hedef sürüm uygulanmış bir migration'ı içermiyor (`E_UPDATE_INCOMPATIBLE`) |
| 21 | Yedek alınamadı (anahtar yok, veritabanı dökümü, dış kopya) ya da bir host / işletim sistemi işlemi başarısız (ad, saat dilimi, NTP, DNS, apt) |
| 22 | Geri yükleme yapılamadı: yedek çalışma klasörüne kopyalanamadı (`E_RESTORE_COPY`), imza (ya da imzasız eski yedek), sağlama toplamı, şifre çözme, eksik yedek, yedek daha yeni bir sürümden, güvenlik yedeği alınamadı, veritabanı ya da başlatma hatası, panel beklemeye alınamadı (`E_RESTORE_HOLD`; servisler başlatılmaz) |
| 23 | Güncelleme başarısız oldu ve container'lar önceki sürüme geri alındı (`E_UPDATE_FAILED`); veritabanı geri alınmaz |

Kodlar `scripts/install.sh` içindeki `die` çağrılarından okunur; her hata ayrıca `E_...` koduyla ve açıklamasıyla yazılır.

## 2. Tarayıcı sihirbazı (`/setup`)
Varsayılan kurulumda sihirbaz atlanır; ayarlar panelden yapılır. `--setup-wizard` ile kurulduysa
yönetici ve ilk ayarlar burada oluşturulur.

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
- **Şifre unutulduysa** (e-posta ayarlı değilse "Şifremi unuttum" çalışmaz): sunucuda şunu çalıştırın:
  ```sh
  sh scripts/install.sh reset-password admin@ornek.com
  ```
  - Yeni, güçlü bir şifre üretilir ve yalnızca bu komutun çıktısında bir kez gösterilir. Hiçbir yerde düz
    metin olarak saklanmaz.
  - Hesabın bütün oturumları kapatılır ve işlem denetim kaydına `auth.password_reset_cli` olarak yazılır.
  - İki adımlı giriş olduğu gibi kalır. Doğrulayıcı uygulama da kaybolduysa `--disable-2fa` ekleyin; giriş
    yaptıktan sonra iki adımlı girişi yeniden açın.
  - Kurulum, ilk yöneticinin şifresini de yalnızca bir kez gösterir. Kaydedilmediyse bu komutla yenisi alınır.
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

### İzleme ve alan adı sihirbazda komutsuz

- **İzleme adımı:** Prometheus, Grafana, Loki ve Alertmanager zaten çalışıyorsa kutucuk işaretli gelir ve
  kontroller geçer.
  - Kapalıyken işaretlenirse panel, sunucudaki ajana `monitoring on` isteği gönderir.
  - Bileşenler hazır olana kadar (en fazla 3 dakika) sayfa birkaç saniyede bir kontrol eder.
  - İşaret kaldırılırsa `monitoring off` gönderilir. Yalnızca izleme servisleri durur, verileri korunur.
  - Ajan kurulu değilse sihirbaz bunu söyler ve tek komutu gösterir: `sudo sh scripts/install.sh agent on`.
- **Elle karşılığı:** `sh scripts/install.sh monitoring on|off`.
- **Alan adı adımı:** DNS'i kontrol eder. HTTPS sertifikası kurulumdan sonra Ayarlar → Alan adı ve SSL'den
  panelin kendisi tarafından kurulur.
