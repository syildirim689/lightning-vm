# Yükseltme notları

Bu sayfa, **kurulu bir Lightning VM'i yükselten işletmeci** içindir ve en yeni turdan eskiye doğru sıralıdır. Her
madde neyin değiştiğini ve işletmecinin yapması gereken bir şey varsa onu söyler. Yalnızca hata düzeltmesi olup
davranışı değiştirmeyen işler burada yoktur. Tahsilat çalıştırması API içinde beş dakikada bir çalışır; yani "ilk
çalıştırma" yükseltmeden birkaç dakika sonradır.

## 0.4.0'dan sonra eklenenler (yayımlanmamış)

Her madde kendi başına yüklenir; veritabanı değişikliği olanlarda migration kendiliğinden çalışır.

- **E-posta adresi doğrulama.** Ayarlar → E-posta'da postası açık olan kurulumlarda, bundan sonra **kayıt olan**
  hesaplara doğrulama kodu postalanır ve adresi doğrulanmamış her hesap Hesabım → Profil'de bir uyarı görür
  (kayıtla açılmış ve bayinin açtığı mevcut hesaplar dahil). **Hiçbir şey engellenmez:** sipariş kuralı (Ayarlar →
  Giriş güvenliği) kapalı gelir. Postayı istemeyen işletmeci Ayarlar → E-posta → "Adres doğrulama" işaretini
  kaldırır. Yalnızca `.env` içindeki `SMTP_URL` ile posta gönderen kurulumlarda özellik kapalıdır. Veritabanı
  değişikliği yoktur (kodlar Redis'te, 30 dakika). Ayrıntı: [auth.md](auth.md#e-posta-adresi-doğrulama).
- **Stripe webhook'u.** Stripe kullanan kurulumda bir şey yapılmazsa davranış aynıdır (dönüş ve yeniden sorma).
  Webhook'u açmak için: Ayarlar → Ödemeler → Stripe'ta gösterilen adresi Stripe'ta uç nokta olarak ekleyin,
  `payment_intent.succeeded` ve `checkout.session.expired` olaylarını seçin, Stripe'ın verdiği imza anahtarını
  (`whsec_...`) aynı ekranda "Webhook imza anahtarı" alanına kaydedin (test ve canlı için ayrı). Veritabanı
  değişikliği yoktur. Ayrıntı: [payments.md](payments.md#stripe-webhooku).
- **Proje başına kota.** Hiçbir projenin kotası yoktur, personel verene kadar da olmaz: mevcut kurulumda davranış
  değişmez. Veritabanı değişikliği yoktur (`quotas` tablosu `project` kapsamını baştan beri taşıyordu). Kotası olan
  bir projede sınır aşılınca API `QUOTA_EXCEEDED` yerine `PROJECT_QUOTA_EXCEEDED` döner; bu kodu yalnızca proje
  kotası tanımlayan kurulumlar görür. Ayrıntı: [catalog.md](catalog.md#kotalar-ve-projeler).
- **Akıllı yardımcılar** (kullanım takibi, ay sonu tahmini, zamanlama önerisi, ödeme riski, destek yardımı;
  kurallar ve eşikler: [smart-features.md](smart-features.md)). İşletmecinin yapacağı bir şey yoktur; hiçbiri
  kendiliğinden bir sunucuda, faturada ya da talepte değişiklik yapmaz.
  - **Veritabanı:** migration 088 iki tablo (`usage_anomalies`, `server_cpu_hourly`) ve
    `server_cpu_samples` üzerinde bir BRIN dizini ekler; 089 `users` tablosuna bir sütun ekler. Mevcut veri
    değişmez. Yükseltmeden iki dakika sonra worker, eldeki 14 günlük işlemci örneklerini bir kez saatlik satırlara
    toplar; sonrasında saatte bir yalnızca yeni örnekleri okur.
  - **Değişen rakam:** saatlik faturalanan sunucusu olan hesaplarda genel bakıştaki "Bu ay" kartı ve
    `GET /usage/summary` artık aylık liste fiyatını değil, faturalamanın kaydettiği saatlik kullanımı ve onun ay
    sonuna izdüşümünü gösterir. Saatlik sunucusu olmayan hesaplarda rakamlar aynıdır. Faturalar etkilenmez.
  - **Yeni bildirimler:** `server.usage_anomaly` (varsayılan: yalnız panel) ve `billing.budget_forecast`
    (varsayılan: panel ve e-posta; yalnızca bütçe belirlemiş müşterilere, ayda bir). Kapatmak isteyen işletmeci
    Ayarlar → Bildirim kuralları'ndan kanallarını kaldırır.
  - **Geçmiş gerektirenler:** kullanım takibi yaklaşık 5 gün, zamanlama önerisi 21 gün işlemci geçmişi ister; o
    zamana kadar ve işlemci ölçümü vermeyen platformlarda (XCP-ng, oVirt, libvirt, Incus) "yeterli veri yok" denir.
  - **Yeni ortam değişkeni (isteğe bağlı):** worker için `ANOMALY_MINUTES` (varsayılan 60).
- **Bakım için en sakin saatler ve dönemsel özet.** İkisi de kendiliğinden bir şey yapmaz.
  - En sakin saatler yalnızca gösterilir (Sistem → Otomatik güncellemeler, bağlantı → Host'lar); güncelleme
    penceresi ancak düğmeye basılırsa değişir. 21 günlük işlemci geçmişi ister. Veritabanı değişikliği yoktur.
  - Migration 091 yalnızca bir dizin ayarıdır (`server_cpu_samples_at`, `autosummarize = on`): veri okunmaz,
    yeniden yazılmaz.
  - Dönemsel özet **kapalı** gelir: personel kendi özetini Hesabım → Bildirimler'den açar; müşteriler için önce
    Ayarlar → Bildirim kuralları'nda `account.digest` olayını açmanız gerekir (varsayılan: kapalı). Migration 090
    boş bir tablo (`digest_preferences`) ve bir dizin ekler; mevcut veri okunmaz ve değişmez. API beş dakikada
    bir, vadesi gelen özet olup olmadığına tek dizinli sorguyla bakar.

## 0.4.0 (beta): kurulum betiğinin yeni çıktısı ve sürüm numarası (2026-11-21)

Bu sürümde veri değişikliği, yeni `.env` değişkeni ya da yeni ayar yoktur. Değişen, kurulum betiklerinin
(`scripts/get.sh`, `scripts/install.sh`) ekrana ne yazdığı ve `install` komutunun sırasıdır. Betiği kendi
otomasyonundan çağıran ya da çıktısını okuyan işletmeci şunlara bakmalıdır:

| Ne değişti | Kimi etkiler | Ne yapmalı |
|---|---|---|
| `install` uçbirimde iki soru sorar: dil (yalnızca `--lang` verilmediyse; 30 sn sonra varsayılanla sürer) ve ön kontrol raporundan sonra "Devam edilsin mi?" (süresiz bekler). "Hayır" çıkış kodu `3` verir ve hiçbir şey kurulmaz | Betiği **uçbirimde** ama başında kimse olmadan çalıştıranlar (`ssh -t`, `expect`, tmux içinde bir betik) | `--lang tr\|en --yes` ekleyin. Uçbirim olmayan çalıştırmalarda (cloud-init, CI, `nohup … > dosya`, systemd, panelin ajanı) hiçbir şey sorulmaz; bir şey yapmanız gerekmez |
| Ön kontroller artık Docker kurulmadan **önce** yapılır. Eskiden root ile çalışan betik önce Docker'ı kurar, sonra denetlerdi | Desteklenmeyen işletim sisteminde ya da yetersiz bellekle deneyenler: betik artık Docker'ı kurmadan durur | Bir şey yapmanız gerekmez |
| `install`, servisleri başlatmadan önce `docker compose build` çalıştırır (ilerlemeyi gösterebilmek için); ardından her zamanki `docker compose up -d --build --wait` gelir | Yok; imaj derlenemezse hata yine `E_START_FAILED` (çıkış 18), iletisi "İmajlar derlenemedi" | — |
| Uçbirim olmayan çıktıda yeni satırlar: `INFO INSTALLER`, `INFO PLAN`, `INFO STEP`, `OK STEP_DONE`, `INFO PROGRESS`, başarısız adımda `INFO LOG_TAIL` + `      \| …` satırları, `INFO HINT`, `INFO LOG`; `install` raporunda `OK TIME` / `W_TIME_UNSYNCED`, `W_DNS_NO_A`, `W_PORT_IN_USE`, `INFO STATE` | `install` ya da `update` çıktısını satır sayısına ya da sırasına göre okuyan betikler | Kodu satırın ikinci alanından okuyun; hata ve sonuç yine **son satırdır** (`OK UPDATED`, `OK UP_TO_DATE`, `FAIL E_…`, geri dönüşte `WARN DB_NOT_ROLLED_BACK`). `backup`, `check`, `releases` çıktısı bayt bayt aynıdır |
| Uçbirimdeki çıktı artık `DÜZEY KOD metin` değil, işaretli ve renkli satırlardır (`✓ KOD metin`) | Uçbirim çıktısını `script`/`expect` ile okuyanlar | `--plain` ekleyin ya da `TERM=dumb` verin: eski satır biçimi |
| Betiğin çalıştırdığı komutların çıktısı `data/logs/<komut>-<zaman>-<pid>.log` dosyalarına yazılır (izin 600; en yeni 30 dosya). Docker kurulumunda apt'nin hata çıktısı da artık ekrana değil oraya gider; adım başarısız olursa son 20 satırı gösterilir | `data/` klasörünü yedekleyen ya da izleyenler: yeni bir alt klasör | — |
| Bir adım kendi hata iletisi olmadan biterse `install` `FAIL E_STEP_FAILED` yazar; çıkış kodu o komutunkidir (eskiden de öyleydi, ileti yoktu) | — | — |
| Dil varsayılanı artık `LC_ALL`, `LC_MESSAGES`, `LANG` sırasıyla okunur (eskiden yalnızca `LANG`) | `LANG=tr_TR.UTF-8` ama `LC_ALL=C` ile çalıştıranlar: çıktı artık İngilizce | `--lang tr` verin |
| `get.sh` seçtiği dili `install.sh`'e her zaman `--lang` ile geçirir; iletileri iki dillidir (uçbirim olmayan İngilizce çıktıda `OK    source at vX.Y.Z` satırı aynı kaldı); `install.sh`'in standart girdisi `/dev/null`'dır | `get.sh` çıktısını okuyanlar | — |
| Paneldeki sürüm etiketi "Erken sürüm / Early build" yerine "Beta" yazar; paketlerin `package.json` sürümü `0.4.0` | — | — |

**Sürüm numarası.** Yayımlanan sürümler `v0.1.0` ve `v0.4.0`'dır. `0.1.1`-`0.3.0` numaraları yalnızca iç test
kurulumlarında kullanıldı ve yayımlanmadı; depoyu GitHub'dan alan bir kurulumda bu etiketler yoktur. `v0.1.0`'dan
yükseltenler bu sayfanın **tamamını** okumalıdır: aşağıdaki bütün turlar bu sürümün içindedir.

## Bekletilen ödemeler, dizin hesaplarının API anahtarları, kuyrukta bekleme ve bayiden ayrılınca liste fiyatı (2026-11-19)

İlk güvenlik turunun bulgu çıkarmadan kapattığı 65 inceleme birimi bu turda yeniden okundu ve bir önceki turun
"olduğu gibi bırakılanlar" listesinin dördü değiştirildi. Yeniden okuma tek bir inceleyiciyle ve yalnızca kaynak
üzerinde yapıldı; bağımsız doğrulamadan geçmiş bir denetim turu **değildir**
([security-audit.md](security-audit.md#re-review-of-the-units-round-one-closed-without-a-finding-2026-11-19)).

Veri değişiklikleri iki dosyadadır ve yükseltme sırasında kendiliğinden uygulanır:
`apps/api/migrations/086_source_confirmed.sql` (`users.source_confirmed_at`) ve
`087_operation_held_since.sql` (`operations.held_since`). İki yeni `.env` değişkeni ve bir yeni ayar vardır; üçü de
varsayılanıyla çalışır, `.env` dosyasına bir şey eklemeniz gerekmez:

| Ad | Nerede | Varsayılan | Ne yapar |
|---|---|---|---|
| `DIRECTORY_TOKEN_DAYS` | `.env` (API) | `30` (0-3650; `0` kuralı kapatır) | Dizin ya da SSO hesabının API anahtarı, hesap kaynağında en son doğrulandıktan sonra kaç gün çalışır |
| `OPERATIONS_HELD_HOURS` | `.env` (worker) | `6` (`0`: bekleme eskisi gibi süreden düşer) | Hesap payını beklerken geçen sürenin, işlemin son tarihine en çok kaç saat eklenebileceği |
| `reviewHoldDays` | Ayarlar → Faturalandırma | `7` (0-90; `0` kapatır) | İnceleme bekleyen bir ödemenin faturasını kaç gün askıdan, silmeden ve ikinci ödemeden koruduğu |

Bu turun test sonuçları (`ea0d19e` commit'i): birim testleri API 162, worker 54, web 128, hepsi geçti. Entegrasyon
paketinin tamamı 2026-11-19'da Docker'lı bir Linux sunucusunda çalıştırıldı: 204 testten 200'ü geçti, 4'ü atlandı
(PowerDNS, ISO deposu ya da konsol ağ geçidi isteyenler), başarısız olan yok; bu turun `security-leftovers-2`
testleri bu sayının içindedir. Uçtan uca paket (Playwright) kendi geçici Compose kurulumuna karşı, boş bir
veritabanı ve VMware simülatörüyle çalıştırıldı (gerçek veri taşıyan bir panele karşı çalıştırılmaz): 33 testin 33'ü
geçti (yaklaşık 14 dakika).
Paketin bazı yeni adımlarında durum sayfaya dışarıdan verilir; hangileri olduğu README'nin
[Geliştirme ve testler](../README.md#-geliştirme-ve-testler) bölümündedir. Hiçbir ekran tarayıcıda elle
kullanılmadı; paketin aldığı 187 ekran görüntüsünün 115'ine gözle bakıldı, 72'sine bakılmadı. Hiçbir şey gerçek bir hipervizörde, gerçek bir Proxmox kümesinde, gerçek bir Param hesabında ya da gerçek bir
dizin sunucusunda denenmedi.

Aşağıdaki maddeler işletmecinin fark edeceği her değişikliği sayar; ilk dördü yükseltmeden önce okunmalıdır.

- **Başlatma sırası: API, worker'dan önce ya da onunla birlikte.** Yeni worker `operations.held_since` sütununu
  (migration `087`) kullanır. Olağan güncelleme (`install.sh update` ya da `docker compose up -d`) migration'ları
  `migrate` servisiyle API ve worker başlamadan uygular; yapacağınız bir şey yoktur. Yalnızca worker'ı tek başına
  yeni sürüme alırsanız, migration uygulanana kadar payı dolu bir hesabın sıradaki işlemleri bekletilemez ve hata
  verir.
- **Dizin (LDAP) ve SSO hesaplarının API anahtarları 30 günde bir doğrulama ister.** Böyle bir hesabın kişisel API
  anahtarı yalnızca hesap, kaynağında son `DIRECTORY_TOKEN_DAYS` gün içinde doğrulanmışsa kabul edilir; değilse
  istek `401 TOKEN_ACCOUNT_UNCONFIRMED` yanıtı alır. Anahtar silinmez, "uykuda"dır: kişi panele dizin ya da SSO
  üzerinden yeniden girdiğinde yeniden çalışır. Önceden bu anahtarlar, hesap dizinde kapatılsa da, panelde
  yasaklanana kadar çalışıyordu.
  - **Süre yükseltme anından başlar.** Migration `086` mevcut dizin ve SSO hesaplarını yükseltme anında doğrulanmış
    sayar; anahtarları çalışmaya devam eder ve ilk kesinti en erken 30 gün sonradır.
  - **Doğrulama nedir:** dizinin ya da sağlayıcının kabul ettiği her panel girişi. LDAP'ta, servis hesabı (bind)
    çalışıyorsa, panel ayrıca anahtar kullanıldığında dizine kendisi sorar (hesap başına en çok saatte bir, son
    doğrulamanın üstünden bir gün geçtiyse): hesap bulunursa doğrulama yenilenir, yani yalnızca API kullanan bir
    dizin hesabının 30 günde bir panele girmesi gerekmez. Arama çalışır ve kimseyi bulamazsa hesabın anahtarları
    hemen uykuya alınır ve denetim kaydına `auth.directory_user_missing` yazılır. Dizin yanıt vermezse, yanıt
    belirsizse ya da dizin girişi kapalıysa hiçbir şey değişmez; yaş sınırı karar verir.
  - **SSO hesaplarında sorulacak bir yer yoktur:** bu hesaplar en az `DIRECTORY_TOKEN_DAYS` günde bir panele SSO
    ile girmelidir. SSO hesabıyla çalışan otomasyonunuz varsa bunu takvime koyun, süreyi `.env` içinde büyütün ya
    da otomasyon için yerel bir hesap kullanın. `DIRECTORY_TOKEN_DAYS=0` kuralı tümüyle kapatır (değişiklik için
    API yeniden oluşturulur: `docker compose up -d api`).
  - **Panelde:** Hesabım → Geliştirici'deki anahtar listesi ve Ayarlar → API'deki "Tüm anahtarlar" listesi uykudaki
    anahtarı "Uykuda" diye işaretler; dizin ya da SSO hesabı kendi sayfasında anahtarlarının ne zamana kadar
    çalışacağını okur. API: `GET /api/account/api-tokens` yanıtında `asleep` ve `confirmation`.
  - Dizine sorma yolunun kendi testi yoktur ve gerçek bir LDAP sunucusunda denenmedi; testler yalnızca yaş kuralını
    kapsar ([auth.md](auth.md#dizin-ldap--active-directory-ile-giriş)). Dizinden çıkardığınız kişinin erişimini
    hemen kesmek için yine panelde yasaklayın ya da anahtarlarını silin.
- **İnceleme bekleyen ödeme, faturasını bekletir (`reviewHoldDays`).** Bir faturanın inceleme bekleyen ödemesi
  varken, incelemenin başladığı andan itibaren en çok `reviewHoldDays` gün (Ayarlar → Faturalandırma; 0-90,
  varsayılan 7): o fatura için sunucu askıya alınmaz ve silinmez, ödenmemiş sipariş süresi dolduğu için geri
  çekilmez ve hatırlatma gönderilmez. Gecikme bildirimi yine bir kez gider ve ödemenin incelendiğini, yeniden ödemek
  gerekmediğini söyler. Aynı süre içinde **müşteri faturayı ikinci kez ödeyemez** (`409 PAYMENT_IN_REVIEW`; bakiye,
  kayıtlı kart ve kart, hepsi); fatura yanıtı engelin ne zamana kadar sürdüğünü söyler (`invoice.payBlockedUntil`,
  ISO tarih ya da `null`; retle aynı işlevden) ve fatura sayfasındaki ödeme düğmeleri o zamana kadar, gerekçesiyle,
  kapalıdır. Önceden askı adımları
  inceleme sırasında sürüyordu ve müşteri aynı faturaya ikinci bir ödeme başlatabiliyordu.
  - **Süre dolduğunda koruma biter.** İnceleme hâlâ açıksa fatura her ödenmemiş fatura gibi yeniden tahsilata girer
    (hatırlatma, askı, ayarlıysa silme) ve müşteri yeniden ödeyebilir. Kimsenin karar vermediği bir inceleme
    ödenmemiş bir sunucuyu süresiz korumaz ve müşteriyi süresiz kilitlemez. İncelemeleri bu süre içinde kapatın.
  - `0` ikisini birden kapatır: askı adımları inceleme sırasında işler ve ikinci ödeme reddedilmez (bir önceki
    sürümün davranışı).
  - **Kapsamadığı:** saatlik kullanımda bakiyesi eksiye düşen hesabın sunucularının saat başı kapatılması bu
    beklemenin dışındadır (silinmeleri bekler). Otomatik tahsilat, bir önceki sürümdeki gibi, böyle bir faturadan
    çekmez ([payments.md](payments.md#incelemedeki-ödemeler)).
- **Bayiden ayrılan müşterinin sunucuları liste fiyatına geçer.** Müşteri bayiden ayrıldığında, personel onu
  ayırdığında ya da bayilik kaldırıldığında, aboneliği müşteriye geçen sunuculardan bayinin indirimi kalkar: **bir
  sonraki faturadan itibaren** liste fiyatıyla faturalanırlar; bayinin ödediği dönem için müşteriden bir şey
  istenmez. Önceden müşteri bayinin indirimli fiyatını ödemeye devam ediyordu.
  - **Yalnızca fiyat kesinse.** Panel sunucu başına tek bir fiyat saklar; liste fiyatını bugünkü katalogdan hesaplar
    ve yalnızca bugünkü katalog fiyatından bayinin şimdiki indirimi düşüldüğünde sunucunun fiyatı kuruşu kuruşuna
    çıkıyorsa değiştirir. Katalog ya da indirim o günden beri değiştiyse, personel fiyatı elle belirlediyse ya da
    sunucu bir sanal veri merkezine aitse **fiyat olduğu gibi kalır** ve sunucu personele listelenir: yanıtta ve
    `reseller.customer_released` denetim olayında `pricesKept`, panelde kullanıcı özeti penceresinde bir uyarı.
    Bu sunucuların fiyatına personelin bakması gerekir.
  - Müşteri yeni aylık tutarları ayrılmadan önce onay sorusunda ve ayrıldıktan sonra bildirimde görür
    (`GET /api/reseller/summary` → `managedBy.afterLeave`; yanıtta `listPrices`).
  - Tahsilatın silinmek üzere işaretlediği bir sunucu, aboneliği zaten bitmiş ya da iptal edilmişse, sahibi bayiden
    ayrıldığında artık yeni bir abonelik almaz; silme kararı yerinde kalır ([billing.md](billing.md#bayiler-kim-öder)).
- **Kullanıcı adına oturum açmış personel hesabı bayiden ayıramaz ve devredilen sunucuyu kabul edemez**
  (`403 NOT_WHILE_IMPERSONATING`). İkisi de hesabın sahibinin kararıdır. Personel bir müşteriyi bayiden kendi
  hesabıyla, Yönetim → Kullanıcılar'daki "Bayiden çıkar" ile ayırır.
- **Bir hesap saatte en çok 20 kart ödemesi başlatabilir** (`429 RATE_LIMITED`; hesabın bütün faturaları için
  ortak). Olağan kullanımda bu sınıra gelinmez.
- **Bayinin yaptıkları müşterinin etkinlik listesinde.** Bayinin müşterisinin sunucusunda işlem başlatmadan
  yaptıkları da artık müşterinin Hesabım → Etkinlik listesindedir: konsol açma, güç zamanlaması, etiket, disk,
  sunucudan imaj alma, ad değiştirme ve kilit. Satırda bayinin adı ya da markası yazar. Bu sürümden önceki
  eylemler geriye dönük görünmez.
- **Etkinlik listesine istek gövdesinden kayıt yazılamaz.** Bir olayı başka bir hesabın etkinlik listesine koyan
  alanlar (`forOwner`, `actingAs`) artık yalnızca denetim işlevinin kendisi tarafından yazılır. Abonelik değişikliği
  olayları (`billing.subscription_changed`, `billing.subscription_updated`) denetim kaydında yalnızca doğrulanmış
  alanları taşır (önceden istek gövdesinin tamamı yazılıyordu) ve yalnızca işlemi yapanın kendi etkinlik listesinde
  görünür.
- **Kuyrukta bekleme süresi işlemin süresinden düşmez (`OPERATIONS_HELD_HOURS`).** Hesap payını bekleyen bir işlem
  başladığında, beklediği süre son tarihine geri eklenir; en çok `OPERATIONS_HELD_HOURS` saat (varsayılan 6).
  Bundan da uzun bekleyen işlem serbest bırakılır ve zaman aşımıyla (`TIMEOUT`) biter. Payı bekleyen işlem "takılmış
  işlem" içgörüsünde sayılmaz. `0`, eski davranıştır ([operations.md](operations.md#kuyrukta-hesap-payı)).
- **Web.** Önceki sürümün tarayıcıda bıraktığı kayıtlı görünümler, hesap çıkış yaparken tarayıcı temizlenmeden önce
  o hesaba gönderilir (başkasına ait olanlar gönderilmeden silinir). Onaylayan bir düğme işleminden sonra
  kaybolduğunda klavye öndeki pencerede kalır, yani Escape onu yine kapatır (her pencerede). Ayarlar'daki Sandbox
  yardımı ve paneldeki API belgeleri dört test kartını
  da sayar; `4000 0000 0000 4954` ("incelemeye alınır") dahil.
- **Ekran görüntülerinde görülenler düzeltildi (arayüz; yapacağınız bir şey yok).** Telefonda pencere düğmeleri alt
  alta dizilir ve pencerenin dışına çıkmaz, komut paleti ekrana sığar, fatura satırları etiket / değer blokları
  olarak okunur, arka plan işleri düğmesi simgeye küçülür; sayfalar seçim çubuğunun altında yer bırakır; yüzdeler,
  bellek boyutları ve saatlik fiyatlar okuyanın diline göre yazılır; 640 ile 1280 px arasında geniş tablolar yana
  kaydığını gösterir. Destek ekibinizin fark edeceği üç ad değişikliği: bekletilen ödeme her yerde "inceleme
  bekliyor" diye geçer (müşterinin notu: "Ödemeniz inceleme bekliyor"); Türkçe arayüzde özellik her yerde
  "firewall"dur; müşteri başarısız işlemin nedenini hata kodu olmadan görür (kod hazır doldurulan destek talebine
  gider) ve gelen kutusu işlemleri sözle adlandırır. Tarayıcı bildirimi, e-posta ve mesajlaşma metinleri hâlâ
  işlemin ham adını taşır. Bilinen ve bırakılan: "anahtar oluşturuldu" bildirimi yeni anahtarın Kaldır düğmesini
  örtebilir; yeni giriş bildirimi tarayıcının ham kimlik metnini gösterir.
- **Bir önceki turun "olduğu gibi bırakılanlar" listesinden kalanlar.** Hesap payı, birlikte hareket eden birden
  çok hesabı sınırlamaz. Bayinin müşterinin sunucularını yalnızca görüntülemesi etkinlik listesinde yoktur. Bayiden
  ayrılma, bayinin tam o anda verdiği bir siparişle çakışabilir. Yalnızca kapatılan (kaldırılmayan) bayi, abonelikleri
  ödemeye devam eder.

## Güvenlik turundan kalanların kapatılması ve hesapta saklanan görünümler (2026-11-18)

İkinci güvenlik turunun "incelenmedi" ya da "değiştirilmedi" diye bıraktığı konular bu turda ele alındı. Bu, kaynak
incelemesi ve testlerle yapılmış bir takiptir; bağımsız doğrulamadan geçmiş bir denetim turu **değildir**
([security-audit.md](security-audit.md)). Veri değişiklikleri üç dosyadadır ve yükseltme sırasında kendiliğinden
uygulanır: `apps/api/migrations/083_saved_views.sql` (`saved_views` tablosu),
`084_owner_share_reseller_notice.sql` (`operations.capped_for`, `users.reseller_notice_at`) ve
`085_staff_addresses_proven.sql` (personelin kefil olduğu mevcut hesapları kanıtlanmış işaretler; ikinci maddeye
bakın). Elle çalıştırılacak bir şey yoktur.

Bu turun birim testleri geçiyor. Entegrasyon paketinin tamamı 2026-11-18'de, `eaa0a4e` commit'inde, Docker'lı bir
Linux sunucusunda çalıştırıldı: 196 testten 192'si geçti, 4'ü atlandı (PowerDNS, ISO deposu ya da konsol ağ geçidi
isteyenler), başarısız olan yok. Bu turda eklenen 19 test (`saved-views`, `security-leftovers` ve `security-auth` ile
`security-billing` dosyalarına eklenenler) bu sayının içindedir ve geçti. Uçtan uca paket (Playwright) aynı commit'te,
demo kurulumunda, boş bir veritabanı ve VMware simülatörüyle çalıştırıldı: 31 testin 31'i geçti. Hiçbir ekrana
tarayıcıda elle bakılmadı; uçtan uca adımı olmayanların listesi README'nin
[Bilinen sınırlar](../README.md#-bilinen-sınırlar) bölümündedir.

Aşağıdaki maddeler işletmecinin fark edeceği her değişikliği sayar; ilk beşi yükseltmeden önce okunmalıdır.

- **Dizin (LDAP) ve SSO kullanıcıları her `SESSION_TTL_HOURS` saatte bir yeniden giriş yapar.** Dizin ya da SSO
  hesabının oturumu, kullanılsa da kullanılmasa da, açıldıktan `SESSION_TTL_HOURS` saat sonra biter (varsayılan 12).
  Önceden oturum kullanıldıkça uzuyordu ve dizinde kapatılan bir hesap panelde oturumunu sürdürebiliyordu. İki adımlı
  doğrulama değişikliği sırasında yenilenen oturum, yerine geçtiği oturumun yaşını taşır. Kullanıcılarınız gün içinde
  bir kez daha giriş yapmak zorunda kalıyorsa `.env` içindeki `SESSION_TTL_HOURS` değerini büyütün (1-720; bu değer
  herkesin oturum süresidir). Yerel hesapların oturumu eskisi gibi kullanıldıkça uzar.
- **Adresi kanıtlanmamış bir hesapta ilk "Parolamı unuttum" sıfırlaması, hesapta önceden kurulanları siler.** Panel
  kayıtta e-posta adresini doğrulamadığı için kayıtla açılmış her hesap, sahibi adresi bir kez kanıtlayana kadar
  "kanıtlanmamış" sayılır. Önceden yalnızca giriş bağlantısı ve e-posta koduyla ilk giriş kanıt sayılıyordu; artık
  postayla gelen sıfırlama bağlantısıyla belirlenen ilk parola da kanıttır. O anda bir kez silinenler: API anahtarları,
  passkey'ler, bağlı giriş hesapları, webhook'lar, mesajlaşma ve tarayıcı bildirimi bağlantıları, telefon numarası,
  açılmamış iki adımlı doğrulama, **kayıtlı SSH anahtarları, kayıtlı kartlar, fatura e-postası ve telefonu**, yarıda
  kalmış ikinci adım ve "bu cihaza güven" kayıtları ile hesabın başka hesaplara yaptığı, henüz kabul edilmemiş sunucu
  devri teklifleri. Sunucular, kişisel imajlar, bakiye, talepler ve fatura bilgilerinin geri kalanı durur. Hesapta
  sunucu, imaj ya da bakiye hareketi varsa personel için kullanıcıya bir ekip notu düşülür (bunları kuran kişi posta
  kutusunun şimdiki sahibi olmayabilir). Kullanıcıya `auth.credentials_reset` bildirimi gider.
  - **Kayıtlı kart silindiği için otomatik yenileme o hesapta karttan çekemez;** müşteri Faturalama'dan yeniden kart
    ekleyene kadar yenilemeler yalnızca bakiyeden denenir. Destek ekibinize bunu söyleyin.
  - **Personelin kefil olduğu mevcut hesaplar yükseltmede kanıtlanmış işaretlenir** (migration `085`): müşteri rolü
    (`user`) dışında bir rolü olan her hesap (yöneticiler ve personel) ve denetim kaydına göre Yönetim →
    Kullanıcılar'dan açılmış hesaplar. Bunları elle işaretlemeniz gerekmez; bir yöneticinin ilk "Parolamı unuttum"
    sıfırlaması passkey'lerini ve API anahtarlarını silmez.
  - **Geri kalan mevcut hesaplar kanıtlanmamış kalır:** kayıtla açılmış müşteri hesapları ve bayilerin açtığı müşteri
    hesapları. Faturalama entegrasyonunun (WHMCS / WISECP) hesaplarına migration dokunmaz; entegrasyon onları açarken
    işaretler, işareti olmayan bir entegrasyon hesabı kanıtlanmamış kalır. **Bu hesapların her birinde postayla
    yapılan ilk parola sıfırlaması kayıtlı kartları, SSH anahtarlarını, API anahtarlarını ve yukarıda sayılan
    diğerlerini bir kez siler;** sonraki sıfırlamalar bir şey silmez. Müşterileriniz bunu ilk "Parolamı unuttum"da
    görür. Yükseltmeden sonra kaç hesabın bu durumda olduğunu şu sorgu verir:
    `SELECT count(*) FROM users WHERE NOT coalesce(email_verified, false);`
  - Adresinden emin olduğunuz tek bir hesabı Yönetim → Kullanıcılar'dan "doğrulanmış" işaretleyebilirsiniz; bu işaret
    sahibin kanıtı değildir, hiçbir şeyi silmez ve işaretlenen hesapta sonraki sıfırlama da bir şey silmez.
  - Yükseltmeden **sonra** kurulum yöneticisi ve personelin Yönetim → Kullanıcılar'dan açtığı hesaplar baştan
    kanıtlanmış sayılır. Bayinin açtığı müşteri hesapları kanıtlanmamış başlar.
- **Sunucu devralmak için kanıtlanmış adres gerekir.** Adresi kanıtlanmamış bir hesap devir teklifini kabul edemez
  (`403 ADDRESS_NOT_PROVEN`); teklif bir haftalık süresi boyunca açık kalır. Kullanıcı adresini bir kez kanıtlar
  (giriş bağlantısı, e-posta kodu ya da "Parolamı unuttum") ve teklifi yeniden kabul eder. Yukarıdaki silme o anda
  uygulanır; hata metni bunu söyler.
- **İşlem kuyruğunda hesap payı: `OPERATIONS_PER_OWNER`.** Bir hesap aynı anda en çok bu kadar işlem yürütebilir;
  fazlası beklerken sıradaki başka müşterilerin işlemleri çalışır. Varsayılan, `OPERATIONS_CONCURRENCY` değerinin
  yarısıdır (en az 1; varsayılan kurulumda 4); `0` payı kapatır. Personelin, tahsilat çalıştırmasının ve faturalama
  entegrasyonunun işlemleri hiç bekletilmez. Çok sunuculu bir müşterinin toplu işlemleri ve aynı dakikaya kurulmuş
  zamanlamaları artık dörder dörder ilerler; işlemin süresi bekleme sırasında da işler
  ([operations.md](operations.md#kuyrukta-hesap-payı)). Değeri değiştirmek için `.env` dosyasına yazın ve
  worker'ı yeniden oluşturun (`docker compose up -d worker`).
- **Ayar personeli dizin ya da SSO ayarını kaydederken reddedilebilir.** Kaydeden kişinin izinleri artık yalnızca
  eşlenen rolleri değil, o kaynaktan giriş yapan **her hesabın** izinlerini (rolleri ve kişiye özel istisnaları)
  kapsamalıdır; aksi halde `403 FORBIDDEN_TARGET` döner ve formda "Bu sunucu üzerinden giriş yapan hesaplarda sizde
  olmayan yetkiler var" yazar. Yöneticiler etkilenmez. Dizinden giren bir yöneticiniz varsa dizin ayarını bundan sonra
  yalnızca yöneticiler kaydedebilir.
- **Dizin ayarı testi artık giriş denemesi sayılır.** Ayarlar → Dizin'deki test bir e-posta ve parolayla
  yapıldığında o adresin giriş sınırından düşer (15 dakikada 10, giriş formuyla ortak). Aynı kişiyle art arda test
  yapmak o kişinin girişini 15 dakika kilitleyebilir.
- **Hesabı olmayan bir adres dizine yalnızca düz yazımıyla sorulur.** "İlk girişte oluştur" açıkken, içinde boşluk,
  görünmez karakter ya da birleşik biçimde olmayan harf bulunan bir adresle yapılan ilk giriş dizine sorulmadan "hatalı
  e-posta ya da parola" yanıtı alır. Hesabı olan kullanıcılar etkilenmez.
- **Silinen rol dizin ve SSO eşlemelerinden çıkar.** Bir rol silindiğinde onu veren grup eşlemeleri o rolü kaybeder,
  hiç rolü kalmayan grup satırı kalkar, varsayılan rol o rolse `user` olur. Rol sildikten sonra Ayarlar → Dizin'deki
  eşlemeleri gözden geçirin.
- **İnceleme bekleyen ödemeler.** Personel faturayı "Ödeme kaydet" ile kapattığında o faturanın inceleme bekleyen
  ödemeleri de aynı işlemde kapanır (durumları `cancelled` olur, gerekçeleri kalır); sağlayıcıdan sonradan gelen
  "ödendi" yanıtı artık ikinci kez bakiye yazmaz. Faturası başka yolla ödenmiş ya da iptal edilmiş, ya da parası hiç
  gelmemiş bir inceleme ödemesi için yeni bir personel işlemi vardır: `POST
  /api/admin/billing/payments/:id/close-review` (`billing.manage`; hiçbir şeyi ödenmiş saymaz), panelde Yönetim →
  Faturalandırma → Ödemeler'de "İncelemeyi kapat" düğmesi. Kapatılan ödemeler aynı listede yeni `cancelled` durum
  süzgeciyle bulunur. Müşteri, inceleme bekleyen ödemesi olan faturasının sayfasında "Ödemeniz inceleniyor" notunu görür.
  Otomatik tahsilat, inceleme bekleyen ödemesi olan faturayı **atlar** (bakiyeden ya da karttan ikinci kez çekmemek
  için); hatırlatma, gecikme ve askıya alma adımları ise **işlemeye devam eder**. Yani inceleme bekleyen bir ödemeyi
  bekletirseniz müşterinin sunucusu askıya alınabilir. PayTR bildiriminde tutar artık imzanın kapsadığı toplamla
  (`total_amount`) denetlenir ([payments.md](payments.md#incelemedeki-ödemeler)).
- **Bayiler: müşteri bayiden ayrıldığında ödeme de müşteriye geçer.** Bir bayilik kaldırıldığında, personel bir
  müşteriyi bayiden ayırdığında (`DELETE /api/admin/resellers/:id/customers/:customerId`) ya da müşteri kendisi
  ayrıldığında (`POST /api/reseller/leave`): sunucuların çalışan abonelikleri müşteriye geçer, bayinin o sunucular
  için kesilmiş ve hiç ödenmemiş yenileme faturaları iptal edilir ve bir sonraki tahsilat çalıştırması ödenmemiş ilk
  dönemi müşteriye faturalar. Bayinin diğer açık faturaları (kurulmuş sunucunun ilk faturası, boyut ya da disk farkı,
  kısmen ödenmiş ya da başka sunucularla ortak olanlar) bayide kalır ve denetim kaydına `leftInvoices` olarak yazılır.
  **Fiyat değişmez:** sunucu, bayi indirimi dahil, o andaki fiyatıyla müşteriye faturalanır. Önceden bayilik
  kaldırıldığında abonelikler bayide kalıyordu. Bayiyi yalnızca kapatmak (`active: false`) bunu yapmaz: bayi işlem
  yapamaz ama abonelikler ona faturalanmaya devam eder; yanıt kaç abonelik olduğunu söyler (`billedSubscriptions`).
- **Bayi müşterileri bilgilendirilir.** Bir bayinin müşterisi paneli ilk kullandığında "Hesabınızı bir bayi
  yönetiyor" bildirimini bir kez alır (`account.reseller`; varsayılan panel ve e-posta). **Yükseltmeden önceki bayi
  müşterileri de bir sonraki ziyaretlerinde bu bildirimi alır.** Bayinin müşterinin sunucularında yaptığı işlemler ve
  onun adına verdiği siparişler müşterinin Hesabım → Etkinlik listesinde "Bayiniz yaptı" etiketiyle görünür. Müşteri
  Hesabım → Profil'deki "Hesabınızı … yönetiyor" kartında bayinin neleri yapıp neleri yapamadığını görür ve
  "Bayiden ayrıl" ile ayrılabilir (kullanıcı adına oturum açmış personele bu düğme gösterilmez). Personel tek bir
  müşteriyi Yönetim → Kullanıcılar'da bayinin kullanıcı özeti penceresindeki müşteri listesinden "Bayiden çıkar" ile
  ayırır (`users.manage`); listeyi `GET /api/admin/resellers/:id` yanıtındaki `customers` alanı verir.
- **Mesajlaşma uygulamaları.** Bağlantı kurma ve bağlantı testi hesap başına saatte 20 ile sınırlıdır; bildirim
  testinde her mesajlaşma adresinin, hangi hesaba bağlı olursa olsun, saatte 6 testlik kendi sınırı vardır. Adresini
  kullanıcının serbestçe yazdığı uygulamalarda (Mattermost, Rocket.Chat, Matrix, ntfy, Gotify, JSON webhook) başarısız
  bir gönderimde kullanıcıya yalnızca hata kodu gösterilir; karşı sunucunun metni gösterilmez
  ([notifications.md](notifications.md)).
- **Kayıtlı görünümler artık hesapta saklanır.** Bir önceki turda tarayıcıda duran görünümler `saved_views`
  tablosuna taşındı (API: `/api/saved-views`); her cihazda görünür ve yalnızca sahibi görür. Kullanıcı bir listeyi bu
  sürümle ilk açtığında o tarayıcıdaki eski görünümleri hesaba **bir kez** gönderilir ve tarayıcıdan silinir. Ad sınırı
  40'tan 60 karaktere çıktı. Bir kullanıcı adına oturum açan personel o kişinin görünümlerini uygular ama
  değiştiremez. Aşağıdaki notta "çıkışta silinmezler" diye yazılan sınır bu sürümle kalktı: tarayıcıda kalmış eski
  kopyalar, sahibi listeyi açtığında hesaba taşınır; taşınmamış olanlar o tarayıcıda bir oturum bittiğinde silinir
  (hesaba gönderilmeden). Yükseltmeden sonra hiç açılmamış bir tarayıcıda eski kopya o zamana kadar durur.
- **Tarayıcıda tutulanlar.** Çıkışta ve oturumun başka bir yolla bitmesinde silinenler genişledi: taslaklar ve son
  açılanların yanında yarım kalmış sipariş, tablo sıralamaları, kenara alınan görevler ve personel özetindeki "son
  bakışınızdan beri" işareti de silinir; ekrandaki tarayıcı bildirimleri kapatılır. Tema, yazı boyutu ve dil gibi
  tercihler kalır. Aynı temizlik artık panel başka biri için açıldığında da yapılır: çıkış yapılmadan başka bir
  hesapla girildiğinde ve "kullanıcı adına giriş" başlarken ve biterken (personelin taslakları müşterinin paneline,
  müşterininkiler personele geçmez). **Yükseltmeden sonraki ilk açılışta her tarayıcıda bir kez** taslaklar, son
  açılanlar ve yarım sipariş silinir: eski sürüm bu içeriğin kime ait olduğunu kaydetmediği için panel onu sahipsiz
  sayar. Yazılmış ama gönderilmemiş uzun bir talep yanıtı olan personelinizi uyarın. Tam liste:
  [operations-modules.md](operations-modules.md#tarayıcıda-tutulanlar-ve-oturum-sonu).
- **Kurulum betiği: bakım dizini ve kilit.** `data/maintenance` root'a ait değilse ya da başkaları yazabiliyorsa
  betik dizini devralır ve `W_MAINT_DIR` uyarısını yazar: sahiplik root'a geçer, içindeki bağlantılar, özel dosyalar
  ve birden çok adı olan dosyalar silinir. Uyarıyı bir kez görmeniz olağandır (dizini root olmadan çalıştırılmış bir
  komut açmış olabilir); yineleniyorsa dizine kimin yazdığına bakın. Dizin bir bağlantıysa betik durur
  (`E_MAINT_DIR`, çıkış kodu 21): bağlantıyı kaldırıp yeniden deneyin. Kilit dosyası (`data/maintenance/.lock`) artık
  her işin sonunda silinir ve bir sonraki iş kendi dosyasını açar; root kilidi alamazsa iş çalışmaz (`E_LOCK`, çıkış
  kodu 21). Panelin okuduğu durum dosyaları ve günlük kopyaları geçici bir adla, yalnızca sahibine açık oluşturulup
  yerine taşınır ([operations.md](operations.md#bakım-dizini-ve-kilit)). Bu yollar yalnızca `dash` ve `bash` altında
  sahte dosyalarla denendi; gerçek bir kurulumda çalıştırılmadı.
- **Sandbox'ta inceleme kartı.** Panelin test sağlayıcısında `4000 0000 0000 4954` numaralı kart ödemeyi "sağlayıcı
  incelemeye aldı" (`FRAUD_REVIEW`) durumunda bırakır; inceleme akışını gerçek bir sağlayıcı olmadan denemek içindir.
  Yalnızca Sandbox sağlayıcısı açıkken çalışır.
- **CI.** `npm audit` adımının yerini `scripts/audit.mjs` aldı: yüksek ve kritik açıklar işi düşürür; yalnızca
  `scripts/audit-allowlist.json` dosyasında gerekçesi ve son günü yazılı olanlar geçer (şu an tek kayıt: `apps/web`
  içinde `picomatch`, GHSA-fc5q-39xc-vjpf, 2026-12-18'e kadar; açıktan etkilenmeyen bir sürüm yayımlandığında
  kendiliğinden geçersiz olur). Web arayüzü Next.js 16.4.6 ile derlenir.
- **Olduğu gibi bırakılanlar.** Dizin hesabının kişisel API anahtarları, dizinde kapatılan hesap panelde
  yasaklanana ya da devre dışı bırakılana kadar çalışmaya devam eder. İnceleme bekleyen ödemesi olan faturada
  hatırlatma ve askı adımları sürer. Hesap payı, birlikte hareket eden birden çok hesabı sınırlamaz. Bayinin
  müşterisi adına yaptığı işlemlerden yalnızca sunucu işlemleri, siparişler ve hesabın açılması müşterinin etkinlik
  listesindedir. Bayiden ayrılma, bayinin tam o anda verdiği bir siparişle çakışırsa o sipariş ayrılmanın dışında
  kalabilir (bayiye faturalanmış ya da bayinin anahtarını taşıyor olabilir); bu yarış kapatılmadı.

## Kayıtlı görünümler, sıradaki adım ve talepte sunucu durumu (2026-11-18)

Bir önceki turun üstüne eklenen arayüz ve bildirim işleri. **İşletmecinin yapacağı bir şey yoktur.** Veri değişikliği
`apps/api/migrations/082_ticket_diagnostics.sql` dosyasındadır (`tickets.diagnostics`: talep açıldığında sunucunun
durumu) ve yükseltme sırasında kendiliğinden uygulanır. Yükseltmeden önce açılmış taleplerde bu alan boştur; onlarda
panel çizilmez.

- **Kötüye kullanım sayacının anlamı değişti.** Yönetim menüsünde Kötüye kullanım'ın yanındaki sayı (`GET
  /api/admin/attention`, `abuse` alanı) artık yalnızca **henüz kimsenin onaylamadığı** açık bulguları sayar. Onaylanan
  bulgu çözülene kadar sayfanın "açık" sekmesinde durmaya devam eder ama sayaçta yer almaz. Yükseltmeden sonra sayı
  düşebilir; bulgular kapanmış değildir. Bu alanı kendi izlemenizde okuyorsanız eşiğinizi buna göre gözden geçirin.
- **Yeni bildirim türü: `admin.restore_hold`,** varsayılanı panel ve e-posta, `system.update` izni olanlara. Geri
  yükleme beklemesi API kapalıyken konduğu için o anda kimseye haber verilemiyordu; API artık beklemeyi ilk gördüğünde
  (açılışta ya da 10 dakikalık denetimde) bekleme başına bir kez bildirir. Yeniden başlatma ya da ikinci bir API
  süreci bildirimi yinelemez; yeni bir geri yükleme yeniden bildirilir. Ayarlar → Bildirim kuralları'nda görünür
  ([operations.md](operations.md#geri-yüklemeden-sonra-bekletme)).
- **Destek talebinde sunucunun o andaki durumu.** Müşteri bir sunucuyu seçerek talep açtığında panel sunucunun
  veritabanındaki halini (durum, paket, boyut, imaj, konum, platform, adresler, kilit, silinme beklemesi, varsa aylık
  trafik, son 5 işlem ve sahibin ödenmemiş fatura sayısı) talebe ekler. Hipervizöre sorulmaz; parola, belirteç ya da
  müşterinin notları eklenmez. Yalnızca `support.view` izni olan personel görür; müşterinin yanıtında bu alan hiç
  yoktur. Okuma iki saniyeden uzun sürerse ya da başarısız olursa talep yine açılır, alan boş kalır
  ([operations-modules.md](operations-modules.md)).
- **Kayıtlı görünümler ("Görünümler").** Müşterinin sunucu listesinde ve yönetimde Sunucular, Kullanıcılar, Destek
  kuyruğu, Denetim kaydı ile Faturalandırma'daki fatura ve ödeme listelerinde. Sunucuya hiçbir şey yazılmaz:
  görünümler o tarayıcının deposunda (`localStorage`) kullanıcı ve liste başına tutulur. **Çıkışta silinmezler:** bir
  görünüme kaydedilmiş arama terimi ya da sahip e-postası o tarayıcıda kalır. Ortak kullanılan bilgisayarlarda
  personelinize görünümleri silmesini ya da site verilerini temizlemesini söyleyin.
- **Toplu işlemde satır seçimi.** Yönetim → Sunucular'da toplu işlem artık varsayılan olarak satır başındaki kutularla
  **seçilen** sunuculara uygulanır; "Gösterilenlerin tümü" ayrıca seçilmelidir. Önceki sürümde düğme doğrudan süzgecin
  gösterdiği tüm sunuculara uygulanıyordu. API (`POST /admin/servers/actions`) değişmedi.
- **Müşteri tarafı.** Başarısız bir işlemden sonra sunucu sayfasında önerilen sıradaki adım; bildirim zilinde aynı
  konudaki art arda bildirimlerin tek satırda toplanması; "Yaklaşan ödemeler"de yenileme tutarının faturalama özetinin
  yeni `nextRenewal` alanından okunması ([billing.md](billing.md)). Komut paletinin son açılanları personel için
  bakılan kullanıcıları ve yönetimdeki faturaları da tutar; bunlar öncekiler gibi çıkışta silinir.
- **Sınırlar.** "Yaklaşan ödemeler"deki yenileme artık vergi dahildir ve faturası kesildiğinde iki kez gösterilmez;
  kalan durumlar (vergi kuralı okunamazsa vergisiz tutar, aynı gün birden çok para birimi, kısmen faturalanmış gün,
  kısmen ödenmiş fatura, 7 günden önce kesilen faturalar) [billing.md](billing.md) içindedir. Bu sürümün ve bir
  öncekinin ekranları tarayıcıda elle gözden geçirilmedi. Uçtan uca testler şunları kapsar: sipariş bağlantısının
  okunması; komut paletinden fatura bulunması ve hızlı işlemler; ödemeler sayfasında "İnceleme bekleyen" süzgeci ve
  aramanın adreste kalması (boş listeyle); `/admin/attention` yanıtı (personele `200`, müşteriye `403`, sayısı sıfır
  olan girişte rozet olmaması); sunucu kartı menüsünde ad değiştirme ve kilit; yeniden kurulum özeti; IP adresinin
  kopyalanması. Ne uçtan uca testi olan ne de elle bakılanlar: kayıtlı görünümler, toplu işlemde satır seçimi,
  talepteki sunucu durumu paneli, "sıradaki adım" bildirimi, zildeki gruplama, "Yaklaşan ödemeler", her sayfadaki geri
  yükleme şeridi ve sayısı sıfırdan büyük menü rozetleri. Talepteki sunucu durumu, `admin.restore_hold` ve
  `nextRenewal` için `security-billing` entegrasyon testlerine üç test eklendi.

## Günlük işleri kısaltan eklemeler (2026-11-17)

İkinci güvenlik turundan sonra eklenen arayüz ve bildirim işleri. **İşletmecinin yapacağı bir şey yoktur.** Veri
değişikliği `apps/api/migrations/081_payment_review_since.sql` dosyasındadır (`payments.review_since`: ödemenin ne
zamandan beri inceleme beklediği) ve yükseltme sırasında kendiliğinden uygulanır; o anda inceleme bekleyen ödemelerde
süre ödemenin başladığı andan sayılır.

- **İki yeni bildirim türü, varsayılanı panel ve e-posta.** `billing.payment_review`: bir ödeme incelemeye girdiğinde
  `billing.manage` izni olan personele, ödeme başına bir kez. `auth.credentials_reset`: adresin ilk kanıtında hesaptan
  bir şey silindiyse kullanıcıya. İkisi de Ayarlar → Bildirim kuralları'nda görünür; istemiyorsanız oradan kapatın.
  Aşağıdaki ikinci tur notlarında "bildirim gitmez / gösterilmez" diye yazılanlar bu sürümle değişti.
- **İnceleme bekleyen ödemeler panelde.** Yönetim → Faturalandırma → Ödemeler'de "İnceleme bekleyen" süzgeci ve
  arama (adreste tutulur), her ödemede gerekçe, bekleme süresi ve faturaya bağlantı; özetin üstünde uyarı. Karar yine
  elledir: faturanın sayfasındaki "Ödeme kaydet" ([payments.md](payments.md#incelemedeki-ödemeler)).
- **Yönetim menüsünde sayaçlar ve bekleme şeridi.** Faturalandırma (inceleme bekleyen ödemeler), Sunucular (son 24
  saatte başarısız işlemler) ve Kötüye kullanım (açık bulgular) girişlerinin yanında sayı görünür; geri yükleme
  beklemesi personele her sayfanın üstünde bir şeritle söylenir. İkisi de dakikada bir `GET /api/admin/attention`
  rotasından okunur; her alan yalnızca ilgili sayfayı açabilen personele gelir, müşteri hesapları `403` alır.
- **Yeni içgörüler.** Personel: inceleme bekleyen ödemeler (`PAYMENTS_IN_REVIEW`, `billing.view` izni olanlara), geri
  yükleme beklemesi (`RESTORE_HOLD`) ve son 14 günde `OUTCOME_UNKNOWN` ya da `VM_MISMATCH` ile bitip sonrasında
  başarılı bir işlemi olmayan sunucular (`OPERATIONS_NEED_DECISION`). Müşteri: 30 günden eski anlık görüntüler
  (`SNAPSHOTS_OLD`; yalnızca panelden 30 günden önce anlık görüntü alınmış sunuculara bakılır, liste platforma
  sorulur ve altı saat saklanır, yanıt vermeyen platform atlanır).
- **Müşteri tarafı.** Genel bakışta "Yaklaşan ödemeler"; komut paletinde fatura arama, son açılan talepler ve
  faturalar, hızlı işlemler; sipariş sayfasında paylaşılabilir yapılandırma bağlantısı; sunucu kartının menüsünde ad
  değiştirme, kilit ve silme; düz HTTP'de de çalışan ve kopyalanamadığında bunu söyleyen kopyalama düğmeleri; yeniden
  kurulum penceresinde önce / sonra özeti ([operations-modules.md](operations-modules.md)).
- **Sınırlar.** Bu sürümde "Yaklaşan ödemeler"deki yenileme tutarı vergisizdi ve aynı yenileme, yenilemeden önceki
  günlerde vadesi yaklaşan fatura olarak da görünebiliyordu; sonraki sürümle tutar API'den okunur (yukarıda). Yeni
  ekranlar tarayıcıda elle gözden geçirilmedi. Yazıldıkları sırada uçtan uca testler yalnızca sipariş bağlantısının
  okunmasını ve komut paletinden fatura bulunmasını kapsıyordu; sonraki sürümle ödemelerin inceleme süzgeci,
  `/admin/attention`, kart menüsü, yeniden kurulum özeti, paletin hızlı işlemleri ve adres kopyalama için adımlar
  eklendi, "Yaklaşan ödemeler", geri yükleme şeridi ve sayısı sıfırdan büyük menü rozetleri hâlâ kapsanmaz (yukarıda).
  Menüdeki Kötüye kullanım sayacı sonraki sürümle yalnızca onaylanmamış bulguları sayar. Anlık görüntü önerisi gerçek
  bir platformda denenmedi.

## Güvenlik denetimi, ikinci tur (2026-11-17)

`d9f90d3` commit'i üzerinde yapılan ikinci denetim turunun ([security-audit.md](security-audit.md)) düzeltmeleri:
ilk turun incelemediği alanlar ve ilk turun düzeltmelerinin yeniden denetimi. Veri değişiklikleri
`apps/api/migrations` altındaki `077`, `078`, `079` ve `080` numaralı dosyalardadır (`maintenance_state` tablosu;
`users.external_source` alanının denetim kaydından doldurulması; `vm_id_changed` bulgusu; kullanıcı adına açılan
oturumların sonu); yükseltme sırasında kendiliğinden uygulanır.

> [!IMPORTANT]
> Yükseltmeden sonra yapılacaklar: **(1)** proxy'yi ve (izleme açıksa) günlük toplayıcısını yeniden başlatın;
> **(2)** başka bir proxy arkasında çalışıyorsanız `install.sh behind-proxy --public-url https://…` komutunu bir kez
> çalıştırın, yoksa bazı parola sıfırlama ve giriş bağlantısı postaları gönderilmez; **(3)** WHMCS / WISECP
> kullanıyorsanız `CUSTOMER_NEEDS_REVIEW` yanıtı alan hesapları yeni **devralma (claim)** rotasıyla çözün;
> **(4)** ekibinize bir geri yüklemeden sonra panelin **beklemede** açıldığını ve serbest bırakılması gerektiğini
> söyleyin; **(5)** e-posta kodu ya da giriş bağlantısıyla girişi açtıysanız aşağıdaki "adresin ilk kanıtı" maddesini
> okuyun.

### Faturalama ve ödeme

- **Yenileme faturası ödeme anında da yeniden fiyatlanır.** Dönemi başlamamış, ödenmemiş bir yenileme faturası artık
  **itirazlıyken de** sunucunun güncel fiyatını izler ve **ödendiği anda** bir kez daha fiyatlanır (bakiyeden, kayıtlı
  karttan, ödeme sayfasından ya da personelin elle kapatmasıyla). Müşteri faturayı görüntülediği an ile ödediği an
  arasında tutar değişebilir. Personelin "Ödeme kaydet" isteği, tutar o anda değiştiyse **bir kez**
  `409 INVOICE_AMOUNT_CHANGED` döner. *Yapılacak:* yeni tutara bakın ve işlemi yineleyin.
- **Fiyatı ödenenin altına düşen yenileme faturası kapanır.** Kısmen ödenmiş bir yenileme faturasının yeni tutarı
  ödenen tutara eşit ya da ondan azsa fatura **ödendi** olur ve fazlası müşterinin bakiyesine yazılır; eskisi gibi
  eski, yüksek tutarla açık kalıp hatırlatma ve askıya girmez.
- **Kabul edilen itiraz en çok kalan tutarı iade eder.** Kabul edilen bir itirazın bakiyeye yazdığı tutar, faturanın
  o andaki kalan tutarını aşamaz.
- **3, 6 ve 12 aylık dönemlerde büyütme, kalan ayların tamamı için ücretlendirilir.** Eskiden çok aylı bir dönemdeki
  büyütme, tek bir ayın farkı dönemin tamamına yayılarak hesaplanıyordu. *Yapılacak:* çok aylı dönem kullanan
  müşterilerinize büyütme ücretinin arttığını söyleyin; yükseltmeden önce yapılmış büyütmeler geriye dönük
  faturalanmaz.
- **Param: incelemedeki ödemeye sonraki dönüşler işlenmez.** Bir Param ödemesi "onay bekliyor" durumuna geçtikten
  sonra gelen dönüşler, **"reddedildi" dahil**, yok sayılır: ödeme personelin bekleyenler listesinden düşmez ve notu
  değişmez. Personel notunu panel yazar; not **ödemenin kendi kimliği ve yapılacak işle başlar**, Param'ın bildirdiği
  sipariş ve dekont numaraları ardından gelir. *Yapılacak:* onaylarken Param panelindeki kaydı nottaki ödeme
  kimliğiyle eşleştirin.
- **İncelemedeki ödemelerin listesi.** Yönetici API'sinde `payments?status=review` incelemede bekleyen ödemeleri
  (onay bekleyen Param ödemeleri, tutarı tutmayanlar, sağlayıcının incelemeye aldıkları) en eskiden başlayarak
  listeler; faturalama özeti bunların sayısını `paymentsInReview` alanında verir. Bu turda bir ödeme incelemeye
  girdiğinde personele bildirim gitmiyordu; sonraki sürümle `billing.payment_review` bildirimi ve paneldeki
  "İnceleme bekleyen" süzgeci eklendi (yukarıda).
- **Adres değişince sırlar yeniden girilir (ödeme ve e-Fatura).** Bir ödeme sağlayıcısının ya da e-Fatura
  entegratörünün API adresi değiştirildiğinde kayıtlı gizli alanlar (anahtar, parola) yeniden yazılmalıdır; boş
  bırakılırsa alan `REQUIRED` hatası verir. Test düğmesi de aynı kurala uyar.
- **Test sonuçları sağlayıcının metnini göstermez.** Ödeme ve e-Fatura testleri yalnızca sabit bir ileti ve durum
  sınıfı (kabul edildi, reddedildi, belirsiz, ulaşılamadı) gösterir. Sağlayıcının yanıt metni API günlüğündedir
  (`docker compose logs api`).
- **"Tahsilatı şimdi çalıştır" artık çoğu zaman reddedilmez.** Periyodik çalıştırma kilidini işi bitince bırakır;
  düğme `409 BILLING_RUNNING` yanıtını yalnızca gerçekten bir çalıştırma sürerken verir.
- **Müşteri adına oturum açmış personel fatura e-postasını değiştiremez** (`NOT_WHILE_IMPERSONATING`); fatura
  profilinin diğer alanları değiştirilebilir.
- **Geri yükleme beklemesindeyken tahsilat çalışmaz** (aşağıda, Kurulum betiği).

### Sunucular, işlemler ve Proxmox

- **Devir, önceki sahibin abonelik tercihlerini temizler.** Bir sunucu başka hesaba geçtiğinde (müşteri devri ya da
  personelin taşıması) abonelikteki **dönem sonunda iptal** kaydı silinir, **otomatik yenileme** varsayılana (açık)
  döner ve faturalamanın "bu sunucu silinecek" işareti kalkar. Eskiden önceki sahibin kaydettiği iptal, dönem
  sonunda yeni sahibin sunucusunu siliyordu. *Yapılacak:* yeni sahip tercihlerini fatura sayfasından kendisi yapar.
- **Devirle çakışan istek `404` alır.** Önceki sahibin, devir kabul edilirken yolda olan isteği (zamanlama, silme,
  yeniden kurulum, özel ağ, anahtar) artık yeni sahibin sunucusuna yazılmaz; istek devrin bitmesini bekler ve `404`
  döner.
- **İptalden önce alınmış konsol ve terminal biletleri reddedilir** (`CONSOLE_REVOKED` / `TERMINAL_REVOKED`): devir,
  çıkış, yasaklama, oturum kapatma ya da yetki daralmasından **önce** alınmış ama henüz kullanılmamış bir bilet artık
  oturum açmaz. Kişi konsolu yeniden açar.
- **Faturalama sisteminin müşteri eşlemesi: yalnızca kendi açtığı hesaplar.**
  `POST /admin/external/:source/customers` artık yalnızca o sistemin **kendi oluşturduğu** hesabı eşler.
  E-postası doğrulanmış olsa bile başka yoldan açılmış (kayıt, personel) her hesap için `409 CUSTOMER_NEEDS_REVIEW`
  döner. Entegrasyonun daha önce oluşturduğu hesaplar eşleşmeye devam eder (migration `078` onları denetim kaydındaki
  `external.customer_created` satırlarından işaretler). Yalnızca e-postası doğrulanmış olduğu için eşleşmiş, panelde
  önceden var olan hesaplar bir sonraki siparişte `CUSTOMER_NEEDS_REVIEW` alır. *Yapılacak:* hesabın gerçekten o
  alıcıya ait olması gerektiğinden emin olduktan sonra personel hesabı devralma rotasıyla o sisteme bağlar
  (`users.manage` izni):

  ```
  POST /api/admin/external/<source>/customers/<hesap kimliği>/claim
  ```

  Bu çağrı hesabı o sisteme bağlar, e-postasını doğrulanmış sayar ve hesabı o güne kadar elinde tutan kişinin
  kullanabileceği her şeyi **siler**: oturumlar, parola, API anahtarları, passkey'ler, bağlı girişler, webhook'lar,
  mesajlaşma ve tarayıcı bildirimi bağlantıları, kayıtlı SSH anahtarları, telefon numarası ve iki adımlı doğrulama.
  Sunucular, faturalar ve talepler kalır; alıcı "Parolamı unuttum" ile yeni parola belirler. Personel hesapları,
  bayiler ve müşterileri ile başka bir sistemin hesapları devralınamaz. Sonra sipariş yeniden denenir. Hesap alıcıya
  ait değilse hesabı yeniden adlandırın ya da kaldırın.
- **Entegrasyon siparişleri müşterinin rolüne ve kotasına bakmaz.** WHMCS / WISECP'nin açtığı sipariş ve paket
  değişikliği için müşterinin rolündeki `servers.create` izni ve hesabın kotası aranmaz: neyin satıldığına o sistem
  karar verir.
- **Entegrasyon müşterileri, panelin faturalaması kapalıyken panelden sipariş veremez** (`409 EXTERNALLY_BILLED`).
  Eskiden böyle bir müşteri panelden sipariş verdiğinde sunucuyu kimse faturalamıyordu. Panelin faturalaması açıksa
  sipariş herkesinki gibi panelde faturalanır. *Yapılacak:* müşterilerinize yeni sunucuyu faturalama sisteminden
  sipariş etmelerini söyleyin.
- **Yeniden denenen boyut değişikliği `409 SERVER_CHANGED` dönebilir.** Personel başarısız bir boyut değişikliğini
  yeniden denediğinde, sunucu o işlemden sonra değiştiyse (başka bir boyut değişikliği) istek reddedilir; yeni bir
  boyut değişikliği isteyin. Arada eklenen bir diskin ücreti artık yeniden denemeyle silinmez.
- **Sonucu öğrenilemeyen işlem `OUTCOME_UNKNOWN` ile biter ve hiçbir şey geri alınmaz.** Bir işlemin süresi,
  hipervizördeki görevi sürerken dolarsa işlem artık `TIMEOUT` ile bitip fiyatı, faturayı ve disk kaydını geri
  almaz: görev, süre dolduktan sonra `TASK_OUTCOME_HOURS` saat (varsayılan 6) daha beklenir. Sonuç o zaman da
  öğrenilemezse işlem `OUTCOME_UNKNOWN` olur; fiyat, fatura ve kayıtlar işlemin yazdığı gibi kalır. *Yapılacak:*
  sunucuya platformda bakın; sonra işlemi yeniden deneyin (yeniden deneme görevin sonucunu okur, adımı ikinci kez
  başlatmaz) ya da sunucuyu düzeltin.
- **Proxmox: VM numarası sunucuya bağlanır** (`409 VM_MISMATCH`). Panel her istekte VM'in taşıması gereken adı
  (`lvm-<sunucu kimliği>`) gönderir; kayıtlı numaradaki VM bu adı taşımıyorsa adaptör hiçbir şeyi okumadan ve
  değiştirmeden reddeder. İmajdan sipariş yalnızca **şablondan** kopyalar: şablonu silinmiş bir imajın numarasını
  başka bir VM almışsa sipariş `TEMPLATE_NOT_FOUND` ile başarısız olur. Tutarlılık denetimi, sunucunun adını başka
  bir numara altında bulursa kaydı o numaraya çeker (`vm_id_changed` bulgusu). *Yapılacak:* `VM_MISMATCH` görürseniz
  Yönetim → Sunucular'dan tutarlılık denetimini çalıştırın; şablonu sildiğiniz imajları katalogdan kaldırın.
- **ISO depoları:** adres (protokol, sunucu, port, URL) değiştiğinde kayıtlı sır yeniden girilir.

### Giriş, bildirimler ve ayarlar

- **Bildirim e-postaları yeniden gönderiliyor.** Node 22'de bir tarih biçimi seçeneği hatası yüzünden bildirim
  e-postalarının **hiçbiri gönderilmiyordu** (yeni giriş, parola değişti, iki adımlı doğrulama değişti dahil); parola
  sıfırlama, giriş bağlantısı ve kod postaları etkilenmiyordu. Düzeltildi. *Yükseltmeden sonra:* kullanıcılar
  e-posta bildirimlerini yeniden almaya başlar; Hesap → Bildirimler'den bir test gönderin.
- **Kullanıcı adına açılan oturum, onu açan personelin yetkisiyle biter.** Oturumu başlatan personelin rolü
  düşürüldüğünde, hesabı yasaklandığında ya da silindiğinde ve oturumları kapatıldığında, başlattığı "kullanıcı
  adına" oturumlar da kapanır. Bu oturumlar, tarayıcı ne gönderirse göndersin, başladıktan **bir saat** sonra biter
  (migration `080`).
- **Panelin adresi bilinmiyorsa bağlantı postası gönderilmez.** Kayıtlı adresi, alan adı ve `PANEL_PUBLIC_URL`
  değeri olmayan bir kurulum (tipik olarak başka bir proxy arkasındaki), herkese açık bir host adıyla gelen isteklere
  parola sıfırlama ya da giriş bağlantısı postası **göndermez**; API günlüğüne
  `auth_mail_not_sent_panel_address_unknown` yazılır. Bir yönetici bir kez giriş yaptığında adres kaydedilir.
  *Yapılacak:* `install.sh behind-proxy --public-url https://panel.example.com` çalıştırın (aşağıda) ya da `.env`
  dosyasına `PANEL_PUBLIC_URL` yazın.
- **Bazı ayarlar yalnızca yöneticiye açık.** `settings.manage` izni olan ama yönetici (`*`) olmayan personel artık
  şunları yapamaz: e-posta ya da SMS ayarlarını kaydetmek, giriş bağlantısı ya da e-posta koduyla girişi açmak, iki
  adımlı doğrulama zorunluluğunu düşürmek, CAPTCHA'yı zayıflatmak ve kaydedilmemiş bir özel SMS sağlayıcısını test
  etmek (`403`). Bu kanallar yöneticiler dahil herkesin sıfırlama bağlantısını ve kodunu taşır. *Yapılacak:* bu
  ayarları yönetici olmayan bir hesapla yönetiyorsanız işi bir yöneticiye verin.
- **Servis günlükleri yalnızca yöneticiye gösterilir ve maskelenir.** Yönetim → Sistem'deki servis günlüklerini
  yalnızca yöneticiler görür; URL'de taşınan sırlar (`token`, `code`, `state`, `session_id` değerleri ve sıfırlama
  belirteci) günlük kopyalarında `***` olur. API'nin istek günlüğü de artık URL'deki belirteçleri yazmaz.
- **Talep atanan kişi `support.manage` iznine sahip olmalı.** Sahibi `support.view` iznini kaybettiğinde ya da
  yasaklandığında talepler atanmamış duruma döner ve bildirimleri ekibe gider.
- **Yeni hız sınırları (`429`):**

  | Ne | Sınır |
  |---|---|
  | Bildirim testi | hesap başına 6 / saat; SMS'te ayrıca numara başına 6 / saat |
  | Telefon doğrulama kodu | hesap başına ve numara başına 5 / gün |
  | İki adımlı doğrulama kodu (SMS / e-posta) | hesap başına 8 / saat |
  | Parola sıfırlama postası | posta kutusu başına 5 / saat |
  | Müşterinin talep yanıtı ve puanı | talep başına 10, müşteri başına 30 / 10 dakika |

  Personele yalnızca **ilk** puan bildirilir; tek bir talepte art arda gelen yanıtlar tek bildirimde toplanır.
- **Tarayıcı bildirimi adresi bir DNS adı olmalıdır.** Sayıyla yazılmış (IP) ya da olağan dışı bir host taşıyan
  abonelik adresi reddedilir. Birinin oturumları hangi yolla kapatılırsa kapatılsın (personel, parola değişikliği,
  "diğer cihazlardan çık") tarayıcı bildirimi abonelikleri de silinir; kullanıcı bildirimleri tarayıcısında yeniden
  açar.
- **Denetim kaydı:** iki yeni eylem var: `auth.password_step` (iki adımlı doğrulaması olan hesabın doğru parolası;
  henüz oturum yok) ve `auth.address_proven` (adresin ilk kanıtı, aşağıda). `auth.login / success` artık her zaman
  bir oturumun gerçekten açıldığı anlamına gelir. *Yapılacak:* denetim kaydını `auth.login` sayarak izleyen
  araçlarınız varsa uyarlayın.
- **Adresin ilk kanıtı, önceden kurulanları siler.** E-posta adresi hiç doğrulanmamış bir hesap **ilk kez** giriş
  bağlantısı ya da e-posta koduyla girdiğinde adres sahibince kanıtlanmış sayılır ve hesapta daha önce kurulanlar
  **bir kez** silinir: parola, bağlı girişler, diğer oturumlar, API anahtarları, passkey'ler, webhook'lar,
  mesajlaşma uygulaması bağlantıları, tarayıcı bildirimi abonelikleri, doğrulanmış telefon numarası ve açılmamış
  (kurulup etkinleştirilmemiş) iki adımlı doğrulama. Neden: panel kayıtta adresi doğrulamadığı için hesabı ilk açan
  kişi adresin sahibi olmayabilir. Parolayla kaydolup sonradan bağlantı ya da kodla giren müşteri "Parolamı unuttum"
  ile yeni parola belirler. Bu turda kullanıcıya ayrı bir bildirim gösterilmiyordu; sonraki sürümle
  `auth.credentials_reset` bildirimi eklendi (yukarıda). Personelin bir adresi elle
  doğrulanmış işaretlemesi hiçbir şeyi silmez. *Yapılacak:* bağlantı ya da kodla girişi açtıysanız destek ekibinize
  haber verin.
- **Giriş kimlikleri metin olmalıdır:** e-posta, kullanıcı adı ya da telefon alanında metin dışı bir değer
  (liste, nesne) reddedilir.

### Kurulum betiği, proxy ve web

- **Geri yüklemeden sonra panel beklemeye alınır.** `install.sh restore` artık (1) arşivi doğrulamadan ve şifresini
  çözmeden önce yalnızca root'un açabildiği bir klasöre **kopyalar** ve yalnızca o kopyayı kullanır (geçici
  klasörde, `TMPDIR` ya da `/tmp`, **bir kopyalık daha yer** gerekir; yoksa `E_RESTORE_COPY`), (2) **herkesin
  oturumunu kapatır**, (3) paneli **beklemeye** alır: serbest bırakılana kadar işlem başlatılmaz ya da sürdürülmez,
  zamanlamalar ve zamanlanmış silmeler çalışmaz, tahsilat çalışmaz; işlem başlatan rotalar `409 RESTORE_HOLD` döner.
  *Yapılacak:* yedekten sonra oluşturulan ya da silinen sunuculara, yedekten sonra yapılan ödemelere ve yedekten
  sonra silinen API anahtarlarına, yasaklara, rol ve parola değişikliklerine bakın (hepsi yedek anındaki haline
  döner); sonra bekletmeyi **Yönetim → Sistem**'deki şeritten ("Serbest bırak") ya da komutla kaldırın:

  ```sh
  docker compose exec api node dist/cli.js release-restore-hold
  ```

  `--no-hold` yalnızca bekletmeyi atlar (az önce alınmış bir yedek için); oturumlar yine kapanır. Bekletme
  konulamazsa servisler **başlatılmaz** (`E_RESTORE_HOLD`); aynı komutu yeniden çalıştırın. Bekletme tablosundan
  önceki bir sürümün yedeği önce güncellenir (migration), sonra beklemeye alınır
  ([operations.md](operations.md#geri-yükleme)).
- **`install.sh behind-proxy` artık `--public-url` ister.** `.env` içinde `PANEL_PUBLIC_URL` yoksa komut
  `E_PUBLIC_URL_MISSING` ile durur ve hiçbir şeyi değiştirmez. *Yapılacak:* başka bir proxy arkasındaki mevcut
  kurulumlarda bir kez çalıştırın:

  ```sh
  sudo sh scripts/install.sh behind-proxy --public-url https://panel.example.com
  ```

  Alan adı modundaki kurulumlarda adres kendiliğinden yazılır (`https://<alan adı>`). Önünüzdeki proxy'nin
  yapılandırmasına `X-Forwarded-Host` başlığını da ekleyin ([domain-https.md](domain-https.md)).
- **Kendi sertifikanız uygulanmadan önce betikte de denetlenir.** Süresi dolmuş ya da henüz geçerli olmayan
  (`E_CERT_DATES`), okunamayan ya da parolayla korunan (`E_CERT_UNREADABLE`) ve anahtarıyla eşleşmeyen
  (`E_CERT_KEY_MISMATCH`) sertifika reddedilir; hiçbir şey değişmez.
- **Geçersiz `--trusted-cidr` reddedilir** (`E_CIDR_INVALID`). Birden çok ağ, aralarında birer boşlukla verilir.
- **Zaman ve ad sunucusu listeleri iki tarafta da sıkı denetlenir.** Panelin ve betiğin kuralı artık aynıdır:
  parçası 255'i aşan bir IPv4 adresi, yalnızca rakam ve noktadan oluşan bir ad, boşluk ya da joker karakter içeren
  bir liste reddedilir.
- **Erişim günlükleri maskelenir.** Proxy'nin erişim günlüğü ve günlük toplayıcısı `token`, `code`, `state` ve
  `session_id` sorgu değerlerini ve parola sıfırlama yolundaki belirteci `***` ile değiştirir; CAPTCHA yanıtı
  başlığı günlüğe yazılmaz. *Yapılacak:* yeni kuralın geçerli olması için proxy'yi ve toplayıcıyı yeniden başlatın.
  Daha önce saklanmış satırlar yeniden yazılmaz; Loki'deki günlükler saklama süresi (7 gün) dolunca silinir.
- **Web arayüzü.** Panel geri yükleme beklemesindeyken Yönetim → Sistem sayfası "Serbest bırak" düğmeli bir şerit
  gösterir. Bu turda yeniden kurulum penceresi ve yönetimdeki ödemeler sayfası turun yeni durumlarını göstermiyordu;
  sonraki sürümle ödemeler sayfasına inceleme görünümü, yeniden kurulum penceresine önce / sonra özeti eklendi
  (yukarıda).

### Yükseltmeden sonra (ikinci tur)

- Proxy'yi ve (izleme açıksa) toplayıcıyı yeniden başlatın:

  ```sh
  docker compose restart proxy
  ```

  ```sh
  docker compose --profile observability restart otel
  ```

- Başka bir proxy arkasındaysanız `behind-proxy --public-url …` komutunu çalıştırın ve bir test hesabı için parola
  sıfırlama isteyin: posta gelmeli ve bağlantı panelin kendi adresini taşımalı.
- Hesap → Bildirimler'den bir e-posta testi gönderin.
- WHMCS / WISECP kullanıyorsanız modülün günlüğünde `CUSTOMER_NEEDS_REVIEW` arayın ve her hesabı devralma rotasıyla
  ya da hesabı kaldırarak çözün.
- Param kullanıyorsanız inceleme bekleyen ödemelere (Yönetim → Faturalandırma → Ödemeler → "İnceleme bekleyen")
  kimin bakacağını belirleyin; `billing.payment_review` bildirimi `billing.manage` izni olanlara gider.
- Yönetim → Sunucular → İşlemler'de `OUTCOME_UNKNOWN` ve `VM_MISMATCH` ile bitmiş işlem var mı bakın.

## Güvenlik denetimi, ilk tur (2026-11-17)

`641aa4d` commit'i üzerinde yapılan güvenlik denetiminin ([security-audit.md](security-audit.md)) düzeltmeleri. Veri
değişiklikleri `apps/api/migrations` altındaki `074`, `075` ve `076` numaralı dosyalardadır
(`servers.clone_from_server_id`, `users.external_source`, `operations.started_by`); yükseltme sırasında kendiliğinden
uygulanır.

> [!IMPORTANT]
> Yükseltmeden sonra yapılacak üç şey: **(1)** proxy'yi yeniden başlatın (`docker compose restart proxy`; Caddy 2.7
> ya da yenisi gerekir), **(2)** Param kullanıyorsanız Param ödemelerinin artık **elle onaylandığını** ekibinize
> söyleyin, **(3)** eski yedeklerin (`.hmac` dosyası olmayanların) yalnızca `--allow-unsigned` ile geri yüklendiğini
> not edin ve yükseltmeden hemen sonra yeni bir yedek alın.

### Faturalama

- **Param ödemeleri kendiliğinden "ödendi" olmaz.** Param'dan başarılı dönen bir ödeme artık faturayı ödemez: ödeme
  **bekliyor** durumunda kalır ve "onay bekliyor" gerekçesini taşır (`NEEDS_CONFIRMATION`; sipariş ve dekont numarası
  ödemenin üzerinde yazar). Reddedilen bir dönüş ödemeyi eskisi gibi kapatır. *Yapılacak:* personel tahsilatı Param
  panelinde (ya da hesap ekstresinde) görür ve faturayı Yönetim → Faturalar'dan "Ödeme kaydet" ile elle kapatır.
  Ödemeden önce kurulum yapmayan panellerde sipariş bu onaya kadar kurulmaz.
- **Param yalnızca TRY için sunulur.** TRY dışındaki bir fatura ya da bakiye yüklemesi Param ile ödenemez
  (`PAYMENT_METHOD_UNAVAILABLE`). `GET /billing/summary` yanıtındaki kart yöntemleri yeni bir `currencies` alanı
  taşır (`null`: her para birimi). *Yapılacak:* başka para biriminde satış yapıyorsanız o faturalar için başka bir
  sağlayıcı etkin olsun.
- **Sandbox kapatılınca bekleyen sandbox ödemeleri kapanır.** Sandbox ayarı kapatıldığında bekleyen bütün sandbox
  ödemeleri başarısız olur (`TEST_MODE_OFF`) ve test kartı rotası sandbox kapalıyken ödeme kabul etmez. Bir
  sağlayıcı canlı moda alındığında test modunda başlatılmış bekleyen ödemeleri de aynı kodla kapanır. Yapılacak bir
  şey yok.
- **Tutarı ya da para birimi tutmayan ödeme beklemede kalır.** Sağlayıcının farklı bir tutar ya da para birimiyle
  bildirdiği veya dolandırıcılık incelemesine aldığı ödeme artık başarısız sayılmaz; gerekçesi görünerek **bekliyor**
  kalır. *Yapılacak:* bu ödemeleri sağlayıcının panelinde inceleyip faturayı elle kapatın ya da ödemeyi iade edin.
- **Boyut ya da disk değişince ödenmemiş yenileme faturası yeniden fiyatlanır.** Dönemi henüz başlamamış, ödenmemiş
  bir yenileme faturası, sunucunun boyutu ya da diskleri değiştikten sonra sunucunun güncel fiyatına çekilir: ücreti
  alınan bir büyütmede hemen, diğer durumlarda bir tahsilat çalıştırması içinde (en çok 5 dakika). İtirazlı faturalara
  dokunulmaz. Yenileme faturası ödenmemişken ve dönemi başlamışken yapılan büyütme, o dönemin kalanı için gün
  hesabıyla ücretlendirilir. *İlk çalıştırma:* dönemi başlamamış, ödenmemiş ve fiyatı sunucusunun bugünkü fiyatından
  farklı olan yenileme faturaları güncel fiyata çekilir; müşteriler faturalarında tutar değişikliği görebilir.
- **"Tahsilatı şimdi çalıştır" reddedilebilir.** Periyodik çalıştırma kilidi tutarken düğme `409 BILLING_RUNNING`
  yanıtı verir; birkaç dakika sonra yeniden deneyin. Çalıştırma sonucunda yeni bir `repriced` sayısı vardır.
- **Aynı faturanın iki iadesi üst üste binmez.**

### Sunucular ve sahiplik

- **WHMCS / WISECP ile faturalanan sunucular panelden büyütülemez.** Böyle bir sunucunun sahibi panelde boyut
  değiştiremez, disk ekleyemez ve kopya sipariş edemez (`409 EXTERNALLY_BILLED`); personel ve entegrasyonun kendisi
  yapabilir. Entegrasyonun boyut değişikliği artık müşteri boyut değiştirme anahtarına, role ve saatlik işlem
  sınırına bakmaz. *Yapılacak:* müşterilerinize paket değişikliğini faturalama sisteminden yapmalarını söyleyin.
- **Faturalama sisteminin müşteri eşlemesi daha sıkı.** `POST /admin/external/:source/customers`, aynı e-postayla
  var olan hesap doğrulanmamışsa, bir bayinin müşterisiyse, bir bayiyse ya da başka bir sistemin hesabıysa
  `409 CUSTOMER_NEEDS_REVIEW` yanıtı verir ve sipariş o hesaba bağlanmaz. *Yapılacak:* personel hesabı **devralma
  rotasıyla** o sisteme bağlar (`POST /api/admin/external/<source>/customers/<hesap kimliği>/claim`; hesabın önceki
  oturumlarını, parolasını ve anahtarlarını siler) ya da hesabı yeniden adlandırır / kaldırır; sonra sipariş yeniden
  denenir. E-postayı Yönetim → Kullanıcılar'dan doğrulanmış işaretlemek **artık yetmez**: ikinci turdan beri yalnızca
  entegrasyonun kendi açtığı hesaplar eşleşir (yukarıda, ikinci tur).
  **WHMCS ve WISECP modülleri yeni 409 kodlarını (`CUSTOMER_NEEDS_REVIEW`, `EXTERNALLY_BILLED`, `CLONE_PENDING`)
  tanımaz ve genel bir API hatası olarak gösterir;** kodu modülün günlüğünde arayın.
- **Bayinin açtığı müşteri hesapları doğrulanmamış e-postayla başlar.**
- **Devir ve personel taşıması sunucuyu temizler.** Bir sunucu başka hesaba geçtiğinde (müşteri devri ya da
  personelin taşıması) kayıtlı SSH anahtarları, root parolası, etiketler, notlar ve zamanlanmış silme temizlenir;
  güncelleme izleme ve bütün zamanlamalar kaldırılır; yedekler yeni sahibe geçer ve önceki sahibin açık konsolları
  kapanır. Sonrasında anahtarsız yapılan bir yeniden kurulum yeni bir root parolası üretir. *Yapılacak:* yeni sahip
  güncelleme izlemeyi ve zamanlamaları isterse yeniden açar.
- **Kopyası sipariş edilmiş sunucu devredilemez, taşınamaz, silinemez, yeniden kurulamaz** (`409 CLONE_PENDING`);
  personele özel bir ISO takılıyken de devir ve taşıma reddedilir (`PRIVATE_ISO_MOUNTED`). Kaynağı kurulumdan önce
  silinmiş, yeniden kurulmuş ya da el değiştirmiş bir kopya `CLONE_SOURCE_GONE` ile başarısız olur. *Yükseltmede:*
  yükseltmeden önce sipariş edilmiş, henüz kurulmamış ve kaynağıyla eşleştirilemeyen kopyalar da bu kodla başarısız
  olur; Yönetim → Sunucular → İşlemler'de bakın, müşteri yeniden sipariş verir.
- **İşlem iptali daraldı.** Müşteri yalnızca kendi başlattığı işlemleri ve yalnızca kurulumları ya da henüz
  işlenmeye başlanmamış işlemleri iptal edebilir. Yükseltme anında açık olan işlemleri yalnızca personel iptal
  edebilir. İptal, hipervizörde sürmekte olan bir görevi artık yarıda kesmez.
- **Küçük API değişiklikleri:** müşterinin talep listesi artık `assigneeEmail` içermez; `GET /vdcs` başka
  müşterilerin kişisel imajlarını listelemez; başarısız bir diski ikinci kez kaldırmak `404` döner.

### Giriş ve ayarlar

- **İstek gövdesi sınırları.** JSON gövdeleri 256 KB ile sınırlıdır (`/api/auth/*` altında 64 KB); talep ve itiraz
  ekleri 9 MB, marka dosyaları 1 MB. Caddy `/api/*` isteklerini 10 MB'ta keser. *Yapılacak:* API'ye büyük gövde
  gönderen kendi betikleriniz varsa bölün.
- **Panelin kullanmadığı kimlik rotaları `404` döner.** better-auth eklentilerinin getirdiği ama panelin
  kullanmadığı rotalar kapatıldı; telefon numarasıyla giriş ve telefonla parola sıfırlama bunların içindedir. SMS
  kodu yalnızca oturum açmış kişinin kendi numarasını doğrular. Sağlayıcının kimlik belirtecini (ID token)
  göndererek giriş reddedilir.
- **Dizin ve SSO hesapları yalnızca kendi yollarından girer.** Dizin (LDAP) girişi kapalıyken dizin hesapları giriş
  yapamaz. Dizin ve SSO hesapları e-posta kodu, giriş bağlantısı, passkey, bağlı sosyal hesap ya da kullanıcı adıyla
  giremez. *Yapılacak:* dizin girişini kapatacaksanız önce yerel bir yönetici hesabınız olduğundan emin olun.
- **İki adımlı doğrulaması olan hesaplar giriş bağlantısı kullanamaz;** parolalarıyla girerler.
- **Dizin ve SSO ayarlarını kaydetmek, eşlenen her rolü kapsayan izin ister.** Yalnızca yöneticiler bir grubu ya da
  varsayılan rolü `admin`'e eşleyebilir; aksi `403 FORBIDDEN_TARGET`.
- **Adres değişince sır yeniden girilir.** SMTP sunucusu / portu / güvenlik türü, özel SMS adresinin hostu, rDNS API
  adresi, LDAP adresi ya da OIDC issuer değiştirildiğinde kayıtlı sır (parola, anahtar) yeniden girilmelidir.
- **Ayar testleri uzak sunucunun metnini göstermez.** SMTP, özel SMS, rDNS, LDAP ve SSO testleri uzak sunucunun
  yanıt metnini artık göstermez. LDAP ayrıntısı API günlüğüne `ldap_test_failed` olarak yazılır
  (`docker compose logs api`).
- **Bağlantılar panelin kendi adresini kullanır.** Parola sıfırlama ve giriş bağlantıları isteğin geldiği host adını
  değil, panelin ayarlı adresini taşır; yönlendirme hedefleri yalnızca panel içi yollar olabilir. *Yapılacak:* panelin
  adresi (Ayarlar → Alan adı ve SSL) doğru olsun.
- **Kullanıcı adına oturum açmış personel kalıcı iz bırakamaz.** Passkey, bağlı hesap, webhook, tarayıcı bildirimi
  ve mesajlaşma bağlantısı ekleme; parola, telefon ve iki adımlı doğrulama değişikliği `NOT_WHILE_IMPERSONATING` ile
  reddedilir.
- **Tarayıcı bildirimi abonelikleri.** Abonelik adresi herkese açık bir HTTPS adresi olmalıdır; kullanıcı başına en
  çok 20 abonelik. Personel bir kullanıcının oturumlarını kapattığında ya da parola sıfırlandığında abonelikler
  silinir; kullanıcı bildirimleri tarayıcısında yeniden açar.
- **Yetki daralınca açık konsollar ve terminaller kapanır:** kullanıcının erişimi azaltıldığında, iki adımlı
  doğrulama kapatıldığında ya da sıfırlandığında.
- **Caddy API'ye tek istemci adresi gönderir** (`{client_ip}`); istemcinin yazdığı `X-Forwarded-For` zinciri API'ye
  ulaşmaz. *Yapılacak:* yükseltmeden sonra proxy'yi yeniden başlatın (`docker compose restart proxy`); Caddy 2.7 ya
  da yenisi gerekir (`docker compose exec proxy caddy version`; eskiyse `docker compose pull proxy`). API'nin önüne
  Caddy yerine kendi proxy'nizi koyduysanız o da tek adres göndermelidir ([domain-https.md](domain-https.md)).
- **Denetim kaydı:** passkey ile giriş, passkey ekleme ve kaldırma artık kaydedilir ve giriş bildirimleri gönderilir.
  254 karakterden uzun giriş kimlikleri (e-posta, kullanıcı adı, telefon) reddedilir; denetim ayrıntılarındaki
  metinler uzunlukça sınırlanır.

### Web, konsol ve kurulum betiği

- **Yedekler imzalanır.** Yedek `AD.tar.enc` ve yanında `AD.tar.enc.hmac` olarak yazılır; `.sha256` dosyası artık
  yazılmaz ve sunucu dışı kopyaya `.hmac` gider. Geri yükleme `.hmac` dosyasının yedeğin yanında olmasını, dosyanın
  **özgün adını** taşımasını ve aynı `secrets/backup.key` anahtarını ister; biri tutmazsa `E_RESTORE_SIGNATURE` verir
  ve hiçbir şey değişmez. *Yapılacak:* yedekleri kendi yönteminizle kopyalıyorsanız `.hmac` dosyasını da kopyalayın
  ve yedekleri yeniden adlandırmayın.
- **Eski yedekler yalnızca `--allow-unsigned` ile geri yüklenir.** Önceki sürümlerin aldığı yedeklerde yalnızca
  `.sha256` vardır: bayraksız `E_RESTORE_UNSIGNED`, bayrakla sağlama denetlenir ve `W_RESTORE_UNSIGNED` uyarısı
  yazılır. *Yapılacak:* yükseltmeden hemen sonra yeni bir yedek alın; eski bir yedeği yalnızca saklandığı yere
  güveniyorsanız bu bayrakla geri yükleyin.
- **`get.sh` erişim anahtarı.** Özel depo için `--token-file DOSYA` ya da `export GIT_TOKEN` ile birlikte
  `sudo --preserve-env=GIT_TOKEN sh` kullanın. `--token` hâlâ çalışır ama kurulum boyunca süreç listesinde görünür
  ([updates.md](updates.md)).
- **Bakım dosyalarının izinleri.** `data/maintenance` altındaki host durumu dosyaları ve istek kayıtları
  `root:1000` ve `640`, `.lock` dosyası `600` izinlidir. Bu dosyaları başka bir hesapla okuyan kendi araçlarınız
  varsa uyarlayın.
- **Konsol geçidi.** Bilinmeyen biletler için dakikada en çok 5 `console.denied` / `terminal.denied` denetim olayı
  yazılır; bastırılanların sayısı olayda görünür. HTTPS ile açılan panel `http://` origin'ini reddeder.
  `CONSOLE_ALLOWED_ORIGINS` artık gerçekten uygulanır; girdiler `https://host[:port]` biçiminde olmalıdır.
  *Yapılacak:* `.env` dosyanızda bu değişken varsa biçimine bakın (uymayan girdi yok sayılır ve geçidin günlüğüne
  `allowed_origin_ignored` yazılır).
- **Web arayüzü.** Çıkış yapmak ya da oturumun sona ermesi o tarayıcıdaki tarayıcı bildirimlerini kapatır, taslakları
  ve son sunucular listesini siler. Next sunucusu artık `X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy` ve `frame-ancestors 'none'` başlıklarını kendisi gönderir. Giriş sayfasındaki `next` parametresi,
  normalleştirildiğinde başka bir siteye giden yolları kabul etmez.

### Yükseltmeden sonra (ilk tur)

- `docker compose restart proxy` çalıştırın; denetim kaydında yeni girişlerin IP adresi doğru görünmeli.
- Yeni bir yedek alın (`sudo sh scripts/install.sh backup`); `backups/` altında `.hmac` dosyası oluşmalı.
- Param kullanıyorsanız "onay bekliyor" ödemeleri kimin izleyeceğini belirleyin.
- Dizin ya da SSO kullanıyorsanız bir dizin hesabıyla ve yerel yönetici hesabıyla giriş deneyin.
- Yönetim → Sunucular → İşlemler'de `CLONE_SOURCE_GONE` ile başarısız olmuş kopya siparişi var mı bakın.

## Önceki tur: baştan sona denetim

Buradan sayfanın sonuna kadarki bölümler, API, worker, web arayüzü, adaptörler ve kurulum betiğinin baştan sona
denetlendiği önceki tura aittir. Her madde neyin değiştiğini ve yükseltmeden sonraki **ilk tahsilat
çalıştırmasının** ya da **ilk başlatmanın** mevcut veriye ne yaptığını söyler. O turun veri değişiklikleri
`apps/api/migrations` altındaki `070`, `071`, `072` ve `073` numaralı dosyalardadır; yükseltme sırasında kendiliğinden
uygulanır.

> [!IMPORTANT]
> En çok dikkat isteyen bölüm **Faturalama**'dır. Yükseltme **geçmişe dönük fatura kesmez**: hatalarımız yüzünden
> faturalanmamış dönemler atlanır ve faturalama bugünden başlar (migration `073`). Bundan sonra otomatik yenilemesi
> kapalı aboneliklere de fatura kesilir ve ödenmeyen bazı faturalar ilk kez tahsilat adımlarına (hatırlatma, askı,
> sonlandırma) girer. Yükseltmeden önce aşağıdaki sorguları çalıştırıp kimlerin etkileneceğine bakın; atlanan
> dönemleri elle faturalamak isterseniz ilk sorgunun çıktısını saklayın.

## Yükseltmeden önce

1. Yedek alın ve `secrets/backup.key` dosyasının sunucu dışında bir kopyası olduğundan emin olun:

   ```bash
   sudo sh scripts/install.sh backup
   ```

2. Veritabanına bağlanın (kurulum klasöründe):

   ```bash
   docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
   ```

3. Kimlerin etkileneceğine bakın. Sorgular yalnızca okur.

   **Dönemi ileri alınacak abonelikler (faturalanmayacak geçmiş dönemler).** Dönemi geçmişte bitmiş, açık yenileme
   faturası olmayan ve hâlâ süren her abonelik, migration `073` ile bugünü içeren döneme taşınır; aradaki dönemler
   için **fatura kesilmez**. Sorgu tam olarak hangilerinin taşınacağını, kaç dönem atlanacağını ve bunun tutarını
   gösterir (iptal edilmiş yenileme faturasının arkasında kalmış olanlar ile otomatik yenilemesi kapalı olanlar
   buradadır). Atlanan dönemleri elle faturalamak isterseniz bu çıktıyı yükseltmeden **önce** saklayın:

   ```sql
   WITH RECURSIVE due AS (
     SELECT b.id, b.period_end AS until, 0 AS skipped
     FROM subscriptions b
     WHERE b.status IN ('active', 'past_due', 'suspended') AND NOT b.cancel_at_period_end
       AND b.period_end < (now() AT TIME ZONE 'Europe/Istanbul')::date
       AND NOT EXISTS (SELECT 1 FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
                       WHERE l.subscription_id = b.id AND i.kind = 'renewal' AND i.status = 'unpaid')
     UNION ALL
     SELECT d.id, (d.until + make_interval(months => b.period_months))::date, d.skipped + 1
     FROM due d JOIN subscriptions b ON b.id = d.id
     WHERE d.until < (now() AT TIME ZONE 'Europe/Istanbul')::date
   )
   SELECT u.email, b.kind, b.description, b.status, b.auto_renew, b.period_end AS ended,
          max(d.until) AS new_period_end, max(d.skipped) AS periods_skipped,
          (b.amount * b.period_months * max(d.skipped))::numeric(12,2) AS not_invoiced, b.currency
   FROM due d JOIN subscriptions b ON b.id = d.id JOIN users u ON u.id = b.owner_id
   GROUP BY u.email, b.id
   ORDER BY b.period_end;
   ```

   Yükseltmeden **sonra** neyin taşındığı denetim kaydındadır:

   ```sql
   SELECT created_at, resource_id AS subscription, metadata
   FROM audit_events WHERE action = 'billing.period_moved' ORDER BY created_at;
   ```

   **Otomatik yenilemesi kapalı abonelikler.** Bundan sonra bunlara da her dönem fatura kesilir (kendiliğinden
   tahsil edilmez); ilk fatura, yaklaşan dönem için, olağan zamanında gelir:

   ```sql
   SELECT u.email, b.kind, b.description, b.amount, b.currency, b.period_end, b.status
   FROM subscriptions b JOIN users u ON u.id = b.owner_id
   WHERE NOT b.auto_renew AND NOT b.cancel_at_period_end
     AND b.status IN ('active', 'past_due', 'suspended')
   ORDER BY b.period_end;
   ```

   **Vadesi geçmiş, ödenmemiş sipariş, boyut değişikliği ve ek disk faturaları.** Bunlar ilk kez tahsilat adımlarına
   girer:

   ```sql
   SELECT i.number, u.email, i.kind, i.total, i.currency, i.due_at
   FROM invoices i JOIN users u ON u.id = i.owner_id
   WHERE i.status = 'unpaid' AND i.kind IN ('order', 'manual') AND i.due_at < now()
   ORDER BY i.due_at;
   ```

   **Yaklaşan dönemin yenileme faturası yükseltmeden önce iptal edilmiş abonelikler.** Geçmiş dönemler için yeniden
   fatura kesilmez (yukarıdaki taşıma). Yalnızca dönemi **henüz bitmemiş** bir aboneliğin yaklaşan dönem faturası
   iptal edilmişse, ilk çalıştırma o yaklaşan dönem için yeni bir fatura keser; dönemi bilerek ücretsiz
   bıraktıysanız yeni faturayı panelden geri çekin (geri çekmek artık "bu dönem ücretsiz" demektir):

   ```sql
   SELECT u.email, b.description, l.period_start, i.number AS cancelled_invoice
   FROM invoice_lines l
   JOIN invoices i ON i.id = l.invoice_id
   JOIN subscriptions b ON b.id = l.subscription_id
   JOIN users u ON u.id = b.owner_id
   WHERE i.status = 'cancelled' AND i.kind = 'renewal'
     AND b.status IN ('active', 'past_due', 'suspended') AND NOT b.cancel_at_period_end
     AND l.period_start = b.period_end
     AND b.period_end >= (now() AT TIME ZONE 'Europe/Istanbul')::date;
   ```

   **Ödenmemiş sanal veri merkezleri.** Bunların sunucuları ilk kez bekletilir ve kapatılır:

   ```sql
   SELECT u.email, b.description, b.status, b.period_end
   FROM subscriptions b JOIN users u ON u.id = b.owner_id
   WHERE b.kind = 'vdc' AND b.status IN ('past_due', 'suspended');
   ```

   **Bekletilen saatlik sunucular.** Bunlar artık süresiz beklemez:

   ```sql
   SELECT u.email, s.name, s.state
   FROM servers s JOIN users u ON u.id = s.owner_id
   WHERE s.billing_hold AND s.billing_mode = 'hourly' AND s.state <> 'deleted';
   ```

   **Kotasını aşacak müşteriler.** Kendi kotası olmayan projeler ve ek diskler artık sahibin kullanımına sayılır.
   Sorgu, kullanıcıya özel kotayı, o yoksa varsayılan kotayı esas alır (role tanımlı sınırlar varsa varsayılanın
   yerine onlar geçer; onları Yönetim → Roller'den karşılaştırın):

   ```sql
   SELECT u.email, x.servers, x.vcpu, x.memory_mb, x.disk_gb,
          q.max_servers, q.max_vcpu, q.max_memory_mb, q.max_disk_gb
   FROM (
     SELECT s.owner_id, count(*) AS servers, sum(s.vcpu) AS vcpu, sum(s.memory_mb) AS memory_mb,
            sum(s.disk_gb + COALESCE((SELECT sum(d.size_gb) FROM server_disks d
                                      WHERE d.server_id = s.id AND d.status <> 'failed'), 0)) AS disk_gb
     FROM servers s
     WHERE s.state <> 'deleted' AND s.vdc_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM quotas p WHERE p.scope = 'project' AND p.subject_id = s.project_id)
     GROUP BY s.owner_id
   ) x
   JOIN users u ON u.id = x.owner_id
   JOIN quotas q ON (q.scope = 'user' AND q.subject_id = x.owner_id)
     OR (q.scope = 'default' AND NOT EXISTS (SELECT 1 FROM quotas o WHERE o.scope = 'user' AND o.subject_id = x.owner_id))
   WHERE x.servers > q.max_servers OR x.vcpu > q.max_vcpu OR x.memory_mb > q.max_memory_mb OR x.disk_gb > q.max_disk_gb;
   ```

4. Daraltılmış API anahtarı kullanan müşterilerinize haber verin ([API](#api) bölümü): anahtarın izinleri dışındaki
   yazma istekleri artık `403 FORBIDDEN` alır.

5. Sandbox ödeme sağlayıcısını canlıda kapattıysanız, sandbox'ta kaydedilmiş kartların artık ödeme yapmayacağını
   bilin ([Faturalama](#faturalama)).

## Faturalama

- **Otomatik yenileme kapalıyken de fatura kesilir.** "Otomatik yenile" kapalı bir abonelik için eskiden hiç fatura
  kesilmiyor, sunucu dönem bittikten sonra ücretsiz çalışmaya devam ediyordu. Artık anlamı şudur: fatura her dönem
  kesilir, yalnızca bakiyeden ya da kayıtlı karttan **kendiliğinden tahsil edilmez**; müşteri kendisi öder. Ödenmezse
  her fatura gibi hatırlatılır, sunucu askıya alınır ve sonunda sonlandırılır. *Yükseltmede:* dönemi geçmişte bitmiş
  olanlar bugünü içeren döneme taşınır ve aradaki dönemler faturalanmaz (aşağıdaki "geçmişe dönük fatura yok"
  maddesi). *İlk çalıştırma:* yalnızca dönemi bitmek üzere olanlara (faturanın dönemden kaç gün önce kesildiği ayarı
  kadar gün kalmışsa), yaklaşan dönem için bir yenileme faturası kesilir; ötekilere sırası gelince.
- **Geçmişe dönük fatura yok: faturalama yükseltmeden başlar.** Eski hatalar yüzünden faturalanmamış abonelikler
  (iptal edilmiş bir yenileme faturasının arkasında kalanlar, otomatik yenilemesi kapalı olanlar) için geçmiş
  dönemlerin faturası kesilmez. *Yükseltmede (migration `073`):* dönemi geçmişte bitmiş, açık yenileme faturası
  olmayan ve hâlâ süren (etkin, vadesi geçmiş ya da askıda) her abonelik, yenilemenin ilerlettiği gibi tam dönemler
  hâlinde ileri alınır; yeni dönem bugün ya da sonra biter. Atlanan dönemler için hiçbir şey tahsil edilmez; her
  taşıma denetim kaydına `billing.period_moved` olarak yazılır (eski ve yeni dönem, atlanan dönem sayısı, dönem
  tutarı). Dokunulmayanlar: açık yenileme faturası olan abonelikler (olağan tahsilat adımlarında kalır) ve dönem
  sonunda iptali istenmiş olanlar (eskisi gibi sona erer). Bu taşıma yalnızca yükseltmede bir kez yapılır; sonradan
  geç kesilen bir yenileme faturası (örneğin tahsilat bir süre çalışmadıysa) dönemini atlamaz, yalnızca vadesi
  kesildiği günden sayılır.
- **Ödenmemiş sipariş, boyut değişikliği ve ek disk faturaları da tahsilat adımlarına girer.** Eskiden yalnızca
  yenileme faturaları hatırlatılıyor ve askıya yol açıyordu; ödemeden önce kurulan bir sunucunun ilk faturası ya da bir
  büyütmenin faturası ödenmeden kalabiliyordu. *Yükseltmede:* vadesi geçmiş olanlar doğrudan askıya gitmez; süre
  yükseltme anından sayılır (`invoices.dunning_from`), yani ilk adım hatırlatmadır.
- **Ödenmemiş sanal veri merkezleri askıya alınır, sonra sonlandırılır.** Eskiden veri merkezi "askıda" görünüyor ama
  sunucuları çalışmaya devam ediyordu. Artık askıda sunucuları bekletilir ve kapatılır, sonlandırmada silinir; askıdaki
  veri merkezinde yeni sunucu açılamaz. *Yükseltmede:* askıda görünen veri merkezleri "vadesi geçmiş" durumuna döner ve
  süre yükseltme anından sayılır; askı, bildirimiyle birlikte olağan gün sayısından sonra gelir.
- **İptal edilen yenileme faturası faturalamayı durdurmaz.** Eskiden bir yenileme faturası iptal edilince o abonelik
  bir daha hiç faturalanmıyordu. Artık iki ayrı durum var: personelin faturayı **geri çekmesi** o dönemin ücretsiz
  olduğu anlamına gelir (abonelik ödenmiş gibi ilerler); sistemin kendi iptalleri (sunucu silindi, sipariş süresi
  doldu) yalnızca dönemi serbest bırakır ve gerekiyorsa fatura yeniden kesilir. *Yükseltmede:* yükseltmeden önce
  iptal edilmiş yenileme faturalarının dönemi serbest kalır, ama geçmiş dönemler için **yeniden fatura kesilmez**:
  böyle bir aboneliğin dönemi yukarıdaki taşımayla bugüne gelir. Tek istisna, dönemi henüz bitmemiş bir aboneliğin
  yaklaşan dönem faturasının iptal edilmiş olmasıdır; o yaklaşan dönem için ilk çalıştırma yeni bir fatura keser.
- **Personelin "Şimdi iptal et" dediği abonelik yeniden açılmaz.** Sunucu ya da veri merkezi faturasız çalışmaya
  devam eder ve sonraki çalıştırmalar ona yeni abonelik vermez; aboneliği sürdürmek bunu geri alır.
- **Fazla ödeme ve kapalı faturaya gelen ödeme bakiyeye yazılır.** Faturanın ihtiyacından fazlası, ya da fatura bu
  arada ödenmiş veya iptal edilmişse ödemenin tamamı müşterinin bakiyesine geçer. Mevcut veriye dokunulmaz.
- **Bekletilen saatlik sunucular borç biriktirmez ve süresiz beklemez.** Bakiyesi bittiği için kapatılan saatlik
  sunucu kapalıyken ücretlendirilmez. Askıdaki bir aboneliğin tutulduğu gün sayısı kadar bekleyen ve hâlâ ödenmemiş
  kullanım faturası olan sunucu sonlandırılır. *Yükseltmede:* hâlen bekletilen sunucular için süre yükseltme anından
  başlar (`servers.held_at`).
- **Yarım kalan kart ödemeleri sağlayıcıya yeniden sorulur.** Stripe, iyzico ve Craftgate'te ödeyip sekmeyi kapatan
  müşterinin ödemesi artık kaybolmaz: tahsilat çalıştırması, beş dakikadan eski açık ödemeleri sağlayıcıya sorar ve
  sonucu işler; bir gün içinde ödenmeyen ödeme "süresi doldu" olarak kapanır. PayTR ve Param'da bu yoktur.
- **Sağlayıcıdan net yanıt gelmeden ödeme sonuçlandırılmaz.** Sağlayıcı yanıt vermediğinde, imza uymadığında ya da
  dönüş adresi sorulacak bilgi olmadan açıldığında ödeme "başarısız" yazılmaz, açık kalır.
- **WHMCS / WISECP'den gelen sonlandırma hemen siler.** Eskiden silme bekleme süresine giriyordu; müşteri bu sürede
  sunucuyu geri alabiliyor ve kimse faturalamıyordu. Dış sistemin askıya alırken başlatamadığı kapatma da sonraki
  çalıştırmada yeniden denenir.
- **Sandbox kartları sandbox kapalıyken ödeme yapmaz.** Test sağlayıcısında kaydedilmiş bir kart, sandbox
  kapatıldıktan sonra otomatik tahsilatta "ödendi" sonucu vermez. *İlk çalıştırma:* böyle kartı varsayılan olan
  müşterilerin otomatik tahsilatı başarısız olur ve fatura olağan adımlara girer.
- **Faturalamanın sileceği sunucu meşgulse karar unutulmaz.** Dönem sonunda iptal ya da ödenmediği için sonlandırma
  kararı sunucunun üzerinde kalır (`servers.billing_remove`); o an başka bir işlemi olan sunucu sonraki
  çalıştırmalarda silinir, aboneliği bitmiş hâlde çalışmaya devam etmez.

## Kotalar

- **Kendi kotası olmayan projeler sahibin kotasına sayılır.** Eskiden her proje sayımı sıfırdan başlatıyordu; proje
  açmak ücretsiz olduğundan kota aşılabiliyordu. *Yükseltmeden sonra:* kullanımı kotasını aşan müşterinin mevcut
  sunucularına dokunulmaz; yalnızca yeni sipariş ve büyütme `QUOTA_EXCEEDED` ile reddedilir. Gerekirse kullanıcıya ya
  da projeye özel kota tanımlayın.
- **Ek diskler kotaya ve kapasiteye sayılır.** Bir sunucunun diski artık sistem diski ile ek disklerinin toplamıdır:
  müşterinin disk kotasında ve konumun ayrılmış kapasitesinde böyle hesaplanır. Dolmaya yakın konumlar yükseltmeden
  sonra daha dolu görünebilir.
- **Sanal veri merkezindeki sunucuya ayrı ek disk eklenemez** (`VDC_SERVER`): veri merkezinin ayrımı içinde
  sayılmayacak ve faturalanmayacaktı.

## API

- **Daraltılmış anahtarlar izinleri dışındaki yazma isteklerinde reddedilir** (`403 FORBIDDEN`). Yalnızca bazı
  izinlerle oluşturulmuş bir API anahtarı eskiden, izin adı taşımayan yazma rotalarını kullanabiliyordu. Artık yazma
  isteği yalnızca rotanın istediği izin anahtarda varsa geçer. Okuma (GET) istekleri ve fiyat hesabı
  (`POST /catalog/quote`) etkilenmez; daraltılmamış anahtarlar da etkilenmez. Daraltılmış anahtara artık kapalı olan
  rota grupları: faturalama (profil, fatura ödeme, bakiye yükleme, abonelik ayarı, kartlar, itirazlar), projeler, SSH
  anahtarları, konsol komutları, sunucu adı, kilidi, etiketleri ve favorileri, işlem iptali, sunucu devri, özel
  ağlar, ters DNS, kişisel imajlar, sunucu içi güncellemeler, destek kayıtları, bildirim ayarları, mesajlaşma
  uygulamaları, oturumlar, bütçe ve saat dilimi, bayinin marka ve müşteri işlemleri. İzin adıyla açık kalanlar: sunucu
  oluşturma, güç, boyut ve ek disk, yeniden kurulum, silme, root parolası, konsol, anlık görüntü, yedek, ISO,
  zamanlamalar, firewall ve veri merkezi güç işlemleri.
- **Başka bir kullanıcı olarak oturum açmışken API anahtarı oluşturulamaz** (`NOT_WHILE_IMPERSONATING`): anahtar,
  onu oluşturan oturumdan uzun yaşar.
- **Host terminali API anahtarını kabul etmez** (`TOKEN_NOT_ALLOWED`): yalnızca panelde oturum açmış tarayıcıdan
  açılır.
- **Rol yöneten kişi, kendisinde olmayan izinleri taşıyan rolü değiştiremez ya da silemez** (`FORBIDDEN_TARGET`).

## Sunucular

- **Müşterinin SSH anahtarları yeni sunucularda `root` için çalışır.** Hazır bulut imajlarında anahtarlar eskiden
  root'a yalnızca "şu kullanıcıyla girin" uyarısı olarak ulaşıyordu. Yalnızca yükseltmeden sonra kurulan ya da yeniden
  kurulan sunucuları etkiler.
- **Geçici hataya takılan boyut değişikliği, denemeler arasında sunucuyu kapalı tutar.** Eskiden sunucu yeniden
  başlatılıyor ve sonraki deneme hiç yapılmamış bir değişikliği "tamamlandı" sayabiliyordu. Sunucu, değişiklik
  uygulanınca ya da işlem kesin olarak başarısız olunca açılır.
- **Yok sayılan kapatma isteği kendi hatasıyla biter** (`SHUTDOWN_TIMEOUT`): işletim sistemi isteğe uymadıysa işlem
  "kapatıldı" diye bitmez; müşteri zorla kapatabilir.
- **Oluşturmayı iptal etmek, süren kopyanın bitmesini bekler.** Kopyayı arka planda yapan platformlarda VM kopya
  bitince ortaya çıkar; iptal artık önce onu bekler, sonra VM'i siler. Süre dolduğunda kopya hâlâ sürüyorsa iptal
  başarısız kalır ve personel görür.
- **Aynı anda yürüyen işlem sayısı 4'ten 8'e çıktı** ve `.env` içindeki `OPERATIONS_CONCURRENCY` ile değiştirilir.
  *İlk başlatma:* worker sekiz işlemi birlikte yürütür; hipervizörünüz bunu kaldırmıyorsa değeri düşürün.
- **Ödenmemiş fatura nedeniyle bekletilen sunucuda yalnızca kapatma ve silme yapılabilir**, isteği kim gönderirse
  göndersin (sahip, bayi, zamanlama). Personel işlem yapabilir.
- **Kaybolan platform görevi "bitti" sayılmaz.** Worker sonucu gerçek nesneden okur (VM var mı, güç durumu, anlık
  görüntü listesi), okuyamıyorsa adımı yeniden dener. Yanıtı kaybolan bir ek disk isteği ikinci bir disk eklemez.

## Platformlar

- **Platformun yapamadığı işlemler arayüzde gizlenir ve hemen reddedilir.** Konsol, firewall, taşıma, kişisel imaj,
  yedek ve ISO, konumun platformu desteklemiyorsa sunucu sayfasında görünmez; API de isteği worker'da başarısız olacak
  bir işlem başlatmak yerine baştan reddeder.
- **İşlemci ölçümüne dayalı öneriler XCP-ng, oVirt, libvirt ve Incus'ta kapalıdır.** Bu adaptörler işlemci kullanımını
  ölçemez ve 0 bildiriyordu; her sunucu boşta görünüyor, küçültme önerisi ve düşük sağlık puanı alıyordu.
  *Yükseltmede:* bu platformlardaki sunucuların kayıtlı işlemci örnekleri silinir, güç örneklerindeki kullanım değeri
  boşaltılır; öneriler hemen kaybolur.

## Kurulum ve bakım

- **Yedek, yazıldıktan sonra geri okunarak doğrulanır.** Şifreli dosyadan çıkan her bayt içeri girenle
  karşılaştırılır; tutmuyorsa yedek başarısız sayılır (`E_BACKUP_VERIFY`) ve eski yedekler silinmez. Yazılamayan yedek
  de artık hata verir (`E_BACKUP_WRITE`).
- **Geri yükleme önce denetler, sonra tek işlemde uygular.** Veritabanı yanıt vermeden ve yedekteki döküm okunmadan
  hiçbir şey durdurulmaz. Mevcut verinin güvenlik yedeği alınamazsa geri yükleme yapılmaz; yedeksiz devam etmek için
  `--no-safety-backup` gerekir. Eski şema ile yeni veri tek veritabanı işleminde yer değiştirir: ya hepsi olur ya
  hiçbir şey değişmez. Sonunda Redis boşaltılır (eski kuyruk işleri geri yüklenen veriye ait değildir). Yarıda kalan
  geri yükleme servisleri kapalı bırakmaz ve veritabanının hangi veriyi tuttuğunu söyler.
- **Bakım işleri aynı kilidi kullanır.** Elle başlatılan `backup`, `update` ve `restore`, saatlik zamanlayıcıyla ve
  panelden gelen isteklerle aynı anda çalışmaz; biri diğerini bekler.
- **`uninstall` komutu eklendi.** Servisleri durdurur ve betiğin proje klasörü dışına yazdıklarını kaldırır; `.env`,
  `secrets/`, `backups/` ve `data/` kalır, `--purge-data` verilmedikçe Docker birimleri de kalır.
- **Kurulu sunucuda `get.sh` yeniden çalıştırılırsa güncelleme yapar.** Eskiden yeniden kurulum yapıyor; yedeği,
  migration denetimini ve geri dönüşü atlıyor, dal izleyen bir sunucuyu kararlı kanala çekebiliyordu. Artık
  `install.sh update` çalışır ve güncelleme kanalı değişmez ([updates.md](updates.md)).
- **Bakım penceresi denetlenir.** Zamanlayıcı saat başlarında çalışır; bir saat başını ve ardından gelen on dakikayı
  içermeyen pencere (örneğin `03:30-04:00`) hiç güncelleme yapmazdı ve bunu söylemezdi. Böyle bir pencere artık
  reddedilir (`E_WINDOW_NEVER`). *Yükseltmeden sonra:* `.env` içindeki `UPDATE_WINDOW` böyleyse yeniden ayarlayın.
- **Otomatik güncelleme, başarısız olan sürümü yeniden denemez.** Eskiden her saat yeniden deniyordu (her seferinde
  yedek, durdurma, derleme, geri dönüş). Artık sonraki sürümü ya da elle başlatılan güncellemeyi bekler
  (`UPDATE_SKIPPED`).
- **Başarısız kaynak geçişi geri alınır.** `git checkout` başarısız olursa (dolu disk, bozuk depo) worker kapalı
  kalmaz; önceki sürüm yeniden başlatılır (`E_UPDATE_CHECKOUT`).
- **`.env` içindeki bazı değişkenler artık container'lara ulaşıyor.** `compose.yaml` bunları eskiden geçirmiyordu,
  yani `.env`'e yazılan değerin etkisi yoktu: `SESSION_TTL_HOURS`, `TRUSTED_PROXIES`, `LOG_ERROR_DETAIL`,
  `POWER_SAMPLE_MINUTES`, `RECONCILE_MINUTES`, `OPERATIONS_CONCURRENCY`, `TASK_POLL_MS`, `SHUTDOWN_POLL_MS`,
  `CONSOLE_MAX_TOTAL`, `CONSOLE_ALLOWED_ORIGINS`, `APP_TIME_ZONE`, `TERMINAL_MAX_PER_USER`, `TERMINAL_MAX_TOTAL`,
  `VMWARE_ALLOW_NETWORKS`, `VMWARE_DENY_NETWORKS`, `CONSOLE_ALLOW_NETWORKS`, `CONSOLE_DENY_NETWORKS` ve diğer altı
  adaptörün `*_DENY_NETWORKS` değişkenleri. *İlk başlatma:* `.env` dosyanızda bunlardan biri eskiden kalma bir
  değerle duruyorsa **artık uygulanır**; yükseltmeden önce dosyaya bakın.
- **İzleme servislerine bellek sınırı kondu** (`observability` profili): Prometheus ve Loki 1 GB, Grafana ve
  OpenTelemetry toplayıcısı 512 MB, Alertmanager 256 MB. Sınırı aşan servis yeniden başlar; panel ve veritabanı
  bellekten düşmez. *İlk başlatma:* çok büyük bir izleme verisi olan kurulumda bu servisler yeniden başlayabilir.
- **cloud-init hotplug hatası susturulur.** Bulut imajlarında cloud-init, container'ların sanal ağ arayüzlerinde hata
  verip `cloud-init-hotplugd.service` birimini "failed" bırakabiliyordu. Betik, sanal arayüzleri atlayan bir systemd
  eki yazar (`/etc/systemd/system/cloud-init-hotplugd.service.d/10-lightning-vm.conf`); gerçek donanım eskisi gibi
  işlenir. Kurulu sunucular bunu sonraki güncellemeyle alır; dosyayı silmek eski davranışı geri getirir.

## Adaptörler

- **Adaptörler kendi Docker ağlarındaki adreslere bağlanmaz.** Proxmox, XCP-ng, oVirt, Hyper-V, libvirt ve Incus
  adaptörleri artık VMware adaptörü gibi, container'ın kendi arayüzlerinin ağlarını da reddeder (`ENDPOINT_BLOCKED`);
  PostgreSQL, Redis ve API o ağlardadır. Her birine `*_DENY_NETWORKS` eklendi. *İlk başlatma:* hipervizörünüz panelin
  Docker ağlarından birindeyse (test kurulumlarında olur) bağlantı reddedilir; `.env` dosyasına ilgili
  `*_ALLOW_NETWORKS` satırını ekleyin.
- **Sabit parmak iziyle yan yana yapılan çağrılar reddedilmez.** Proxmox, XCP-ng, oVirt, Hyper-V ve Incus
  adaptörlerinde ikinci bağlantı, devam ettirilen TLS oturumu sertifika sunmadığı için `TLS_PIN_MISMATCH` alıyordu.
- **Süresi dolan istek, oturumu işin altından kapatmaz.** Bir rota zaman aşımına uğradığında adaptör oturumu iş
  bitince kapatır; art arda değişiklik yapan bir iş yarıda kesilmez.
- **VMware:** adaptörün tanımadığı vSphere hataları artık `VMWARE_ERROR` koduyla gelir; `NOT_VSPHERE` yalnızca adreste
  vSphere API'si yanıt vermediğinde kullanılır. Bazı kodların HTTP durumu 502'den 404 / 409 / 400'e taşındı
  ([adapter-contract.md](adapter-contract.md)); panel koda baktığı için davranışı değişmez.
- **Proxmox VE:** PVE 9'un konuk aracı yetkileri tanınır ve eksikse bağlantıda uyarı çıkar; aracı açık ama sessiz
  sunucu dört dakika sonra hazır sayılır; fazladan adresler için işlem uyarı taşır; yerel depolamadaki şablondan
  başka düğüme kopya açık bir iletiyle reddedilir; hotplug olmadan çalışan sunucudan disk kaldırma başarısız olur ve
  disk kaydı korunur ([proxmox.md](proxmox.md)).
- **XCP-ng:** silme, sunucunun anlık görüntülerini de kaldırır; ağ arayüzü MAC ile eşlenip `eth0` adını alır, imajda
  netplan gerekmez; yanıtı kaybolan kopya yeniden başlatılmaz, süren kopya bulunur ([xcpng.md](xcpng.md)).
- **oVirt:** Engine'in "meşgul" yanıtı yeniden denenir (`ENGINE_BUSY`); anlık görüntüye dönmeden önce sunucu
  kapatılır; 16'dan fazla vCPU soket × çekirdek olarak bölünür; `eth0` şartı bağlantıda uyarı olarak görünür
  ([ovirt.md](ovirt.md)).
- **Hyper-V:** ağ kartı sabit MAC alır ve arayüz `eth0` olur; `.vhd` şablon `.vhd` kalır; iş ve sunucu klasörleri
  izinle korunur; klasörü kilitli sunucunun silinmesi yeniden denenir ([hyperv.md](hyperv.md)).
- **KVM (libvirt):** hostta `timeout` komutu gerekir; `tasks` klasörü yalnızca bağlanan hesaba açıktır; yapılandırma
  diski q35'te SATA, i440fx'te IDE olarak takılır; ağ kartı sunucu kimliğinden MAC alır; yanıtı kaybolan snapshot
  isteği ikinci bir snapshot almaz; UUID olmayan sunucu kimliği ya da IP olmayan adres reddedilir
  ([libvirt.md](libvirt.md)).
- **Incus:** yukarıdaki üç ortak düzeltme dışında davranışı değişmedi ([incus.md](incus.md)).

## Yükseltmeden sonra

- Yönetim → Sistem'de güncellemenin bittiğini ve servislerin çalıştığını doğrulayın.
- İlk tahsilat çalıştırmasından sonra Faturalar sayfasına bakın: yeni kesilen yenileme faturaları ve tahsilat adımına
  giren eski faturalar beklediğiniz müşterilere mi ait?
- Yönetim → Bağlantılar'da her bağlantıyı yenileyin: yeni keşif uyarıları (Proxmox konuk aracı yetkisi, oVirt `eth0`)
  ve `ENDPOINT_BLOCKED` hataları burada görünür.
- Yönetim → Sunucular → İşlemler'de başarısız işlemleri gözden geçirin.
