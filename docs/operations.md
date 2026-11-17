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
- kendi sertifikanız ve anahtarı (`domain --tls custom` ile yüklediyseniz: `data/tls/cert.pem`, `key.pem`);
- `data/observability/alertmanager.yml`.

Redis yedeklenmez. Redis'te yalnızca kuyruk kopyaları, tek kullanımlık biletler ve hız sınırı sayaçları vardır
(oturumlar PostgreSQL'dedir). Açık işlemler PostgreSQL'den yeniden kuyruğa alınır.

**Kapsam dışı:** bu yedek müşteri VM'lerini içermez. VMware snapshot'ı da bağımsız bir yedek
değildir: aynı datastore'da durur, datastore kaybolursa snapshot da kaybolur. Müşteri VM'leri için
ayrı bir yedekleme çözümü gerekir.

**Şifreleme:**
- Arşiv `secrets/backup.key` ile şifrelenir: AES-256-CBC, anahtar PBKDF2 ile 200.000 turda türetilir.
- Arşiv, aynı anahtarla **imzalanır**: yedek `AD.tar.enc`, imzası `AD.tar.enc.hmac` olarak yazılır. İmza, şifreli
  dosyanın ve **dosya adının** `backup.key`'den türetilen bir anahtarla alınmış HMAC-SHA256 özetidir; yedek deposuna
  yazabilen ama anahtarı bilmeyen biri onu yeniden üretemez. `.sha256` dosyası artık yazılmaz.
- Yedek, yazıldıktan sonra geri okunarak doğrulanır: şifresi çözülür ve içindeki her dosya yedeğe giren
  dosyayla bayt bayt karşılaştırılır. Doğrulama geçmeden yedek "başarılı" sayılmaz ve eski yedekler silinmez
  (disk dolduğunda yarım kalan arşiv `E_BACKUP_VERIFY` veya `E_BACKUP_WRITE` ile reddedilir).
- `backup.key` ilk kurulumda oluşturulur ve **yedeklerin tek anahtarıdır**: yedeğin içinde yoktur, başka bir
  yerden yeniden üretilemez. **Bu dosyayı sunucu dışında güvenli bir yere (parola kasası gibi) kopyalayın.**
  Sunucu kaybolursa o olmadan hiçbir yedek açılamaz. Yedeklerle aynı yere koyarsanız şifrelemenin koruması
  kalmaz.
- **Sunucu dışı kopya sizin işinizdir.** Varsayılan kurulumda yedekler yalnızca bu sunucunun diskinde
  (`backups/`) durur; disk giderse yedekler de gider. `BACKUP_COPY_TO` ayarlayın (aşağıda) ya da `backups/`
  klasörünü kendi yönteminizle başka bir yere kopyalayın.
- **Sınır:** imza, değiştirilmiş ya da başka adla konmuş bir yedeği yakalar; değiştirilmemiş **eski** bir yedeğin
  kendi adıyla geri konmasını ya da yedeklerin silinmesini engellemez. Yedekleri güvendiğiniz bir depoda tutun.

**Saklama ve harici hedef** (`.env`):

| Ayar | Varsayılan | Anlamı |
|---|---|---|
| `BACKUP_DIR` | `backups` | Yerel klasör. Harici bir disk veya NFS de bağlanabilir. |
| `BACKUP_KEEP` | `7` | Yerelde tutulan en yeni yedek sayısı. Eskiler silinir. |
| `BACKUP_COPY_TO` | boş | `rsync` hedefi: `kullanici@yedek:/yol` (SSH) veya bağlı bir klasör. Yedekle birlikte `.hmac` dosyası da kopyalanır. Hedefteki saklama süresini hedefin kendisi yönetir. |
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

**İmza:** geri yükleme, `DOSYA.hmac` dosyasının yedeğin yanında durmasını, yedeğin **yazıldığı adı** taşımasını ve
`secrets/backup.key`'in yedeği yazan anahtar olmasını ister. Biri tutmazsa `E_RESTORE_SIGNATURE` verir ve hiçbir
şey değişmez. Yedekleri yeniden adlandırmayın; başka bir yere taşırken `.hmac` dosyasını da taşıyın.

**Eski sürümlerin yedekleri** yalnızca `.sha256` taşır; bunu yedek deposuna yazabilen herkes yeniden hesaplayabilir.
Böyle bir yedek imzasız sayılır ve reddedilir (`E_RESTORE_UNSIGNED`). Dosyanın saklandığı yere güveniyorsanız
`--allow-unsigned` ekleyin: sağlama yine denetlenir (`E_RESTORE_CHECKSUM`) ve `W_RESTORE_UNSIGNED` uyarısı yazılır.

```sh
sudo sh scripts/install.sh restore backups/ESKI-YEDEK.tar.enc --allow-unsigned --yes-replace-data
```

**Tek okuma:** arşiv, imzası denetlenmeden ve şifresi çözülmeden önce, kendi adıyla ve imza dosyasıyla birlikte
yalnızca root'un açabildiği bir çalışma klasörüne **kopyalanır**; denetlenen, şifresi çözülen ve açılan yalnızca o
kopyadır. Böylece yedeğin durduğu yere yazabilen biri, denetim ile kullanım arasında dosyayı değiştiremez. Kopya
geçici klasöre (`TMPDIR`, yoksa `/tmp`) yazılır: orada **arşiv boyutunda bir kopyalık daha yer** olmalıdır; yoksa
`E_RESTORE_COPY` verir ve hiçbir şey değişmez. Kopya, geri yükleme nasıl biterse bitsin silinir.

**Onaysız çalıştırma:** komut yalnızca kontrol eder ve neyin değişeceğini söyler, hiçbir şeyi
değiştirmez (çıkış kodu 3). Kontroller:
- imza (eski yedekte `--allow-unsigned` ile sağlama);
- şifre çözme;
- içerik;
- yedeğin bu sürümden yeni olmaması.

**Onaylı çalıştırma** (`--yes-replace-data`), sırasıyla:
1. **Hiçbir şeyi durdurmadan önce denetler:** veritabanı yanıt veriyor mu (`E_RESTORE_DB_DOWN`) ve yedekteki
   döküm `pg_restore` tarafından okunabiliyor mu (`E_RESTORE_DUMP`). Biri tutmazsa hiçbir şey değişmez.
2. **Mevcut verinin yedeğini alır.** Bu yedek alınamazsa geri yükleme yapılmaz (`E_RESTORE_NO_SAFETY`).
   Yedeksiz devam etmek yalnızca açıkça `--no-safety-backup` verilirse mümkündür; o durumda geri yüklemenin
   geri dönüşü yoktur.
3. Uygulama servislerini durdurur.
4. Veritabanını **tamamen** yedektekiyle değiştirir. Eski şemanın silinmesi ve dökümün yüklenmesi **tek bir
   işlemdir (transaction)**: yükleme yarıda kalırsa işlem geri alınır ve veritabanı olduğu gibi kalır.
   Ardından Redis boşaltılır: oradaki kuyruk işleri, kilitler, önbellekler ve tek kullanımlık biletler yeni
   duruma aittir, eski veritabanının üzerinde kalmamalıdır. Hepsi yeniden üretilir.
5. **Herkesin oturumunu kapatır ve paneli beklemeye alır** ([aşağıda](#geri-yüklemeden-sonra-bekletme)). Bu, geri
   yüklenen satırlar üzerinde herhangi bir servis başlamadan önce, tek bir veritabanı işleminde yapılır. Bekletme
   konulamazsa servisler **başlatılmaz** (`E_RESTORE_HOLD`): başlasalar eski duruma göre hemen işlem yaparlardı.
   Aynı `restore` komutunu yeniden çalıştırın.
6. `master.key`, `vmware.token` ve Caddy'nin sertifikalarını geri koyar. VMware parolaları o anahtarla
   şifrelendiği için anahtarlar veriyle birlikte döner.
7. Geçerli `.env`, `alertmanager.yml` ve kendi sertifikanız değiştirilmez. Yedekteki halleri
   `.env.from-backup`, `data/observability/alertmanager.yml.from-backup` ve `data/tls.from-backup/`
   (`cert.pem`, `key.pem`) olarak yazılır.
8. Servisleri başlatır ve sağlığı kontrol eder.
9. Neye bakmanız gerektiğini ve bekletmenin nasıl kaldırılacağını yazar (`RESTORE_SESSIONS`, `RESTORE_HOLD`,
   `RESTORE_CHECK`, `RESTORE_RELEASE`).
10. Yedek başka bir adreste çalışıyorsa (veya kendi sertifikanızı içeriyorsa) çalıştırmanız gereken
   `install.sh domain …` komutunu tam haliyle yazar. Adres ve sertifika modu `.env` içinde durur ve geri
   yükleme `.env` dosyasına dokunmaz; bu adım atlanırsa panel eski adresinde açılmaz.

Geri yükleme öncesi alınan yedek, saklama sayısına (`BACKUP_KEEP`) bakmadan tutulur ve hiçbir eski yedeği
silmez: geri yüklediğiniz dosya en eski yedek olsa bile yerinde kalır.

**Geri yükleme yarıda kalırsa** (hata, Ctrl-C, bağlantının kopması) servisler durmuş bırakılmaz: betik onları
yeniden başlatır ve veritabanının hangi durumda olduğunu yazar (`RESTORE_STATE`):
- veritabanı yüklenemediyse (`E_RESTORE_DB`) **değişmemiştir**, panel önceki veriyle açılır;
- veritabanı yüklendikten sonra kesildiyse veritabanı **yedekteki veridir**, ama anahtarlar ve sertifikalar
  geri konmamış olabilir: aynı `restore` komutunu yeniden çalıştırın.

Yedeğin şifresi çözülmüş geçici kopyası her durumda silinir.

### Geri yüklemeden sonra: bekletme

Geri yüklenen veritabanı; hipervizörlerden, ödeme sağlayıcılarından ve anlattığı kişilerden **eskidir**. Yedekte açık
duran bir işlem, ödenmemiş bir sipariş ya da zamanlanmış bir silme, o günden sonra ödenmiş ve kurulmuş bir sunucuyu
bozabilir. Bu yüzden geri yükleme iki şey yapar:

- **Herkesin oturumunu kapatır.** Yedekten sonra çıkış yapmış biri yeniden girmiş olmaz; herkes yeniden giriş yapar.
- **Paneli beklemeye alır** (`maintenance_state` tablosunda `restore_hold` satırı; yedeğin adı ve zamanıyla).
  Bekletme sürerken panel **kendiliğinden hiçbir şey yapmaz**:
  - worker hiçbir işlemi başlatmaz ve açık kalmış işlemleri yeniden kuyruğa almaz;
  - güç ve snapshot zamanlamaları ve zamanlanmış silmeler çalışmaz;
  - tahsilat çalıştırması (fatura kesme, otomatik tahsilat, hatırlatma, askı, sonlandırma) çalışmaz;
  - tutarlılık denetimi yalnızca **bulgu yazar**, sunucu kayıtlarına dokunmaz;
  - işlem başlatan API rotaları (sipariş, güç, boyut, silme ve benzerleri) `409 RESTORE_HOLD` döner.

  Giriş, sayfaları görüntüleme ve ayarlar çalışır.

**Serbest bırakmadan önce bakın:**

1. **Yedekten sonra oluşturulan ya da silinen sunucular.** Panel onları yedekteki haliyle bilir. Tutarlılık
   denetiminin bulguları (kaydı olmayan `lvm-*` VM, VM'i olmayan sunucu) yönetim panelinde listelenir.
2. **Yedekten sonra yapılan ödemeler.** Geri yüklenen veride yoktur: ödeme sağlayıcınızın kayıtlarıyla karşılaştırıp
   kaydedin; yoksa ödenen sipariş ve faturalar ödenmemiş sayılır ve tahsilat adımlarına girer.
3. **Yedekten sonra silinen API anahtarları, yasaklar, kapatılan hesaplar, rol ve parola değişiklikleri.** Hepsi
   yedek anındaki haline döner: silinen anahtar yeniden geçerlidir, kaldırılan yasak geri gelmiştir. Yeniden silin,
   yasaklayın, değiştirin. (Oturumlar kapatılır, API anahtarları kapatılmaz.)

**Serbest bırakma:** Yönetim → Sistem sayfasındaki şeritte **Serbest bırak** (`system.update` izni) ya da sunucuda:

```sh
docker compose exec api node dist/cli.js release-restore-hold
```

Serbest bırakma denetim kaydına `system.restore_hold_released` olarak yazılır. Ardından açık işlemler yeniden kuyruğa
alınır; zamanlamalar ve tahsilat sıradaki çalıştırmada devam eder.

**`--no-hold`:** yalnızca bekletmeyi atlar; oturumlar yine kapatılır. Az önce alınmış bir yedeği geri yüklerken
kullanın. Betik `W_RESTORE_NO_HOLD` uyarısını ve aynı kontrol listesini yazar; panel geri yüklenen duruma göre
**hemen** işlem yapar.

```sh
sudo sh scripts/install.sh restore backups/DOSYA.tar.enc --yes-replace-data --no-hold
```

**Bekletmeden önceki sürümlerin yedekleri:** yedekteki şemada bekletme tablosu yoksa betik önce şemayı günceller
(`migrate` servisi; servisler başlarken zaten yapılacak iş) ve sonra bekletmeyi koyar. Bu da olmazsa servisler
başlatılmaz (`E_RESTORE_HOLD`).

**Yeni sunucuya taşıma:**
1. Yeni sunucuda `sh scripts/install.sh` ile kurun.
2. Sakladığınız `backup.key` dosyasını `secrets/backup.key` olarak kopyalayın (kurulumun ürettiği yeni
   anahtarın yerine; izinler `chmod 400`). Yedek dosyasını ve `.hmac` dosyasını da (adlarını değiştirmeden) sunucuya getirin; imza bu anahtarla doğrulanır.
3. `restore … --yes-replace-data` çalıştırın. Panel beklemede açılır; yukarıdaki listeye bakıp serbest bırakın.
4. DNS kaydını yeni sunucuya çevirin ve geri yüklemenin yazdığı komutu çalıştırın, örneğin:
   ```sh
   sudo sh scripts/install.sh domain panel.example.com
   ```
   Kendi sertifikanızı kullanıyorsanız komut `--tls custom --cert data/tls.from-backup/cert.pem
   --key data/tls.from-backup/key.pem` ile birlikte yazılır.
5. Diğer ayarları (`BACKUP_COPY_TO`, `UPDATE_CHANNEL` gibi) `.env.from-backup` dosyasından `.env`
   içine kendiniz taşıyın; parolalar (`POSTGRES_PASSWORD` gibi) yeni kurulumunkiler olarak kalmalıdır.

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
4. Yedek alır. Yedek alınamazsa güncelleme yapılmaz. Yedek sırasında veritabanı, `.env` ve anahtarlar
   `backups/.work-<pid>` altında kısa süre şifresiz durur; bu klasör yedek nasıl biterse bitsin (hata,
   Ctrl-C) silinir, önceki bir çökmeden kalanı da bir sonraki yedeğin başında silinir.
5. **İşleri boşaltır:** worker'ı durdurur. Çalışan adımın bitmesi için en çok 120 sn bekler.
6. Yeni sürüme geçer. Migration'lar `migrate` servisinde çalışır. Ardından servislerin ve
   `/api/ready`'nin sağlığını kontrol eder.
7. **Başarısızlıkta:**
   - yeni sürümün kaynağına geçilemezse (`E_UPDATE_CHECKOUT`, örneğin disk dolu) önceki sürüme dönülür ve
     durdurulan worker yeniden başlatılır; veritabanı değişmemiştir;
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
- Zamanlayıcı saat başlarında çalışır (en çok 5 dakika rastgele gecikmeyle). Bu yüzden pencere bir saat
  başını ve ardından gelen 10 dakikayı içermelidir: `03:30-04:00` gibi hiç çalışmayacak bir pencere
  `E_WINDOW_NEVER` ile reddedilir (`03:30-04:15` kabul edilir).
- Otomatik güncelleme başarısız olan bir sürümü her saat yeniden denemez: aynı sürüm için bekler
  (`UPDATE_SKIPPED`), yeni bir sürüm çıkınca ya da siz elle `update` çalıştırınca yeniden dener.
- Aynı anda tek bakım işi çalışır. Elle başlatılan `backup`, `update` ve `restore`, zamanlayıcı ve panel
  istekleriyle aynı kilidi (`data/maintenance/.lock`) kullanır; biri çalışırken diğeri bekler.
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

## Kaldırma
```sh
sudo sh scripts/install.sh uninstall
```
```sh
sudo sh scripts/install.sh uninstall --purge-data
```

`uninstall`:
- zamanlayıcıyı ve panel ajanını kapatır, systemd birimlerini siler;
- betiğin proje klasörü dışına yazdığı dosyaları siler: `/etc/systemd/timesyncd.conf.d/lightning-vm.conf`,
  `/etc/systemd/resolved.conf.d/lightning-vm.conf`, `/etc/apt/apt.conf.d/52lightning-vm-auto`,
  cloud-init eklentisi (`cloud-init-hotplugd.service.d/10-lightning-vm.conf`) ve saklanan git erişim anahtarı
  (`/root/.lightning-vm-git-credentials`);
- container'ları durdurur ve kaldırır (izleme ve terminal dahil).

**Kalanlar:** `.env`, `secrets/` (yedek anahtarı dahil), `backups/`, `data/`, kaynak kodu ve Docker veri
birimleri (veritabanı, sertifikalar). `sh scripts/install.sh` ile kurulum aynı veriyle geri gelir.
Docker Engine, sunucu adı, saat dilimi ve `/etc/hosts` satırına dokunulmaz.

`--purge-data` Docker veri birimlerini de **geri dönüşsüz** siler (veritabanı, Caddy sertifikaları, izleme
verisi). `.env`, `secrets/` ve `backups/` yine kalır; tamamen silmek için proje klasörünü kendiniz silin.
Önce bir yedek alıp `backup.key` ile birlikte sunucu dışına kopyalayın.

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
- **Maskeleme:** API'nin istek günlüğü başlık yazmaz ve URL'de taşınan sırları (parola sıfırlama belirteci, giriş
  bağlantısının `token` değeri, SSO dönüşünün `code` ve `state` değerleri, ödeme dönüşünün `session_id` değeri)
  `***` ile yazar. Aynı maske üç yerde daha uygulanır: proxy'nin erişim günlüğünde (`deploy/caddy/Caddyfile`;
  istek adresi, `Referer` ve `Location`; CAPTCHA yanıtı başlığı hiç yazılmaz), Collector'da
  (`deploy/observability/otel.yaml`; ayrıca `password`/`token`/`secret`/`cookie`/`ticket`/`authorization`
  değerleri) ve panelin Yönetim → Sistem için aldığı günlük kopyalarında (`install.sh`). Kural değişikliği için
  proxy ve Collector yeniden başlatılmalıdır (`docker compose restart proxy`,
  `docker compose --profile observability restart otel`); daha önce saklanmış satırlar yeniden yazılmaz.
- **Kim görür:** Yönetim → Sistem'deki servis günlüklerini yalnızca yöneticiler (`*`) görür.
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
