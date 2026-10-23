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
| Rezerve | platformun oluşturduğu sunucular (9. aşamaya kadar 0) | aynı | aynı |
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
- Faturalama, vergi ve ödeme henüz yoktur.

## IP havuzları
- **Tanım:** her IP havuzu bir kaynak havuzuna bağlıdır ve şunları içerir: IPv4 alt ağı (CIDR),
  ağ geçidi, DNS sunucuları, kullanılacak aralık ve hariç tutulan adresler.
- **Veritabanı kısıtları:** ağ geçidi ve aralık alt ağın içinde olmalı, aralığın başı sonundan büyük
  olamaz ve ağ geçidi aralığın içinde olamaz (`IP_OUTSIDE_SUBNET`).
- **Çakışma:** aynı kaynak havuzundaki aralıklar çakışamaz (`RANGE_OVERLAPS`). Bu kontrol bir kilit
  altında yapılır; aynı anda gelen üç istekten yalnızca biri kaydedilir (test edildi).
- **Henüz yok:** IPv6 ve adres ataması. Atama, sunucu oluşturmayla birlikte atomik rezervasyon olarak
  9. aşamada gelecek.

## Kotalar ve projeler
- **Kota sırası:** proje kotası, yoksa kullanıcı kotası, yoksa varsayılan kota uygulanır. Boş bırakılan
  bir sınır sınırsızdır. Sınırlar: sunucu sayısı, vCPU, RAM ve disk.
- **Fiyat teklifi:** teklif ekranı yeni bir sunucunun hangi sınırları aşacağını gösterir. Kullanım
  9. aşamaya kadar 0'dır.
- **Projeler:** projeler sahibine aittir. Sorgular sahipliği kendisi kontrol eder; başka bir kullanıcının
  proje kimliğini bilmek ona erişim sağlamaz (`404`).

## Müşteri kataloğu ve fiyat teklifi
- **`GET /api/catalog`:** yalnızca etkin paketleri, etkin havuzların adını, konumunu ve özel kaynak
  kuralını, ve imajları döndürür. Fazla tahsis oranları, ayrılan paylar ve VMware nesne kimlikleri
  müşteriye gösterilmez.
- **`POST /api/catalog/quote`:** paketi veya özel yapılandırmayı sunucuda doğrular ve fiyatlar; kotayı
  ve kapasiteyi kontrol eder.
- **Sunucu oluşturma:** **henüz yok** (9. aşama). Ekran bunu açıkça söyler.
