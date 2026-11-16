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

Proxmox panel sunucusuyla aynı yerel ağdaysa adaptörün o ağa erişmesine izin verin (`.env`):

```bash
PROXMOX_ALLOW_NETWORKS=10.20.0.0/16
```

## Panel Proxmox'u nasıl görür

| Panelde | Proxmox'ta |
|---|---|
| Host ve işlem kaynağı | Düğüm (her düğüm ayrı bir kaynak; konum bir düğümü gösterir) |
| Veri deposu | Disk imajı ya da ISO tutabilen depolama; paylaşımlı depolama tek kayıt, yerel depolama `ad@düğüm` |
| Ağ | Köprü (`vmbr0`…) |
| Şablon imajı | Şablona çevrilmiş VM |
| Sunucu | `lvm-<sunucu kimliği>` adlı VM |

## Şablon hazırlama

- VM'i **şablona çevirin** (Convert to template).
- İçinde **cloud-init** kurulu olsun. Şablonda cloud-init sürücüsü yoksa panel, ilk kurulumda sistem diskinin
  deposuna bir tane ekler.
- **QEMU guest agent** kurulu ve VM ayarlarında açık olsun: panel sunucunun hazır olduğunu ve IP adreslerini
  ondan öğrenir. Agent kapalıysa çalışan sunucu, cloud-init'e verilen adreslerle hazır sayılır.

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

Proxmox'un kendi cloud-init'i şunları taşıyamaz, bu yüzden Proxmox sunucularında uygulanmaz:

- Sipariş sırasında verilen **root parolası** (yalnız SSH anahtarları gider)
- **Uygulama kurulumu** (cPanel, Plesk…) ve **güncelleme bildiricisinin kendiliğinden kurulumu**
- Birden fazla IPv4 adresi (yalnız ilki yapılandırılır)
- Sunucu adı: Proxmox, misafire VM adını (`lvm-…`) verir

Ölçümler Proxmox'ta dakikada bir tutulur (VMware'de 20 saniye); host güç tüketimi ölçülmez, tahmin edilir.
