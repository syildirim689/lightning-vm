# ISO kütüphanesi

Yönetici ISO dosyalarının durduğu depoları bağlar, içlerinde gezinir ve seçtiği ISO'yu bir ya da birden
fazla konumun datastore'una kopyalar. Müşteri hazır ISO'yu sunucusunun CD-ROM'una takar, isterse ISO'dan
başlatır, sonra çıkarır.

## Desteklenen depolar

| Protokol | Not |
|---|---|
| FTP / FTPS | Açık TLS (FTPES, AUTH TLS) veya örtük TLS (genelde 990) |
| SFTP | Parola veya PEM özel anahtar |
| WebDAV | Nextcloud, ownCloud, NAS, her WebDAV sunucusu |
| S3 uyumlu | MinIO, Ceph, Wasabi, Cloudflare R2, AWS S3… Kök klasör = `kova/önek` |
| SMB / CIFS | Windows, Samba, NAS. Kök klasör = `paylaşım/klasör` |
| HTTP | Dizin listelemesi açık adres (yalnız okuma, dağıtım aynaları) |

Erişim worker kapsayıcısındaki **rclone** ile yapılır. Depo ayarları rclone seçenekleri olarak saklanır;
parolalar ve gizli anahtarlar şifrelenir (`iso-source:<id>` bağlamı), API yanıtlarında hiç dönmez
(yalnızca "kayıtlı" bilgisi). rclone'a yapılandırma dosyası yerine `RCLONE_CONFIG_SRC_*` ortam
değişkenleriyle verilir; komut satırında gizli bilgi bulunmaz.

## Akış

1. **Depo bağla** → *Bağlantıyı test et*: worker kök klasörü listeler (API en fazla 45 sn bekler).
2. **Gözat**: klasör klasör; yalnızca alt klasörler ve `.iso` dosyaları gösterilir.
3. **Kopyala**: konum(lar) seçilir. Her konuma ayrı kopya yapılır (konumun ilk datastore'u,
   `[datastore] lightning-iso/<ad>.iso`). `rclone cat` → worker → VMware adaptörü → vCenter `/folder`
   akış olarak aktarılır; dosya hiçbir yerde ara diske yazılmaz. İlerleme 3 sn'de bir kaydedilir,
   bayt sayısı eşleşmezse kopya başarısız sayılır. Sonuç yöneticilere bildirilir
   (`admin.iso_ready`, `admin.iso_failed`).
4. **Silme**: takılı olduğu sunucu varsa reddedilir; kopyalama sürerken silinirse kopya durur.

## Müşteri tarafı

Sunucu sayfası → *ISO / CD-ROM*: sunucunun konumundaki hazır ve "müşteriler kullanabilsin" işaretli
ISO'lar listelenir. Takarken *ISO'dan başlat* seçilirse önyükleme sırası CD-ROM → disk olur (yeniden
başlatınca etkili); çıkarınca varsayılan sıraya döner. CD-ROM sürücüsü yoksa IDE denetleyicisine eklenir.
Adaptör yalnızca bu platformun oluşturduğu (`lvm-`) VM'lere dokunur.

## Sınırlar

- Tarayıcıdan doğrudan dosya yükleme yok; dosya bir depodan (gerekirse HTTP adresinden) alınır.
- HTTP deposu dosya boyutunu bildirmezse kopyalanamaz (`ISO_SIZE_UNKNOWN`).
- Yükleme vCenter üzerinden yapılır (ESXi'ye servis biletiyle doğrudan değil); büyük ISO'larda
  vCenter ağ hızı belirleyicidir.
