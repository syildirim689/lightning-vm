# Önerilen adlar

Panel, yeni bir şey oluştururken boş bir ad/etiket alanı bırakmaz: ne oluşturulduğundan çıkarılabilen bir öneri
yazar. Öneri yalnızca bir başlangıçtır; düzenlenebilir ve hiçbir zaman zorunlu değildir.

## Kurallar

- **Öneri, düzenlenebilir bir değerdir.** Alana yazılır, alanın altında "Panelin önerisi; yazdığınız onun yerine
  geçer." der. Alana girilince metnin tamamı seçilir, yazmaya başlayınca öneri gider. Önerinin dayandığı şey
  değişirse (erişim düzeyi, yapıştırılan anahtar, seçilen konum) öneri de değişir; **kişi bir kez yazdıktan sonra**
  (alanı boşaltmak da buna dahil) alana bir daha dokunulmaz. Gönderilen form boşaldığında yeni bir öneri gelir.
- **Doldurmanın yanlış olacağı yerde** (destek talebinin konusu) alan boş kalır; öneri alanın altında tek tıkla
  alınabilen bir düğmedir.
- **Var olan hiçbir şeyin adı değişmez.** Düzenleme formlarında öneri yoktur.
- **Benzersizdir:** kişinin aynı türden kayıtlarında aynı ad varsa (büyük/küçük harf ve boşluklar yok sayılır) sonuna
  " 2", " 3"… eklenir; sunucu adlarında "-1", "-2"…
- **Panelin dilindedir;** Türkçe ve İngilizce kelimeler karışmaz. Dile bağlı olmayan öneriler (tarih, adres, anahtar
  açıklaması, port adı) iki dilde aynıdır.
- **Alanın kurallarına uyar:** uzunluk sınırı (ad kısaltılır, numara korunur), izin verilen karakterler (sunucu adı
  `a-z 0-9 -`, 63 karakter; anlık görüntü adı API'nin kuralı).
- **Başkalarının görebileceği bir kayda** o ekranın zaten gösterdiğinden fazla kişisel bilgi konmaz (proje adı
  yalnızca "Proje 1"; komut adı komutun kendisinden).
- **Tarayıcı bilgisi yalnızca tarayıcıda okunur:** passkey önerisi için `navigator.userAgentData` (yoksa
  `navigator.userAgent`) cihazda okunur; sunucuya yalnızca kişinin kaydettiği ad gider.
- Tarihli adlar sıralanabilir biçimdedir: `2026-11-23 14:05` (yerel saat).

Kod: `apps/web/lib/proposals.ts` (öneriyi üreten saf işlevler, birim testleri `proposals.test.ts`),
`apps/web/lib/use-proposal.ts` (alanı öneride tutan kanca), `TextInput`'un `proposed` ve `suggestions` özellikleri
(`apps/web/components/ui.tsx`). Sunucu tarafı: `apps/api/src/labels.ts` (birim testleri `test/labels.test.mjs`).
Önerideki kelimeler `messages/*.json` → `Proposals`.

## Nerede, hangi kural

| Yer | Alan | Öneri |
| --- | --- | --- |
| Hesabım → Güvenlik → Passkey | Ad | Tarayıcı · işletim sistemi · cihaz türü: "Chrome · Windows · Masaüstü" (bilinmeyen tarayıcı: "Tarayıcı · Masaüstü"). Kayıttan sonra tarayıcı passkey'in bir güvenlik anahtarında ya da telefonda olduğunu söylerse (WebAuthn `authenticatorAttachment` = `cross-platform`, `transports` içinde `hybrid` → telefon) ve kişi öneriyi değiştirmediyse ad buna göre düzeltilir: "Güvenlik anahtarı · Chrome · Windows". En çok 60 karakter, hesabın passkey'leri arasında benzersiz. |
| Passkey yöneticisinin gösterdiği ad (sunucu) | WebAuthn `rp.name`, `user.name`, `user.displayName` | `rp.name` panelin adı (Ayarlar → Markalama); `user.name` hesabın e-posta adresi; `user.displayName` kişinin adı, yoksa e-posta. better-auth `user.name` olarak passkey'in adını kullanıyordu; artık kullanmaz. |
| Hesabım → Güvenlik → İki adımlı doğrulama (sunucu) | Doğrulama uygulamasındaki ad (`otpauth://` URI) | Yayımcı (issuer) = panelin adı (iki nokta üst üste olmadan, en çok 64 karakter; boşsa "Lightning VM"), hesap = e-posta. Hem `Yayımcı:hesap` etiketine hem `issuer` parametresine yazılır, ikisi de yüzde kodlamalı (boşluk `%20`, `+` değil). Kurulum penceresi uygulamada nasıl görüneceğini söyler. |
| İki adımlı doğrulama → yedek kodlar | İndirilen dosyanın adı | `<panel-adı>-yedek-kodlar.txt` / `<panel-name>-backup-codes.txt` |
| Hesabım → API | Ad | Erişim düzeyi + gün: "Salt okunur anahtar 2026-11-23" / "Read-only token 2026-11-23"; erişim düzeyi değişince öneri de değişir. |
| Hesabım → API → Webhook (yeni) | Açıklama | Çağrılacak adresin sunucu adı: "hooks.example.com". |
| Hesabım → SSH anahtarları | Anahtar adı | Yapıştırılan anahtarın açıklaması ("serhat@laptop"); açıklama yoksa tür + parmak izinin başı: "ed25519 SHA256:Ab3dE9xQ". En çok 100 karakter. |
| Hesabım → Projeler | Proje adı | "Proje 1", "Proje 2"… (paylaşılan bir kayıt olduğu için kişisel bilgi yok). |
| Hesabım → Sohbet uygulamaları | Etiket | Uygulamanın adı: "Slack", ikincisi "Slack 2". |
| Sunucu → Anlık görüntüler | Ad | Sunucu adı + yerel tarih-saat: "web-1 2026-11-23 14:05" (API'nin karakter kuralı ve 80 karakter). Hazır adlar ("Güncelleme öncesi"…) tek tıkla önerinin yerine geçer. Başarısız işlemde "yeniden dene" düğmesi de aynı adı kullanır. |
| Sipariş, "benzerini sipariş et", "kopyala", sanal veri merkezi | Sunucu adı | Zaten vardı; tek yardımcıya taşındı: imajın ilk kelimesi + numara ("ubuntu-1"), "web-1-copy", veri merkezinin adı + numara. Türkçe harfler sadeleşir ("ışık" → "isik"), 63 karakteri ve kısa çizgiyle bitmemeyi garanti eder (63 karakterlik bir adın kopyası artık aynı adı önermez). |
| Güvenlik duvarları → Yeni | Ad | Başlangıç şablonu: "Web sunucusu", "Yalnızca SSH", "Windows RDP", boş şablonda "Güvenlik duvarı"; bir güvenlik duvarından kopyalanırken "<ad> (kopya)". |
| Güvenlik duvarı → kural | Açıklama | Portun hizmeti: "HTTPS", "PostgreSQL", "WireGuard"; bilinmeyen port "TCP 8000-8100", ICMP "Ping". Açıklama boşken ya da panelin verdiği addayken protokol/port değişince izler; yazılmış açıklamaya dokunulmaz. |
| Özel ağlar | Ad | Konum: "İstanbul özel ağı" / "Istanbul private network". |
| Konsol → kayıtlı komutlar | Ad | Komutun ilk satırı (zaten sunucunun boş ada uyguladığı kural, artık alanda görünür). |
| Destek → Yeni talep | Konu | **Doldurulmaz.** Mesaj yazılıp konu boşken mesajın ilk satırı (sunucu seçiliyse önünde sunucu adı) tek tıkla alınabilir bir öneri olarak gösterilir. |
| Yönetim → Katalog → Havuz (yeni) | Ad | Seçilen konumun şehri ya da adı. |
| Yönetim → Katalog → Paket (yeni) | Ad | Verdikleri: "2 vCPU · 4 GB · 40 GB"; boyutlar değişince izler. |
| Yönetim → Katalog → İmaj (yeni) | Ad | Seçilen şablonun adı. |
| Yönetim → Katalog → IP havuzu (yeni) | Ad | Havuz + alt ağ: "İstanbul-1 · 203.0.113.0/24". |
| Yönetim → Katalog → Konum (yeni) | Ad | Şehir · veri merkezi: "İstanbul · Equinix IL2". |
| Yönetim → Katalog → ISO kaynağı (yeni) | Ad | Protokol · adres: "SMB · nas.local". |
| Yönetim → Destek → Hazır yanıtlar (yeni) | Başlık | Yanıtın ilk satırı. |
| Yönetim → Sanallaştırma bağlantısı (yeni) | Ad | Adres ("vcenter.example.com"); ağ taramasından gelen ad varsa o. |

## Bilerek öneri konmayanlar

| Yer | Neden |
| --- | --- |
| Sunucunun, güvenlik duvarının ya da herhangi bir kaydın yeniden adlandırılması | Var olan bir adı panel değiştirmez. |
| Profil adı, kullanıcı adı, yönetici panelinde yeni kullanıcının adı | Kişinin kendi bilgisi; tahmin edilmez. |
| Markalama adı, bayi marka adı, şirket bilgileri, fatura ön eki | Kurulumun kimliği; yalnızca sahibi bilir. |
| Kupon kodu | Zaten tek tıkla rastgele kod üreten düğme var; pazarlama metni olduğu için alan boş başlar. |
| Ödeme sağlayıcısı etiketi | Boş bırakılınca sağlayıcının adı kullanılır ve yer tutucuda görünür; doldurmak bir şey eklemez. |
| Rol adı ve anahtarı | Ortak bir kalıp yok; kopyalanan rol zaten "(kopya)" adıyla gelir. |
| Sanal veri merkezi adı (yönetim) | Müşteriye özgü bir ad; müşterinin e-postasını öneriye koymak başkasına ait kişisel bilgiyi ada taşırdı. |
| Yedek notu | İsteğe bağlı bir not; yedek listesi zaten sunucuyu ve zamanı gösterir, aynı bilgiyi nota yazmak yalnızca tekrar olurdu. |
| Zamanlanmış anlık görüntülerin adı (`auto 2026-10-27 02:00`) | Sunucu üretir ve döndürme bu ön eke bakar; adı değiştirmek eski zamanlanmış görüntülerin silinmesini bozardı. Tarih zaten sıralanabilir biçimde. |
| Sanallaştırma bağlantısı adında benzersizlik | Form kurulum sihirbazında da kullanılıyor ve orada bağlantı listesi okunamıyor; öneri yalnızca adres. |
| Kayıtlı görünümler (liste filtreleri) | Filtreler adreste duruyor; okunabilir bir özet için her listenin kendi filtre sözlüğü gerekirdi. Alan bugünkü gibi boş başlar. |
| Duyuru metni, ban nedeni, iade nedeni, değerlendirme yorumu, transfer notu, sunucu notları | Serbest metin; tahmin edilecek bir ad değil. |
