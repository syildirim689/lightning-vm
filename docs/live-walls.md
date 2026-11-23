# Canlı ekranlar (live walls)

Bir TV'de, ikinci bir monitörde ya da bir NOC duvarında açık bırakılmak için yapılmış tam ekran, canlı sayfalar. Aynı
sayfa dizüstünde ve telefonda da çalışır. Bir motor (three.js), üç sahne: **Sistem**, **İstatistikler**, **Enerji**.

| Ekran | Adres | Nereden açılır | Kim açabilir (sayfasıyla aynı izin) |
|---|---|---|---|
| Sistem | `/wall/system` | Yönetim → Sistem → Sunucu durumu: "Her şey yolunda / N uyarı" yazısının hemen solundaki düğme | `system.view` |
| İstatistikler | `/wall/stats` | Yönetim → İstatistikler: başlığın sağındaki düğmelerin ilki | `dashboard.view` |
| Enerji | `/wall/energy` | Yönetim → Enerji: "Şimdi ölç" düğmesinin solu | `dashboard.view` veya `system.view` |

Giriş düğmesi küçük bir ekran simgesidir; ekran okuyucuya "Canlı ekranı aç (Sistem)" der, üzerine gelince ne
olduğunu yazar. Ekran aynı sekmede açılır; sol üstteki **Geri** düğmesi (ve `Esc`) ekranın ait olduğu sayfaya döner.
Herkese açık ya da anahtarla açılan bir adres **yoktur**: oturum gerekir (oturumu olmayan giriş sayfasına gider ve
girişten sonra ekrana döner), iki adımlı doğrulaması eksik hesap panele yönlendirilir, izni olmayan "403" görür ve
ekran hiçbir şey çizmez; API de her okumada aynı izni ister.

## Ne gösterir, sayılar nereden gelir

Ekrandaki her sayı, renk ve hareket panelin gerçek verisinden gelir; ölçümmüş gibi görünen süs yoktur. Yalnızca
sahnedeki toz zerreleri süstür ve hiçbir veriye bağlı değildir. Veri eskiyse ya da yoksa ekran bunu söyler:
çubuktaki "Güncellendi 14:05:10" yerini "14:03:55 saatinden beri yeni veri yok" (uyarı simgesiyle) alır, sahne gri
ve durgun çizilir; hiç yanıt gelmediyse değer "–" olur, sahnede o parça çizilmez.

Bir yanıt, istenme aralığının iki katı + 10 saniye içinde yenilenmediyse **eski** sayılır (`lib/wall-state.ts`
`freshness`).

### Sistem

- **Kabinler:** her ünite panelin bir servisidir (host ajanının anlık görüntüsü, `GET /api/admin/host/live` →
  `state.services`). Plakasında servisin adı ve sürümü yazar.
  - Çalışıyor / sağlıklı: yeşil sabit ışık; yanındaki mavi etkinlik ışığı, **servisin kendi işlemci kullanımıyla**
    orantılı hızda kırpışır (%0'da söner).
  - Sağlıksız, başlıyor, duraklatılmış: sarı, yavaş yanıp söner.
  - Çöktü, durdu, yeniden başlıyor: kırmızı, hızlı yanıp söner.
  - **Arıza yalnız renkle anlatılmaz:** arızalı ünite kabinden 9 cm dışarı çıkar, önünde sarı-siyah çizgili bir
    plaka ve "ARIZA" etiketi olur; rakamlar panelinde adı ve durumu yazıyla listelenir.
  - Bitmiş tek seferlik iş (migrate, çıkış kodu 0) arıza değildir: soluk sabit ışık.
  - Anlık görüntü bir saatten eskiyse bütün ışıklar söner ve yazı "eski bir anlık görüntü" der. Anlık görüntü,
    Yönetim → Sistem'in yaptığı gibi ekran açılınca (son görüntü iki dakikadan eskiyse ve ajan kuruluysa) bir kez
    istenir; ekran açık kaldıkça kendiliğinden yeniden istenmez (sayfa da istemez).
- **Göstergeler:** işlemci, bellek, veri diski ve yük için cam tüpler; dolgu değere göre yükselir, %75 ve %90'da
  (yük için çekirdek sayısının 1 ve 1,5 katında) uyarı ve tehlike halkaları vardır. Kaynak: aynı yanıtın `cpu`,
  `memory`, `disk`, `cpu.load` alanları (API her 5 saniyede bir `/proc`'tan okur).
- **Şeritler:** son on dakikanın işlemci, bellek ve yük geçmişi (`history`, 5 saniyelik 120 örnek).
- **Kabin üstü ışık** ve rakamlar panelindeki hüküm: Yönetim → Sistem'deki "N uyarı" ile aynı sayım (arızalı
  servisler, %90'ı geçen işlemci/bellek, dolu dosya sistemleri, inode, başarısız systemd birimleri, yük).
- **API ve worker satırı:** `GET /api/ready` ve `GET /api/admin/system` (worker yaşam sinyali), Yönetim → Sistem'deki
  "Sistem sağlığı" bölümüyle aynı.

### İstatistikler

Yönetim → İstatistikler'in dönemi (`GET /api/admin/stats?days=30&tz=…`, adres `?days=7|30|90|365` ile değişir):
her ölçü için bir sıra kule (oluşturulan ve silinen sunucular, yeni hesaplar, açılan ve kapanan talepler, başarılı ve
başarısız işlemler), her gün (yılda her hafta) bir kule, en eski solda. Her sıra **kendi en yüksek değerine** göre
ölçeklenir ve o değer sıranın sonunda "en çok N" olarak yazar; boş gün düz bir karodur, boşluk değil. Rakamlar paneli
sayfanın beş başlık rakamını (canlı sunucular, aylık tutar, yeni hesaplar, destek talepleri, başarılı işlemler)
önceki döneme göre değişimleriyle gösterir.

### Enerji

`GET /api/admin/power?range=1d` (Yönetim → Enerji'nin varsayılan aralığı):

- **Tesis çekirdeği:** iç ışığı şu anki gücün (son 15 dakikadaki örnekler) günün en yüksek saatine oranıyla
  parlar; üstünde tesis gücü (PUE dahil) ve hostların çektiği güç yazar.
- **Hostlar:** her host bir kabin; yüksekliği hostun şu anki gücünün en çok çeken hosta oranı. Çekirdeğe bir boru
  ile bağlıdır: borudaki ışık **hostun watt'ıyla orantılı hızda** akar, kalınlığı toplamdaki payıdır. Güç sayacı
  olan (ölçülen) hostun ışığı kesintisiz mavi; sayacı olmayan ve profilinden tahmin edilen hostunki kesik kesik
  turuncudur (yalnız renkle değil desenle de ayrılır). Son 15 dakikada örneği olmayan host ışık taşımaz. En çok 24
  host çizilir; fazlası "+N host daha" diye toplanır.
- **Çevre halkası:** son 24 saatin saatlik ortalama gücü.
- Son 15 dakikada hiç örnek yoksa hiçbir şey akmaz ve ekran "Son 15 dakikada güç örneği yok" der.
- Bu ekran için API'ye tek bir alan eklendi: `hosts[].lastAt` (hostun en yeni örneğinin zamanı, aynı sorguda
  `max(at)`), böylece "şimdi" ile "aralığın başında" host başına ayrılabiliyor. Yeni bir uç nokta eklenmedi.

## İstek yükü

Her ekranın **tek** bir yoklayıcısı vardır (`lib/wall-poller.ts`): sayfasının okuduklarını sayfasının hızında okur
(Sistem: `host/live` 5 sn, `ready` ve `admin/system` 15 sn; İstatistikler ve Enerji: 60 sn). Bir kaynağa aynı anda
ikinci istek gitmez; sekme gizliyken hiç istek gitmez (sekme görünür olunca vadesi gelen hemen istenir); hata sonrası
bekleme 2, 4, 8 katına çıkar (en çok 5 dakika); oturum bitti / izin yok / bulunamadı yanıtı o kaynağı elle
"Yeniden dene" denene kadar durdurur. İzleme yoklamaları (`/admin/maintenance/monitoring`, 3 saniyeye kadar süren
yoklamalar) ekranlarda kullanılmaz.

## Kalite katmanları ve 2B

Açılışta cihaza kısa bir bakış (`lib/wall-quality.ts`): WebGL 2, en büyük doku boyutu, bellek ve çekirdek sayısı,
dokunmatik küçük ekran ve çizicinin adı. Tarayıcının WebGL 2 bağlamını yalnızca "ciddi performans uyarısıyla"
vermesi ya da çizicinin adı (SwiftShader, llvmpipe, Microsoft Basic Render…) yazılım çizicisini gösterir.

| Katman | Ne zaman | Çözünürlük | Gölge | Bloom | Alan derinliği | MSAA | Ayrıntı | Hedef |
|---|---|---|---|---|---|---|---|---|
| Yüksek | masaüstü GPU, ≥ 8 GB, > 4 çekirdek | DPR ≤ 2 | yumuşak, 2048 | var | var (hafif) | 4× | tam | 60 fps |
| Orta | telefon/tablet, ≤ 4 GB ya da ≤ 4 çekirdek | DPR ≤ 1,5 | sert, 1024 | var | yok | 2× | %60 | 60 fps |
| Düşük | ≤ 2 GB, ≤ 2 çekirdek ya da doku < 4096 | DPR 1 | yok (yalnız temas gölgesi) | yok | yok | ekranın | %30 | sabit 30 fps |
| 2B | WebGL 2 yok, yazılım çizicisi, ya da 3B bir slayt gösterisine döndü | — | — | — | — | — | — | — |

Hiçbir katman 4K'dan fazla piksel çizmez (DPR 2'de 4K bir TV, 8K yerine 4K kadar piksel çizer).

**Çalışırken** kare süresi denetleyicisi (`lib/wall-governor.ts`) 60 karelik pencerelerin ortanca ve %90'lık kare
süresine bakar: hedefin 1,3 katını iki pencere aşarsa bir adım geri çekilir (sıra: alan derinliği → MSAA → %85
çözünürlük → bloom → sert gölge → gölgesiz ve az ayrıntı → %70 → %55 çözünürlük ve ayrıntısız). Hedefin üç katı
kötüyse tek pencere yeter. Altı iyi pencereden sonra bir adım geri gelir; hemen yine kötüleşirse bir sonraki deneme
iki kat bekler. Bütün adımlar alınmışken saniyede 20 karenin altında kalırsa ekran **2B'ye geçer** ve nedenini yazar
("3B'yi dene" ile geri dönülebilir). Adres `?quality=high|medium|low|2d` ile katman elle seçilir (yazılım
çizicisinde bile 3B için `low`; elle seçilen katmanda ekran 2B'ye kendiliğinden geçmez, adımlar yine alınır).
`?quality=…&hold=1` katmanı adımsız sabit tutar: kayıt ve ölçüm içindir ([validation.md](validation.md)'deki ölçümler böyle alındı).

**2B ekran** bir hata mesajı değildir: aynı rakamlar paneli, kabin yerine servislerin listesi (ışıklar, yanıp sönme,
çizgili arıza satırı ve "ARIZA" etiketi), sütun göstergeler ve SVG geçmiş; istatistiklerde sıra sıra çubuklar;
enerjide hostların gücü hızına göre akan çizgilerle (tahminiler kesik).

### Görünüm

Fiziksel tabanlı malzemeler (fırçalanmış metal kabinler, delikli ön paneller, cam tüpler ve kılıflar, cilalı maket
masası), kodda üretilen bir ortamdan görüntü tabanlı ışık (three.js `RoomEnvironment`, PMREM; dışarıdan HDR yok),
yumuşak gölgeler ya da her katmanda olan temas gölgesi, yalnız parlayan şeylerde bloom, ACES filmik ton eşleme. Bütün
dokular (yükseltilmiş döşeme, fırçalanmış metal, delikli panel, uyarı çizgileri) kodda çizilir; model, doku, yazı tipi
ya da logo dosyası yüklenmez, CDN kullanılmaz (panel özel ağlarda çalışır). Sahnedeki yazılar sayfanın kendi yazı
tipiyle tek bir doku atlasına çizilir; okunması gereken bütün değerler ise HTML'dir (keskin, 1080p'de 3 metreden
okunacak büyüklükte, `clamp()` ile 4K'ya kadar büyür). Varsayılan görünüm koyu "gece"; "gündüz" açık görünümü
düğmeyle seçilir ve bu tarayıcıda hatırlanır.

Kamera sahnenin çevresinde 2–3 dakikalık yavaş bir sürüklenmeyle döner (ekran yanığına karşı da); **Tur** açılırsa
her 18 saniyede bir ilgi noktasına yumuşakça geçer. "Daha az hareket" isteyen cihazda (ya da Erişilebilirlik
ayarında) kamera sabittir, tur kapalıdır, ışıklar yanıp sönmez, değerler kaymadan yerine oturur ve sahne yalnızca
veri değişince çizilir. Geniş ekranda sahnenin merkezi rakamlar panelinin sağına kaydırılır.

## Sağlamlık

- three.js ve sahneler yalnız 3B çizilecekse, ayrı bir parça olarak yüklenir; başka hiçbir sayfanın ilk JS'inde
  yoktur (ölçüm: [validation.md](validation.md)).
- Tek çizim döngüsü; örneklenmiş (instanced) ve birleştirilmiş geometri; karede yeni nesne oluşturulmaz (geçmiş ve
  etiket tamponları baştan ayrılır, sınırlıdır); hiçbir şey hareket etmiyorsa döngü uyur.
- Sekme gizliyken ya da tuval ekranda değilken çizim durur.
- `webglcontextlost`: ekran "yeniden çiziliyor" der ve yeni bir tuvalle yeniden kurar; bir dakikada iki kez olursa
  2B'de kalır.
- Ekrandan çıkınca geometriler, malzemeler, dokular, render hedefleri, gölge haritaları, ortam haritası ve dinleyiciler
  bırakılır ve WebGL bağlamı hemen geri verilir (`forceContextLoss`).
- **Açık tut** (varsayılan açık): Screen Wake Lock ile ekranın uyumasını önler; tarayıcı desteklemiyorsa sessizce
  hiçbir şey yapmaz ve Ayrıntılar'da bunu yazar.

## Klavye ve erişilebilirlik

| Tuş | İş |
|---|---|
| `F` | Tam ekran aç/kapat (Fullscreen API; desteklemeyen tarayıcıda düğme görünmez) |
| `Esc` | Sayfasına geri dön (tam ekrandayken önce tam ekrandan çıkar) |
| `←` `→` | Bu kişinin açabildiği diğer ekranlar |
| `T` | Tur (daha az hareket istenmişse kapalı) |
| `I` | Ayrıntılar: çizim ve katman, grafik kartı, kare hızı, geri alınan adım, tuval, çizim çağrısı, bellekteki nesneler |

Bütün denetimler etiketli düğmelerdir ve sekmeyle gezilir. Tuvalin sahneyi anlatan bir etiketi vardır; değerler,
durumlar ve arızalar HTML metnidir. Telefonda (390 px) sahne üstte, rakamlar altta; geniş ekranda rakamlar sahnenin
solunda yarı saydam bir panelde.

## Neden bu üç ekran (inceleme)

| Yer | Karar | Neden |
|---|---|---|
| Yönetim → Sistem | **Yapıldı** | 5 saniyede bir gerçekten değişen veri (işlemci, bellek, yük, geçmiş) ve servis durumu; NOC/TV için tam okuyucusu var. |
| Yönetim → İstatistikler | **Yapıldı** | Yönetimin duvarda görmek istediği büyüme ve işlem rakamları; dakikada bir yenilenir. |
| Yönetim → Enerji | **Yapıldı** | Host başına güç akışı doğal bir canlı görüntü; 5 dakikada bir örneklenir. |
| Yönetim → Genel bakış (pano) | Yapılmadı | Kartları başka sayfaların özetleri ve yapılacak işler; duvar için ayrı verisi yok, Sistem ve İstatistikler ekranları zaten kapsıyor. |
| Konum / hipervizör kapasitesi (Katalog, VMware) | Yapılmadı | Kapasite nadiren değişir (havuzlar 30 sn'de bir, çoğu sabit); canlı bir görüntü değişmeyen sayıyı hareketli gösterirdi. Topoloji sayfası bu ilişkiyi zaten çiziyor. |
| Müşterinin tek sunucusu | Yapılmadı | Canlı grafikler VMware'den 20 saniyelik örneklerle gelir ve her okuma vCenter'a gider; TV'de bırakılan bir ekran her izleyici için bu yükü sürekli eklerdi. Okuyucusu da tek bir sunucunun sahibi, duvar değil. |
| Bayi paneli | Yapılmadı | Tahsis ve müşteri sayıları; canlı değişen bir veri yok. |
| Herkese açık durum sayfası (`/status`) | Yapılmadı | Ekranlar oturum ve izin ister; herkese açık ya da anahtarlı bir ekran adresi istenmedi. Durum sayfası zaten kendi başına açık bırakılabilir. |

## Ekran görüntüleri

`docs/screenshots/walls/` (geliştirme makinesinde yerel yığın; **grafik kartı olmayan bir sanal makine**, Chrome'un
yazılım çizicisi WARP ile `?quality=high&hold=1`, yani yüksek katmanın görünüşü, saniyede 1 karenin altında çizilerek).
Sistem ekranındaki işlemci, bellek, yük ve geçmiş API'nin WSL içindeki gerçek `/proc` okumasıdır; servis listesi
hazırlanmış bir host ajanı anlık görüntüsüdür (bu makinede Docker yok). İstatistik ve Enerji görüntülerindeki rakamlar
**örnek veridir** (yerel yığında VMware ve geçmiş yok); yanıtın biçimi API'ninkiyle aynıdır.

| Görüntü | Dosya |
|---|---|
| Sistem, TR, gece, 1920×1080 | `wall-system-tr-1920.jpg` |
| İstatistikler, TR, gece, 1920×1080 | `wall-stats-tr-1920.jpg` |
| Enerji, TR, gece, 1920×1080 | `wall-energy-tr-1920.jpg` |
| Sistem / İstatistikler / Enerji, EN, 390 px | `wall-system-en-390.jpg`, `wall-stats-en-390.jpg`, `wall-energy-en-390.jpg` |
| 2B ekran (Sistem gece, İstatistikler gündüz, Enerji gece), EN | `wall-system-2d.jpg`, `wall-stats-2d-day.jpg`, `wall-energy-2d.jpg` |
| Sistem, EN, gündüz | `wall-system-day.jpg` |

## Kod

- Rotalar: `apps/web/app/(wall)/layout.tsx` (oturum), `apps/web/app/(wall)/wall/[scene]/page.tsx` (izin, 403).
- İzinler ve adresler: `apps/web/lib/wall-scenes.ts`. Giriş düğmesi: `apps/web/components/wall/wall-link.tsx`.
- Saf mantık ve birim testleri: `lib/wall-quality.ts`, `lib/wall-governor.ts`, `lib/wall-state.ts`,
  `lib/wall-poller.ts` (`*.test.ts`).
- Kabuk, rakamlar, 2B: `components/wall/wall.tsx`, `figures.tsx`, `flat.tsx`, `hooks.ts`.
- 3B: `components/wall/stage.tsx` (tuval, bağlam kaybı), `three/engine.ts` (çizici, döngü, denetleyici, efektler),
  `three/kit.ts` (kodda üretilen dokular, etiket atlası, temizlik), `three/system.ts`, `three/stats.ts`,
  `three/energy.ts`.
- Tarayıcı testleri: `apps/web/e2e/wall.spec.ts`. Çeviriler: `messages/*.json` → `Wall`.
- Bağımlılık: `three` 0.187.0 (MIT) ve yalnız geliştirmede `@types/three` 0.187.0 (MIT).
