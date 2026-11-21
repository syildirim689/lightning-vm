# Kaynak havuzları, paketler, özel kaynak kuralları, IP havuzları ve kotalar

## Kaynak havuzu
Kaynak havuzu **fiziksel kaynak üretmez.** Keşfedilmiş bir bağlantıdaki mevcut kapasitenin bir
kısmını satışa veya kullanıma açar. Bir havuz şunlardan oluşur:
- bir küme veya tek bir host;
- bir veya daha fazla datastore;
- bir ağ (port group, VLAN ile);
- kaynak türü başına fazla tahsis (overcommit) oranları ve ayrılan paylar.

Bu öğelerin hepsi bağlantının keşfedilmiş envanterinde bulunmalıdır (`NOT_IN_INVENTORY`).

### Kapasite katmanları (ayrı ayrı gösterilir)
| Katman | CPU | RAM | Depolama |
|---|---|---|---|
| Fiziksel toplam | hostların fiziksel çekirdekleri (hyper-thread sayılmaz) | hostların RAM toplamı | seçilen datastore'ların kapasitesi |
| Yönetim ve güvenlik payı | fiziksel × `reserve_cpu_pct` | fiziksel × `reserve_memory_pct` | fiziksel × `reserve_storage_pct` |
| Satışa açılan | (fiziksel − pay) × **CPU oranı** | (fiziksel − pay) × **RAM oranı** | (fiziksel − pay) × **depolama oranı** |
| Rezerve | platformun oluşturduğu, silinmemiş sunucular (büyütülmekte olan, büyüyeceği boyutla) | aynı | aynı |
| Gerçek kullanım | o hostlardaki mevcut VM'lerin vCPU toplamı (şablonlar hariç) | VM'lerin RAM toplamı | yazılmış ve thin olarak tahsis edilmiş alan ayrı ayrı |
| Kalan satılabilir | satışa açılan − kullanım − rezerve (0'ın altına inmez) | aynı | satışa açılan − tahsis edilen − rezerve |

**Oranlar:**
- **CPU:** CPU fazla tahsisi RAM ve diskten ayrı tutulur (varsayılan 4x, en çok 32x).
- **RAM:** 1x önerilir (en çok 4x); RAM fazla tahsisi performans sorununa yol açar.
- **Depolama:** thin disk varsayımıyla ayarlanır (1x–10x).

**Thin provisioning ve gerçek boş alan farkı:**
- Mevcut VM'lerin henüz yazılmamış (uncommitted) alanı "tahsis edilmiş" olarak sayılır.
- Gerçek boş alan ayrıca gösterilir.
- Gerçek boş alan güvenlik payının altına düşerse `STORAGE_FREE_BELOW_HEADROOM` uyarısı çıkar.
- Tahsis edilen alan fiziksel kapasiteyi aşarsa `STORAGE_OVERPROVISIONED` uyarısı çıkar.

Mevcut VM'ler platform dışında oluşturulmuş olsa da kapasite tüketir; bu yüzden "kalan satılabilir"
hesabından düşülür. Bu temkinli bir varsayımdır.

## Özel kaynaklı sunucu kuralları
Her havuz için en fazla bir kural tanımlanır. Kural şunları belirler:
- vCPU, RAM ve disk için en az / en çok değerler ve artış adımları;
- vCPU başına izin verilen RAM aralığı;
- birim fiyatlar (aylık, vCPU, GB RAM ve GB disk başına) ve para birimi.

Sunucu tarafında şu hata kodları döner:
- `OUT_OF_RANGE`: aralık dışında;
- `INVALID_STEP`: artış adımına uymuyor;
- `RATIO_NOT_ALLOWED`: vCPU başına RAM izin verilen aralıkta değil;
- `MIN_ABOVE_MAX`: en az değer en çoktan büyük;
- `BELOW_IMAGE_MINIMUM`: disk, imajın en az disk boyutundan küçük.

Özel kaynak seçimi **fiziksel olarak ayrılmış işlemci garantisi değildir.** vCPU'lar paylaşılan
fiziksel çekirdeklerde çalışır. Arayüz bunu sipariş ekranında açıkça yazar.

## Paketler ve imajlar
- **Paket:** vCPU, RAM, disk, aylık fiyat (isteğe bağlı saatlik fiyat), ISO 4217 para birimi,
  sunulduğu havuzlar (en az bir) ve izin verilen imajlardan oluşur.
- **İmaj:** bağlantının envanterindeki bir VM **şablonudur** (template). Şablon VMware tarafında
  hazırlanır.

## Para
- Tutarlar PostgreSQL'de `numeric` türünde saklanır ve API'de ondalık metin olarak taşınır.
- Özel kaynak fiyatı SQL içinde `numeric` ile hesaplanır; ikilik kayan nokta (float) kullanılmaz.
  Örnek: 3 vCPU × 5,00 + 6 GB × 2,00 + 70 GB × 0,10 = **34,00**; bu değer test edildi.
- Arayüz tutarı seçilen dile göre biçimlendirir. Örnek: Türkçe `€12,10`, İngilizce `€12.10`.
- Faturalama, vergi ve ödeme: [billing.md](billing.md), [payments.md](payments.md).

## IP havuzları
- **Tanım:** her IP havuzu bir kaynak havuzuna bağlıdır ve şunları içerir: IPv4 alt ağı (CIDR),
  ağ geçidi, DNS sunucuları, kullanılacak aralık ve hariç tutulan adresler.
- **Veritabanı kısıtları:** ağ geçidi ve aralık alt ağın içinde olmalı, aralığın başı sonundan büyük
  olamaz ve ağ geçidi aralığın içinde olamaz (`IP_OUTSIDE_SUBNET`).
- **Çakışma:** aynı kaynak havuzundaki aralıklar çakışamaz (`RANGE_OVERLAPS`). Bu kontrol bir kilit
  altında yapılır; aynı anda gelen üç istekten yalnızca biri kaydedilir (test edildi).
- **Atama:** adres, sunucu oluşturulurken aynı işlemde ayrılır. Havuzda IPv6 öneki varsa sunucuya `::10`'dan
  başlayarak ilk boş IPv6 adresi de verilir. Ayrıntılar: [ip-management.md](ip-management.md).

## Kotalar ve projeler
- **Kota sırası:** kullanıcıya özel kota varsa o uygulanır; yoksa varsayılan kota, kullanıcının rolünün sınırlarıyla
  birlikte (docs/auth.md, Rol sınırları). Boş bırakılan bir sınır sınırsızdır. Sınırlar: sunucu sayısı, vCPU, RAM
  ve disk.
- **Proje kotası:** personel (`catalog.manage`) bir projeye kendi kotasını verebilir: Katalog → Kotalar → "Kota
  ata" → kapsam alanında proje adı ya da sahibinin e-postası yazılır (`PUT /api/admin/quotas/projects/:id`,
  kaldırma `DELETE`; ikisi de denetim kaydına `catalog.quota_set` / `catalog.quota_removed` olarak yazılır).
  - Proje kotası, **o projeye verilen siparişlerde** sahibinin kotasının (kullanıcıya özel ya da varsayılan + rol)
    **yerine geçer** ve yalnızca o projenin sunucularını sayar. Sahibinin kotasından dar da geniş de olabilir; bu
    yüzden onu sahibi değil personel tanımlar.
  - Proje dışındaki (ya da kendi kotası olmayan projedeki) siparişler hesabın kotasına tabidir ve hesabın **bütün**
    sunucuları sayılır (kotası olan projedekiler de). Proje açmak tek başına kotayı büyütmez.
  - Aşıldığında sipariş, boyut büyütme ve ek disk `409 PROJECT_QUOTA_EXCEEDED` ile reddedilir (alanlar hangi
    sınırın aşıldığını söyler: `servers`, `vcpu`, `memoryMb`, `diskGb`); hesabın kotasında kod eskisi gibi
    `QUOTA_EXCEEDED`'dir. Aynı anda gelen iki sipariş, iki boyut büyütme ya da iki ek disk son yeri birlikte alamaz
    (hepsi sahibin satırı kilitliyken sayar). Kabul edilmiş ama henüz bitmemiş bir boyut büyütme, büyüyeceği
    boyutla kullanıma sayılır (tekliflerde ve listelerde de öyle görünür); başarısız olursa yeri geri döner.
  - Sunucunun projesi yalnızca siparişte seçilir, sonradan değiştirilemez. Proje silinirse kotası da silinir;
    sunucuları projesiz kalır ve hesabın kotasına sayılır. Aynı adla açılan yeni proje kotasız başlar.
  - Kotalar listesi kullanıcı ve proje satırlarında her sınırın yanında **kullanılanı** gösterir ("3 / 5").
- **Müşteri ne görür:** Hesabım → Projeler, kendi kotası olan projede sınırları ve kullanımı yazar. Sipariş
  özeti, siparişin sayılacağı kotayı (seçilen projenin kotası ya da "Kotanız") **bu sunucuyla birlikte varacağı
  durumla** gösterir; aşılan sınır kırmızıdır, hangi kotanın aşıldığı yazılır ve "Sunucu oluştur" kapanır. Paket
  listesindeki "kotanızı aşıyor" gerekçesi de seçilen projeye göre hesaplanır.
- **Fiyat teklifi:** teklif (`POST /api/catalog/quote`) kotanın kime ait olduğunu (`scope`: `project` / `account`),
  sınırları, bugünkü kullanımı ve yeni sunucunun hangi sınırları aşacağını döner. Kullanım, silinmemiş
  sunuculardan hesaplanır (sanal veri merkezindekiler sayılmaz).
- **Denenmeyen:** proje kotası gerçek bir hipervizörde sunucu kurarak denenmedi; testler siparişin kabul ya da
  reddedildiği ana kadar gider (`apps/api/test/integration/project-quota.test.mjs`, hipervizörsüz bir konumla).
- **Projeler:** projeler sahibine aittir. Sorgular sahipliği kendisi kontrol eder; başka bir kullanıcının
  proje kimliğini bilmek ona erişim sağlamaz (`404`).

## Müşteri kataloğu ve fiyat teklifi
- **`GET /api/catalog`:** yalnızca etkin paketleri, etkin havuzların adını, konumunu ve özel kaynak
  kuralını, ve imajları döndürür. Fazla tahsis oranları, ayrılan paylar ve VMware nesne kimlikleri
  müşteriye gösterilmez.
- **`POST /api/catalog/quote`:** paketi veya özel yapılandırmayı sunucuda doğrular ve fiyatlar; kotayı
  ve kapasiteyi kontrol eder.
- **Sunucu oluşturma:** [provisioning.md](provisioning.md).

## Konum bakım modu, trafik kotası, kişisel imajlar
- **Konum durumu:** bir konum `active`, `maintenance` ya da `hidden` olabilir. Bakımdaki (ve gizli) konum yeni
  sunucu almaz; içindeki sunucular çalışmaya devam eder. Müşteri sipariş sayfasında durumu görür.
- **Trafik kotası:** paket ya da havuz aylık bir trafik hakkı (GB) taşıyabilir. Worker her sunucunun giriş ve çıkış
  trafiğini güne yazar; kotası olan sunucunun sahibi %80 ve %100'de ayda birer kez uyarılır. Kota dolunca ne olacağı
  Ayarlar → Sunucular'dadır: yalnızca haber ver ya da hızı sınırla (varsayılan 10 Mbit/sn; kota yeniden karşılanınca
  kalkar). **Sayım yalnızca VMware ve Proxmox VE'de** vardır; **hız sınırlama yalnızca VMware'de**, dağıtık sanal
  anahtardaki portlarda çalışır. Diğer platformlarda sayaç sıfır kalır, kota hiçbir zaman dolmaz.
- **Kişisel imajlar (yalnız VMware):** müşteri bir sunucusunu o anki diskiyle imaj olarak kaydeder (vCenter'da yanına
  bir şablon çıkarılır), sonra ondan yeni sunucu sipariş eder ya da sunucusunu ondan yeniden kurar. İmajı başka kimse
  görmez. Diğer altı platformda adaptör bu işlemi desteklemez.
- **Herkese açık durum sayfası** (`/status`, ayarlardan kapatılabilir): oturum açmadan görülür. Panelin parçalarının
  (panel, veritabanı, kuyruk, otomasyon, sanallaştırma) ve her konumun durumunu, geçmiş günlerin çalışma oranını ve
  olayları gösterir; bağlantı adı, host ya da müşteri sayısı göstermez. Yanıt 15 saniye önbellekte tutulur. Yetkili
  personel bir **olay** (incident) açar: başlık, etki (küçük, büyük ya da bakım), etkilenen parçalar ve bir ilk
  güncelleme; çözülene kadar güncelleme yazar (inceleniyor, bulundu, izleniyor, çözüldü). Açık bir büyük olay genel
  durumu "kesinti", diğerleri "aksama" yapar. Çözülen olaylar yedi gün daha görünür.
