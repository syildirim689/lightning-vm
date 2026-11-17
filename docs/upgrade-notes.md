# Yükseltme notları

Bu sayfa, **kurulu bir Lightning VM'i yükselten işletmeci** içindir ve en yeni turdan eskiye doğru sıralıdır. Her
madde neyin değiştiğini ve işletmecinin yapması gereken bir şey varsa onu söyler. Yalnızca hata düzeltmesi olup
davranışı değiştirmeyen işler burada yoktur. Tahsilat çalıştırması API içinde beş dakikada bir çalışır; yani "ilk
çalıştırma" yükseltmeden birkaç dakika sonradır.

## Güvenlik denetimi turu (2026-11-17)

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
  `409 CUSTOMER_NEEDS_REVIEW` yanıtı verir ve sipariş o hesaba bağlanmaz. *Yapılacak:* personel hesabın e-postasını
  doğrular (Yönetim → Kullanıcılar) ya da hesabı yeniden adlandırır / kaldırır; sonra sipariş yeniden denenir.
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

### Yükseltmeden sonra (bu tur)

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
