# Microsoft Hyper-V

Panel; VMware, Proxmox VE, XCP-ng, oVirt ve [KVM (libvirt)](libvirt.md)'in yanında **Microsoft Hyper-V** hostlarını da yönetir. Hyper-V'nin bir
HTTP API'si olmadığı için adaptör (`services/hyperv`) hostta **WinRM üzerinden PowerShell** çalıştırır; yine de
VMware adaptörüyle aynı sözleşmeyi konuşur: [adapter-contract.md](adapter-contract.md).

> [!WARNING]
> Hyper-V desteği **ilk sürümdür** ve dört yeni adaptör içinde en az denenmiş olanıdır. Kimlik doğrulama (NTLMv2)
> Microsoft'un yayımladığı test değerleriyle, WinRM istemcisi sahte bir WinRM sunucusuyla sınandı; PowerShell
> betikleri gerçek PowerShell ayrıştırıcısından geçirildi ve her Hyper-V komutunun çağrısı Microsoft'un belgelediği
> parametre kümeleriyle karşılaştırıldı. **Betiklerin Hyper-V komutları gerçek bir Hyper-V hostunda yine de hiç
> çalıştırılmadı.** Üretimde kullanmadan önce bir test hostunda deneyin.

## Hostu hazırlamak

Panel WinRM'e **yalnızca HTTPS** ile bağlanır (HTTP'de NTLM ek şifreleme ister; adaptör bunu yapmaz). Hostta,
yönetici PowerShell'de bir HTTPS dinleyicisi açın:

```powershell
$cert = New-SelfSignedCertificate -DnsName $env:COMPUTERNAME -CertStoreLocation Cert:\LocalMachine\My
```

```powershell
New-Item -Path WSMan:\localhost\Listener -Transport HTTPS -Address * -CertificateThumbPrint $cert.Thumbprint -Force
```

```powershell
New-NetFirewallRule -DisplayName "WinRM HTTPS" -Direction Inbound -Protocol TCP -LocalPort 5986 -Action Allow
```

Kendi CA'nızdan bir sertifikanız varsa onu kullanın; kendinden imzalı sertifikada panelde "sabit parmak izi"
seçilir.

## Bağlantı eklemek

Yönetim → Bağlantılar → Yeni bağlantı → **Microsoft Hyper-V**.

| Alan | Değer |
|---|---|
| Adres | Hyper-V hostunun adresi |
| Port | `5986` (varsayılan) |
| Kullanıcı | Hyper-V yöneticisi bir hesap: `ALAN\kullanici`, yerel hesap için yalnızca kullanıcı adı |
| Sertifika | Sistem CA'ları, verilen CA ya da sabit parmak izi |

Giriş NTLMv2 ile yapılır; host yalnızca Basic sunuyorsa (HTTPS üzerinde) o kullanılır. Her bağlantı **tek bir
host** içindir; Failover Cluster bu sürümde tek kaynak olarak yönetilmez.

Adaptör varsayılan olarak loopback ve bağlantı-yerel adresleri, ayrıca **kendi Docker ağlarındaki** adresleri
reddeder (panelin PostgreSQL, Redis ve API'si o ağlardadır; hata `ENDPOINT_BLOCKED`). Host böyle bir ağdaysa o
ağa izin verin (`.env`):

```bash
HYPERV_ALLOW_NETWORKS=10.20.0.0/16
```

Hiç bağlanılmaması gereken ağlar için `HYPERV_DENY_NETWORKS` vardır (virgülle ayrılmış CIDR'ler; izin listesi
yasak listesinin önüne geçer).

## Panel hostu nasıl görür

| Panelde | Hyper-V'de |
|---|---|
| Host ve işlem kaynağı | Hostun kendisi |
| Veri deposu | Sabit sürücüler (`C`, `D`…); sunucular `<sürücü>:\LightningVM\<sunucu>` klasöründe durur |
| Ağ | Sanal anahtar (virtual switch) |
| Şablon imajı | Adı `template-` ya da `tpl-` ile başlayan, veya notunda `lvm-template` yazan **kapalı** VM |
| Sunucu | `lvm-<sunucu kimliği>` adlı VM |

Hyper-V'de şablon kavramı yoktur; bu yüzden şablon olarak kullanılacak VM'i adıyla ya da notuyla işaretlersiniz.

## Şablon hazırlama

- Bir Linux VM kurun; içine **cloud-init** ve IP adresini bildirmesi için **Hyper-V tümleştirme hizmetlerini**
  (çoğu dağıtımda `hyperv-daemons` / `linux-cloud-tools`) kurun.
- VM'i kapatın, **denetim noktalarını (checkpoint) silin** ki diski tek dosya olsun, adını `template-…` yapın.
- 2. nesil (Generation 2) VM'lerde Linux için Güvenli Önyükleme şablonu "Microsoft UEFI Certificate Authority"
  olmalı; panel yeni sunucuya şablondaki ayarı aynen verir.

Panel her yeni sunucuya `cidata` etiketli küçük bir **yapılandırma diski** (DVD) takar. cloud-init ağ ayarlarını,
sunucu adını, SSH anahtarlarını, root parolasını, uygulama kurulumunu ve güncelleme bildiricisini bu diskten
okur. Tümleştirme hizmetleri yoksa sunucu, açıldıktan dört dakika sonra kendisine verilen adreslerle hazır sayılır.
Aynı kural, tümleştirme hizmetleri çalışıp adres bildirmediğinde de geçerlidir (KVP hizmeti `hv_kvp_daemon`
olmayan Linux imajları).

Bilmeniz gerekenler:

- **Ağ kartı:** yeni sunucunun ağ kartına sunucu kimliğinden türetilen **sabit bir MAC adresi** verilir
  (`02:15:5d:…`); misafirdeki arayüz bu MAC ile eşlenir ve `eth0` adını alır. İmajda netplan gerekmez.
- **Disk biçimi:** `.vhd` şablonun kopyası `.vhd` kalır; diğerleri `.vhdx` olur.
- **Klasör izinleri:** iş dosyalarının durduğu `%ProgramData%\LightningVM\tasks` klasörü ile sunucunun klasörü
  yalnızca Administrators, SYSTEM ve betikleri çalıştıran hesaba açıktır (sunucu klasörü ayrıca Hyper-V sanal
  makinelerine); bu dosyalarda parola özeti ve ilk açılış betikleri bulunur.
- **Silme:** sunucunun klasöründeki dosyalar hâlâ kullanılıyorsa silme başarısız olur ve yeniden denenir; VM o
  sırada kaldırılmıştır, kalan klasör sonraki denemede silinir.

## Bu sürümde çalışanlar

Keşif ve kapasite · şablondan sunucu oluşturma (disk kopyası hostta arka planda çalışır; CPU, bellek, disk, ağ,
cloud-init'in tamamı) · açma / kapatma / yeniden başlatma / temiz kapatma · silme (klasörüyle) · boyut değiştirme ·
denetim noktası alma, geri dönme, silme · ek disk ekleme ve kaldırma · mevcut VM'i devralma · sunucu ayrıntıları ·
topoloji.

## Henüz olmayanlar

Bu işlemler Hyper-V bağlantılarında "henüz desteklenmiyor" yanıtı verir: tarayıcı konsolu (Hyper-V konsolu RDP
tabanlıdır), firewall ve hız sınırlama, yedekleme ve geri yükleme, kişisel imaj, ISO kitaplığı ve CD takma, özel
ağlar, canlı taşıma.

Ayrıca:

- **Windows misafirler yapılandırılmaz:** özelleştirme cloud-init ile yapılır; Windows şablonları için
  `unattend.xml` desteği yoktur.
- **Grafikler boş gelir:** Hyper-V kaynak ölçümü açık değilse geçmiş tutmaz; trafik sayımı da yoktur.
- Boyut değiştirme için sunucu kapalı olmalıdır (panel bunu kendisi yapar).
- Her işlem hostta bir PowerShell oturumu açar; bu yüzden işlemler diğer platformlardan biraz yavaştır.
