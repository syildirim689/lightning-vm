# İç içe ESXi (Nested ESXi) imajları

Müşteriye VMware ESXi çalıştıran bir sunucu verir. Laboratuvar, eğitim ve vSphere testi için uygundur.

## Şablon

William Lam'in **Nested ESXi Virtual Appliance** OVA'sı (ESXi 7/8) veya aynı vApp özelliklerini okuyan bir
şablon kullanılır:

1. OVA'yı vCenter'a dağıtın. Ağ ve parola alanlarını boş bırakın, açmayın.
2. **Template'e dönüştürün.**
3. Katalog → İşletim sistemi imajları → Yeni imaj:
   - Aile: **VMware ESXi (iç içe)**
   - Şablon: dönüştürdüğünüz template
   - En az disk: şablonun disk boyutu
4. İmajı en az **2 vCPU / 4 GB RAM** (ESXi 8 için 8 GB önerilir) olan paketlere ekleyin. Daha küçük paketler
   siparişte "ESXi için en az 2 vCPU ve 4 GB RAM gerekir" gerekçesiyle seçilemez. API de bu siparişi
   `ESXI_NEEDS_MORE` hatasıyla reddeder.

## Kurulum nasıl yapılır

ESXi'de cloud-init yoktur. Panel, kloncada şablonun vApp (OVF) özelliklerini doldurur. Aynı değerleri
`guestinfo.*` olarak extraConfig'e de yazar:

| Özellik | Değer |
|---|---|
| `guestinfo.hostname` | sunucu adı |
| `guestinfo.ipaddress` / `netmask` / `gateway` | IP havuzundan ayrılan adres |
| `guestinfo.dns` | havuzun DNS sunucuları |
| `guestinfo.ntp` | `pool.ntp.org` |
| `guestinfo.password` | root parolası. Siparişte verilen ya da üretilen parola kullanılır ve şifreli saklanır. Boş bırakılırsa ESXi için parola mutlaka üretilir. |
| `guestinfo.ssh` | `True` |
| `guestinfo.createvmfs` | `False` |

Ek olarak VM'de iç içe sanallaştırma (`nestedHVEnabled`) her zaman açılır.

## Sınırlar

- Ek IPv4 adresleri ve IPv6, ESXi'ye otomatik verilmez. Yalnızca birincil adres ayarlanır.
- Hazır uygulamalar (cPanel/Plesk vb.) ESXi imajlarında seçilemez.
- vcsim, kloncada donanım bayraklarını uygulamaz. Bu bayraklar birim testinde doğrulanır. vApp özellikleri
  ve `guestinfo` değerleri ise simülatörde doğrulanır. Gerçek bir ESXi şablonuyla uçtan uca deneme yapılmadı.

## İlgili sunucu ayarları

Ayarlar → Sunucular → Yeni sunucuların donanımı bölümünde CPU/RAM sıcak ekleme ve iç içe sanallaştırma tüm
yeni VM'ler için açılabilir. ESXi imajları bu ayardan bağımsız olarak iç içe sanallaştırmayı her zaman açar.
