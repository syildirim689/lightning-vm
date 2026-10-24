# Plan: DiyoVM benzeri ürün

DiyoVM (diyovm.com) 2026-10-24 tarihinde incelendi: ana sayfa, "Sanal Sunucu Otomasyonu", "Özellikler"
sayfaları ve tanıtılan panel ekranları (ana sayfa, havuz listesi, şablon ekleme).

## DiyoVM'de neler var
**Yönetici paneli:**
- Koyu tema; solda menü: Ana Sayfa, vCenter, Sunucu, Plan, IP Adresi, Havuz, Görev, Şablon,
  Otomatik Sistemler, rDNS İstekleri, Ayarlar, Kayıtlar, Store, Sistem Güncellemeleri, Cronjob,
  Rehber, Lisans.
- Ana sayfada kullanılan CPU / RAM / hat kartları, en çok kullanılan planlar ve şablonlar grafikleri,
  güncelleme bildirimi ve API erişim tokeni.

**Müşteri tarafı:**
- tek tıkla işletim sistemi kurma ve format;
- yeniden başlatma, IP atama, disk genişletme;
- canlı CPU/RAM/disk grafikleri;
- HTML5 (noVNC) konsol;
- SSH anahtarı yönetimi;
- ISO kütüphanesi;
- snapshot, firewall, trafik analizi.

**İş tarafı:**
- WHMCS / WiseCP entegrasyonu;
- otomatik yaşam döngüsü: kurulum → askıya alma → iptal → silme;
- REST API;
- alt bayi (reseller) ve VDC (müşteriye kaynak havuzu);
- beyaz etiket (logo, renk, alan adı, özel CSS);
- canlı imaj yedekleme;
- içe aktarma sihirbazı (mevcut VM'leri panele alma).

**Kurulum:** anahtar teslim; müşteri teknik bilgiye ihtiyaç duymaz.

## Lightning VM'de durum
**Var (simülatörle test edildi):**
- vCenter/ESXi bağlantısı ve envanter;
- havuzlar, paketler ve özel kaynak; şablonlar (imaj); IP havuzları ve kotalar;
- otomatik oluşturma (cloud-init), güç işlemleri ve silme;
- yönetici konsolu ve müşteri konsolu;
- görev geçmişi ve uzlaştırma;
- yedek/geri yükleme ve güncelleme;
- izleme ve alarm.

**Eksik** (DiyoVM'e göre, öncelik sırasıyla):
1. **Profesyonel arayüz:** yan menülü yönetim paneli, dashboard, tutarlı tasarım sistemi.
   → bu aşamada (HeroUI v3).
2. **Tek komutla tam kurulum ve özet çıktısı.** → bu aşamada.
3. **Yeniden kurulum (format):** aynı sunucuyu seçilen şablondan yeniden oluşturma; IP ve ad korunur.
4. **Canlı metrikler:** vCenter performans sayaçlarından CPU/RAM/disk/ağ grafikleri.
5. **Disk genişletme ve paket yükseltme:** online resize ve kota/kapasite kontrolü.
6. **rDNS istekleri ve IP atama/ek IP.**
7. **API tokenları ve REST API dokümantasyonu:** OpenAPI.
8. **Fatura sistemi entegrasyonu:** WHMCS/WiseCP modülü, askıya alma, iptal, silme yaşam döngüsü.
9. **Mevcut VM'leri içe aktarma sihirbazı.**
10. **Snapshot**, ayrıca VM firewall (NSX/dvfilter yoksa host tabanlı seçenekler araştırılmalı).
11. **Beyaz etiket:** logo, renk, alan adı. Reseller ve VDC.

Her madde ayrı bir aşamadır. Her biri gerçek vCenter ile kabul testi gerektirir; simülatör yalnızca
orkestrasyonu kanıtlar.

## Bu aşamanın kapsamı
**Kurulum:** `sudo sh scripts/install.sh` her şeyi yapar ve sonunda bir özet basar.
- Docker yoksa kurar.
- Servisleri başlatır.
- HTTPS'i açar: `--domain` verilirse o alan adıyla, verilmezse sunucunun genel IPv4'ü varsa
  `<ip>.sslip.io` ile.
- İzlemeyi açar (4 GB RAM varsa), yöneticiyi oluşturur, günlük yedeği zamanlar ve ilk yedeği alır.
- **Özet:** panel adresi, yönetici e-postası ve parolası, Grafana erişimi, yedek durumu ve sıradaki adım.

**Arayüz:** HeroUI v3 ile baştan yazılır.
- Yönetici: yan menü, dashboard (kapasite, sunucular, işlemler, uyarılar), sunucular, görevler,
  bağlantılar, katalog, yedek/güncelleme, ayarlar.
- Müşteri: sunucularım, sipariş, sunucu detayı, SSH anahtarları.
- Açık/koyu tema; TR/EN.
