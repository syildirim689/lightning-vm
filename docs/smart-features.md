# Akıllı yardımcılar

Bu sayfadaki her şey **kural tabanlı ve istatistikseldir**; panelin kendi veritabanındaki verilerden, panelin içinde
hesaplanır. Dışarıdaki bir yapay zekâ ya da başka bir servis kullanılmaz, kurulumdan hiçbir veri çıkmaz. Her öneri
neden gösterildiğini (arkasındaki sayıları) söyler ve gizlenebilir. Bir müşterinin sunucusunda değişiklik yapan her
öneri, yetkisi olan birinin açık tıklamasıyla çalışır; panel kendiliğinden hiçbir şey yapmaz.

İlk küme (doğru boyutlandırma, sağlık puanı, bu ayın maliyeti, içgörüler) için bkz.
[operations-modules.md](operations-modules.md#akıllı-özellikler). Bu sayfa sonradan eklenenleri anlatır.

## Olağan dışı kullanım

Bir sunucunun işlemci ya da ağ kullanımı **kendi yakın geçmişinden** keskin biçimde ayrıldığında bir bulgu açılır.
Başka sunucularla karşılaştırma yapılmaz.

- **Nerede hesaplanır:** worker, saatte bir (`apps/worker/anomalies.mjs`; kurallar `apps/worker/anomaly-rules.mjs`,
  birim testleri `apps/worker/test/anomaly-rules.test.mjs`). Aralık `ANOMALY_MINUTES` ile değişir (varsayılan 60).
  Yedekten geri yükleme beklemesi sürerken çalışmaz.
- **İşlemci:** son 3 tam saatin saatlik ortalamalarının medyanı, önceki 14 günün **günün aynı saatleriyle** (±1 saat)
  karşılaştırılır. Saatler UTC'dir; yaz saati geçişi yerel düzeni bir saat kaydırır, ±1 saatlik bant bunu karşılar.
  - Yayılım, medyan mutlak sapmadan (MAD × 1,4826) hesaplanır ve 5 puandan küçük alınmaz: düz çalışan bir sunucuda
    küçük bir oynama bulgu olmaz.
  - **Açılır:** sağlam z-puanı ≥ 4 **ve** olağandan en az 20 puan yüksek. **Kapanır:** z < 2 ya da fark < 10 puan.
    İki eşik arasındaki değer açık bulguyu açık tutar, yeni bulgu açmaz (titreme olmaz).
  - **Olağandan düşük:** yalnızca olağanı en az %15 olan sunucuda; son saatler olağanın %20'sine ya da altına
    indiğinde açılır, %50'sine çıkınca kapanır (çalışan bir hizmet durmuş olabilir).
  - 3 saatin en az 2'sinde ölçüm olmalıdır; tek saatlik sıçrama bulgu değildir.
  - **En az geçmiş:** önceki 4 ayrı günden toplam 12 saat. Daha azında sonuç "yeterli veri yok"tur.
- **Ağ:** panel trafiği gün gün tutar. Bugünün şimdiye kadarki toplamı ile dünün toplamından büyüğü, ondan önceki 14
  günün medyanıyla karşılaştırılır. En az 7 gün gerekir. **Açılır:** en az 5 GiB, olağan günün en az 3 katı ve z ≥ 4
  (yayılım en az 1 GiB ve olağanın %25'i). **Kapanır:** z < 2.
- **Kalıcı değişiklik:** kullanım günlerce yeni düzeyinde kalırsa taban onu öğrenir ve bulgu kendiliğinden kapanır
  (yaklaşık bir hafta).
- **Ölçüm vermeyen platformlar:** XCP-ng, oVirt, libvirt ve Incus işlemci ölçümü bildirmez; bu sunucular için hiçbir
  sonuca varılmaz ve sunucu sayfası bunu açıkça söyler. Trafik satırı hiç olmayan sunucunun ağı da yargılanmaz.
- **Müşteri:** sunucu sayfasında "Kullanım takibi" bölümü (bulgunun sayıları, ne zamandan beri, 7 gün gizle) ve genel
  bakıştaki içgörüler (`USAGE_ANOMALY_CPU_HIGH`, `USAGE_ANOMALY_CPU_LOW`, `USAGE_ANOMALY_NETWORK_HIGH`). Bulgu
  açıldığında bir kez `server.usage_anomaly` bildirimi gider (varsayılan: yalnız panel; kullanıcı e-posta ve diğer
  kanalları Hesap → Bildirimler'den açabilir). Gizleme içgörülerin kendi gizlemesidir; yeni bir bulgu yeni
  anahtardır, eski gizleme onu saklamaz.
- **Personel:** Yönetim → Kötüye kullanım → "Olağan dışı kullanım" sekmesi (`GET /admin/anomalies`,
  `servers.view_all`) ve özet içgörüsü `USAGE_ANOMALIES`. Sayılar kötüye kullanım izlemenin aradığına benziyorsa not
  düşülür: işlemci %90 ve üstünde ("madenciliğe benziyor") ya da trafiğin en az %90'ı giden ("saldırı trafiğine
  benziyor"); aynı sunucudaki açık kötüye kullanım bulguları da sayılır. Bu liste istatistiktir: kötüye kullanım
  bulgusu **oluşturmaz**, o modülün kendi denetimleri ve onay akışı aynen sürer.
- **Arka plan maliyeti:** her çalışmada (1) son toplanan saatten bu yana gelen ham örnekler okunup saatlik satırlara
  yazılır (`server_cpu_hourly`, 63 gün tutulur; ham örnekler 14 gün), (2) 200'er sunuculuk gruplar hâlinde her
  sunucunun en çok 15 × 24 saatlik satırı ve 16 günlük trafik satırı okunur. Kapanan bulgular 90 gün sonra silinir.
