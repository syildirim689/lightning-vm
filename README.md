<div align="center">

<img src="docs/screenshots/logo.svg" width="72" height="72" alt="">

# Lightning VM

**VMware, Proxmox VE, XCP-ng, oVirt, Hyper-V, KVM (libvirt) ve Incus / LXD için açık kaynak sunucu satış ve yönetim paneli**

Müşteriler sunucu sipariş eder, açar, kapatır, yeniden kurar; yönetici kapasiteyi, IP'leri, fiyatları,
bildirimleri ve sistemin kendisini tek panelden yönetir. Kurulumdan sonraki günlük işlerin çoğu için sunucuya SSH ile
girmeniz gerekmez. Özelliklerin tamamı yalnızca VMware'de vardır; diğer altı platformun neyi yapıp neyi yapmadığı
[Platform kapsamı](#-platform-kapsamı) tablosundadır.

![Durum](https://img.shields.io/badge/durum-geli%C5%9Ftirme%20s%C3%BCr%C3%BCm%C3%BC-orange)
![Lisans](https://img.shields.io/badge/lisans-Apache--2.0-blue)
![Next.js](https://img.shields.io/badge/Next.js-16-black)
![NestJS](https://img.shields.io/badge/NestJS-Fastify-e0234e)
![Go](https://img.shields.io/badge/Go-govmomi-00add8)
![vSphere](https://img.shields.io/badge/vSphere-6.0%E2%80%939.x-607078)
![Yapay zekâ ile yazıldı](https://img.shields.io/badge/yaz%C4%B1ld%C4%B1-Claude%20Code%20ile-d97757)

[Özellikler](#-özellikler) · [Platform kapsamı](#-platform-kapsamı) · [Son eklenenler](#-son-eklenenler) · [Ekran görüntüleri](#-ekran-görüntüleri) · [Kurulum](#-kurulum) · [Kullanım](#-ilk-adımlar) ·
[Mimari](#-mimari) · [Geliştirme](#-geliştirme-ve-testler) · [Bilinen sınırlar](#-bilinen-sınırlar) · [Güvenlik](#-güvenlik) · [English](#-english-summary)

</div>

---

> [!WARNING]
> **Bu proje "vibe coding" ile, yapay zekâ ile birlikte yazıldı.** Kodun neredeyse tamamı
> [Anthropic'in Claude Code](https://claude.com/claude-code) aracıyla, proje sahibinin yönlendirmesi, istekleri ve
> testleriyle üretildi. Her değişiklik birim, entegrasyon ve uçtan uca (Playwright) testlerden geçirilip bir
> demo sunucuda denendi; yine de **hatalar, eksikler ve güvenlik açıkları olabilir.** Bağımsız (üçüncü taraf) bir
> güvenlik denetiminden geçmedi; yapay zekâ destekli, kısmi bir güvenlik denetimi iki tur hâlinde yapıldı ve
> bulguları düzeltildi ([Güvenlik](#-güvenlik)). VMware tarafı gerçek vCenter/ESXi yerine çoğunlukla govmomi simülatörüyle test edildi.
> Üretimde, gerçek müşterilerle ve gerçek parayla kullanmadan önce kendi ortamınızda deneyin, yedek alın ve
> kodu inceleyin. Bulduğunuz hataları [issue](https://github.com/syildirim689/lightning-vm/issues) olarak
> bildirmeniz çok değerli.

## ✨ Özellikler

<table>
<tr><td valign="top" width="50%">

### Müşteri paneli
- **Akıllı sipariş:** paket veya özel kaynak, uygun olmayan paketler gerekçesiyle, en uygun paket, ad önerisi,
  canlı fiyat ve kota kontrolü; yapılandırmanın **paylaşılabilir bağlantısı** (yalnız konum, imaj, plan ve ödeme
  dönemi; ad, SSH anahtarı ve parola bağlantıya girmez, değerler katalogla denetlenir)
- **Sunucu yönetimi:** aç / kapat / yeniden başlat, silme onayı, işlem geçmişi, CPU-RAM-disk-ağ grafikleri
  (grafikler yalnız VMware ve Proxmox'ta dolar); listedeki kartın menüsünden ad değiştirme, kilitleme / kilidi açma
  ve silme
- **Yeniden kurulum, boyut değiştirme, kopyalama:** aynı adresler ve anahtarlarla başka imaj; paket ya da özel boyut
  (disk yalnızca büyür, fark gün hesabıyla, çok aylı dönemlerde kalan ayların tamamı için faturalanır); bir sunucunun
  diskiyle birlikte kopyası. Yeniden kurulum penceresi imajın neye dönüşeceğini, neyin kalacağını ve neyin
  silineceğini önceden özetler
- **Tarayıcı konsolu** ve **ISO bağlama** (ikisi de yalnız VMware'de), root parolası, uygulama kurulumu (cPanel, Plesk…)
- **Anlık görüntüler** (snapshot), **ek diskler**, **güç zamanlaması**, etiketler ve notlar; **yedekler** ve geri
  yükleme ile **kişisel imajlar** (sunucuyu imaj olarak kaydedip ondan sipariş verme) yalnız VMware'de
- **Silmede bekleme süresi:** silinen sunucu önce kapatılır ve ayarlanan süre (varsayılan 24 saat) sonunda silinir;
  o zamana kadar geri alınabilir. **Sunucu kilidi** silmeyi, zorla kapatmayı, yeniden kurmayı, boyut değiştirmeyi ve
  geri yüklemeleri engeller. **Favoriler** sık kullanılan sunucuları işaretler
- **Sunucuyu başka hesaba devretme:** e-postayla teklif edilir, karşı taraf 7 gün içinde kabul ederse aboneliğiyle
  geçer. Devirde kayıtlı SSH anahtarları, root parolası, etiketler, notlar ve zamanlamalar temizlenir; önceki
  sahibin abonelikte kaydettiği dönem sonu iptali ve otomatik yenileme tercihi sıfırlanır; yedekler yeni sahibe geçer
- **Trafik kotası:** günlük giriş-çıkış sayımı, %80 ve %100'de uyarı (sayım VMware ve Proxmox'ta); kota dolunca hız
  sınırlama yalnız VMware'de (dağıtık anahtar)
- **İşletim sistemi güncellemeleri:** sunucunun içindeki bekleyen ve güvenlik güncellemeleri, "yalnız haber ver / güvenliği kur /
  hepsini kur" politikası, seçilen saatte otomatik yeniden başlatma (Linux: apt, dnf, yum)
- Faturalar ve ödeme, **saatlik kullanım** (bakiyeden; bakiye bitince bekletme, ay sonunda kullanım faturası),
  **aylık bütçe uyarısı** (aylık gidiş bütçeyi aşınca ayda bir bildirim; siparişte önceden uyarı), destek talepleri.
  Genel bakışta **Yaklaşan ödemeler:** vadesi geçmiş ya da 7 gün içinde dolacak faturalar, sıradaki yenileme ve
  saatlik kullanımda bakiyenin ne zaman biteceği
- **Komut paleti (Ctrl+K):** sayfa, sunucu, destek talebi ve fatura arama; son açılan sunucular, talepler ve
  faturalar; hızlı işlemler (yeni destek talebi, bakiye yükleme, yeni sunucu, SSH anahtarı ekleme, onay sorarak
  sunucuyu sıfırlama)
- **API anahtarları ve API belgeleri:** arama, süzgeçler, örnek istekler, OpenAPI ve PDF indirme (istekler tarayıcıdan
  çalıştırılamaz). **Webhook'lar:** imzalı, yeniden denenen, teslimat kaydı ve sınama düğmesiyle
- **Verilerimi indir:** hesabın panelde tutulan verileri tek JSON dosyası olarak (parola, oturum ve gizli anahtarlar hariç)
- **Özel ağlar** ve **firewall** şablonları (ikisi de yalnız VMware'de, dağıtık anahtarla), ters DNS (PTR), SSH
  anahtarları (GitHub'dan içe aktarma)
- **Sanal veri merkezi (VDC)** ve ağ topolojisi görünümü
- Sunucu sağlık puanı, aylık maliyet tahmini, hızlı bağlantı bilgileri; adres ve PTR için kopyalama düğmeleri
  (kopyalama düz HTTP'de de çalışır, kopyalanamadıysa bunu söyler); 30 günden eski anlık görüntüler için öneri

</td><td valign="top" width="50%">

### Yönetici paneli
- **Incus / LXD bağlantıları (ilk sürüm, gerçek Incus 6.0'da konteynerlerle denendi):** sanal makineler ve sistem konteynerleri, imaj deposundan; Incus'un kendi cloud-init desteğiyle ([docs/incus.md](docs/incus.md))
- **KVM (libvirt) bağlantıları (ilk sürüm):** düz bir Linux KVM hostu, SSH üzerinden `virsh` ile; hosta hiçbir şey kurulmaz ([docs/libvirt.md](docs/libvirt.md))
- **Microsoft Hyper-V bağlantıları (ilk sürüm):** WinRM üzerinden PowerShell ile; cloud-init yapılandırma diskiyle ([docs/hyperv.md](docs/hyperv.md))
- **oVirt / RHV bağlantıları (ilk sürüm):** Engine'in kendi cloud-init desteğiyle ([docs/ovirt.md](docs/ovirt.md))
- **XCP-ng / XenServer bağlantıları (ilk sürüm):** havuz ya da tek host; cloud-init'in tamamı yapılandırma diskiyle ([docs/xcpng.md](docs/xcpng.md))
- **Proxmox VE bağlantıları (ilk sürüm):** düğüm ya da küme; keşif, şablondan sunucu oluşturma, güç, boyut, anlık görüntü, ek disk ([docs/proxmox.md](docs/proxmox.md))
- **ESXi / vCenter bağlantıları:** envanter keşfi, kapasite, lisans ve yetki kontrolü; IP bloğu tarayarak ağdaki ESXi/vCenter'ları bulma, tek tıkla ekleme ve günlük/haftalık otomatik tarama
- **Katalog:** kaynak havuzları, fazla tahsis oranları, paketler, imajlar, konumlar (bakım modundaki konum yeni
  sunucu almaz), IPv4 havuzları. IPv6 ayrı bir havuz değildir: IPv4 havuzuna isteğe bağlı bir önek eklenir ve her
  sunucu o önekten **tek** adres alır
- **Mevcut VM'leri devralma:** panel dışında oluşturulmuş bir VM, bir müşterinin sunucusu olur (çalışmaya devam eder)
- **Taşıma ve host boşaltma** (yalnız VMware): sunucuyu çalışırken başka hosta ya da veri deposuna taşıma, bakım
  öncesi bir hosttaki tüm sunucuları taşıma
- **İçgörüler:** dolan havuz tahmini, azalan IP, boşta / büyük / küçük sunucular, takılan işler, inceleme bekleyen
  ödemeler, geri yükleme beklemesi, sonucu belirsiz kalıp karar bekleyen işlemler (boşta / büyük /
  küçük sunucu ve sağlık puanı işlemci ölçümüne dayanır; XCP-ng, oVirt, KVM ve Incus'ta işlemci ölçülmediği için
  oralarda anlamlı değildir)
- **Kullanıcılar ve roller:** izin tabanlı roller, kişiye özel izinler, kullanıcı adına giriş, yasaklama. **Rol
  sınırları:** kota, snapshot / firewall / SSH anahtarı sayısı, saatlik işlem sayısı, oturum süresi, iki adım
  zorunluluğu, izinli konumlar ve izinli IP adresleri. Kullanıcıya **ekip notları** (müşteri görmez, sabitlenebilir)
- **Kötüye kullanım:** açık riskli port taraması, madencilik şüphesi (uzun süreli tam CPU; işlemcinin ölçüldüğü
  platformlarda); sekme, arama ve süzgeç adreste tutulur
- **Menüde sayaçlar:** Faturalandırma (inceleme bekleyen ödemeler), Sunucular (son 24 saatte başarısız işlemler) ve
  Kötüye kullanım (açık bulgular) girişlerinin yanında; geri yükleme beklemesi personele her sayfanın üstünde görünür
- **Enerji raporu:** kWh, maliyet ve karbon tahmini (işlemci kullanımından hesaplanır; XCP-ng, oVirt, KVM ve
  Incus'ta anlamlı değildir)
- **Genel bakışta özet:** son bakışınızdan beri yeni kullanıcı, sunucu, başarısız işlem, kötüye kullanım bulgusu,
  alarm ve reddedilen / başarısız giriş sayıları
- **Herkese açık durum sayfası** (`/status`): panelin parçalarının ve konumların durumu; yönetici olay (incident)
  açar ve güncelleme yazar
- **İstatistikler:** önceki döneme göre eğilimli KPI’lar, zaman serileri, konum/işletim sistemi/paket kırılımı, en büyük müşteriler ve gün × saat işlem haritası (animasyonlu)
- **Denetim kaydı**, duyuru bandı, toplu sunucu işlemleri
- **Destek sistemi:** öncelik ve SLA, departmanlar, iç notlar, değişkenli hazır yanıtlar, puanlama ve kapanışta memnuniyet isteği; müşteri yanıtlarında hız sınırı, art arda yanıtlar için tek bildirim
- **Sunucu terminali** (iki adımlı doğrulama zorunlu) ve **panelden güncelleme**
- **Sunucu durumu:** panelin çalıştığı sunucunun canlı işlemci, bellek, yük ve disk grafikleri; servisler, dosya
  sistemleri, en çok kaynak kullanan süreçler ve her servisin günlükleri (arama, yalnız sorunlar, indirme; günlükleri
  yalnızca yöneticiler görür, URL'deki belirteçler maskelenir)
- **İşletim sistemi güncellemeleri:** panel sunucusunda güvenlik / tüm güncellemeleri kurma, otomatik güvenlik
  güncellemeleri, yeniden başlatma; adım adım ilerleme penceresi. Tüm müşteri sunucularının güncelleme durumu tek listede
- **Kullanıcı ayrıntısı:** doğrulamalar, parola, iki adımlı doğrulama sıfırlama, geçiş anahtarları, bağlı hesaplar,
  oturumlar ve giriş geçmişi
- **İnceleme bekleyen ödemeler:** Faturalandırma → Ödemeler'de "İnceleme bekleyen" süzgeci ve arama (ikisi de
  adreste tutulur); her ödemede gerekçe, bekleme süresi ve faturaya bağlantı; özet sayfasında uyarı; ödeme incelemeye
  girdiğinde personele bildirim
- **Bayiler**, faturalama, kuponlar, itiraz yönetimi ve e-Fatura / e-Arşiv (yedi entegratörden yalnızca İzibiz ve
  Uyumsoft'a, kendi test ortamlarında gerçek e-Arşiv faturası gönderildi; diğer beşi belgelere göre yazıldı, denenmedi)
- **WHMCS / WISECP modülleri** (`integrations/`): satışı o sistem yapar, panel bu sunuculara fatura kesmez; sahibi
  bu sunucuları panelden büyütemez, disk ekleyemez ya da kopyalayamaz (paket değişikliği o sistemden yapılır) ve
  panelin faturalaması kapalıyken panelden yeni sunucu sipariş edemez. Entegrasyon yalnızca kendi açtığı müşteri
  hesaplarını eşler; aynı e-postayla önceden var olan bir hesabı personel devralma (claim) rotasıyla bağlar
  ([integrations/README.md](integrations/README.md)). WISECP modülü bir WISECP kurulumunda denenmedi

</td></tr>
<tr><td valign="top">

### Bildirimler
- Panel içi, tarayıcı (Web Push), e-posta, SMS ve **mesajlaşma uygulamaları:**
  Telegram, WhatsApp, Slack, Discord, Microsoft Teams, Google Chat, Mattermost, Rocket.Chat, Matrix, ntfy,
  Gotify, Pushover ve imzalı JSON webhook
- Önce yöneticinin kuralı, sonra kullanıcının seçimi; her kanal test edilebilir (hesap başına saatte 6 test)
- Prometheus/Alertmanager alarmları panel bildirimi olarak gelir

</td><td valign="top">

### Entegrasyonlar
- **E-posta:** SMTP ve 12 API sağlayıcısı (Resend, SendGrid, Mailgun, Postmark, Amazon SES, Brevo, Mailjet,
  SparkPost, MailerSend, SMTP2GO, Elastic Email, ZeptoMail)
- **SMS:** Türkiye'deki 18 sağlayıcı + Twilio, Vonage, Infobip, Plivo, Sinch, Telnyx, Clickatell, MessageBird
  ve özel HTTP API
- **Ödeme:** kartla tahsilat yalnızca **iyzico, PayTR, Craftgate, Param ve Stripe** ile (ve panelin kendi test
  sağlayıcısıyla) yapılır. Bunlardan **Param'da ödeme kendiliğinden işlenmez:** müşteri Param'ın sayfasında öder,
  ödeme "onay bekliyor" kalır ve personel tahsilatı Param panelinde görüp faturayı elle kapatır (ödeme incelemeye
  girdiğinde personele bildirim gider; bekleyenler Yönetim → Faturalandırma → Ödemeler'de "İnceleme bekleyen" süzgecindedir); Param yalnızca TRY faturalar için sunulur. Listedeki diğer 41 sağlayıcının (Türkiye'deki ödeme kuruluşları, banka sanal POS'ları,
  Papara, PayPal, Mollie, Adyen, Checkout.com, Razorpay, Square, Paddle) yalnızca hesap bilgileri kaydedilir ve çoğu
  para hareketi olmayan bir sorguyla sınanır; **bunlarla ödeme alınamaz** ([docs/payments.md](docs/payments.md))
- **CAPTCHA:** Cloudflare Turnstile, reCAPTCHA v2/v3, hCaptcha · **Ters DNS:** PowerDNS

</td></tr>
<tr><td valign="top">

### Güvenlik
- better-auth: parola, passkey, iki adımlı doğrulama (uygulama, SMS, e-posta, yedek kodlar)
- **Kurumsal giriş:** LDAP / Active Directory ve OpenID Connect ile tek oturum açma (Keycloak, Entra ID, Okta, Google, authentik); gruplardan rol
- CSRF koruması, hız sınırları, istek gövdesi sınırları, şifreli sırlar (ana anahtar), oturum yönetimi
- Kimlik rotalarında izin listesi: panelin kullanmadığı giriş yolları kapalıdır; dizin ve SSO hesapları yalnızca kendi
  yollarından girer; iki adımlı doğrulaması olan hesap e-posta kodu ya da giriş bağlantısıyla giremez
- Kullanıcı adına oturum açan personel hesapta kalıcı iz bırakamaz (passkey, bağlı hesap, parola, iki adım, webhook,
  fatura e-postası); bu oturum bir saat sonra ve onu açan personelin yetkisi kalktığında (rol düşürme, yasak) biter
- E-posta ve SMS ayarları, giriş bağlantısı / kod ile girişi açma, iki adım zorunluluğunu düşürme ve CAPTCHA'yı
  zayıflatma yalnızca yöneticiye açıktır
- SMS ve e-posta gönderen her yol hesap ve hedef başına sınırlıdır (doğrulama kodları, sıfırlama postası, bildirim
  testi, talep yanıtları)
- Adresi doğrulanmamış bir hesap ilk kez giriş bağlantısı ya da e-posta koduyla girdiğinde, hesapta önceden kurulmuş
  parola, anahtar ve bağlantılar silinir (hesabı adresin sahibi açmamış olabilir)
- Proxmox'ta her istek VM'in beklenen adını taşır: yeniden kullanılan bir VM numarası başka bir sunucuya işlem yaptırmaz
- İptalden (çıkış, yasak, devir) önce alınmış konsol ve terminal biletleri de reddedilir
- **Mükerrer işlem koruması:** Idempotency-Key, sunucu başına tek açık işlem ve çift tıklamada ikinci isteğin reddi
- Kullanıcının verdiği webhook ve tarayıcı bildirimi adresleri yalnızca herkese açık HTTPS olabilir (iç ağa istek
  atılamaz); tarayıcı bildirimi adresi bir DNS adı olmalıdır

</td><td valign="top">

### İşletim
- **Tek komutla kurulum**, otomatik HTTPS (alan adı veya `<ip>.sslip.io`)
- Şifreli ve yedek anahtarıyla imzalı (HMAC) yedek, zamanlanmış yedek; kontrollü geri yükleme: herkesin oturumu
  kapanır ve panel, yönetici serbest bırakana kadar **beklemede** kalır (işlem, zamanlama, silme ve tahsilat yapmaz)
- **Güncelleme:** önce yedek, migration uyumluluğu denetimi, başarısızlıkta container'ların geri dönüşü. Kendiliğinden
  yalnızca daha yeni sürüme geçer; açıkça bir sürüm verildiğinde eski bir sürüme dönüşü yalnızca migration denetimi durdurur
- İsteğe bağlı Prometheus, Grafana, Loki, Alertmanager. Kurulumda açılır; sonradan yalnızca komut satırından açılıp
  kapatılır (`install.sh monitoring on|off`). Panelde bunun düğmesi yalnız kurulum sihirbazında vardır
- Türkçe / İngilizce arayüz, koyu / açık tema, telefondan geniş ekrana tam uyumlu
- **Pencere mantığı:** tüm iletişim kutuları başlık çubuğundan taşınır, kenara alınır, büyütülür; sola / sağa / üste / alta yaslanır, köşelere yerleşir, ortalanır, kenarından ve köşesinden boyutlandırılır. Kenara sürüklerken yerleşeceği alan önizlenir; düzen menüsü (başlıkta sağ tık ya da düzen düğmesi) ve Ctrl+Alt+← → ↑ ↓ / C kısayolları (telefonda alttan açılan sayfa)
- **Erişilebilirlik:** %75–%200 yazı boyutu ve metin aralığı kaydırıcıları, yüksek kontrast, okunaklı yazı tipi, azaltılmış hareket
- **Türkçe duyarlı arama** ("sirket" → "Şirket", "istanbul" → "İstanbul") ve sağ altta arka plan görevleri paneli

</td></tr>
</table>

## 🧩 Platform kapsamı

Yedi platform aynı sözleşmeyi konuşur, ama hepsi her şeyi yapmaz. Aşağıdaki tablo adaptörlerin kendi yol
tablolarından çıkarıldı: "yok" yazan işlemde adaptör `PLATFORM_NOT_SUPPORTED` yanıtı verir ve işlem "bu platformda
desteklenmiyor" hatasıyla biter. ✓ işareti kodun var olduğunu söyler, gerçek donanımda denendiğini değil; son satıra
bakın.

| | VMware (vCenter) | Proxmox VE | XCP-ng | oVirt | Hyper-V | KVM (libvirt) | Incus / LXD |
|---|---|---|---|---|---|---|---|
| Keşif, kapasite, topoloji | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Şablondan / imajdan sunucu oluşturma, yeniden kurulum | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ ¹ | ✓ |
| Aç, kapat, yeniden başlat, sil | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Boyut değiştirme | ✓ | ✓ | ✓ ² | ✓ | ✓ ² | ✓ ² | ✓ ² |
| Anlık görüntü (al, geri dön, sil) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Ek disk (ekle, kaldır) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Mevcut VM'i devralma, tutarlılık denetimi | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Root parolası, uygulama kurulumu, güncelleme bildiricisi (cloud-init) | ✓ | guest agent ile ³ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Kullanım grafikleri (geçmiş) | ✓ | ✓ (dakikada bir) | yok (boş) | yok (boş) | yok (boş) | yok (boş) | yok (boş) |
| Trafik sayımı ve kota uyarısı | ✓ | ✓ | yok | yok | yok | yok | yok |
| Sunucu başına işlemci ölçümü ⁴ | ✓ | ✓ | yok | yok | ✓ | yok | yok |
| Tarayıcı konsolu | ✓ ⁵ | yok | yok | yok | yok | yok | yok |
| Firewall | ✓ ⁶ | yok | yok | yok | yok | yok | yok |
| Kota dolunca hız sınırlama | ✓ ⁶ | yok | yok | yok | yok | yok | yok |
| Özel ağlar | ✓ ⁶ | yok | yok | yok | yok | yok | yok |
| Yedek ve geri yükleme | ✓ | yok | yok | yok | yok | yok | yok |
| Kişisel imaj | ✓ | yok | yok | yok | yok | yok | yok |
| ISO kitaplığı, CD takma, kurtarma | ✓ | yok | yok | yok | yok | yok | yok |
| Taşıma ve host boşaltma | ✓ | yok | yok | yok | yok | yok | yok |
| Ağı tarayarak host bulma | ✓ | yok | yok | yok | yok | yok | yok |
| Gerçek sunucuda denendi mi | çoğunlukla simülatör | hayır | hayır | hayır | hayır | hayır | evet: Incus 6.0, yalnız konteyner |

¹ Hostta `virt-clone` ve `virt-xml` varsa; yoksa bağlantı yalnızca envanter ve güç işlemleri içindir.
² Sunucu kapalıyken; panel kapatıp açmayı kendisi yapar.
³ Proxmox'un kendi cloud-init'i yalnızca ağı ve SSH anahtarlarını taşır; kalanı sunucu açıldıktan sonra QEMU guest
agent ile uygulanır. Şablonda agent yoksa bunlar uygulanmaz.
⁴ Boşta / büyük / küçük sunucu, madencilik şüphesi, sağlık puanı ve enerji raporu bu ölçüme dayanır; "yok" yazan
platformlarda anlamlı sonuç vermezler. oVirt'te yalnızca host kullanımı okunur.
⁵ VMware HTML Console SDK depoda yoktur ve gerçek SDK ile denenmedi ([docs/console.md](docs/console.md)).
⁶ Dağıtık sanal anahtar (vSphere Distributed Switch) gerekir.

VMware'de sunucu oluşturmak vCenter ister; tek başına ESXi'de yalnızca okuma ve güç işlemleri vardır. oVirt'te bir
sunucunun kopyası çıkarılamaz (kopya yalnızca şablondan). Her platformun ayrıntısı kendi belgesindedir:
[vmware](docs/vmware.md), [proxmox](docs/proxmox.md), [xcpng](docs/xcpng.md), [ovirt](docs/ovirt.md),
[hyperv](docs/hyperv.md), [libvirt](docs/libvirt.md), [incus](docs/incus.md).

## 🆕 Son eklenenler

| Ne | Nerede |
|---|---|
| **Günlük işleri kısaltan eklemeler (2026-11-17).** *Personel:* inceleme bekleyen ödemeler için süzgeç, arama, gerekçe, bekleme süresi ve faturaya bağlantı; özet sayfasında uyarı ve `billing.payment_review` bildirimi; menüde sayaçlar; geri yükleme beklemesi her sayfada; üç yeni içgörü (inceleme bekleyen ödemeler, geri yükleme beklemesi, karar bekleyen işlemler); kötüye kullanım ve abonelik süzgeçleri adreste. *Müşteri:* "Yaklaşan ödemeler"; komut paletinde fatura arama, son açılan talepler ve faturalar, hızlı işlemler; siparişte paylaşılabilir yapılandırma bağlantısı; sunucu kartı menüsünde ad değiştirme, kilit ve silme; düz HTTP'de de çalışan kopyalama düğmeleri; yeniden kurulumda önce / sonra özeti; 30 günden eski anlık görüntüler için öneri; adresin ilk kanıtında giriş bilgileri silindiğinde `auth.credentials_reset` bildirimi. İşletmecinin yapacağı bir şey yok | Yönetim → Faturalandırma → Ödemeler · yönetim menüsü · Genel bakış (müşteri ve yönetim) · Ctrl+K · Yeni sunucu · Sunucular · sunucu sayfası · [docs/upgrade-notes.md](docs/upgrade-notes.md) |
| **Güvenlik denetimi, ikinci tur (2026-11-17):** ilk turun incelemediği alanlar ve ilk turun düzeltmelerinin yeniden denetimi; 26 doğrulanmış bulgu (10 orta, 15 düşük, 1 bilgi amaçlı) düzeltildi. İşletmeciyi en çok etkileyenler: geri yüklemeden sonra panel beklemede açılır ve serbest bırakılması gerekir; `install.sh behind-proxy` artık `--public-url` ister; WHMCS / WISECP yalnızca kendi açtığı hesapları eşler (diğerleri için devralma rotası); bildirim e-postaları yeniden gönderiliyor (Node 22'de gönderilmiyordu); Proxmox'ta VM numarası sunucuya bağlanır; yeni hız sınırları. Yükseltmeden sonra proxy ve günlük toplayıcısı yeniden başlatılmalıdır. **Yükseltmeden önce okuyun** | [docs/upgrade-notes.md](docs/upgrade-notes.md) · [docs/security-audit.md](docs/security-audit.md) |
| **Güvenlik denetimi, ilk tur (2026-11-17):** 22 doğrulanmış bulgu (1 yüksek, 10 orta, 11 düşük) düzeltildi. İşletmeciyi en çok etkileyenler: Param ödemeleri artık elle onaylanır, yedekler imzalanır (eski yedekler yalnızca `--allow-unsigned` ile geri yüklenir), panelin kullanmadığı giriş rotaları kapandı, WHMCS / WISECP sunucuları panelden büyütülemez. Yükseltmeden sonra proxy yeniden başlatılmalıdır. **Yükseltmeden önce okuyun** | [docs/upgrade-notes.md](docs/upgrade-notes.md) · [docs/security-audit.md](docs/security-audit.md) |
| **Baştan sona denetim (önceki tur):** API, worker, web arayüzü, yedi adaptör ve kurulum betiği gözden geçirildi. İşletmeciyi etkileyen 49 davranış değişikliği var; en önemlileri faturalamada (otomatik yenilemesi kapalı aboneliklere artık fatura kesilir, ödenmeyen sipariş ve veri merkezi faturaları tahsilat adımlarına girer). **Yükseltmeden önce okuyun** | [docs/upgrade-notes.md](docs/upgrade-notes.md) |
| **Pencere düzenleri:** iletişim kutuları sola / sağa yaslanır, köşelere ve yarımlara yerleşir, ortalanır, kenarından boyutlandırılır; sürüklerken önizleme, düzen menüsü ve Ctrl+Alt+ok tuşları | Panelin tamamı |
| **Incus / LXD desteği (ilk sürüm):** aynı panelden sanal makine ve konteyner; istemci sertifikasıyla, küme desteğiyle. Gerçek bir Incus 6.0 sunucusunda konteynerlerle denendi | Yönetim → Bağlantılar → Incus / LXD · [docs/incus.md](docs/incus.md) |
| **KVM (libvirt) desteği (ilk sürüm):** vCenter ya da Proxmox olmadan, düz bir Linux KVM hostu; SSH ile, parola ya da anahtarla | Yönetim → Bağlantılar → KVM (libvirt) · [docs/libvirt.md](docs/libvirt.md) |
| **Microsoft Hyper-V desteği (ilk sürüm):** aynı panelden Hyper-V hostları | Yönetim → Bağlantılar → Hyper-V · [docs/hyperv.md](docs/hyperv.md) |
| **oVirt / RHV desteği (ilk sürüm):** aynı panelden oVirt Engine | Yönetim → Bağlantılar → oVirt · [docs/ovirt.md](docs/ovirt.md) |
| **XCP-ng / XenServer desteği (ilk sürüm):** aynı panelden XAPI havuzları | Yönetim → Bağlantılar → XCP-ng · [docs/xcpng.md](docs/xcpng.md) |
| **Proxmox VE desteği (ilk sürüm):** VMware ile aynı panelden Proxmox düğümleri ve kümeleri | Yönetim → Bağlantılar → Proxmox VE · [docs/proxmox.md](docs/proxmox.md) |
| Panel sunucusunun canlı durumu: işlemci, bellek, yük, disk, servisler, süreçler, günlükler | Yönetim → Sistem → Sunucu durumu |
| İşletim sistemi güncellemeleri (panel sunucusu): kurulum, otomatik güvenlik güncellemeleri, yeniden başlatma, ilerleme penceresi | Yönetim → Sistem |
| Müşteri sunucularının içindeki güncellemeler; yeni Linux sunuculara bildirici ilk açılışta kendiliğinden kurulur | Sunucu sayfası · Yönetim → Sunucular → Güncellemeler |
| Kullanıcının hesap ve giriş ayrıntıları, iki adımlı doğrulama sıfırlama, geçiş anahtarı ve bağlı hesap yönetimi | Yönetim → Kullanıcılar |
| Pencere gibi davranan iletişim kutuları (taşı, kenara al, büyüt, kapat) | Panelin tamamı |
| Yazı boyutu ve metin aralığı kaydırıcıları | Erişilebilirlik |
| Türkçe harflere duyarlı arama; zaman ve DNS sunucuları için önerilen varsayılanlar | Panelin tamamı · Yönetim → Sistem |

## 📸 Ekran görüntüleri

| Yönetici genel bakış | Müşteri sunucuları |
|---|---|
| ![Yönetici paneli](docs/screenshots/admin-dashboard.png) | ![Sunucularım](docs/screenshots/my-servers.png) |
| **Akıllı sipariş** | **Topoloji** |
| ![Sipariş](docs/screenshots/order.png) | ![Topoloji](docs/screenshots/admin-topology.png) |
| **E-posta sağlayıcıları** | **Mesajlaşma uygulamaları** |
| ![E-posta ayarları](docs/screenshots/mail.png) | ![Mesajlaşma](docs/screenshots/chat-settings.png) |

## 🚀 Kurulum

### Gereksinimler

| | En az | Önerilen |
|---|---|---|
| İşletim sistemi | Ubuntu 22.04 / 24.04 / 26.04 (amd64 veya arm64) | Ubuntu 24.04 LTS |
| Bellek / disk | 2 GB RAM, 10 GB boş disk | 4 GB RAM, 40 GB disk (izleme açıkken) |
| Ağ | 80 ve 443 portları dışarıya açık (HTTPS için) | Bir alan adı (A kaydı sunucuyu göstermeli) |
| Sanallaştırma | ESXi / vCenter 6.0 – 9.x, Proxmox VE 7.x – 9.x, XCP-ng 8.x, oVirt 4.4+, Hyper-V (Windows Server 2016+), libvirt'li bir Linux KVM hostu ya da Incus 6.x / LXD 5.x | Sunucu oluşturmak için **vCenter**, **Proxmox VE**, **XCP-ng**, **oVirt**, **Hyper-V**, **KVM (libvirt)** ya da **Incus / LXD** |

Docker kurulu değilse betik resmî deposundan kurar. Paneli VMware host'unun kendisine değil, ayrı bir Linux
sunucuya (sanal da olabilir) kurun.

### Tek komutla kurulum (önerilen)

Yeni bir sunucuda yalnızca bu satırı çalıştırın; `git clone` gerekmez:

```bash
curl -fsSL https://raw.githubusercontent.com/syildirim689/lightning-vm/main/scripts/get.sh | sudo sh
```

Komut kaynağı `/opt/lightning-vm` dizinine indirir, en yeni kararlı sürümü seçer ve kurulumu başlatır; panel
sonradan kendini bu dizinden günceller. Kendi alan adınızla:

```bash
curl -fsSL https://raw.githubusercontent.com/syildirim689/lightning-vm/main/scripts/get.sh | sudo sh -s -- -- --domain panel.example.com
```

| `get.sh` seçeneği | Ne yapar |
|---|---|
| `--version v1.2.0` | Belirli bir sürümü kurar (varsayılan: en yeni kararlı sürüm) |
| `--branch main` | Sürüm yerine bir dalı izler (test sunucuları) |
| `--dir /srv/lightning-vm` | Kaynağın duracağı dizin (varsayılan `/opt/lightning-vm`) |
| `--token-file DOSYA` | Özel (private) depo için salt okunur erişim anahtarı, dosyanın ilk satırından okunur (ya da `GIT_TOKEN` ortam değişkeni: `sudo --preserve-env=GIT_TOKEN sh`) |
| `--token TOKEN` | Aynısı, komut satırında. Çalışır, ama anahtar kurulum boyunca süreç listesinde görünür; yukarıdaki iki yolu yeğleyin |
| `-- …` | `--` sonrasındaki her şey aşağıdaki kurulum seçenekleridir |

> [!NOTE]
> Bu adres, depo herkese açık (public) olduğunda doğrudan çalışır. Depo özelken komutu bir erişim anahtarıyla
> çalıştırın: [docs/updates.md](docs/updates.md).

### Elle kurulum

```bash
git clone https://github.com/syildirim689/lightning-vm.git
```

```bash
cd lightning-vm
```

```bash
sudo sh scripts/install.sh
```

Betik sırasıyla sistemi kontrol eder, Docker'ı kurar, sırları üretir, servisleri derleyip başlatır, HTTPS
sertifikasını alır, izlemeyi ve günlük yedeği ayarlar. Sonunda **panel adresini ve ilk yönetici bilgilerini**
yazar (parola `secrets/initial-admin.txt` dosyasında da durur; ilk girişten sonra değiştirip dosyayı silin).

Sık kullanılan seçenekler:

| Seçenek | Ne yapar |
|---|---|
| `--domain panel.example.com` | Kendi alan adınızla Let's Encrypt sertifikası |
| `--acme-staging` | Önce test sertifikasıyla dener (limitlere takılmamak için) |
| `--setup-wizard` | Yönetici hesabı yerine tarayıcıda kurulum sihirbazı açar |
| `--admin-email adres@ornek.com` | İlk yöneticinin e-postası |
| `--local` | Genel IP yoksa: panel yalnızca sunucuda, SSH tüneliyle açılır |
| `--no-monitoring` / `--no-schedule` | İzlemeyi / zamanlanmış yedeği kurmaz |
| `--lang en` | Kurulum çıktısı İngilizce |

Yalnızca kontrol etmek (hiçbir şeyi değiştirmez):

```bash
sh scripts/install.sh check
```

Kurulum yarıda kalırsa aynı komutu tekrar çalıştırın; mevcut sırlar, veriler ve hesaplar korunur.

<details>
<summary><b>Genel IP'si olmayan sunucu (<code>--local</code>)</summary>

Panel yalnızca sunucunun kendisinde açılır. Kendi bilgisayarınızdan SSH tüneliyle bağlanın:

```bash
ssh -L 8080:127.0.0.1:8080 KULLANICI@SUNUCU
```

Ardından tarayıcıda `http://127.0.0.1:8080` adresini açın. Paneli HTTPS olmadan internete açmayın:
parolalar düz metin gider.
</details>

<details>
<summary><b>Alan adını sonradan eklemek / değiştirmek, başka bir proxy arkasında çalıştırmak</b></summary>

Alan adı panelin Ayarlar → Alan adı ve SSL sekmesinden de değiştirilebilir. Komut satırından:

```bash
sudo sh scripts/install.sh domain panel.example.com --acme-staging
```

```bash
sudo sh scripts/install.sh domain panel.example.com
```

Mevcut bir Nginx / Caddy / Traefik arkasında çalıştırma (panelin dış adresi verilmelidir; postayla gönderilen
bağlantılar bu adresi kullanır):

```bash
sudo sh scripts/install.sh behind-proxy --public-url https://panel.example.com
```

Ayrıntılar ve proxy yapılandırması: [docs/domain-https.md](docs/domain-https.md).
</details>

## 🧭 İlk adımlar

1. **Giriş yapın** ve parolanızı değiştirin; Hesap → Güvenlik'ten iki adımlı doğrulamayı açın.
2. **VMware bağlantısı ekleyin** (Yönetim → Bağlantılar): vCenter veya ESXi adresi, kullanıcı ve parola. Panel
   host'ları, datastore'ları, ağları ve VM'leri keşfeder; TLS sertifikası parmak iziyle doğrulanır.
3. **Kataloğu hazırlayın** (Yönetim → Katalog): konum, kaynak havuzu, IP havuzu, şablon imajı ve paketler.
4. **E-posta / SMS / ödeme / mesajlaşma** ayarlarını yapın (Yönetim → Ayarlar); her biri kaydetmeden önce test
   edilebilir.
5. **Bildirim kurallarını** belirleyin; kullanıcılar kendi kanallarını Hesap → Bildirimler'den seçer.
6. Müşteri hesabıyla **bir sunucu sipariş edip** uçtan uca deneyin.

Güncellemeler, yedekler ve terminal **panelden** yönetilir (Yönetim → Sistem). İzleme (Prometheus, Grafana, Loki,
Alertmanager) panelden yalnızca kurulum sihirbazında açılıp kapatılabilir; sonrasında komut satırından:

```bash
sudo sh scripts/install.sh monitoring on
```

Ayrıntılı kılavuz: [docs/setup.md](docs/setup.md).

## 🔄 Güncelleme ve yedek

Panelden: **Yönetim → Sistem → Güncellemeler**. Komut satırından:

```bash
sudo sh scripts/install.sh update
```

```bash
sudo sh scripts/install.sh backup
```

```bash
sudo sh scripts/install.sh restore backups/DOSYA.tar.enc --yes-replace-data
```

- Sürüm verilmeden çalışan güncelleme yalnızca çalışan sürümden **daha yeni** bir sürüme geçer. Açıkça bir sürüm
  verildiğinde (`update --to v1.2.0`, ya da panelin gönderdiği "bu sürüme geç" isteği) betik herhangi bir sürüm
  etiketini ya da commit'i kabul eder; eski bir sürüme dönüşü yalnızca migration denetimi durdurur (veritabanında
  uygulanmış bir migration o sürümde yoksa reddeder).
- Her güncelleme önce yedek alır ve başarısız olursa container'ları geri alır (veritabanı otomatik geri alınmaz;
  yedek oradadır).
- Yedekler `secrets/backup.key` ile şifrelenir ve imzalanır: her yedek `AD.tar.enc` ile yanındaki `AD.tar.enc.hmac`
  dosyasından oluşur (sunucu dışı kopyaya ikisi de gider). **Bu anahtarı sunucu dışında saklayın**; o olmadan yedek
  açılmaz.
- Geri yükleme `.hmac` dosyasını yedeğin yanında, yedeği özgün adıyla ve aynı `backup.key` ile ister; tutmazsa
  `E_RESTORE_SIGNATURE` verir ve hiçbir şey değişmez. Eski sürümlerin aldığı yedekler (yalnızca `.sha256`) yalnızca
  `--allow-unsigned` ile geri yüklenir. Arşiv, denetlenmeden önce yalnızca root'un açabildiği bir klasöre kopyalanır
  ve o kopya kullanılır (geçici klasörde bir kopyalık daha yer gerekir).
- **Geri yüklemeden sonra panel beklemede açılır.** Geri yükleme herkesin oturumunu kapatır ve paneli beklemeye
  alır: serbest bırakılana kadar işlem başlatılmaz, zamanlamalar ve zamanlanmış silmeler çalışmaz, tahsilat
  çalışmaz (işlem başlatan rotalar `409 RESTORE_HOLD` döner). Yedekten sonra oluşturulan ya da silinen sunuculara,
  yapılan ödemelere ve silinen API anahtarlarına, yasaklara, rol değişikliklerine baktıktan sonra **Yönetim →
  Sistem**'deki şeritten ya da `docker compose exec api node dist/cli.js release-restore-hold` ile serbest bırakın.
  `--no-hold` yalnızca bekletmeyi atlar (az önce alınmış bir yedek için).
- Parolasını unutan yönetici için: `sudo sh scripts/install.sh reset-password eposta@ornek.com`.
- **Yükseltmeden önce** [docs/upgrade-notes.md](docs/upgrade-notes.md) sayfasını okuyun: sürümler arasında değişen
  davranışları, mevcut veriye etkisini ve kimlerin etkileneceğini gösteren sorguları içerir.

Ayrıntılar: [docs/operations.md](docs/operations.md), [docs/updates.md](docs/updates.md).

## 🏗 Mimari

```mermaid
flowchart LR
  B[Tarayıcı] -->|HTTPS| C[Caddy]
  C --> W[Web<br/>Next.js 16 + HeroUI]
  C -->|/api| A[API<br/>NestJS + Fastify]
  C -->|/console, /terminal| G[Konsol geçidi<br/>Go]
  A --> P[(PostgreSQL)]
  A --> R[(Redis / BullMQ)]
  R --> K[Worker]
  K --> V[VMware servisi<br/>Go + govmomi]
  A --> V
  V --> X[vCenter / ESXi]
  H[Host ajanı<br/>systemd] -.bakım istekleri.- A
```

| Bileşen | Teknoloji | Görev |
|---|---|---|
| `apps/web` | Next.js 16, React, HeroUI v3, next-intl, React Query | Müşteri ve yönetici paneli |
| `apps/api` | NestJS (Fastify), better-auth, PostgreSQL, BullMQ | REST API, kimlik, ayarlar, bildirimler |
| `apps/worker` | Node.js, BullMQ | Sunucu oluşturma ve işlemler, adım adım ve kaldığı yerden |
| `services/vmware` | Go, govmomi | vCenter/ESXi ile konuşan adaptör |
| `services/proxmox` | Node.js (bağımlılıksız) | Aynı sözleşmeyle Proxmox VE ile konuşan adaptör ([sözleşme](docs/adapter-contract.md)) |
| `services/xcpng` | Node.js (bağımlılıksız) | Aynı sözleşmeyle XCP-ng / XenServer (XAPI) ile konuşan adaptör |
| `services/ovirt` | Node.js (bağımlılıksız) | Aynı sözleşmeyle oVirt Engine (REST) ile konuşan adaptör |
| `services/hyperv` | Node.js (bağımlılıksız) | Aynı sözleşmeyle Hyper-V'yi WinRM üzerinden PowerShell ile yöneten adaptör |
| `services/libvirt` | Node.js (bağımlılıksız) + OpenSSH istemcisi | Aynı sözleşmeyle bir KVM hostunu SSH üzerinden `virsh` ile yöneten adaptör |
| `services/incus` | Node.js (bağımlılıksız) | Aynı sözleşmeyle Incus / LXD (REST) ile konuşan adaptör |
| `services/console` | Go | Tarayıcı konsolu ve sunucu terminali için WebSocket geçidi |
| `scripts/install.sh` | POSIX sh, Docker Compose | Kurulum, güncelleme, yedek, host ajanı |

Daha fazlası: [docs/architecture.md](docs/architecture.md).

## 🧪 Geliştirme ve testler

```bash
docker compose -f compose.yaml -f compose.simulator.yaml up -d --build
```

Simülatör (govmomi `vcsim`) gerçek bir vCenter olmadan tüm akışı çalıştırır. Testler:

| Test | Komut |
|---|---|
| API birim testleri (143 test) | `cd apps/api && npm test` |
| API entegrasyon testleri (PostgreSQL + Redis; güvenlik denetiminin düzeltmeleri için eklenen `security-auth`, `security-billing` ve `security-servers` testleri bunların içindedir) | `cd apps/api && npm run test:integration` |
| API entegrasyon testlerinin tamamı (PostgreSQL, Redis, vcsim, VMware adaptörü ve worker'ı Docker'da kendisi kurar). Son olarak 2026-11-17'de Docker'lı bir Linux sunucusunda çalıştırıldı: 174 testten 170'i geçti, 4'ü PowerDNS, ISO deposu ya da konsol ağ geçidi istediği için atlandı. | `cd apps/api && npm run test:integration:full` |
| Go servisleri | `cd services/vmware && go test ./...` |
| Proxmox (26), XCP-ng (19), oVirt (15), Hyper-V (18), libvirt (19) ve Incus (11 test) adaptörleri | `cd services/proxmox && npm test` (aynısı `services/xcpng`, `services/ovirt`, `services/hyperv`, `services/libvirt` ve `services/incus` için; libvirt'in dört betik testi yalnızca Linux'ta çalışır, başka yerde atlanır) |
| Web birim testleri (70 test: çeviriler, simgeler, pencere düzenleri ve diğer hesaplar) | `cd apps/web && npm test` |
| Worker (sözdizimi denetimi ve 43 birim testi) | `cd apps/worker && npm run check` |
| Uçtan uca (Playwright, çalışan bir Compose kurulumuna karşı) | `cd apps/web && npx playwright test` |

Uçtan uca yolculuklar tek bir masaüstü boyutunda (1280 px) koşar; aralarında birkaç ekran ayrıca 390 ve 768 px'te
taşma için denetlenir. Ayrı bir döngü sayfaları 390 / 768 / 1920 px'te açar ve yalnızca sayfa başlığının göründüğüne
ve yana taşma olmadığına bakar; bu genişliklerde işlev sınanmaz.

CI (`.github/workflows/ci.yaml`): birim işleri (API, web, worker, altı Node adaptörü, Go servisleri) `main`'e her
gönderimde, pull request'lerde ve elle çalışır. Servis ya da bütün bir Compose kurulumu isteyen işler (API
entegrasyon testleri, imaj derlemeleri, kurulum + uçtan uca) yalnızca elle tetiklenir (GitHub Actions → *Run workflow*).
Adaptör testleri gerçek bir hipervizöre değil, platformu taklit eden sahte sunuculara karşı çalışır. Veritabanı şeması
`apps/api/migrations` altındaki 81 dosyadadır (`001`–`081`; `077`–`080` ikinci güvenlik turuna aittir, `081`
ödemenin ne zamandan beri inceleme beklediğini tutar) ve
`migrate` servisiyle kendiliğinden uygulanır. Katkı kuralları: [CONTRIBUTING.md](CONTRIBUTING.md).

## ⚠️ Bilinen sınırlar

- **Yapay zekâ ile yazıldı:** yukarıdaki uyarıya bakın. Hatalar olabilir; üretim öncesi inceleyin.
- **VMware:** testlerin çoğu govmomi simülatörüyle yapıldı. Gerçek vCenter/ESXi'de farklı davranışlar
  görülebilir. Sunucu oluşturma vCenter ister (standalone ESXi'de yalnızca okuma ve güç işlemleri).
- **Konsol:** tarayıcı konsolu **yalnız VMware'de** vardır. VMware HTML Console SDK (wmks) lisansı gereği depoda
  yok; kurulumu yapan kişi ekler. Geçit ve bilet akışı sınandı, ancak **bütün, gerçek SDK ile hiç denenmedi**: ekranın
  göründüğü, klavye ve farenin çalıştığı doğrulanmadı ([docs/console.md](docs/console.md)).
- **Ödeme:** kartla tahsilat yalnız iyzico, PayTR, Craftgate, Param ve Stripe ile; diğer 41 sağlayıcı yalnızca bilgi
  kaydıdır. Beşinden **hiçbiri gerçek bir üye işyeri hesabıyla denenmedi**. **Stripe:** webhook yok; müşteri ödedikten sonra
  sekmeyi kapatırsa ödeme, tahsilat çalıştırması Stripe'a yeniden sorduğunda işlenir (beş dakika sonra başlar, bir
  gün sürer; iyzico ve Craftgate'te de böyledir, PayTR ve Param'da yoktur). **Param:** dönüş Param'a sorularak
  doğrulanamadığı için ödemenin kanıtı sayılmaz: ödeme "onay bekliyor" kalır, personel Param panelinde doğrulayıp
  faturayı elle kapatır; kendiliğinden işleyen bir Param tahsilatı yoktur. Param yalnızca TRY için sunulur ve bu
  akış **sağlayıcıyla teyit edilmedi**. **İncelemeye giren ödemeler kendiliğinden kapanmaz:** Param'ın onay
  bekleyen ödemeleri ile tutarı tutmayan ya da sağlayıcının incelemeye aldığı ödemeler Yönetim → Faturalandırma →
  Ödemeler'de "İnceleme bekleyen" süzgecinde, gerekçesi ve bekleme süresiyle durur; ödeme incelemeye girdiğinde
  `billing.manage` izni olan personele bir kez bildirim gider (varsayılan: panel ve e-posta). Karar yine elledir:
  personel sağlayıcının panelinde doğrular ve faturayı kendi sayfasındaki "Ödeme kaydet" ile kapatır
  ([docs/payments.md](docs/payments.md)).
- **Yaklaşan ödemeler:** sıradaki yenilemenin tutarı aboneliğin vergisiz tutarıdır; faturada vergi eklenir. Aynı
  yenileme, yenilemeden önceki günlerde hem "yenileme" satırında hem de vadesi yaklaşan fatura olarak görünebilir.
- **Yeni ekranlar elle gözden geçirilmedi:** 2026-11-17'de eklenenlerden ikisi (sipariş bağlantısının okunması ve
  komut paletinden fatura bulunması) tarayıcıda elle gözden geçirilmedi; uçtan uca testler kapsar. Diğerlerinin
  (ödemeler sayfasının inceleme görünümü, menü sayaçları, her sayfadaki geri yükleme şeridi, "Yaklaşan ödemeler",
  sunucu kartı menüsü, yeniden kurulum özeti, kopyalama düğmeleri) yazıldığı sırada **uçtan uca testi yoktu ve
  tarayıcıda elle gözden geçirilmediler**; arkalarındaki hesaplar birim testleriyle sınanır. 30 günden eski anlık
  görüntü önerisi listeyi platforma sorar; yalnızca sayımı birim testiyle sınandı, gerçek bir platformda denenmedi.
- **Gerçek hipervizör:** altı yeni adaptörden yalnızca Incus gerçek bir sunucuda çalıştırıldı, o da yalnızca
  konteynerlerle. Proxmox VE, XCP-ng, oVirt, Hyper-V ve KVM (libvirt) adaptörleri **gerçek bir hipervizörde hiç
  çalıştırılmadı**; testleri platformu taklit eden sahte sunuculara karşıdır.
- **Entegrasyon testleri:** bütün entegrasyon paketini Docker'da kendi kuran çalıştırıcı
  (`apps/api/test/integration/run.sh`) Docker'lı bir Linux sunucusunda çalışır. Güvenlik düzeltmelerinin (iki turun
  da) kendi entegrasyon testleri (`security-*.test.mjs`) bu paketin içindedir ve gerçek PostgreSQL ve Redis'e karşı
  çalışır. Baştan sona denetim turunda değişen
  faturalama davranışlarının (otomatik yenileme, vadesi geçen faturalar, sanal veri merkezleri) çoğu için entegrasyon
  testi **yazılmadı**: mevcut testler yalnız eski davranışın bozulmadığını gösterir.
- **Güvenlik denetimi kısmidir:** iki tur yapıldı, ikisi de tek tarama dalgasıyla. İkinci turda dizin (LDAP) ve SSO
  girişindeki dört düzeltme **yeniden denetlenemedi** (projenin entegrasyon testleri kapsar), denetimin sonradan
  önerdiği altı alan **incelenmedi** ve dört aday bağımsız bir doğrulamadan geçmedi; bunlardan bayilerle ilgili ikisi
  değiştirilmedi. Düzeltmeler gerçek hipervizörlerde, gerçek bir Proxmox kümesinde ve gerçek bir Param hesabıyla
  doğrulanmadı; kurulum betiğinin yolları yalnızca sahte dosyalarla denendi
  ([docs/security-audit.md](docs/security-audit.md)).
- **İkinci güvenlik turundan açık kalanlar kapandı (biri kısmen):** ödeme incelemeye girdiğinde personele bildirim
  gider ve yönetimdeki ödemeler sayfası bekleyenleri ayrı gösterir; adresin ilk kanıtında (aşağıda) hesaptan bir şey
  silindiyse kullanıcıya `auth.credentials_reset` bildirimi gider (silinecek bir şeyi olmayan hesaba gitmez). Yeniden
  kurulum penceresine yalnızca neyin kalıp neyin silineceğini gösteren özet eklendi; başka bir şey eklenmedi.
- **e-Fatura / e-Arşiv:** yalnızca İzibiz ve Uyumsoft'a, yayımladıkları test kullanıcılarıyla e-Arşiv faturası
  gönderildi. Nilvera, EDM, QNB eFinans, BirFatura ve Paraşüt belgelere göre yazıldı ve denenmedi; e-Fatura (mükellef
  alıcı) gönderimi hiçbir gerçek entegratörde denenmedi ([docs/billing.md](docs/billing.md)).
- **IPv6:** ayrı IPv6 havuzu yoktur; IPv4 havuzuna eklenen önekten sunucu başına tek adres verilir.
- **İzleme:** kurulumdan sonra panelden açılıp kapatılamaz (`install.sh monitoring on|off`).
- **Küme (cluster):** birden çok sunucuda çalışma bir tasarımdır, yazılmadı ([docs/cluster.md](docs/cluster.md)).
- **E-posta adresi doğrulama yok:** kayıtla açılan hesabın e-posta adresi doğrulanmaz. (SSO, dizin ve faturalama
  entegrasyonu üzerinden gelen hesaplar doğrulanmış sayılır; bayinin açtığı müşteri hesapları doğrulanmamış başlar.)
  Adresi doğrulanmamış bir hesap ilk kez giriş bağlantısı ya da e-posta koduyla girdiğinde (ikisi de varsayılan
  kapalıdır) adres kanıtlanmış sayılır ve hesapta önceden kurulanlar bir kez silinir: parola, bağlı girişler, diğer
  oturumlar, API anahtarları, passkey'ler, webhook'lar, mesajlaşma ve tarayıcı bildirimi bağlantıları, doğrulanmış
  telefon. Parolayla kaydolmuş müşteri "Parolamı unuttum" ile yeni parola belirler ([docs/auth.md](docs/auth.md)).
- **WhatsApp:** Meta Cloud API ve onaylı bir mesaj şablonu gerekir. **Telegram:** botta webhook tanımlı olmamalı.
- **Incus / LXD:** ilk sürüm; **gerçek bir Incus 6.0 sunucusunda konteynerlerle uçtan uca denendi** (oluşturma, cloud-init, güç, snapshot, disk, boyut, devralma, silme). Sanal makineler, LXD ve kümeler denenmedi.
  Konsol, firewall, hız sınırlama, yedek, kişisel imaj, ISO, özel ağ, taşıma, grafikler, trafik sayımı ve işlemci
  ölçümü yok ([docs/incus.md](docs/incus.md)).
- **KVM (libvirt):** ilk sürüm; betikler sahte bir `virsh` ile ve gerçek bir SSH sunucusu üzerinden sınandı, **gerçek bir libvirt/KVM hostunda henüz denenmedi**.
  Bağlantı başına tek host, depolama yalnız klasör tipi havuz (qcow2), Windows misafir özelleştirmesi yok. Konsol,
  firewall, hız sınırlama, yedek, kişisel imaj, ISO, özel ağ, taşıma, grafikler, trafik sayımı ve işlemci ölçümü yok
  ([docs/libvirt.md](docs/libvirt.md)).
- **Microsoft Hyper-V:** ilk sürüm ve en az denenmiş adaptör; PowerShell betikleri gerçek bir Hyper-V hostunda hiç çalıştırılmadı. Yalnız
  HTTPS üzerinden WinRM, bağlantı başına tek host (Failover Cluster yok), Windows misafir özelleştirmesi yok. Konsol,
  firewall, hız sınırlama, yedek, kişisel imaj, ISO, özel ağ, taşıma, grafikler ve trafik sayımı yok
  ([docs/hyperv.md](docs/hyperv.md)).
- **oVirt / RHV:** ilk sürüm; gerçek bir Engine'de henüz denenmedi. Konsol, firewall, hız sınırlama, yedek, kişisel
  imaj, ISO, özel ağ, taşıma, grafikler, trafik sayımı ve sunucu başına işlemci ölçümü yok; sunucudan sunucu
  kopyalanmaz. **Misafirdeki ilk arayüzün adı `eth0` olmalı:** Engine ağ ayarlarını bu adla yazar, arayüzü başka adla
  gelen imaj adres alamaz (bağlantıda uyarı olarak görünür) ([docs/ovirt.md](docs/ovirt.md)).
- **XCP-ng / XenServer:** ilk sürüm; gerçek bir havuzda henüz denenmedi. Konsol, firewall, hız sınırlama, yedek,
  kişisel imaj, ISO, özel ağ, taşıma, grafikler, trafik sayımı ve işlemci ölçümü yok ([docs/xcpng.md](docs/xcpng.md)).
- **Proxmox VE:** ilk sürüm; gerçek bir Proxmox sunucusunda henüz denenmedi. Konsol, firewall, hız sınırlama, yedek,
  kişisel imaj, ISO, özel ağ ve taşıma yok; root parolası, sunucu adı ve uygulama kurulumu için şablonda guest agent
  gerekir. **Ek adresler:** sunucunun içinde yalnızca ilk IPv4 ve ilk IPv6 adresi yapılandırılır; fazlası için işlem
  uyarı taşır, adresleri elle eklemek gerekir ([docs/proxmox.md](docs/proxmox.md)).
- **İşletim sistemi güncellemeleri:** panel sunucusunda yalnızca Debian / Ubuntu (apt); müşteri sunucularında Linux
  (apt, dnf, yum), Windows yok. Otomatik kurulum cloud-init kullanan imajlarda çalışır.
- Sürümlü, imzalı kurulum paketi (GHCR imajlarıyla) henüz yok; kurulum ve güncelleme kaynak koddan derler.

Olmayanların listesi: [docs/roadmap.md](docs/roadmap.md).

## 🔒 Güvenlik

Kasım 2026'da yapay zekâ destekli bir güvenlik denetimi iki tur hâlinde yapıldı: ilk tur `641aa4d`, ikinci tur
`d9f90d3` commit'i üzerinde. Bağımsız bir üçüncü tarafın denetimi **değildir** ve iki tur da **kısmidir**.

- **Neye bakıldı:** ilk turda deponun tamamı (API, worker, web arayüzü, konsol geçidi, adaptörler, kurulum betiği);
  ikinci turda ilk turun incelemediği alanlar (panelin kendi sunucusunu yöneten bakım isteği kanalı dahil) ve ilk
  turun her düzeltmesinin yeniden denetimi. Yöntem ikisinde de aynıdır: kaynak incelemesi ve ağ erişimi olmayan bir
  sandbox'ta sahte veriyle yapılan sınırlı denemeler. Çalışan hiçbir sisteme istek gönderilmedi.
- **Ne bulundu:** iki turda toplam **48 zayıflık** doğrulandı ve hepsi düzeltildi: ilk turda 22 (1 yüksek, 10 orta,
  11 düşük), ikinci turda 26 (10 orta, 15 düşük, 1 bilgi amaçlı). İlk tur, müşteri rotalarında bir müşterinin
  başkasının sunucusuna, faturasına, talebine ya da ağına ulaşabildiği bir yol bulmadı. İkinci tur, müşterinin
  kendi başına seçemeyeceği bir ön koşula bağlı böyle yollar buldu ve bunlar düzeltildi: sunucu devri sırasında
  (önceki sahibin o anda yolda olan isteği, devirden önce kaydettiği iptal) ve Proxmox'ta bir VM numarası yeniden
  kullanıldıktan sonra.
- **İlk turun düzeltmeleri tuttu mu:** 22 düzeltmenin 17'si gerçek PostgreSQL üzerinde yeniden denetlendi ve
  tutuyor. 4'ü (dizin ve SSO girişi) yeniden **denetlenemedi**: denetleyici, modelin güvenlik önlemlerince durduruldu;
  bunları projenin entegrasyon testleri kapsar. Yeniden denetim, bir düzeltmenin eksik kaldığı beş yer buldu
  (yenileme faturasının fiyatı, Param dönüşü, üç ek rotasında gövde boyutu, üç entegrasyonda kayıtlı sırlar,
  faturalama sisteminin hesap eşlemesi); beşi de düzeltildi.
- **Ne düzeltildi (ilk tur, özet):** Param dönüşü artık ödemenin kanıtı sayılmaz ve Param yalnızca TRY alır; boyut
  değişikliği, yenileme faturası ve dışarıdan faturalanan sunucularla ilgili ücret hataları; devredilen sunucuda
  önceki sahibin anahtarlarının ve parolasının kalması; kopya siparişinin kaynağına bağlanması; dizin / SSO
  hesaplarının başka yollardan girebilmesi ve rol eşlemesiyle yönetici oluşturulabilmesi; istek gövdesi ve giriş
  kimliği sınırları; yedeklerin anahtarla imzalanması; konsol geçidinde denetim kaydı taşması; giriş sonrası açık
  yönlendirme.
- **Ne düzeltildi (ikinci tur, özet):** yetkisi alınan personelin "kullanıcı adına" oturumunun sürmesi; devirle
  çakışan isteklerin ve önceki sahibin kaydettiği iptalin yeni sahibin sunucusuna uygulanması; Proxmox'ta yeniden
  kullanılan VM numarası (kopyalama ve işlemler); parola sıfırlama belirtecinin istek günlüğüne yazılması; sınırsız
  SMS testi ve hesap başına sınırı olmayan doğrulama kodları; ödeme, e-Fatura ve ISO deposu ayarlarında kayıtlı
  sırrın yeni adrese gitmesi; eski bir yedeğin geri yüklenmesinden sonra panelin eski siparişlere ve silmelere göre
  işlem yapması; geri yüklemede imzanın ve şifre çözmenin ayrı okumalarla yapılması; süresi dolan ama platformda
  süren işlemin geri alınması; iptalden önce alınmış konsol biletleri; destek yanıtlarında hız sınırı.
- **Yol üstünde bulunan işlev hatası:** bildirim e-postaları Node 22'de bir tarih biçimi seçeneği hatası yüzünden
  gönderilmiyordu; düzeltildi.
- **Ne doğrulanmadı:** ikinci turda dizin ve SSO girişinin yeniden denetimi yapılamadı, denetimin sonradan önerdiği
  altı alan incelenmedi, üç konu işletmecinin kararına ya da denetimine bırakıldı (üçü de değiştirildi), bir aday
  reddedildi ve dört aday bağımsız bir doğrulama almadı (ikisi değiştirildi; bayilerle ilgili ikisi değiştirilmedi).
  Düzeltmeler birim testleriyle ve gerçek PostgreSQL / Redis üzerinde entegrasyon testleriyle doğrulandı; gerçek
  hipervizörlerde, gerçek bir Proxmox kümesinde ve gerçek bir Param üye işyeri hesabıyla **doğrulanmadı**; kurulum
  betiğinin yolları yalnızca sahte dosyalarla denendi.

Tam özet: [docs/security-audit.md](docs/security-audit.md) (İngilizce). İşletmeciyi etkileyen değişiklikler:
[docs/upgrade-notes.md](docs/upgrade-notes.md).

**Açık bildirme:** bir güvenlik açığı bulursanız lütfen herkese açık issue açmayın; [SECURITY.md](SECURITY.md)
dosyasındaki yolu izleyin (GitHub'ın özel bildirimi: Security → Report a vulnerability).

## 🤖 Bu proje nasıl yazıldı?

Lightning VM, **vibe coding** yaklaşımıyla geliştirildi: proje sahibi ne istediğini Türkçe anlattı, ekran
görüntüleriyle geri bildirim verdi; kodu, testleri, belgeleri ve kurulum betiklerini
[Claude Code](https://claude.com/claude-code) (Anthropic) yazdı. Her adımda şu kurallara uyuldu:

- Her özellik için birim / entegrasyon / uçtan uca test; her arayüz değişikliği telefon, tablet ve geniş ekranda
  ekran görüntüsüyle kontrol edildi.
- Her commit öncesi bağımlılık açıkları (npm audit, govulncheck, Dependabot) kontrol edildi.
- Kullanıcının sunucuya girmesi gerekmeyecek şekilde her işlem panelden yapılabilir tasarlandı.

Bu yöntem hızlıdır ama insan gözünden geçmemiş kod barındırır. Kodu okuyup katkı vermeniz, hata bildirmeniz
projeyi güvenilir kılacak olan şeydir.

## 📄 Lisans

[Apache License 2.0](LICENSE). Depoda ve derlenen imajlarda yer alan üçüncü taraf içerik (Lucide simgeleri, yazı
tipleri): [NOTICE](NOTICE).

---

## 🌍 English summary

**Lightning VM** is an open-source hosting panel for VMware (ESXi / vCenter 6.0–9.x) and, as first releases, Proxmox VE, XCP-ng / XenServer, oVirt / RHV, Microsoft Hyper-V, plain KVM hosts (libvirt over SSH) and Incus / LXD. Customers order and manage
virtual servers. Administrators manage capacity, IP pools, pricing, notifications and the panel
itself from the browser, including updates and backups. It ships with a one-command installer and
automatic HTTPS. The UI is in Turkish and English.

Highlights: smart ordering, reinstall, resize and clone, snapshots, extra disks, billing and invoices (monthly and
hourly), resellers, support desk, 17 notification channels (in-app, browser push, e-mail, SMS and 13 messaging
apps and webhooks), customer webhooks, LDAP / OIDC sign-in, passkeys and two-factor, live state of the panel host
(CPU, memory, disk, services, logs), operating system updates for the host and for customers' servers, window-style
dialogs (move, put aside, snap to halves and quarters, centre, resize, keyboard shortcuts), and accessibility controls.

What is not the same everywhere (the table under "Platform kapsamı" above has every platform):

- **Only on VMware:** browser console, firewalls, private networks, backups and restore, personal images, ISO
  library, live migration and host evacuation, throttling a server that used up its traffic allowance. The six newer
  adapters answer these with "not supported on this platform".
- **Usage graphs and traffic counting:** VMware and Proxmox VE only. **CPU usage per server** is not measured on
  XCP-ng, oVirt, KVM (libvirt) and Incus, so idle / oversized / mining findings, the health score and the energy
  report mean nothing there.
- **Browser console:** needs VMware's HTML Console SDK, which is not in this repository, and was never tried with
  the real SDK.
- **Payments:** only iyzico, PayTR, Craftgate, Param and Stripe (plus the built-in sandbox) can take a payment. The
  other 41 listed providers are credential forms, most with a check that moves no money. None was tried with a real
  merchant account. Stripe has no webhook: a payment whose customer never returns to the panel is settled when the
  billing run asks Stripe again (as for iyzico and Craftgate; not for PayTR and Param). **Param does not settle by
  itself:** its return cannot be confirmed with Param, so the payment stays pending as "awaiting confirmation" and
  staff mark the invoice paid after checking the Param panel. Param is offered for TRY invoices only, and the flow
  was not confirmed with the provider. Payments waiting for staff (Param's unconfirmed returns, another amount,
  held by the provider) have their own filter under Admin → Billing → Payments, with the reason, the waiting time
  and a link to the invoice; staff with `billing.manage` are notified once when a payment enters review.
- **e-Invoice (Turkey):** of seven integrators only İzibiz and Uyumsoft were sent a real e-Arşiv invoice, in their
  test systems.
- **IPv6:** an optional prefix on an IPv4 pool, one address per server; there are no separate IPv6 pools.
- **Monitoring** (Prometheus, Grafana, Loki, Alertmanager) can be switched from the panel only in the setup wizard;
  afterwards with `install.sh monitoring on|off`.
- **Real hardware:** only the Incus adapter (containers, Incus 6.0) ran against a real server. VMware was tested
  mostly against the govmomi simulator; Proxmox VE, XCP-ng, oVirt, Hyper-V and libvirt against imitations only.
- **Upgrading:** the last three rounds changed behaviour an operator can notice: a full audit of the API, worker,
  web UI, adapters and installer (49 changes, most of them in billing), then round one of the security audit below
  (Param payments confirmed by hand, signed backups, closed sign-in routes) and round two (the panel is on hold
  after a restore until released, `install.sh behind-proxy` needs `--public-url`, the billing integration matches
  only accounts it created, new send limits; restart the proxy and the log collector after upgrading). Read
  [docs/upgrade-notes.md](docs/upgrade-notes.md) (Turkish) before you update.
- **Tests:** unit tests: API 143, worker 43, web 70, Proxmox adapter 26, plus the other adapters'. The full
  integration test runner (`npm run test:integration:full`) sets up PostgreSQL, Redis, the simulator, the VMware
  adapter and the worker in Docker. Last run on 2026-11-17 on a Linux host with Docker: 170 of 174 tests passed, 4 were skipped (they need PowerDNS, an ISO storage or the console gateway). It includes the security tests of both rounds
  (`security-*.test.mjs`), which run against real PostgreSQL and Redis. Most of the billing behaviour changed in
  the full-audit round has no integration test of its own. The database schema is 81 migrations (`001`–`081`).
- **Private repository installs:** give `get.sh` the access token with `--token-file FILE` or `GIT_TOKEN` in the
  environment (`sudo --preserve-env=GIT_TOKEN sh`); `--token` works but is visible in the process list.
- **Backups** are encrypted and signed with `secrets/backup.key` (`NAME.tar.enc` plus `NAME.tar.enc.hmac`). Restore
  refuses a backup whose signature, name or key does not match; backups made by older versions restore only with
  `--allow-unsigned`. Restore works on a root-only copy of the archive, signs everyone out and puts the panel **on
  hold**: no operations, schedules, deletions or billing until an administrator has reviewed what changed since the
  backup and released it (Admin → System, or `docker compose exec api node dist/cli.js release-restore-hold`);
  `--no-hold` skips the hold only.
- **Behind another proxy:** `install.sh behind-proxy` needs the panel's public address
  (`--public-url https://panel.example.com`); mailed links are built from it.
- **Added on 2026-11-17 (no operator action; migration `081` runs by itself).** Staff: the review filter and search
  on the payments page (kept in the address), a notice on the billing overview, the `billing.payment_review`
  notification, counts in the menu next to Billing (payments in review), Servers (operations failed in 24 hours)
  and Abuse (open findings) from `GET /admin/attention`, the restore-hold bar on every page, three new findings
  (payments in review, restore hold, operations that ended as `OUTCOME_UNKNOWN` or `VM_MISMATCH` and need a
  decision), abuse and subscription filters kept in the address. Customers: an "upcoming charges" block on the
  first page (invoices overdue or due within 7 days, the next renewal, when the hourly balance runs out); the
  command palette finds invoices, remembers recent tickets and invoices and has quick actions (new ticket, top up,
  new server, add SSH key, reset a server after confirmation); a shareable order link (`/order?loc=&pkg=…`, checked
  against the catalog, no name or key in it); rename, lock / unlock and delete in the server card's menu; copy
  buttons that also work over plain HTTP and say so when nothing was copied; a before / after summary in the
  reinstall dialog; a finding for snapshots older than 30 days; the `auth.credentials_reset` notification.
- **What was open after the second security round is closed, one item in part:** staff are notified when a payment
  enters review and the admin payments page lists such payments; a user is notified when the first proof of an
  unverified address (first sign-in by e-mail link or code) removed something from the account. The reinstall
  dialog gained only the summary of what stays and what is erased.
- **Limits of the new parts:** the upcoming renewal amount is the subscription's amount before tax, and the same
  renewal can also appear as a due invoice in the days before it. Two of the new parts have an end-to-end test
  (reading an order link, finding an invoice in the command palette); the others had none at the time of writing.
  None of the new screens was looked at by hand in a browser, and the snapshot finding was not tried against a
  real platform.

> [!WARNING]
> This project was **vibe-coded**: almost all of the code was written by Anthropic's Claude Code, steered and
> tested by the maintainer. It has unit, integration and Playwright end-to-end tests and was tried on a demo
> server. It has **not** been audited by an independent third party (an AI-driven, partial security review was run
> in two rounds and its findings fixed; see Security below), and the VMware side was mostly tested against the govmomi
> simulator. **Expect bugs.** Review it and test in your own environment before using it with real customers or
> money.

**Security.** An AI-driven security review was run in two rounds in November 2026, on commits `641aa4d` and
`d9f90d3`: source review plus bounded checks in a sandbox without network access, with dummy data; nothing was sent
to a live system. Round one covered the whole repository and confirmed 22 weaknesses (1 high, 10 medium, 11 low):
the Param return is no longer proof of payment, several under-billing paths around resize and externally billed
servers, credentials that stayed on a transferred server, directory and single sign-on accounts signing in by other
routes, a role mapping that could create an administrator, request size limits, backups signed with the backup key,
and others. Round two covered the areas round one had left unreviewed (the maintenance channel through which the
panel manages its own host among them: no finding) and re-checked every round-one fix: 17 of the 22 hold on real
PostgreSQL, 4 (directory and single sign-on sign-in) could not be re-checked because the reviewer was stopped by the
model's safeguards (the project's integration tests cover them), and five places where a fix was incomplete were
found and fixed. Round two confirmed 26 more weaknesses (10 medium, 15 low, 1 informational), among them an
impersonation session that outlived the staff member's rights, requests and a booked cancellation that crossed a
server hand-over, reused Proxmox VM numbers, a reset token in request logs, unlimited SMS sends, and a restore that
acted on old orders. All 48 are fixed. Round one found no way for one customer to reach another customer's servers
through the customer routes; round two found such paths behind preconditions a customer cannot choose (a hand-over
in progress, a reused Proxmox VM number), and they are fixed. Both rounds were **partial passes**: in round two the
directory and single sign-on re-check and six further areas were not reviewed, three leads were left to the
operator (all three changed), and four candidates got no independent verdict (two were changed; two about resellers
were not). The fixes were verified by unit tests and by integration tests on real PostgreSQL and Redis, not against
real hypervisors, a real Proxmox cluster or a real Param merchant account, and the installer paths were exercised
with dummy files only. Details: [docs/security-audit.md](docs/security-audit.md). To report a vulnerability, do not
open a public issue; follow [SECURITY.md](SECURITY.md).

Quick start on Ubuntu 22.04 / 24.04 / 26.04:

```bash
curl -fsSL https://raw.githubusercontent.com/syildirim689/lightning-vm/main/scripts/get.sh | sudo sh -s -- -- --domain panel.example.com --lang en
```

The command downloads the source to `/opt/lightning-vm`, picks the latest stable release and runs the installer;
the panel later updates itself from there. Cloning the repository and running `sudo sh scripts/install.sh` works too.

Docs (mostly Turkish) are in [`docs/`](docs). Issues and pull requests are welcome.
