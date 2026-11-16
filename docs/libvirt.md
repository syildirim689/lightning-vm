# KVM (libvirt)

Panel; VMware, Proxmox VE, XCP-ng, oVirt, Hyper-V ve [Incus](incus.md)'un yanında, üzerinde yalnızca **libvirt ve QEMU/KVM** kurulu
düz bir Linux hostu da yönetir: vCenter, Proxmox ya da başka bir yönetim katmanı gerekmez. Adaptör
(`services/libvirt`) hosta **SSH** ile bağlanıp `virsh` çalıştırır; hosta bir ajan ya da paket **kurmaz**. Yine de
VMware adaptörüyle aynı sözleşmeyi konuşur: [adapter-contract.md](adapter-contract.md).

> [!WARNING]
> KVM desteği **ilk sürümdür**. Kabuk betikleri gerçek Linux'ta, libvirt araçlarını taklit eden sahte bir `virsh`
> ile uçtan uca; SSH tarafı (host anahtarı sabitleme, parola ve anahtarla giriş) adaptörün gerçek imajıyla gerçek
> bir OpenSSH sunucusuna karşı sınandı. **Gerçek bir libvirt/KVM hostunda henüz hiç çalıştırılmadı.** Üretimde
> kullanmadan önce bir test hostunda deneyin.

## Hostu hazırlamak

Hostta bash ile birlikte şu araçlar olmalı: `virsh`, `qemu-img`, `virt-clone`, `virt-xml`.

Debian / Ubuntu:

```bash
apt install -y qemu-kvm libvirt-daemon-system libvirt-clients qemu-utils virtinst
```

AlmaLinux / Rocky / RHEL:

```bash
dnf install -y qemu-kvm libvirt qemu-img virt-install
```

`virt-clone` ve `virt-xml` yoksa bağlantı yine eklenir (envanter, güç işlemleri çalışır) ama **sunucu
oluşturulamaz**; panel bunu bağlantıda uyarı olarak gösterir.

Panelin bağlanacağı hesap `root` ya da **libvirt grubunda** olan ve depolama havuzunun klasörüne yazabilen bir
hesap olmalıdır. Panel hostta yalnızca şunlara dokunur:

- adı `lvm-` ile başlayan sanal makineler ve onların disk dosyaları,
- `/var/lib/lightning-vm/tasks`: arka planda çalışan kopyalama işlerinin durum dosyaları (iki gün sonra silinir).

## Bağlantı eklemek

Yönetim → Bağlantılar → Yeni bağlantı → **KVM (libvirt)**.

| Alan | Değer |
|---|---|
| Adres | KVM hostunun adresi |
| Port | `22` (varsayılan) |
| Kullanıcı | `root` ya da libvirt grubundaki bir hesap |
| Parola ya da SSH özel anahtarı | Hesabın parolası; ya da parola yerine özel anahtarın tamamı (`-----BEGIN …` ile başlayan metin) |
| Host anahtarı | SSH host anahtarının SHA-256 özeti; boş bırakılırsa ilk sınamada host kendi anahtarını gösterir |

**Host anahtarı.** SSH'ta sertifika yoktur; panel hostu host anahtarının parmak iziyle tanır ve yalnızca o anahtarı
sunan hosta bağlanır. Alanı boş bırakıp **Bağlantıyı sına**'ya bastığınızda host anahtarı gösterilir; parmak izini
hostta şu komutla karşılaştırıp onaylayın:

```bash
awk '{print $2}' /etc/ssh/ssh_host_ed25519_key.pub | base64 -d | sha256sum
```

Host yeniden kurulursa anahtarı değişir; bağlantıyı düzenleyip yeni parmak izini onaylamanız gerekir.

**Özel anahtarla giriş.** Parola yerine anahtar kullanmak daha güvenlidir. Anahtar **parolasız** olmalıdır
(parola korumalı anahtarlar kullanılamaz). Yalnız panel için bir anahtar üretip hosta tanıtın:

```bash
ssh-keygen -t ed25519 -N "" -f lightning-vm-key
```

```bash
ssh-copy-id -i lightning-vm-key.pub root@KVM_HOSTU
```

Sonra `lightning-vm-key` dosyasının içeriğini parola alanına yapıştırın. Parola da anahtar da diğer bağlantıların
parolaları gibi şifrelenmiş saklanır.

Host panel sunucusuyla aynı yerel ağdaysa adaptörün o ağa erişmesine izin verin
(`.env`):

```bash
LIBVIRT_ALLOW_NETWORKS=10.20.0.0/16
```

## Panel hostu nasıl görür

| Panelde | libvirt'te |
|---|---|
| Host ve işlem kaynağı | Hostun kendisi (kimliği `/etc/machine-id`) |
| Veri deposu | Depolama havuzu (`virsh pool-list`); **klasör tipi** olmalı, diskler qcow2 dosyasıdır |
| Ağ | libvirt ağı (`virsh net-list`), örneğin `default` ya da köprüye bağlı kendi ağınız |
| Şablon imajı | Adı `template-` ya da `tpl-` ile başlayan, veya açıklamasında `lvm-template` yazan **kapalı** VM |
| Sunucu | `lvm-<sunucu kimliği>` adlı VM |

Müşteri sunucularına genel IP verecekseniz, hostun köprüsüne bağlı bir libvirt ağı tanımlayın (NAT'lı `default`
ağı dışarıdan erişilemez):

```bash
cat > br0-net.xml <<'EOF'
<network><name>public</name><forward mode="bridge"/><bridge name="br0"/></network>
EOF
```

```bash
virsh net-define br0-net.xml && virsh net-start public && virsh net-autostart public
```

## Şablon hazırlama

- Dağıtımın **cloud imajından** bir VM kurun (örneğin Ubuntu `noble-server-cloudimg-amd64.img`); içinde
  **cloud-init** olmalı. IP adresinin panele bildirilmesi için **qemu-guest-agent** kurun ve VM tanımına agent
  kanalını ekleyin (virt-install ile kurulan VM'lerde vardır).
- VM'i kapatın, adını `template-…` yapın (`virsh domrename`), snapshot'larını silin.
- Şablonun **ilk diski** sistem diskidir ve bir ağ kartı olmalıdır.

Panel her yeni sunucuya `cidata` etiketli küçük bir **yapılandırma diski** (CD) takar. cloud-init ağ ayarlarını,
sunucu adını, SSH anahtarlarını, root parolasını, uygulama kurulumunu ve güncelleme bildiricisini bu diskten okur.
Misafir ajanı yoksa sunucu, açıldıktan dört dakika sonra kendisine verilen adreslerle hazır sayılır.

## Bu sürümde çalışanlar

Keşif ve kapasite · şablondan sunucu oluşturma (disk kopyası hostta arka planda çalışır; CPU, bellek, disk, ağ,
cloud-init'in tamamı) · açma / kapatma / yeniden başlatma / temiz kapatma · silme (disk dosyalarıyla) · boyut
değiştirme · snapshot alma, geri dönme, silme · ek disk ekleme ve kaldırma · mevcut VM'i devralma · sunucu
ayrıntıları · topoloji.

## Henüz olmayanlar

Bu işlemler KVM bağlantılarında "henüz desteklenmiyor" yanıtı verir: tarayıcı konsolu (VNC/SPICE geçidi yok),
firewall ve hız sınırlama, yedekleme ve geri yükleme, kişisel imaj, ISO kitaplığı ve CD takma, özel ağlar, canlı
taşıma.

Ayrıca:

- **Bağlantı başına tek host.** Birden çok KVM hostu ayrı bağlantılar olarak eklenir; aralarında taşıma yoktur.
- **Depolama:** yalnızca klasör tipi havuzlar (qcow2 dosyaları). LVM, Ceph/RBD, ZFS havuzlarında sunucu
  oluşturulamaz.
- **Grafikler boş gelir:** libvirt kullanım geçmişi tutmaz; trafik sayımı da yoktur.
- **Snapshot:** libvirt'in dahili (qcow2) snapshot'ı kullanılır. UEFI ile açılan çalışan bir VM'de eski libvirt
  sürümleri snapshot almayı reddedebilir; sunucu kapalıyken alın. Snapshot'ı olan diskin boyutu büyütülemez.
- Boyut değiştirme ve devralma için sunucu kapalı olmalıdır (boyut değiştirmede panel bunu kendisi yapar).
- **Windows misafirler yapılandırılmaz:** özelleştirme cloud-init ile yapılır.
- Her işlem hosta kısa bir SSH oturumu açar; hostta `MaxStartups` / `fail2ban` çok sıkıysa panel sunucusunun
  adresine izin verin.
