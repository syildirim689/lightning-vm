# Kurulum ve güncelleme

## Yeni bir sunucuya kurulum (tek komut)
`scripts/get.sh`:
- kaynağı git ile indirir;
- en son kararlı sürüme (`vX.Y.Z` etiketi) geçer;
- `scripts/install.sh` ile kurar (Docker, HTTPS, yönetici, yedek, panel ajanı).

Kaynak git kopyası olduğu için kurulum daha sonra kendini güncelleyebilir.

```sh
# Depo herkese açıksa
curl -fsSL https://raw.githubusercontent.com/syildirim689/lightning-vm/main/scripts/get.sh | sudo sh

# Özel depo: salt-okunur bir erişim anahtarıyla (fine-grained token, yalnızca "Contents: read")
curl -fsSL -H "Authorization: Bearer $TOKEN" https://raw.githubusercontent.com/syildirim689/lightning-vm/main/scripts/get.sh \
  | sudo GIT_TOKEN="$TOKEN" sh

# Seçenekler
sudo sh get.sh --version v1.2.0                                # belirli bir sürüm
sudo sh get.sh --branch main                                   # test sunucusu: daldaki her değişikliği izler (edge)
sudo sh get.sh --repo git@github.com:ORG/lightning-vm.git      # SSH deploy key ile
sudo sh get.sh -- --domain panel.example.com --lang tr         # "--" sonrası install.sh seçenekleri
```

- **Erişim anahtarı:** `/root/.lightning-vm-git-credentials` dosyasında (izin 600) saklanır. Uzak depo adresine
  yazılmaz; sonraki güncellemeler bu dosyayı kullanır.
- **SSH deploy key:** root'un SSH anahtarı depoya salt-okunur deploy key olarak eklenir.
- **Varsayılan dizin:** `/opt/lightning-vm`.
- **Tekrar çalıştırma:** aynı komut güvenlidir. Kaynak güncellenir ve kurulum kaldığı yerden sürer.

## Panelden güncelleme
Konum: Yönetim → Sistem → **Güncellemeler** (`system.update` izni).

- **Güncellemeleri denetle:** sürümleri çeker ve listeler; açıklamalar etiket notlarından gelir.
- **Şimdi güncelle:** komut satırıyla aynı güvenli akışı çalıştırır.
  1. Şifreli yedek alınır. Yedek alınamazsa hiçbir şey değişmez.
  2. Worker durdurulur; çalışan adımın bitmesi en çok 120 sn beklenir.
  3. Yeni sürüm derlenip başlatılır ve sağlık kontrolü yapılır.
  4. Yeni sürüm hazır olmazsa önceki sürüm otomatik olarak geri gelir.
  5. Veritabanı otomatik geri alınmaz. Gerekirse komut, adıyla birlikte kayıtta yazılır:
     `restore <yedek> --yes-replace-data`.
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
3. `run-requests` isteği **yeniden doğrular**:
   - yalnızca `check`, `update`, `backup` ve `auto-update` işlemleri kabul edilir;
   - sürüm, kanal ve pencere değerleri sıkı kalıplarla kontrol edilir.
   Sonra `install.sh` komutunu çalıştırır.
4. Sonuçlar `data/maintenance` dizinine yazılır. Panel bu dizini yalnızca okuyabilir.
   - `status.json`: işin durumu;
   - `runs/<id>.log`: ilerleme satırları;
   - `releases.json`: sürüm listesi;
   - `history.jsonl`: geçmiş.
5. Zamanlanmış bakım ile panel istekleri aynı kilidi kullanır; ikisi aynı anda çalışmaz.

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
