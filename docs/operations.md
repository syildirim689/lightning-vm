# İşletim: yedekleme, geri yükleme, güncelleme ve izleme

Bu işlemler sunucuda `scripts/install.sh` ile ve root olarak çalışır. Web ve API container'larının
host üzerinde hiçbir yetkisi yoktur. Panel sonuçları `data/maintenance/` altındaki dosyalardan
yalnızca okur (Yönetim → Yedekler ve güncellemeler).

## Yedekleme
```sh
sudo sh scripts/install.sh backup
```

**Yedeğin içeriği:**
- PostgreSQL'in tamamı (`pg_dump`, custom format);
- `.env`;
- `secrets/master.key` ve `secrets/vmware.token`;
- Caddy'nin sertifikaları ve ACME hesabı;
- `data/observability/alertmanager.yml`.

Redis yedeklenmez. Redis'te yalnızca kuyruk kopyaları, oturumlar ve hız sınırı sayaçları vardır.
Açık işlemler PostgreSQL'den yeniden kuyruğa alınır.

**Kapsam dışı:** bu yedek müşteri VM'lerini içermez. VMware snapshot'ı da bağımsız bir yedek
değildir: aynı datastore'da durur, datastore kaybolursa snapshot da kaybolur. Müşteri VM'leri için
ayrı bir yedekleme çözümü gerekir.

**Şifreleme:**
- Arşiv `secrets/backup.key` ile şifrelenir: AES-256-CBC, anahtar PBKDF2 ile 200.000 turda türetilir.
- Arşivin yanına bir `.sha256` dosyası yazılır.
- Yedek, yazıldıktan sonra geri okunarak doğrulanır.
- `backup.key` ilk kurulumda oluşturulur. **Bu dosyayı sunucu dışında güvenli bir yere kopyalayın.**
  O olmadan yedekler açılamaz. Yedeklerle aynı yere koyarsanız şifrelemenin koruması kalmaz.
- **Sınır:** SHA-256 dosyası bozulmayı yakalar, ama kasıtlı değiştirmeye karşı imza değildir.
  Yedekleri güvendiğiniz bir depoda tutun.

**Saklama ve harici hedef** (`.env`):

| Ayar | Varsayılan | Anlamı |
|---|---|---|
| `BACKUP_DIR` | `backups` | Yerel klasör. Harici bir disk veya NFS de bağlanabilir. |
| `BACKUP_KEEP` | `7` | Yerelde tutulan en yeni yedek sayısı. Eskiler silinir. |
| `BACKUP_COPY_TO` | boş | `rsync` hedefi: `kullanici@yedek:/yol` (SSH) veya bağlı bir klasör. Hedefteki saklama süresini hedefin kendisi yönetir. |
| `BACKUP_SCHEDULE` | `daily` | Zamanlayıcı açıkken günlük yedek. `off`: kapalı. |

SSH hedefinde kopya root'un SSH anahtarıyla yapılır (zamanlayıcı da root olarak çalışır).
Anahtarı ve kullanıcıyı `/root/.ssh/config` içinde o host için tanımlayın.
Harici kopya başarısız olursa yerel yedek yine kalır, ama sonuç "başarısız" (`E_BACKUP_COPY`)
olarak kaydedilir ve alarm üretir.

## Geri yükleme
```sh
sudo sh scripts/install.sh restore backups/lightning-20261024T030001Z.tar.enc
```
```sh
sudo sh scripts/install.sh restore backups/lightning-20261024T030001Z.tar.enc --yes-replace-data
```

**Onaysız çalıştırma:** komut yalnızca kontrol eder ve neyin değişeceğini söyler, hiçbir şeyi
değiştirmez (çıkış kodu 3). Kontroller:
- sağlama;
- şifre çözme;
- içerik;
- yedeğin bu sürümden yeni olmaması.

**Onaylı çalıştırma** (`--yes-replace-data`), sırasıyla:
1. **Mevcut verinin yedeğini alır.** Bu yedek alınamazsa geri yükleme yapılmaz.
2. Uygulama servislerini durdurur.
3. Veritabanını **tamamen** yedektekiyle değiştirir.
4. `master.key`, `vmware.token` ve sertifikaları geri koyar. VMware parolaları o anahtarla
   şifrelendiği için anahtarlar veriyle birlikte döner.
5. Geçerli `.env` ve `alertmanager.yml` değiştirilmez. Yedekteki halleri `.env.from-backup` ve
   `data/observability/alertmanager.yml.from-backup` olarak yazılır.
6. Servisleri başlatır ve sağlığı kontrol eder.

**Yeni sunucuya taşıma:** önce `sh scripts/install.sh` ile kurun, `backup.key` dosyasını
`secrets/` altına kopyalayın, sonra `restore` çalıştırın.

## Güncelleme
Kaynak kurulum git etiketlerini izler. `vX.Y.Z` kararlı sürümdür, `vX.Y.Z-rc.1` gibi etiketler
beta sürümdür.
```sh
sudo sh scripts/install.sh update
```
```sh
sudo sh scripts/install.sh update --to v1.2.0
```

**Adımlar:**
1. Kaynakta yerel değişiklik yoksa sürümleri çeker (`git fetch --tags`).
2. **Uyumluluk:** hedef sürüm, uygulanmış her migration'ı içermelidir. Veritabanı otomatik olarak
   eski sürüme indirilemez (`E_UPDATE_INCOMPATIBLE`).
3. Açık işlem varsa:
   - otomatik güncelleme bir sonraki saate ertelenir;
   - elle güncellemede uyarı verilir. İşlemler yeni sürümde kaldıkları adımdan sürer.
4. Yedek alır. Yedek alınamazsa güncelleme yapılmaz.
5. **İşleri boşaltır:** worker'ı durdurur. Çalışan adımın bitmesi için en çok 120 sn bekler.
6. Yeni sürüme geçer. Migration'lar `migrate` servisinde çalışır. Ardından servislerin ve
   `/api/ready`'nin sağlığını kontrol eder.
7. **Başarısızlıkta:**
   - container'lar önceki sürüme döner;
   - veritabanı **otomatik geri alınmaz**: yeni sürümün migration'ları uygulanmış olabilir;
   - eski sürüm uyumsuz kalırsa, mesajdaki yedekle `restore` çalıştırın.

**Self-update:** betik kendi dosyasını da güncellediği için güncelleme sırasında geçici bir
kopyasından çalışır.

**Otomatik güncelleme:** varsayılanı kapalıdır.
```sh
sudo sh scripts/install.sh schedule on
```
```sh
sudo sh scripts/install.sh auto-update on --channel stable --window 03:00-05:00
```
- `schedule on`, saatlik bir systemd zamanlayıcısı kurar (`lightning-vm-maintenance.timer`).
  Zamanlayıcı her çalışmada:
  - son başarılı yedek 23 saatten eskiyse yedek alır;
  - otomatik güncelleme açık ve saat pencere içindeyse güncelleme yapar.
- Pencere sunucunun yerel saatine göredir ve gece yarısını geçebilir (`22:00-02:00`).
- Kapatmak için:
  ```sh
  sudo sh scripts/install.sh auto-update off
  ```
  ```sh
  sudo sh scripts/install.sh schedule off
  ```

**Geçmiş:**
- `data/maintenance/history.jsonl`: son 500 kayıt.
- `data/maintenance/settings.json`: ayarların özeti.

**Henüz yok:** GHCR'den hazır imajla kurulum ve imzalı kurulum paketi. Güncelleme şimdilik kaynak
checkout'u ile çalışır ve imajları sunucuda derler.

## İzleme
```sh
sudo docker compose --profile observability up -d
```

| Bileşen | Görevi | Erişim |
|---|---|---|
| Prometheus | API metrikleri, host (node-exporter), dış erişim probe'u (blackbox) | http://127.0.0.1:9090 |
| Alertmanager | Alarmların yönlendirilmesi | http://127.0.0.1:9093 |
| Grafana | "Lightning VM" panosu | http://127.0.0.1:3001, kullanıcı `admin`, parola `.env` içindeki `GRAFANA_PASSWORD` |
| Loki | Loglar, 7 gün saklama | Grafana üzerinden |
| OTel Collector | Container loglarını Loki'ye taşır | — |

Hiçbiri internete açılmaz. Uzaktan erişim için SSH tüneli kullanın:
```sh
ssh -L 3001:127.0.0.1:3001 KULLANICI@SUNUCU
```

**Metrikler** (API `/metrics`, yalnızca iç ağdan): tarama anında PostgreSQL ve Redis'ten hesaplanır.
- worker yaşam sinyalinin yaşı;
- kuyruk uzunluğu ve en eski bekleyen işlemin süresi;
- takılmış ve başarısız işlemler;
- sunucuların durum/güç/misafir dağılımı;
- ESXi/vCenter bağlantıları;
- datastore doluluğu;
- havuz kapasite katmanları;
- konsol olayları;
- veritabanı bağlantıları;
- son yedek ve güncelleme sonucu;
- API gecikmesi ve hata oranı (rota şablonuna göre).

**Etiketler:** yalnızca yöneticinin verdiği adlar (havuz, bağlantı, datastore) ve sabit değerler
kullanılır. Kullanıcı, sunucu veya istek kimliği etiket olmaz, böylece seri sayısı sınırlı kalır.

**"Veri yok" ile "sıfır" farkı:** API PostgreSQL'e ulaşamazsa metrikler boş kalır, sıfır
gösterilmez. Bu durum `lightning_dependency_up` ve `up` alarmlarıyla ayrıca bildirilir. Sunucu
durumu da üçe ayrılır:
- `missing`: VMware'de bulunamadı;
- `power`: VM'nin güç durumu;
- `guest`: işletim sisteminin hazır olup olmadığı.

**Loglar:**
- Servisler JSON log yazar. Ortak alanlar: `service`, `env`, `level`, `time` ve kararlı İngilizce
  olay kodu (`event` veya `msg`). İstek logunda `reqId`, worker işlem logunda `operationId` bulunur.
- **Rotasyon:** Docker json-file sürücüsü, servis başına 3 × 10 MB.
- OTel Collector Docker'ın log dosyalarını salt okunur okur ve servis adını `service_name`
  etiketiyle Loki'ye yazar.
- **Maskeleme:** uygulamalar zaten sır yazmaz. İkinci bir önlem olarak Collector,
  `password`/`token`/`secret`/`cookie`/`ticket`/`authorization` değerlerini `***` ile değiştirir.
- Docker'ın veri klasörü `/var/lib/docker` değilse `compose.yaml` içindeki otel bağlamasını
  değiştirin.

**Alarmlar** (`deploy/observability/alerts.yaml`):
- API'ye ulaşılamıyor; API bir bağımlılığa ulaşamıyor;
- worker yaşam sinyali eski;
- kuyrukta uzun bekleyen veya takılmış işlem; başarısız işlem;
- bağlantı kopuk;
- datastore %85'in üzerinde dolu; satılabilir kapasite %10'un altında;
- konsol hataları;
- 26 saattir başarılı yedek yok; son yedek/güncelleme başarısız;
- panele dışarıdan ulaşılamıyor; sertifika 14 gün içinde bitiyor;
- host diski veya RAM'i dolu.

**Bildirim:** `data/observability/alertmanager.yml` dosyasına webhook veya e-posta alıcısı ekleyin.
Bu dosya git dışındadır ve güncellemelerde korunur. Sonra:
```sh
sudo docker compose --profile observability restart alertmanager
```

**Dış erişim probe'u:** `domain` modunda `https://<alan adı>/api/health` dışarıdan denetlenir.
Diğer modlarda genel adres bilinmediği için API içeriden denetlenir. İsterseniz `.env` içinde
`PANEL_PROBE_URL` ayarlayın.

**Henüz yok:**
- dağıtık iz (Tempo/OpenTelemetry tracing);
- konteyner ağının host ağ metrikleri (node-exporter container ağında çalışır);
- GPU ve ESXi host donanım metrikleri.
