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

Sınır: ek IP'ler sipariş sırasında seçilir. Çalışan bir sunucuya sonradan IP eklemek, sunucunun içinde
yapılandırma gerektirdiği için bu sürümde yok.

## Doğrulama
- **Entegrasyon:** gerçek worker, VMware simülatörü ve **gerçek PowerDNS** ile denendi
  (Ubuntu `pdns-server` paketinden test imajı: `/opt/pdns-test`).
  - Ek IPv4 ve IPv6 içeren sipariş ile fiyat hesabı;
  - varsayılan PTR'ın PowerDNS'e yazılması;
  - müşteride ileri doğrulama reddi, başkasının sunucusunda 404, yöneticinin değiştirmesi;
  - silmede PTR'ın kaldırılması, karantina, sonraki siparişin karantinadaki adresi almaması ve erken serbest bırakma.
- **Gerçek bir colocation bloğunda denenmedi.** Statik IPv6 ve ek IPv4'ün konuk içinde çalışması,
  şablonun cloud-init (netplan) desteğine bağlıdır.
