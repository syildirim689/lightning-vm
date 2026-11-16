# Sunucu oluşturma, işlemler ve uzlaştırma

Bu sayfa akışı VMware (vCenter) üzerinden anlatır; `CloneVM_Task` gibi adlar oraya aittir. Diğer altı platformda aynı
adımlar o platformun adaptörüyle yürür ve "VMware Tools" yerine o platformun misafir ajanı okunur. Platformların
farkları: README'deki "Platform kapsamı" tablosu ve her platformun kendi belgesi.

## Akış
1. **Yetki ve doğrulama (API):**
   - kullanıcı oturumu;
   - Idempotency-Key başlığı (zorunlu);
   - paket veya özel kaynak, imaj, proje ve SSH anahtarları sunucu tarafında doğrulanır;
   - konumun bağlantısı sunucu oluşturabilmelidir: keşifte `cloneFromImage` yeteneği görülmüş olmalıdır (VMware'de
     bu vCenter ve şablondan kopyalama yetkisi demektir); yoksa `PROVISIONING_NOT_SUPPORTED`.
2. **Kısa bir transaction** (dış çağrı yapılmaz):
   - kullanıcı satırı, ardından havuz satırı `FOR UPDATE` ile kilitlenir;
   - kota kontrol edilir (`QUOTA_EXCEEDED`);
   - kapasite kontrol edilir (`CAPACITY_EXHAUSTED`);
   - boş bir IP seçilir (`IP_EXHAUSTED`);
   - sunucu, IP ataması ve işlem kaydı (`operations`) yazılır.
3. **Kuyruğa alma:** BullMQ işinin kimliği işlem kimliğiyle aynıdır. Kuyruğa eklenemezse worker'ın
   kurtarma taraması işi PostgreSQL'den bulup kuyruğa ekler.
4. **Worker adımları** (her biri `operations.step` alanına yazılır):
   - **`clone`:** şablondan kopyalanır (`CloneVM_Task`). Aynı anda CPU, RAM, disk büyütme, ağ kartı
     ve cloud-init özelleştirmesi (`CustomizationCloudinitPrep`, vSphere 7.0 U3+) uygulanır.
     VMware görev kimliği beklemeye başlamadan önce kaydedilir.
   - **`power_on`:** VM açılır.
   - **`readiness`:** hazır olma ölçütleri beklenir (aşağıda).
5. **Sonuç:** sunucu `ready`, işlem `succeeded` olur.

## Hazır olma ölçütü
VM'nin açık olması, işletim sisteminin hazır olduğu anlamına gelmez. Sunucu **hazır** sayılabilmesi
için şu üçünün birlikte doğru olması gerekir:
- VMware güç durumu `poweredOn`;
- misafir işletim sisteminde VMware Tools çalışıyor;
- misafir, cloud-init ile atanan IP adresini VMware'e bildiriyor. Bu, ağ yapılandırmasının
  uygulandığını ve cloud-init'in çalıştığını gösterir.

Panel bu üçünü ayrı ayrı gösterir: güç durumu, "işletim sistemi hazır değil" ve hata.

SSH (22) erişimi bu ölçüte dahil değildir. Panel sunucusunun müşteri ağına yol bulması gerekmez;
bu kontrol ileride isteğe bağlı olarak eklenebilir.

## Güvenilirlik kuralları
- **Doğruluk kaynağı:** PostgreSQL'dir. Redis/BullMQ yalnızca işlem kimliğini taşır.
- **Idempotency:** aynı anahtar ve aynı istek aynı sonucu döndürür. Çift tıklamada iki istek de
  aynı sunucuyu döndürür (test edildi). Aynı anahtarla farklı bir istek `IDEMPOTENCY_MISMATCH` alır.
  Tarayıcı anahtarı yalnızca ağ hatasında saklayıp tekrar kullanır.
- **İkinci VM oluşmaz:** VM'nin adı `lvm-<sunucu kimliği>` biçimindedir ve VM'ye
  `lightning.server-id` etiketi eklenir. Adaptör klonlamadan önce bu adı arar; varsa mevcut VM'yi
  döndürür. vCenter da aynı klasörde aynı adı reddeder (`DUPLICATE_NAME`), bu durumda worker VM'yi
  adından bulur. Böylece ağ zaman aşımından sonra yapılan yeniden deneme ikinci bir VM oluşturamaz.
- **Kayıtlı görev:** worker yeniden başlarsa kayıtlı görevi beklemeye devam eder. Platform görevi artık
  tanımıyorsa (`TASK_NOT_FOUND`) bu, işin bittiğini göstermez: sonuç okunabiliyorsa gerçek nesneden okunur (VM var mı,
  güç durumu istenen mi, snapshot listede mi); okunamıyorsa kayıtlı görev kimliği silinir, adım yeniden denenebilir
  olarak başarısız sayılır ve sonraki denemede baştan verilir. Buraya gelen her adım ya yinelenmesi güvenli bir
  adımdır ya da önce neyin var olduğuna bakar.
- **Yeniden deneme:** en çok 6 deneme, üstel bekleme (5 sn'den başlayarak). Kalıcı hatalar hemen
  başarısız sayılır ve tekrar denenmez: `INVALID_LOGIN`, `PERMISSION_DENIED`, `WRITE_RESTRICTED`,
  TLS hataları, şablon veya ağ yok, `INSUFFICIENT_RESOURCES` ve benzerleri.
- **Süre sınırı:** her işlemin bir son tarihi vardır (oluşturmada 45 dk). Süre geçince işlem
  `TIMEOUT` ile başarısız olur.
- **İptal:** devam eden bir oluşturma iptal edilebilir. Worker adımlar arasında iptali kontrol eder,
  yaptıklarını geri alır (VM'yi siler, IP'yi bırakır) ve işlemi `cancelled` olarak işaretler.
- **Kurtarma:**
  - açık kalmış ama kuyrukta işi olmayan işlemler her dakika yeniden kuyruğa alınır;
  - çöken worker'ın işini BullMQ "stalled job" mekanizması geri verir;
  - adımlar idempotenttir; daha önce yapılmış bir adım tekrarlanmaz.
- **Tek işlem kuralı:** bir sunucuda aynı anda tek bir açık işlem olabilir. Bunu veritabanındaki
  tekil indeks sağlar (`OPERATION_IN_PROGRESS`).
- **Kısmi başarısızlık:** oluşturma yarıda kalırsa sunucu `error` durumuna geçer, rezervasyonu ve
  IP'si korunur. Yönetici işlemi "Yeniden dene" ile kaldığı adımdan sürdürebilir ya da sunucu
  silinebilir.

## Silme ve kaynakların bırakılması
Silme, sunucu adının aynen yazılmasını ister. Kilitli sunucu silinmez (`SERVER_LOCKED`).

**Bekleme süresi.** Ayarlar → Sunucular'da bir bekleme süresi tanımlıysa (varsayılan 24 saat; 0 kapatır), hazır
durumdaki bir sunucu hemen silinmez: kapatılır, `deleteAt` zamanı yazılır ve sahibine bildirilir. Süre dolana kadar
"geri al" ile vazgeçilebilir; süre 6 saat ve üzeriyse bitmeden iki saat önce bir hatırlatma gider. Süre dolunca
silmeyi zamanlayıcı başlatır. Bu arada kilitlenen sunucu silinmez ve zamanı iptal edilir. İstek `now: true` ile
gelirse bekleme atlanır. Birden çok sunucuyu tek seferde silmek yalnızca bekleme süresini başlatır; süre kapalıysa
toplu silme reddedilir. Hazır olmayan (hata durumundaki, kurulumu süren) sunucu beklemeden silinir; süren bir
kurulum önce iptal edilir.

Silme işleminde worker sırasıyla:
1. VM'yi kapatır ve siler;
2. platformda VM'nin artık **olmadığını doğrular**;
3. ancak bundan sonra IP atamasını kaldırır (adresler havuzun karantina süresini bekler), ters DNS kayıtlarını ve
   sunucunun yedeklerini siler, uygulama lisansını havuza geri verir ve sunucuyu `deleted` yapar. Rezerve kapasite de
   böylece serbest kalır.

Adaptör, adı `lvm-` ile başlamayan bir VM'yi hiçbir koşulda silmez (`NOT_MANAGED`).

## Güç işlemleri
| İşlem | VMware çağrısı | Not |
|---|---|---|
| Aç | PowerOnVM_Task | |
| Düzgün kapat | ShutdownGuest | VMware Tools gerekir (`TOOLS_NOT_RUNNING`) |
| Zorla kapat | PowerOffVM_Task | Arayüzde açık onay ister |
| Reset | ResetVM_Task | Arayüzde açık onay ister |

## Uzlaştırma (reconciliation)
Worker her 5 dakikada bir (`RECONCILE_MINUTES`) ve yönetici istediğinde panel kayıtlarını, kaynak havuzu olan her
bağlantıdaki (vCenter ve diğer altı platform) `lvm-*` VM'lerle karşılaştırır. Aynı anda tek bir uzlaştırma çalışır (Redis kilidi).
- **VM yok:** `vm_missing` bulgusu açılır ve sunucu `missing` durumuna geçer. VM yeniden görünürse
  bulgu kapanır ve sunucu `ready` durumuna döner.
- **Güç durumu farklı:** `power_drift` bulgusu açılır ve kayıt düzeltilir.
- **Platform kaydı olmayan `lvm-*` VM:** `orphan_vm` bulgusu açılır.

Uzlaştırma **hiçbir şeyi kendiliğinden silmez.** Rezervasyonlar da kendiliğinden bırakılmaz;
karar yöneticiye aittir.

## cloud-init
- **Metadata:** `instance-id`, ana bilgisayar adı ve ağ yapılandırması (netplan v2): statik IP/prefix,
  varsayılan rota ve DNS.
- **User data:** ana bilgisayar adı, müşterinin SSH açık anahtarları ve `ssh_pwauth: false`.
- **Gizlilik:** bu veriler adaptör ve worker loglarına yazılmaz. SSH açık anahtarları gizli değildir;
  sipariş anında sunucu kaydına kopyalanır.
- **Şablonun gereksinimleri:** şablonda cloud-init ve VMware Tools (open-vm-tools) kurulu olmalı ve
  en az bir ağ kartı bulunmalıdır.

## Sunucunun ömrü boyunca yapılabilenler
Hepsi aynı işlem kaydı, tek-açık-işlem kuralı ve yeniden deneme mantığıyla çalışır. Platform sütunu için README'deki
tabloya bakın; burada yalnızca VMware dışında olmayanlar işaretlendi.

- **Yeniden kurulum:** kaydedilen imajdan yeni bir VM; adresler, anahtarlar ve firewall'lar aynı kalır, isteğe bağlı
  yeni anahtar ve parola verilir. Eski VM önce silinir; kopyalama adımı başladıktan sonraki bir yeniden deneme bir daha
  silmez. Eski diskteki uygulamanın lisansı havuza döner.
- **Boyut değiştirme:** paket ya da özel boyut. Disk yalnızca büyür. Misafirin içindeki bölüm ve dosya sistemi panel
  tarafından büyütülmez: imajdaki cloud-init bunu sonraki açılışta yapıyorsa (growpart / resize_rootfs, çoğu bulut
  imajında varsayılan) büyür. Bu davranış denenmedi. Faturalandırma açıksa fark gün hesabıyla faturalanır
  ([billing.md](billing.md)).
- **Kopyalama:** müşterinin bir sunucusunun, diskiyle birlikte, aynı konumda yeni ad, adres ve anahtarlarla kopyası.
  oVirt'te yoktur (kopya yalnızca şablondan çıkar).
- **Snapshot, ek disk, güç zamanlaması:** her platformda. Ek disk eklemede yeniden deneme ikinci bir disk eklemez:
  önceki çağrının sonucu bilinmiyorsa worker önce VM'de, hiçbir kaydın sahiplenmediği, istenen boyutta bir disk arar ve
  onu benimser.
- **Yedek ve geri yükleme, kişisel imaj, ISO takma, özel ağ, firewall:** yalnız VMware.
- **Taşıma ve host boşaltma (yalnız VMware, vCenter):** personel bir sunucuyu durdurmadan başka bir hosta ya da veri
  deposuna taşır (vMotion, Storage vMotion), ya da bakım öncesi bir hosttaki tüm panel sunucularını boşaltır: her biri
  aynı kümede en az panel sunucusu olan hosta gider. Hostlar ve yerleşim son envanter keşfinden okunur.
- **Kilit:** sahibi sunucuyu kilitleyebilir. Kilitliyken silme, zorla kapatma, reset, snapshot'a dönme, yeniden kurulum,
  boyut değiştirme ve yedekten geri yükleme reddedilir (`SERVER_LOCKED`).
- **Başka hesaba devretme:** sahibi sunucuyu bir e-posta adresine teklif eder; karşı hesap bir hafta içinde kabul
  ederse sunucu aboneliğiyle birlikte geçer. Eski sahibin firewall'ı ya da özel ağı bağlıysa, ödenmemiş faturası ya da
  süren bir işlemi varsa devredilmez. Snapshot'lar, yedekler, ek diskler ve güç zamanlamaları sunucuyla gider.
  Yetkili personel bir sunucuyu beklemeden taşıyabilir.
- **Devralma (içe aktarma):** Yönetim → Sunucular → İçe aktar. Keşfedilen envanterdeki bir VM, bir müşterinin sunucusu
  olur: çalışmaya devam eder, yönetilen adı (`lvm-<sunucu kimliği>`) alır, boyutu platformdan okunur, adresi verilirse
  konumun IP havuzundan kaydedilir.
- **IPv6:** IP havuzunda önek varsa sunucuya o önekten bir adres de verilir ([ip-management.md](ip-management.md)).
- **Grafikler ve ölçümler:** VMware ve Proxmox'ta kullanım geçmişi gösterilir; diğer platformlarda grafikler boş gelir.

## Henüz yok
- Standalone ESXi üzerinde oluşturma (API ile kopyalama yok; `PROVISIONING_NOT_SUPPORTED`).
- Çalışan bir sunucuya sonradan ek IP ekleme.
- VMware dışındaki platformlarda konsol, firewall, yedek, ISO, özel ağ ve taşıma.

## Gerçek ortam kabul testleri (henüz yapılmadı)
1. vCenter 7.0 U3+ / 8 üzerinde Ubuntu cloud-init şablonundan oluşturma:
   - IP, ana bilgisayar adı ve SSH anahtarı doğru uygulanıyor mu?
   - Hazır olma ölçütü ne zaman sağlanıyor?
2. Klonlama sırasında worker ağının kesilmesi: ikinci VM oluşmamalı.
3. Klonlama sırasında worker'ın yeniden başlatılması: kayıtlı görevden devam etmeli.
4. Kotası veya yetkisi kısıtlı bir servis hesabıyla `PERMISSION_DENIED` hemen başarısız olmalı.
5. Datastore dolduğunda `INSUFFICIENT_RESOURCES` görünmeli.
6. VMware Tools'u olmayan bir şablonda düzgün kapatma `TOOLS_NOT_RUNNING` vermeli.
7. Dağıtık port group (DVS) ile ağ bağlantısı çalışmalı.
8. Silmeden sonra VM ve diskleri datastore'dan kalkmalı.
9. vCenter'da elle silinen bir VM uzlaştırmada `vm_missing` olarak görünmeli.
