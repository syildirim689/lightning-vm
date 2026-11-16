# Yükseltme notları

Bu sayfa, **kurulu bir Lightning VM'i yükselten işletmeci** içindir. API, worker, web arayüzü, adaptörler ve kurulum
betiğinin baştan sona denetlendiği turda değişen davranışları anlatır: her madde neyin değiştiğini ve yükseltmeden
sonraki **ilk tahsilat çalıştırmasının** ya da **ilk başlatmanın** mevcut veriye ne yaptığını söyler. Tahsilat
çalıştırması API içinde beş dakikada bir çalışır; yani "ilk çalıştırma" yükseltmeden birkaç dakika sonradır.

Yalnızca hata düzeltmesi olup davranışı değiştirmeyen işler burada yoktur. Veri değişiklikleri
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
