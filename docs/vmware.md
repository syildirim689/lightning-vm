# ESXi / vCenter bağlantısı ve envanter

## Mimari
```
Tarayıcı ─▶ Caddy ─▶ API (NestJS) ──token──▶ vmware (Go + govmomi) ──TLS──▶ ESXi / vCenter (/sdk)
                        │
                        └─ PostgreSQL: bağlantılar (şifreli parola) + son keşfedilen envanter
```
- **`services/vmware`:** küçük, durumsuz bir Go servisi.
  - Yayımlanmış portu yok. Yalnızca API, `secrets/vmware.token` içindeki ortak token ile çağırabilir.
  - İstek gövdelerini loglamaz; logda kimlik bilgisi bulunmadığı test edildi.
  - Kökü olmayan (`scratch`) imajda uid 1000 ile ve salt okunur dosya sistemiyle çalışır.
- **Tarayıcı:** ESXi/vCenter yönetim ağına hiçbir zaman doğrudan erişmez.
- **Okuma ve yazma:** bu aşamada yalnızca okunur. Platform ESXi/vCenter üzerinde hiçbir şeyi
  değiştirmez. Sanal makine oluşturma 9. aşamada gelecek.

## Kullanılan API
- **vSphere Web Services API (SOAP, `/sdk`):** govmomi ile kullanılır. Hem ESXi'de hem vCenter'da
  vardır. Keşfin tamamı bu API ile yapılır.
- **vCenter Automation REST API (`/api`):** yalnızca vCenter'da vardır. Bu aşamada kullanılmaz.
  Bağlantı vCenter ise `operations.automationApi = true` olur; standalone ESXi'ye bu API'nin
  çağrıları hiçbir zaman gönderilmez.
- **Ürün türü:** `about.apiType` alanından okunur. `VirtualCenter` → vCenter, `HostAgent` → ESXi.

## Keşfedilenler
- **Ürün:** ad, sürüm, build, API sürümü, vCenter instance UUID.
- **Lisans:** sürüm (edition) ve kullanım. Lisans anahtarları ne döndürülür ne saklanır.
- **Yetkiler:** servis hesabının kök klasördeki yetkileri (`HasPrivilegeOnEntity`) ve bunlardan
  çıkan desteklenen işlemler: envanter, VM oluşturma, şablondan kopyalama (yalnızca vCenter), güç,
  kaynak değiştirme, silme, snapshot, konsol.
- **Hostlar:** donanım UUID, CPU (çekirdek, iş parçacığı, MHz), bellek, bağlantı/güç/bakım durumu,
  sürüm, yönetildiği vCenter.
- **Datastore'lar:** kapasite, boş alan, henüz yazılmamış (uncommitted, thin) alan, erişilebilirlik.
- **Ağlar:** standart port group'lar (VLAN host yapılandırmasından) ve dağıtık port group'lar
  (VLAN dvPortgroup ayarından).
- **Hesaplama kaynakları:** kümeler ve tek hostlu kaynaklar, efektif CPU/bellek.
- **Sanal makineler:** ad, UUID, güç durumu, host, vCPU, RAM, şablon olup olmadığı, disk kullanımı.

**Fiziksel kapasite:** host ve datastore toplamları olarak gösterilir. Thin disklerde
"tahsis edilmiş" alan şöyle hesaplanır: kapasite − boş + henüz yazılmamış alan. Yönetim payı,
satışa açılan ve rezerve kapasite 8. aşamada (kaynak havuzları) gelecek.

## Ücretsiz ESXi lisansı
Ücretsiz vSphere Hypervisor lisansında VMware API'si salt okunurdur. Lisans sürümü `esxBasic` ise
veya adında "Hypervisor" geçiyorsa `writeApi = restricted` olur ve yazma gerektiren tüm işlemler
"desteklenmiyor" görünür.

Bu tespit lisans bilgisine dayalı bir **çıkarımdır**. Kesin doğrulama gerçek bir yazma işlemiyle,
gerçek donanımda yapılmalıdır (aşağıdaki kabul testlerine bakın). Lisans okunamazsa sonuç `unknown` olur.

## Aynı hostun iki kez sayılmaması
- Her host, donanım UUID'si (`summary.hardware.uuid`) ile tanınır. Bu değer veritabanında tekildir
  (`vmware_hosts_hardware_uuid_key`).
- vCenter üzerinden keşfedilmiş bir host ayrıca standalone ESXi olarak eklenemez; bunun tersi de
  geçerlidir. Bağlantı `409 HOSTS_ALREADY_MANAGED` ile reddedilir ve çakışan bağlantı adı gösterilir.
  Eşzamanlı isteklerde de bu kuralı veritabanındaki tekil indeks garanti eder.
- Aynı vCenter farklı bir adresle tekrar eklenemez (instance UUID tekil; `CONNECTION_EXISTS`).
- Bir vCenter'a bağlı bir ESXi doğrudan eklenirse uyarı verilir (`HOST_MANAGED_BY_VCENTER`).

Bilinen sınır: bazı sunucular aynı veya sıfır BIOS UUID'si raporlar. Böyle iki farklı host
birbiriyle çakışır; bu gerçek donanımda kontrol edilmelidir.

## TLS
Sertifika doğrulaması hiçbir modda kapatılmaz:

| Mod | Anlamı |
|---|---|
| `system` (varsayılan) | Sistem CA'ları ve ad doğrulaması |
| `ca` | Sistem CA'larına eklenen özel CA (örneğin vCenter VMCA kökü); ad doğrulaması devam eder |
| `pinned` | Yalnızca SHA-256 parmak izi kaydedilmiş olan tam sertifika kabul edilir |

Sertifika güvenilir değilse (`TLS_UNTRUSTED` veya `TLS_HOSTNAME_MISMATCH`):
- Panel sunulan sertifikayı gösterir: konu, veren, bitiş tarihi, adlar ve SHA-256 parmak izi.
- Yönetici parmak izini sunucunun kendisinde doğrulayıp **açıkça** sabitler. ESXi'de:
  ```sh
  openssl x509 -in /etc/vmware/ssl/rui.crt -noout -fingerprint -sha256
  ```
- Sertifika sonradan değişirse `TLS_PIN_MISMATCH` döner; yeni parmak izi kendiliğinden kabul edilmez.

**Kendi kodumuzdaki önlem:** govmomi kendi `tls.Dial` fonksiyonunu kullanıyordu; bu, adres
kontrolünü ve istek zaman aşımını atlıyordu. Adaptör bu fonksiyonu, adres kontrolünden geçen
kendi bağlantı fonksiyonuyla değiştirir (simülatör testleriyle bulundu ve doğrulandı).

## Adres güvenliği (SSRF)
Yalnızca yöneticiler (ve kurulum sırasında yönetici oturumu) bağlantı ekleyip test edebilir.
Adaptör, adı bir kez çözer, **her** IP'yi kontrol eder ve kontrol ettiği IP'ye bağlanır.

Varsayılan olarak engellenenler:
- loopback;
- link-local, bulut metadata servisi dahil (`169.254.169.254`);
- `0.0.0.0` ve multicast;
- adaptörün kendi Docker ağları (PostgreSQL, Redis ve API buradadır).

Ayarlar:
- `VMWARE_ALLOW_NETWORKS=10.20.0.0/16,...`: bu ağlar yukarıdaki kuralların önüne geçer.
  Örneğin simülatör ağı yalnızca test dosyasında bu yolla açılır.
- `VMWARE_DENY_NETWORKS=...`: ek olarak engellenecek ağlar.

Engellenen bir adres `ENDPOINT_BLOCKED` döner. Ağ seviyesinde ek önlem olarak, platform sunucusunun
yalnızca yönetim ağına çıkabilmesi önerilir.

## Servis hesabı ve önerilen yetkiler
Platform için ayrı bir hesap açın (örneğin vCenter'da `lightning@vsphere.local`) ve ona yalnızca
gereken yetkileri içeren bir rol verin. Keşif şu yetkileri kontrol eder:
- **Envanter:** `System.View`, `System.Read`
- **VM oluşturma ve silme:** `VirtualMachine.Inventory.Create` / `.Delete`
- **Güç:** `VirtualMachine.Interact.PowerOn` / `PowerOff` / `Reset`
- **Konsol:** `VirtualMachine.Interact.ConsoleInteract`
- **Yapılandırma:** `VirtualMachine.Config.CPUCount` / `Memory` / `AddNewDisk`
- **Şablondan kopyalama ve snapshot:** `VirtualMachine.Provisioning.Clone`,
  `VirtualMachine.State.CreateSnapshot`
- **Kaynaklar:** `Datastore.AllocateSpace`, `Network.Assign`, `Resource.AssignVMToPool`

Panel her bağlantı için hangi işlemlerin yetki ve lisansa göre mümkün olduğunu gösterir.

## Kimlik bilgilerinin saklanması ve anahtar yönetimi
- **Şifreleme:** VMware parolası AES-256-GCM ile şifrelenir. Bağlantı kimliği ek doğrulama verisi
  (AAD) olarak kullanılır, bu yüzden şifreli metin başka bir satıra taşınırsa çözülmez.
- **Anahtarın yeri:** anahtar veritabanında değil `secrets/master.key` dosyasındadır
  (uid 1000, izin 400). Bu dosya Compose secret olarak yalnızca API container'ına bağlanır.
- **Görünürlük:** parola tarayıcıya hiçbir zaman geri gönderilmez, API yanıtlarında yer almaz ve
  loglanmaz. Lisans anahtarları da saklanmaz.
- **Yedek:** `sh scripts/install.sh backup` veritabanını ve bu anahtarı tek bir arşivde, ayrı bir
  anahtarla (`secrets/backup.key`) şifreli olarak saklar (docs/operations.md). Koruma artık
  `backup.key`'in ayrı tutulmasına dayanır: onu yedeklerle aynı yere koymayın. `master.key` olmadan
  veritabanı geri yüklenebilir, ama kayıtlı VMware parolaları çözülemez (`SECRET_KEY_UNAVAILABLE`);
  her bağlantının parolası yeniden girilmelidir.
- **Kurtarma:** `secrets/master.key` dosyasını aynı izinlerle geri koyun ve API'yi yeniden başlatın:
  ```sh
  sudo docker compose up -d api
  ```
- **Dokunulmazlık:** kurulum betiği var olan anahtarı asla değiştirmez. Anahtar rotasyonu henüz yok.

## Test ortamı: simülatör
```sh
sudo docker compose -f compose.yaml -f compose.simulator.yaml up -d --build --wait
```
- Bu komut govmomi'nin simulator paketiyle (vcsim'in motoru) simüle bir vCenter (`vcsim-vcenter`,
  2 host) ve simüle bir ESXi (`vcsim-esxi`) başlatır. Bunlar yalıtılmış bir ağda çalışır.
- Bu ortamda görünen hostlar, datastore'lar, VM'ler ve kapasite **simülasyondur**; gerçek altyapı
  değildir.
- Simülatörün kimlik bilgileri dosyada yazılıdır ve yalnızca test içindir.
- Simülatörler govmomi'nin gömülü sertifikasını kullanır; ikisi aynı sertifikayı sunar.

Testler (hepsi simülatöre karşı):
- `services/vmware`, `go test ./...`: TLS reddi ve sertifikanın gösterilmesi, sabitleme ve
  sabitleme uyuşmazlığı, adres engeli, hatalı giriş, ESXi/vCenter ayrımı, küme ve hostlar,
  servis token'ı.
- `apps/api`, `npm run test:integration` (`vmware.test.mjs`, `VCSIM_*` ve `VMWARE_SERVICE_URL`
  gerekir): doğrulama, şifreli saklama, envanter, aynı vCenter'ın ve aynı hostun ikinci kez
  eklenememesi, yenileme hatasının kaydedilmesi, yalnızca yönetici erişimi, denetim kayıtları.
- `apps/web`, `npm run test:e2e` (`E2E_VCSIM_HOST`): sihirbazda sertifikanın sabitlenip bağlantının
  kurulması, keşif, yönetim sayfasında kapasite, yenileme ve adı yazarak onaylanan kaldırma.

## Gerçek ortam kabul testleri (henüz yapılmadı)
Simülatör gerçek donanım doğrulamasının yerine geçmez. Gerçek bir test ortamında şunlar denenmeli:
1. ESXi 7.x ve 8.x'e standalone bağlantı: ürün, sürüm, lisans ve envanter doğru mu?
2. vCenter 7.x/8.x bağlantısı: kümeler, dağıtık port group VLAN'ları ve VM sayısı doğru mu?
3. Kendinden imzalı ESXi sertifikası: reddediliyor mu? Parmak izi ESXi'deki `rui.crt` ile
   eşleşiyor mu? Sabitlemeden sonra bağlanıyor mu?
4. vCenter VMCA kök sertifikasıyla `ca` modu ve ad doğrulaması çalışıyor mu?
5. Sertifika yenilendikten sonra `TLS_PIN_MISMATCH` geliyor mu?
6. Ücretsiz lisanslı ESXi'de `writeApi = restricted` görünüyor mu? Gerçek bir yazma denemesi
   `RestrictedVersion` hatası veriyor mu? (9. aşamada)
7. vCenter'a bağlı bir hostu ayrıca standalone eklemek reddediliyor mu (`HOSTS_ALREADY_MANAGED`)?
8. Yalnızca okuma yetkili bir hesapla yazma işlemleri "desteklenmiyor" görünüyor mu?
9. Yanlış parola `INVALID_LOGIN` veriyor mu, ve hesap kilitleme politikası tetiklenmeden mi?
10. Yüzlerce VM'li bir vCenter'da keşif süresi ve yanıt boyutu kabul edilebilir mi?
    (Envanter şu an sayfalanmadan tek yanıtta geliyor.)
11. Platform sunucusundan yönetim ağına güvenlik duvarı kuralları; adres engelinin üretim ağında
    yanlış bir engellemeye yol açmadığı.
