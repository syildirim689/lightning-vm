# IP yönetimi (colocation)

Veri merkezi, size ait IP bloklarını (örneğin bir /26 veya /24) sunucularınızın ağına yönlendirir. Panel bu
blokları **IP havuzu** olarak tanır ve adresleri otomatik dağıtır.

## Akış
1. **Katalog → IP havuzları:** blok (CIDR), ağ geçidi, dağıtılacak aralık, DNS sunucuları, hariç tutulanlar,
   karantina süresi ve isteğe bağlı IPv6 öneki girilir. Havuz bir konuma (resource pool) bağlıdır; konumun
   ağı, bloğun yönlendirildiği VLAN/port grubudur.
2. **Sipariş:** müşteri konumu seçer. Konum ek IPv4 satıyorsa adet seçer; fiyat aylık toplama eklenir.
   IPv6 varsa sunucuya kendiliğinden eklenir.
3. **Ayırma (çakışmasız):** birincil ve ek IPv4 adresleri **aynı** IP havuzundan, kilitli bir işlem içinde
   ayrılır (tek ağ geçidi). Hariç tutulan, ağ geçidi, kullanımda ve karantinadaki adresler atlanır. IPv6, önekteki
   ilk boş adres olur (`::10` ve sonrası).
4. **Yapılandırma:** tüm adresler, ağ geçitleri (IPv4 ve IPv6) ve DNS sunucuları cloud-init ile ilk açılışta
   sunucuya yazılır; elle ayar gerekmez.
5. **Ters DNS:** sunucu hazır olunca adreslerine varsayılan PTR yazılır.
6. **Silme:** VMware'de silindiği doğrulanınca:
   - PTR kayıtları kaldırılır;
   - adresler havuzun **karantina** süresi (varsayılan 24 saat) dolana kadar kimseye verilmez.
   İptal edilen bir kurulumun adresleri hiç kullanılmadığı için hemen serbest kalır.

## Karantina
Silinen bir sunucunun IP'si spam listelerinde ya da müşterilerin önbelleklerinde hâlâ önceki müşteriye ait
olabilir. Karantina süresi IP havuzu başına ayarlanır (0 = kapalı, en fazla 8760 saat). Yönetici bir adresi
**Adresler** listesinden erken serbest bırakabilir. Karantinadaki adresler kapasite uyarılarında dolu sayılır.

## Ters DNS (PTR)
Konum: Ayarlar → **Ters DNS**.
- **Sağlayıcı:** PowerDNS HTTP API'si. PowerDNS-Admin kullanan kurulumlarda da panel doğrudan PowerDNS ile konuşur.
- **Bağlantı testi:** sunucudaki ters zone'ları ve her IP havuzunun (IPv4/IPv6) bir zone ile kapsanıp kapsanmadığını gösterir.
- **Varsayılan PTR şablonu:** `{ip}`, `{ip-dashed}`, `{name}`; örneğin `{ip-dashed}.static.example.com`.
- **Müşteri düzenlemesi:** müşteri sunucu sayfasından kendi adreslerinin PTR'ını değiştirebilir.
  - **İleri doğrulama** açıksa (varsayılan) ad önce adrese çözülmelidir (A/AAAA kaydı); aksi halde `PTR_FORWARD_MISMATCH`.
  - Yöneticiler kontrol edilmez.
  - "Varsayılan" düğmesi şablona döndürür.
- **Zone seçimi:** adresi kapsayan en uzun ters zone otomatik bulunur (örneğin /24 için `2.0.192.in-addr.arpa.`).
  Zone'ları DNS sunucusunda önceden oluşturmanız gerekir.
- **Kim yazar:** PTR kayıtlarını API süreci yazar (`rdns` kuyruğu). Worker yalnızca kuyruğa ekler; DNS anahtarı API'de şifreli kalır.

## Ek IPv4
Katalog → Havuzlar → konum kartı → "Satılık ek IPv4": sunucu başına en fazla adet (0-32) ve adet başı aylık
fiyat. Fiyat, paketin veya özel teklifin para biriminde toplama eklenir.

Sınır: ek IP'ler sipariş sırasında seçilir. Çalışan bir sunucuya sonradan IP eklemek bu sürümde yok
([aşağıda](#çalışan-sunucuya-sonradan-ek-ip-neden-yok-ne-gerekir)).

## Çalışan sunucuya sonradan ek IP: neden yok, ne gerekir
2026-11-21'de incelendi ve **yazılmadı**. Hazır olanlar ve eksikler:

**Hazır olan (bugünkü kod):**
- Veri modeli sunucu başına birden çok adresi taşır: `ip_allocations` satırları `primary`, `extra`, `ipv6`
  türündedir ve hepsi aynı IP havuzundan (tek alt ağ, tek ağ geçidi) gelir.
- Silmede worker, sunucunun **bütün** adreslerini bırakır ve havuzun karantinasına alır
  (`apps/worker/operations.mjs`); PTR kayıtları adres başınadır (`apps/api/src/rdns.ts`).
- Yeniden kurulumda misafire yazılan ağ ayarı veritabanındaki bütün adreslerden üretilir; sonradan eklenen bir
  adres de ilk yeniden kurulumda kendiliğinden yazılırdı.
- İncelenen kodda (worker, firewall, adaptörler) sunucunun adreslerine bağlı bir kural ya da adres süzgeci
  görülmedi: adresler yalnızca misafire yazılan ağ ayarında kullanılır. Hipervizör tarafında yapılacak bir iş
  yoktur; bu yüzden VMware simülatöründe sınanacak bir adım da yoktur.

**Eksik olan (yazılması gereken):**
1. **Ayırma ucu:** siparişteki kilit sırasıyla (sahip, sonra konum) birincil adresin havuzundan boş, hariç
   tutulmamış, karantinada olmayan tek adres; konumun "sunucu başına en fazla ek IPv4" sınırı; aynı anda gelen iki
   isteğin aynı adresi alamaması.
2. **Faturalama (dört yerde para):** sunucunun aylık (ve saatlik) fiyatına ek IPv4 fiyatının eklenmesi, kalan
   dönemin ek disk ve boyut büyütmedeki gibi faturalanması (`resizeCharge`, `billResize`), bayi indirimi ve bayi
   payı, dış faturalama sisteminin (WISECP / WHMCS) sunucularında reddi. `servers.extra_ipv4` sayacı doğru
   tutulmazsa yenileme fiyatı (bugünkü katalogdan hesaplanır) yanlış çıkar.
3. **Geri verme ucu:** eklenebilen adres geri de verilebilmelidir; yoksa müşteri onu sunucuyu silene kadar öder.
   Geri verilen adresin karantinaya girmesi, PTR'ının silinmesi, fiyatın düşmesi ve bunun dönem içindeki karşılığı.
4. **Misafir içi yapılandırma:** panel çalışan bir sunucunun içine yazamaz (cloud-init yalnızca ilk açılışta ve
   yeniden kurulumda çalışır; misafir ajanı yoktur). Ekran, müşteriye adresi, önek uzunluğunu ve ağ geçidini verip
   Linux (netplan / `ip addr add`) ve Windows için ne yapacağını söylemek zorundadır; adres müşteri bunu yapana
   kadar faturalanır ama çalışmaz.
5. **Ekran:** sunucu sayfasında adres listesi, fiyatıyla onay isteyen ekleme, geri verme, yukarıdaki yönerge.

**Neden bu turda yazılmadı:** iş, ilk bakışta göründüğünden büyüktür (madde 2 ve 3 faturalamanın dört yoluna
dokunur ve ancak birlikte doğru olur) ve asıl sonucu, yani eklenen adresin misafirde çalışması, gerçek bir ağ
olmadan sınanamaz: simülatörde hipervizör tarafında adım yoktur, entegrasyon testleri yalnızca ayırmayı, fiyatı ve
karantinayı görebilirdi. Yarım hâliyle (adres ayrılıp faturalanırken geri verilemeyen ya da nasıl kurulacağı
söylenmeyen bir özellik) yayımlanması müşteriye para kaybettirirdi; bu yüzden hiçbiri eklenmedi.

## Doğrulama
- **Entegrasyon:** gerçek worker, VMware simülatörü ve **gerçek PowerDNS** ile denendi
  (Ubuntu `pdns-server` paketinden test imajı: `/opt/pdns-test`).
  - Ek IPv4 ve IPv6 içeren sipariş ile fiyat hesabı;
  - varsayılan PTR'ın PowerDNS'e yazılması;
  - müşteride ileri doğrulama reddi, başkasının sunucusunda 404, yöneticinin değiştirmesi;
  - silmede PTR'ın kaldırılması, karantina, sonraki siparişin karantinadaki adresi almaması ve erken serbest bırakma.
- **Gerçek bir colocation bloğunda denenmedi.** Statik IPv6 ve ek IPv4'ün konuk içinde çalışması,
  şablonun cloud-init (netplan) desteğine bağlıdır.
