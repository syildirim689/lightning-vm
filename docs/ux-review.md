# Kullanım incelemesi (UX) — 2026-11-23

Müşteri, bayi ve yönetici tarafı, gerçek işler yapan biri gibi kod ve ekran üzerinden yürünerek incelendi: ilk giriş,
sunucu siparişi, bir sunucuyu yönetmek (güç, konsol, boyut, anlık görüntü, yedek, güvenlik duvarı, ağ), fatura ödemek,
destek talebi açmak, yöneticinin günlük kontrolleri ve kurulumu. Aranan: çıkmaz sokaklar, geri bildirimsiz işlemler,
nedeni ve sonraki adımı söylemeyen hatalar, geri alınamayan ya da orantısız onay isteyen işlemler, araması / sıralaması
/ boş durumu olmayan listeler, girdiyi kaybeden formlar, ilerleme göstermeyen beklemeler, gereksiz tıklamalar, benzer
ekranlar arasındaki tutarsızlıklar, klavye ve ekran okuyucu boşlukları, 44 px altı dokunma alanları, kontrast, 390 px
sorunları, TR/EN eksikleri. Kural kaynağı: `ui-ux-pro-max` (geri alma, taslak, hata kurtarma, boş durum, oturum
uyarısı, odak dönüşü, dokunma alanı kuralları) ve WCAG 2.2 AA.

**Özet:** 34 bulgu — **yüksek 5**, **orta 17**, **düşük 12**. 22'si bu işte düzeltildi, 1'i kısmen, 11'i nedeniyle
bırakıldı (ikisi bilerek: güvenlik işlemleri beklememeli).

**En kötü beş:**
1. Güvenlik duvarında "Ayır" tek tıkla, onaysız ve geri alınamaz biçimde sunucunun korumasını kaldırıyordu.
2. Güvenlik duvarının kaynak adresleri tek satırlık alandı: satır satır yapıştırılan liste tek bir yanlış değere
   ("1.2.3.45.6.7.8") birleşiyordu.
3. Oturum çerezi girişten 12 saat sonra, kullanılsa da, uyarısız bitiyordu (aşağıda); çalışan kişi ancak bittikten
   sonra öğreniyordu.
4. Toplu silme onayı, yöneticinin bekleme süresi kapalıyken de "süre dolana kadar geri alabilirsiniz" diyordu; API
   onaydan sonra reddediyordu.
5. Uzun işlemler (oluşturma, boyut, yedek, geri yükleme) yalnızca adım adı ve belirsiz bir çubuk gösteriyordu: ne zaman
   başladığı, genellikle ne sürdüğü, uzayıp uzamadığı yoktu.

## Bulgular

Önem: **Y** yüksek (bir işi bozar ya da veri / korumayı tek tıkla kaybettirir), **O** orta (işi zorlaştırır, yanıltır),
**D** düşük (cila, tutarlılık).

| # | Bulgu | Önem | Durum |
|---|---|---|---|
| 1 | Güvenlik duvarı → Sunucular → "Ayır": onay yok, geri alma yok, koruma hemen kalkıyor (`firewalls/[id]/detail.tsx`). | Y | **Düzeltildi:** ayırma birkaç saniye "Geri al" ile bekliyor, istek ileti kapanınca gidiyor. |
| 2 | Güvenlik duvarı kaynakları (ve diğer tek satırlık liste alanları) satır satır yapıştırılan listeyi birleştiriyor. | Y | **Düzeltildi:** yapıştırmada satır sonları virgüle çevrilir ve bunu söyler (`repairPaste`). |
| 3 | "Beni hatırla" ile açılan oturumun çerezi girişten `SESSION_TTL_HOURS` (12) saat sonra bitiyor; istekler veritabanındaki oturumu uzatıyor ama çerezi yeniden yazmıyor. Önceden uyarı yok. | Y | **Düzeltildi:** bitişten 5 dk önce uyarı, "Oturumu açık tut" yalnızca tıklamayla uzatır (`POST /auth/stay`). Sabit bitişler (kullanıcı olarak gir, dizin/SSO, rol süresi) nedenini söyler, uzatma sunulmaz. |
| 4 | Toplu silme onayı bekleme süresi kapalıyken de geri alma vaat ediyor; API sonra `ACTION_DISABLED` ile reddediyor (`servers-ui.tsx` BulkBar). | Y | **Düzeltildi:** onay saati söylüyor; süre kapalıysa düğme yerine neden ve ne yapılacağı yazıyor. |
| 5 | 44 px'den küçük dokunma alanları: toplu etiket kaldırma (24 px), ek dosya kaldırma (20 px). | Y | **Düzeltildi:** dokunmatik ekranda 44 px alan (`.hit-44`), görünüş aynı. |
| 6 | Uzun işlemlerde geçen süre ve beklenen süre yok. | O | **Düzeltildi:** "Genellikle yaklaşık 2 dakika", "Her zamankinden uzun sürüyor", neye dayandığı; bitince süresiyle sonuç. |
| 7 | Anlık görüntüye dönüş veri kaybettiriyor ama yalnızca düz onay istiyor; neyin kaybolacağı kesin değil. | O | **Düzeltildi:** sunucu adı yazılarak onay; metin tarihi ve kaybolanları söylüyor. |
| 8 | SSH anahtarı, proje, güç zamanlaması ve hazır yanıt silme "emin misiniz?" diye soruyor; hepsi güvenle birkaç saniye bekleyebilir. | O | **Düzeltildi:** "Geri al" iletisi; geri alınanı API hiç görmez. |
| 9 | Sipariş formu siparişler arasında hiçbir şey hatırlamıyor. | O | **Düzeltildi:** yeni sipariş en yeni sunucunun konumu, imajı, paketi/boyutu ve projesiyle başlar ve bunu söyler; "Boş başla". |
| 10 | Sipariş taslağı güvenlik duvarı seçimini tutmuyor; SSH anahtarı eklemek için sayfadan çıkınca kayboluyor. | O | **Düzeltildi:** seçim taslakta (yalnız kimlikler). |
| 11 | "Benzerini sipariş et" önceki bir kopyalama taslağını (`cloneFrom`) temizlemiyor; proje taşınmıyor. | O | **Düzeltildi.** |
| 12 | Panel sunucusu yanıt vermezken listeler yoklamayı sürdürüyor (her biri bir yeniden deneme ile), yeniden deneme düğmesi yok. | O | **Düzeltildi:** yoklama duraklar, tek bir istek 2–30 sn aralıkla dener, "Şimdi dene"; dönünce sayfa yenilenmeden sürer. |
| 13 | Bağlantı yokken gönderilen bir değişiklik (React Query'nin "çevrimdışı" durumunda) beklemeye alınıp sonra kendiliğinden çalışabilirdi. | O | **Düzeltildi** (bu iş sırasında bulundu): değişiklikler hemen başarısız olur, neden söylenir, form yazılanı tutar (`networkMode: 'always'`). |
| 14 | Yönetici başlangıç listesi ödeme yöntemi, yedek zamanlaması, izleme, güncellemeler, personelin iki adımlı doğrulaması ve e-postanın gerçekten gidip gitmediğini bilmiyor; kapatılamıyor. | O | **Düzeltildi:** "Sağlıklı tutar" adımları gerçek durumdan; "Bir şey değişene kadar gizle", bozulan adım listeyi geri getirir. |
| 15 | Çevirisi olmayan bir hata kodu ve kodsuz yanıtlar (vekil/ağ geçidi sayfası) "Bilinmeyen bir hata oluştu" oluyor: neden ve sonraki adım yok. | O | **Düzeltildi:** kod adıyla söylenir, kodsuz yanıt HTTP durumuyla ve ne yapılacağıyla (`lib/error-key.ts`). |
| 16 | Yönetici sunucu listesi boşken müşteri cümlesini ("Henüz sunucunuz yok") gösteriyor. | O | **Düzeltildi:** yöneticiye göre boş ve süzgeçli boş durum. |
| 17 | Servis çekmecesinde yeniden başlatma onayı iptal edilince odak sayfaya düşüyor; ardından Escape çekmeceyi kapatmıyor. | O | **Düzeltildi:** onay penceresi kapanınca odak onu açan düğmeye döner (`returnFocus`). |
| 18 | Sunucu listesinin hızlı menüsünden açılan Yeniden adlandır / Sil pencereleri kapanınca odak sayfaya düşüyor. | O | **Düzeltildi:** odak "…" düğmesine döner. |
| 19 | SSH anahtarı alanı sk- (güvenlik anahtarı), PuTTY, SSH2 biçimi ve özel anahtar için genel "geçersiz" diyor; bölünmüş anahtar bozuluyor. | O | **Düzeltildi:** tür ve boyut gösterilir, özel anahtar anında uyarılır, SSH2 biçimi ve bölünmüş anahtar tek satıra çevrilir. |
| 20 | Uzun yönetici formları (ayarlar sekmeleri, katalog, kullanıcı oluşturma, VMware bağlantısı) yenilemede taslak tutmuyor; seçim kutuları ve anahtarlar kaydedilmemiş değişiklik sayılmıyor. | O | **Bırakıldı:** bu formların çoğu sır taşır (parola, API anahtarı); güvenli bir alan listesi çıkarmak ayrı bir iş. Metin alanları zaten ayrılırken soruluyor. |
| 21 | Başarısız boyut değiştirme / yeniden kurulum / geri yükleme / yedek müşteriye yalnızca destek yolunu gösteriyor. | O | **Bırakıldı:** API yeniden denemeyi `operations.retry` yetkisine bağlıyor (kota, fatura ve kilit kuralları); personelde var. |
| 22 | Anlık görüntü, yedek, SSH anahtarı, API anahtarı, proje listelerinde arama/sıralama yok; fatura listesinde sıralama yok. | O | **Bırakıldı:** listeler kısa (sınırlı sayıda kayıt); ayrı iş. |
| 23 | Kullanıcı listesi hiç kullanıcı yokken "Eşleşen kullanıcı yok" diyor. | D | **Düzeltildi.** |
| 24 | Kupon kopyalama, konum ping düğmesi, etiket × düğmesi 28 px. | D | **Düzeltildi** (`.hit-44`). |
| 25 | Katalog boş durumları ("Henüz paket yok") yeni oluşturma düğmesini anmıyor (düğme hemen üstünde). | D | **Bırakıldı:** düğme aynı satırda görünür. |
| 26 | vCPU, "RAM (MB)", IP, MoRef, MAC gibi teknik etiketler çeviri dosyası dışında. | D | **Bırakıldı:** iki dilde de aynı teknik terimler. |
| 27 | Komut paletinde yönetici eylemleri ve ayar sekmeleri yok. | D | **Bırakıldı.** |
| 28 | Sabitleme yalnızca sunucularda (yıldız); talep ve kişi sabitlenemiyor. | D | **Bırakıldı:** son açılanlar palette ve karşılamada zaten var. |
| 29 | Ayarlar → Genel'in iki adımlı doğrulama sayısı yalnızca `admin` rolünü sayıyor. | D | **Kısmen:** başlangıç listesindeki yeni adım bütün personeli sayar; genel bakış kartı aynı kaldı. |
| 30 | VMware bağlantı ayrıntısında yükleme hatası düz metin, yeniden deneme yok. | D | **Bırakıldı.** |
| 31 | Sayı alanları birimli yazımı ("4 GB") almıyor. | D | **Bırakıldı:** alanlar birimi kendi gösteriyor; çevirme yanlış anlaşılmaya açık. |
| 32 | Güvenlik sayfasında tek bir oturumu kapatmak onaysız. | D | **Bırakıldı (bilerek):** oturum kapatmak bir güvenlik işlemi, beklemeden olmalı. |
| 33 | API anahtarı silme onay istiyor (geri alma değil). | D | **Bırakıldı (bilerek):** sızan anahtarın iptali beklememeli. |
| 34 | Başlangıç listesi "Getting started" adımlarının hepsi bitince tamamen kayboluyordu; sonradan bozulan bir şey (yedek, e-posta) görünmüyordu. | D | **Düzeltildi** (14 ile). |

## Kararlar

- **Geri alma ve denetim kaydı:** kaldırma isteği ileti kapanınca gönderilir; "Geri al" basılırsa hiç gönderilmez.
  Bu yüzden denetim kaydı **yalnızca gerçekleşen sonucu** yazar; geri alınan bir kaldırma API'ye hiç ulaşmaz.
  Yetki, kota, kilit ve denetim aynen eski isteğin kurallarıdır. Sekme kapanırken bekleyen kaldırmalar `keepalive` ile
  gönderilir. Geri alınamayanlar (sunucu silme, yedekten geri yükleme, anlık görüntüye dönme, yeniden kurulum) adı
  yazılarak onaylanır ve neyin kaybolacağını söyler.
- **Taslaklar:** yeni bir taslak deposu eklenmedi. Uzun metinler (talep, itiraz, olay, toplu ileti) zaten taslak
  tutuyor; oturum biterken panelin kişi verisini tarayıcıdan silmesi (paylaşılan bilgisayar) bilerek korundu. Süre
  dolarken yazılan metin ekranda kalıyor (mevcut "oturum doldu" penceresi). Sipariş taslağı artık güvenlik duvarı
  seçimini de tutuyor; parola, anahtar, kart hiçbir taslakta yok.
- **Hatırlanan seçimler** tarayıcıya yazılmıyor: sipariş formu sayfanın zaten okuduğu sunucu listesinden çıkarıyor.
- **Oturum:** kendiliğinden hiçbir şey uzatılmıyor. Uyarı `/auth/me`'nin zaten dakikada bir okunan yanıtından
  hesaplanıyor; yeni bir yoklama yok.

Ayrıntılar ve neyin neye dayandığı: [smart-features.md](smart-features.md#günlük-işi-kolaylaştıranlar).
