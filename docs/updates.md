# Kurulum ve güncelleme

> Kurulu bir sunucuyu yükseltmeden önce [upgrade-notes.md](upgrade-notes.md) sayfasını okuyun: değişen davranışlar,
> mevcut veriye etkileri ve kimlerin etkileneceğini gösteren sorgular oradadır.

## Yeni bir sunucuya kurulum (tek komut)
`scripts/get.sh`:
- kaynağı git ile indirir;
- en son kararlı sürüme (`vX.Y.Z` etiketi) geçer;
- `scripts/install.sh` ile kurar (Docker, HTTPS, yönetici, yedek, panel ajanı).

Kaynak git kopyası olduğu için kurulum daha sonra kendini güncelleyebilir.

```sh
# Depo herkese açıksa
curl -fsSL https://raw.githubusercontent.com/syildirim689/lightning-vm/main/scripts/get.sh | sudo sh

# Özel depo: salt-okunur bir erişim anahtarıyla (fine-grained token, yalnızca "Contents: read").
# Anahtar komut satırına yazılmaz: ortam değişkeninden okunur ve sudo yalnızca onu geçirir.
export GIT_TOKEN   # değeri önceden, ekrana yazdırmadan atayın: read -rs GIT_TOKEN
curl -fsSL -H "Authorization: Bearer $GIT_TOKEN" https://raw.githubusercontent.com/syildirim689/lightning-vm/main/scripts/get.sh \
  | sudo --preserve-env=GIT_TOKEN sh

# Ya da anahtarı yalnızca root'un okuyabildiği bir dosyadan (ilk satırı okunur):
sudo sh get.sh --token-file /root/lvm-token

# Seçenekler
sudo sh get.sh --version v1.2.0                                # belirli bir sürüm
sudo sh get.sh --branch main                                   # test sunucusu: daldaki her değişikliği izler (edge)
sudo sh get.sh --repo git@github.com:ORG/lightning-vm.git      # SSH deploy key ile
sudo sh get.sh -- --domain panel.example.com --lang tr         # "--" sonrası install.sh seçenekleri
```

- **Erişim anahtarı:** `/root/.lightning-vm-git-credentials` dosyasında (izin 600) saklanır. Uzak depo adresine
  yazılmaz; sonraki güncellemeler bu dosyayı kullanır. Anahtarı `--token-file DOSYA` ile ya da `GIT_TOKEN` ortam
  değişkeniyle (`sudo --preserve-env=GIT_TOKEN sh`) verin; betik değişkeni başlattığı git, apt ve kurulum
  süreçlerine aktarmaz. `--token ANAHTAR` hâlâ çalışır, ama anahtar kurulum boyunca süreç listesinde (`ps`)
  sunucudaki her hesaba görünür; eski `sudo GIT_TOKEN="…" sh` biçimi de anahtarı sudo'nun komut satırına yazar.
  İkisini de kullanmayın. `curl` satırındaki `Authorization` başlığı da indirme süresince süreç listesinde görünür;
  sunucuda başka kabuk hesabı varsa betiği dosyaya indirip `--token-file` ile çalıştırın.
- **SSH deploy key:** root'un SSH anahtarı depoya salt-okunur deploy key olarak eklenir.
- **Varsayılan dizin:** `/opt/lightning-vm`.
- **Tekrar çalıştırma:** aynı komut kurulu bir sunucuda yeniden kurulum yapmaz, ne yaptığı duruma bağlıdır:
  - **Kurulum tamamlanmışsa** (`.env` ve `data/maintenance/history.jsonl` var): sürümleri çeker ve
    `install.sh update` çalıştırır. Yani önce yedek alınır, uyumluluk denetlenir, yeni sürüm hazır olmazsa
    önceki sürüme dönülür. `--version vX.Y.Z` verilirse `update --to vX.Y.Z` çalışır. Sunucunun güncelleme
    kanalı (`UPDATE_CHANNEL`, `UPDATE_BRANCH`) **değiştirilmez**; `--branch` bu durumda uygulanmaz (kanalı
    değiştirmek için: `install.sh auto-update on|off --channel … --branch …`). `--` sonrasındaki
    seçeneklerden yalnızca `--lang` kullanılır.
  - **Kurulum yarıda kalmışsa** (`.env` var, geçmiş yok) ve sürüm ya da dal verilmediyse: başlanan sürümle
    kaldığı yerden sürer.
  - **Kurulum yoksa:** yukarıdaki gibi sıfırdan kurar.

## Panelden güncelleme
Konum: Yönetim → Sistem → **Güncellemeler** (`system.update` izni).

- **Güncellemeleri denetle:** sürümleri çeker ve listeler; açıklamalar etiket notlarından gelir.
- **Şimdi güncelle:** komut satırıyla aynı güvenli akışı çalıştırır.
  1. Şifreli yedek alınır. Yedek alınamazsa hiçbir şey değişmez.
  2. Worker durdurulur; çalışan adımın bitmesi en çok 120 sn beklenir.
  3. Yeni sürüm derlenip başlatılır ve sağlık kontrolü yapılır.
  4. Yeni sürüm hazır olmazsa önceki sürüm otomatik olarak geri gelir.
  5. Veritabanı otomatik geri alınmaz. Gerekirse komut, adıyla birlikte kayıtta yazılır:
     `restore <yedek> --yes-replace-data`. Geri yükleme herkesin oturumunu kapatır ve paneli beklemeye alır; az önce
     alınmış bu yedek için bekletme gerekmiyorsa `--no-hold` ekleyin
     ([operations.md](operations.md#geri-yüklemeden-sonra-bekletme)).
- **Bu sürüme geç:** listedeki belirli bir sürüme geçer. Veritabanı daha yeni bir sürümce değiştirildiyse
  eski sürüme dönüş reddedilir.
- **Şimdi yedekle** ve **otomatik güncelleme** ayarları (açık/kapalı, kanal, bakım penceresi).
- **İlerleme:** canlı kayıt satırları gösterilir. Güncelleme sırasında panel yeniden başlar; sayfa denemeye
  devam eder ve yeni sürüm çalışınca bildirir.

### Nasıl çalışır
Panel sunucuda doğrudan hiçbir şey çalıştıramaz; Docker soketi de verilmez. Akış:
1. API, `data/maintenance-requests/<id>.req` dosyasına birkaç `anahtar=değer` satırı yazar. Bu dizin yalnızca
   API kullanıcısı (uid 1000) ve root tarafından yazılabilir.
2. Kurulumun eklediği systemd path birimi `lightning-vm-requests.path` dosyayı görür ve
   `install.sh run-requests` komutunu çalıştırır.
3. `run-requests` isteği **yeniden doğrular**. Yalnızca aşağıdaki işlemler kabul edilir; listede olmayan
   her istek reddedilir (`E_REQUEST_INVALID`):

   | İstek | Çalışan komut | Denetlenen değerler |
   |---|---|---|
   | `check` | `releases` | — |
   | `update` | `update [--to …]` | sürüm: `vX.Y.Z[-ek]` ya da commit kimliği |
   | `backup` | `backup` | — |
   | `auto-update` | `auto-update on\|off [--channel …] [--window …]` | kanal: `stable`/`beta`/`edge`; pencere: `SS:DD-SS:DD` |
   | `domain` | `domain ALAN_ADI [--tls staging\|custom …]` | alan adı kalıbı; `custom` için sertifika ve anahtar dosyaları (boyut sınırlı, yalnızca normal dosya) |
   | `host` | `host [--hostname] [--timezone] [--ntp] [--dns]` | sunucu adı, saat dilimi, en çok 4 NTP/DNS sunucusu |
   | `monitoring`, `terminal` | `monitoring on\|off`, `terminal on\|off` | yalnızca `on`/`off` |
   | `os` | `os check\|upgrade\|security\|reboot\|auto-on\|auto-off` | yalnızca bu altı eylem |
   | `state` | `state` | — |

   Yani panel, ajan üzerinden bu sunucunun alan adını ve sertifikasını, adını, saatini, DNS'ini
   değiştirebilir, işletim sistemi güncellemelerini kurabilir, sunucuyu yeniden başlatabilir ve yönetici
   terminalini açabilir. Ajanı kapatmak (`agent off`) bunların hepsini panelden kullanılamaz kılar.
4. Sonuçlar `data/maintenance` dizinine yazılır. Panel bu dizini yalnızca okuyabilir. Host durumu dosyaları ve
   istek kayıtları `root:1000`, izin `640`; kilit dosyası (`.lock`) `600`. Dizin root'un olmalıdır; değilse betik onu
   devralır (`W_MAINT_DIR`). Durum dosyaları geçici bir adla oluşturulup yerine taşınır; isteğin günlüğü her istekte
   yeniden ve başkasına kapalı açılır, açılamazsa istek `E_REQUEST_LOG` ile başarısız olur
   ([operations.md](operations.md#bakım-dizini-ve-kilit)).
   - `status.json`: işin durumu;
   - `runs/<id>.log`: ilerleme satırları;
   - `releases.json`: sürüm listesi;
   - `history.jsonl`: geçmiş.
5. Zamanlanmış bakım, panel istekleri ve elle başlatılan `backup`/`update`/`restore` aynı kilidi kullanır;
   aynı anda yalnızca biri çalışır. Kilit alınamazsa panel istekleri çalıştırılmaz (`E_LOCK`).

Eski kurulumlarda ajanı bir kez açın: `sudo sh scripts/install.sh agent on`.

## Kanallar
| Kanal | İzlediği |
|---|---|
| `stable` | Yalnızca yayımlanmış sürümler (`vX.Y.Z`) |
| `beta` | Ön sürümler de (`vX.Y.Z-rc.1`) |
| `edge` | `UPDATE_BRANCH` dalındaki her değişiklik; test sunucuları içindir, sürüm değildir |

Sürüm yayımlamak: `git tag -a v1.2.0 -m "notlar"` ve `git push --tags`. Panel notları etiketten gösterir.

## Komut satırı
```sh
sh scripts/install.sh releases                                  # sürümleri denetle
sh scripts/install.sh update [--to v1.2.0]                      # güncelle
sh scripts/install.sh auto-update on --channel stable --window 03:00-05:00
sudo sh scripts/install.sh agent on|off                         # panel ajanı
sudo sh scripts/install.sh schedule on|off                      # saatlik bakım (yedek + otomatik güncelleme)
```

## Bu sunucunun ayarları (Yönetim → Sistem → Bu sunucu)
Panelin çalıştığı makinenin adı (hostname), saat dilimi, zaman sunucuları (NTP) ve DNS sunucuları panelden
değiştirilir. Panel yalnızca istek bırakır; ajan (`scripts/install.sh host`) değerleri yeniden denetler ve
`hostnamectl`, `timedatectl`, systemd-timesyncd (`/etc/systemd/timesyncd.conf.d/lightning-vm.conf`) ve
systemd-resolved (`/etc/systemd/resolved.conf.d/lightning-vm.conf`) ile uygular; yeni ad `/etc/hosts` içinde
`127.0.1.1` satırına da yazılır. "default" (boş alan) zaman/DNS listesini dağıtımın varsayılanına döndürür.
Sonra `data/maintenance/host.json` dosyasına güncel bilgiler (saat, NTP eşitlemesi, işletim sistemi, çekirdek,
çalışma süresi) yazılır; sayfa sunucu saatini ve bilgisayarınızla farkını gösterir. chrony/ntpd ya da
systemd-resolved olmayan sunucularda ilgili alan uygulanmaz ve nedeni yazılır.
Elle: `sudo sh scripts/install.sh host --hostname panel.example.com --timezone Europe/Istanbul --ntp time.cloudflare.com --dns 1.1.1.1,9.9.9.9`
