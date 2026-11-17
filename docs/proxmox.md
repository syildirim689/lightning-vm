# Proxmox VE

Panel, VMware'in yanında **Proxmox VE** düğümlerini ve kümelerini de yönetir. Bağlantı, katalog, sipariş ve
sunucu sayfaları aynıdır; arkada yalnızca farklı bir adaptör (`services/proxmox`) çalışır. Adaptör, VMware
adaptörüyle aynı sözleşmeyi konuşur: [adapter-contract.md](adapter-contract.md).

> [!WARNING]
> Proxmox desteği **ilk sürümdür**. Adaptör, Proxmox API'sinin davranışını taklit eden testlerle sınandı;
> **gerçek bir Proxmox VE sunucusunda henüz denenmedi.** Üretimde kullanmadan önce bir test düğümünde deneyin.

## Bağlantı eklemek

Yönetim → Bağlantılar → Yeni bağlantı → **Proxmox VE**.

| Alan | Değer |
|---|---|
| Adres | Web arayüzünün adresi (kümede herhangi bir düğüm) |
| Port | `8006` (varsayılan) |
| Kullanıcı | `root@pam` gibi alanıyla birlikte kullanıcı, ya da API anahtarı: `kullanici@pve!anahtar-adi` |
| Parola | Kullanıcının parolası; API anahtarında anahtarın gizli değeri |
| Sertifika | Sistem CA'ları, verilen CA ya da sabit parmak izi (kendinden imzalı sertifika için) |

Parmak izini düğümde şu komutla karşılaştırın:

```bash
openssl x509 -in /etc/pve/local/pve-ssl.pem -noout -fingerprint -sha256
```

Önerilen: panel için ayrı bir kullanıcı ve **yetki ayrımı kapalı** bir API anahtarı. Gereken yetkiler
(`/` yolunda): `VM.Allocate`, `VM.Clone`, `VM.Config.CPU`, `VM.Config.Memory`, `VM.Config.Disk`,
`VM.Config.Network`, `VM.Config.Cloudinit`, `VM.PowerMgmt`, `VM.Snapshot`, `VM.Audit`, `Datastore.AllocateSpace`,
`Datastore.Audit`, `Sys.Audit`.

Konuk aracına (guest agent) sormak için ayrıca: **Proxmox VE 8 ve öncesinde** `VM.Monitor`; **Proxmox VE 9'da** bu
yetki kaldırıldı, yerine `VM.GuestAgent.*` yetkileri gelir (panel `VM.GuestAgent.Unrestricted` yetkisine bakar). Bu
yetki yoksa bağlantı sayfasında uyarı görünür: panel sunucunun adreslerini okuyamaz, root parolasını, sunucu adını
ve ilk açılış komutlarını uygulayamaz.

Adaptör varsayılan olarak loopback ve bağlantı-yerel adresleri, ayrıca **kendi Docker ağlarındaki** adresleri
reddeder (panelin PostgreSQL, Redis ve API'si o ağlardadır; hata `ENDPOINT_BLOCKED`). Proxmox böyle bir ağdaysa o
ağa izin verin (`.env`):

```bash
PROXMOX_ALLOW_NETWORKS=10.20.0.0/16
```

Hiç bağlanılmaması gereken ağlar için `PROXMOX_DENY_NETWORKS` vardır (virgülle ayrılmış CIDR'ler; izin listesi
yasak listesinin önüne geçer).

## Panel Proxmox'u nasıl görür

| Panelde | Proxmox'ta |
|---|---|
| Host ve işlem kaynağı | Düğüm (her düğüm ayrı bir kaynak; konum bir düğümü gösterir) |
| Veri deposu | Disk imajı ya da ISO tutabilen depolama; paylaşımlı depolama tek kayıt, yerel depolama `ad@düğüm` |
| Ağ | Köprü (`vmbr0`…) |
| Şablon imajı | Şablona çevrilmiş VM |
| Sunucu | `lvm-<sunucu kimliği>` adlı VM |

## VM numaraları ve sunucu kimliği

Proxmox bir VM'i numarasıyla (VMID) tanır ve **boşalan numarayı sonraki VM'e yeniden verir**. Panel sunucunun
numarasını saklar; numara tek başına, zaman içinde başka bir VM'i, hatta başka bir müşterinin sunucusunu gösterebilir
(VM düğümde silinip başka numarayla geri getirildiyse, ya da panelin veritabanı bir yeniden kurulumdan eski bir
yedekten geri yüklendiyse). Bu yüzden:

- **Her istek beklenen adı taşır.** Panel bir sunucu için yaptığı her çağrıda (güç, snapshot, ayrıntılar, ölçümler,
  boyut, disk, silme, guest agent işlemleri) VM'in taşıması gereken adı (`lvm-<sunucu kimliği>`) gönderir. Kayıtlı
  numaradaki VM başka bir ad taşıyorsa adaptör hiçbir şeyi okumadan ve değiştirmeden `409 VM_MISMATCH` döner; işlem
  kalıcı hatayla biter.
- **İmajdan sipariş yalnızca şablondan kopyalar.** İmajın gösterdiği numarada bir şablon yoksa (şablon silinmiş ve
  numarasını sıradan bir VM almış olabilir) oluşturma `TEMPLATE_NOT_FOUND` ile başarısız olur. Bir sunucunun kopyası
  çıkarılırken kaynak VM'in adı da aynı şekilde denetlenir.
- **Tutarlılık denetimi numarayı yeniden bağlar.** Denetim sunucunun adını (`lvm-<sunucu kimliği>`) başka bir numara
  altında bulursa kaydı o numaraya çeker ve `vm_id_changed` bulgusu yazar; sunucu ancak bundan sonra yeniden "hazır"
  sayılır. Kaydı elle düzeltmek gerekmez.

`VM_MISMATCH` görürseniz: tutarlılık denetimini çalıştırın (Yönetim → Sunucular; kendiliğinden beş dakikada bir
çalışır) ve işlemi yeniden deneyin. Şablonunu sildiğiniz bir imajı katalogdan da kaldırın ya da yeni şablona
bağlayın. **Şablonları yüksek numaralarda tutmak** (örneğin 9000 ve üzeri) numaranın yeniden kullanılma olasılığını
azaltır. Bu davranış Proxmox API'sini taklit eden testlerle sınandı; gerçek bir kümede denenmedi.

## Şablon hazırlama

- VM'i **şablona çevirin** (Convert to template).
- İçinde **cloud-init** kurulu olsun. Şablonda cloud-init sürücüsü yoksa panel, ilk kurulumda sistem diskinin
  deposuna bir tane ekler.
- **QEMU guest agent** kurulu ve VM ayarlarında açık olsun: panel sunucunun hazır olduğunu ve IP adreslerini
  ondan öğrenir. Agent kapalıysa çalışan sunucu, cloud-init'e verilen adreslerle hazır sayılır.
  Agent açık ama yanıt vermiyorsa (imajda kurulu değil ya da hesabın yetkisi yok) sunucu, açıldıktan **dört dakika
  sonra** aynı adreslerle hazır sayılır.

## Bu sürümde çalışanlar

Keşif ve kapasite · şablondan sunucu oluşturma (CPU, bellek, disk, ağ, IPv4/IPv6, DNS, SSH anahtarları) ·
açma / kapatma / yeniden başlatma / temiz kapatma · silme · boyut değiştirme · anlık görüntü alma, geri dönme,
silme · ek disk ekleme ve kaldırma · mevcut VM'i devralma · sunucu ayrıntıları ve grafikler · topoloji ·
trafik sayımı · tutarlılık denetimi.

## Henüz olmayanlar

Bu işlemler Proxmox bağlantılarında "henüz desteklenmiyor" yanıtı verir:

- Tarayıcı konsolu (noVNC geçidi gerekiyor)
- Firewall kuralları ve hız sınırlama
- Yedekleme ve geri yükleme, kişisel imaj oluşturma
- ISO kitaplığı ve CD takma, özel ağlar, canlı taşıma
- Ağ taraması ile Proxmox düğümlerini bulma

Proxmox'un kendi cloud-init'i yalnızca ağı ve SSH anahtarlarını taşır. Geri kalanı panel, sunucu açıldıktan sonra
**guest agent üzerinden** bir kez uygular:

- Siparişte verilen **root parolası** (özet olarak verilir, düz metin olarak hiçbir yere yazılmaz)
- **Sunucu adı**
- **Uygulama kurulumu** (cPanel, Plesk…) ve **güncelleme bildiricisinin kendiliğinden kurulumu**

Bu yüzden şablonda guest agent şart: agent yoksa sunucu yine kurulur ama bu üçü uygulanmaz.

Ayrıca:

- **Ek adresler:** sunucunun içinde yalnızca ilk IPv4 ve ilk IPv6 adresi yapılandırılır (Proxmox'un `ipconfig0`
  alanı birer adres taşır). Siparişte daha fazla adres varsa panel bunu işlemin üzerine uyarı olarak kaydeder
  (Yönetim → Sunucular → İşlemler, `EXTRA_ADDRESSES_NOT_CONFIGURED`); diğer adresleri sunucunun içinden ekleyin.
- **Başka düğüme kopya:** yerel depolamadaki bir şablondan başka bir düğümde sunucu oluşturulamaz (Proxmox düğümler
  arası kopyayı yalnızca paylaşımlı depolamadan paylaşımlı depolamaya yapar). Oluşturma, nedeni söyleyen açık bir
  iletiyle hemen başarısız olur; şablonu ve hedefi paylaşımlı depolamaya alın ya da şablonun bir kopyasını hedef
  düğümde tutun.
- **Çalışan sunucudan disk kaldırma** disk hotplug ister (VM ayarlarında Hotplug → Disk açık, disk SCSI ya da
  VirtIO yuvasında). Hotplug yoksa disk takılı kalır ve işlem "sunucuyu durdurup yeniden kaldırın" iletisiyle
  başarısız olur.

Ölçümler Proxmox'ta dakikada bir tutulur (VMware'de 20 saniye); host güç tüketimi ölçülmez, tahmin edilir.
