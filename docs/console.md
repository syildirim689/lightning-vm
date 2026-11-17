# Tarayıcı konsolu (VMware WebMKS)

## Akış
```
Tarayıcı ──POST /api/admin/vmware/connections/:id/vms/:vm/console──▶ API
  API: yönetici yetkisi + bağlantının konsol yetkisi → adaptör: VM açık mı? → AcquireTicket("webmks")
  API: bilet + host sertifika parmak izi → Redis (console:session:<sha256(token)>, 60 sn, tek kullanım)
  API ──Set-Cookie: lvm_console=<token>; Path=/console/ws; HttpOnly; SameSite=Strict; Max-Age=60──▶ Tarayıcı
Tarayıcı ──wss://<panel>/console/ws (aynı alan adı ve TLS)──▶ Caddy ──▶ console geçidi
  Geçit: Origin kontrolü → çerezdeki oturumu tüketir (GETDEL) → sınırlar
       → wss://<esxi>:443/ticket/<bilet> (yalnızca biletteki parmak iziyle eşleşen sertifika)
       → çift yönlü aktarım
```

- **Biletin gizliliği:** VMware bileti tarayıcıya hiç ulaşmaz; URL'de, API yanıtında, logda veya
  analitikte yer almaz. Tarayıcının elindeki tek şey 60 saniyelik, tek kullanımlık ve
  JavaScript'in okuyamadığı bir çerezdir. Yalnızca `/console/ws` yoluna gönderilir.
  Proxy, geçit, adaptör, API, web ve worker loglarında bilet ve çerez geçmediği kontrol edildi.
- **ESXi yönetim ağı:** tarayıcıya açılmaz. Geçit, hosta panel sunucusundan bağlanır.
- **Sertifika doğrulaması:** ESXi sertifikası, VMware'in bilet içinde (doğrulanmış API kanalı
  üzerinden) bildirdiği SHA-256/SHA-1 parmak izi veya PEM ile doğrulanır. Bilet parmak izi
  içermiyorsa bağlantı kurulmaz (`CONSOLE_TLS_UNVERIFIABLE`).
- **Adres kontrolü:** geçit de adaptörle aynı kontrolü yapar: loopback, metadata ve kendi iç ağları
  engellidir (`CONSOLE_ALLOW_NETWORKS`, `CONSOLE_DENY_NETWORKS`).
- **İşletim sistemi girişi:** konsol yalnızca VM'nin ekranını gösterir; işletim sistemi girişini
  atlamaz. Bu not konsol sayfasında da yazılıdır.

## Yetki
- **Yönetici:** yetkili olduğu bağlantılardaki açık VM'lerin konsolunu açabilir. Bağlantının servis
  hesabında `VirtualMachine.Interact.ConsoleInteract` yetkisi yoksa `CONSOLE_NOT_PERMITTED` döner.
- **Müşteri:** yalnızca kendi sunucusunun konsolunu açar (`POST /api/servers/:id/console`). Sahiplik
  backend'de kontrol edilir; sunucu kimliğini bilmek yetmez. Sunucu `ready` durumunda olmalıdır,
  ayarlarda müşteri konsolu kapatılabilir ve ödenmemiş fatura yüzünden bekletilen sunucuda `BILLING_HOLD`
  döner.
- **Normal kullanıcı:** yönetici konsol uç noktalarından `403` alır (test edildi).

## Hatalar birbirinden ayrılır
| Durum | Kod |
|---|---|
| VM kapalı | `VM_POWERED_OFF` (bilet istenmeden önce) |
| VM yok | `VM_NOT_FOUND` |
| Geçit hosta ulaşamıyor (ağ) | `CONSOLE_UNREACHABLE` |
| Host sertifikası biletle uyuşmuyor | `CONSOLE_TLS_MISMATCH` |
| Host bileti reddetti | `CONSOLE_TICKET_REJECTED` |
| Oturum geçersiz, süresi dolmuş veya kullanılmış | `CONSOLE_SESSION_INVALID` |
| Kapatıldı (çıkış, yönetici veya geçidin durması), ya da bilet bir iptalden önce alınmış | `CONSOLE_REVOKED` (host terminalinde `TERMINAL_REVOKED`) |
| En uzun süre doldu | `CONSOLE_EXPIRED` |
| Eşzamanlı konsol sınırı | `CONSOLE_LIMIT` |

Geçit bu kodları WebSocket kapanış nedeni olarak gönderir (4401, 4403, 4408, 4429, 4502, 4503);
arayüz bunları çevirerek gösterir.

## Oturum iptali ve sınırlar
- **Çıkış:** panelden çıkış yapınca o oturumla açılmış bütün konsollar hemen kapanır
  (Redis `console:revoke` kanalı üzerinden).
- **Yönetici:** Yönetim → VMware sayfasındaki "Açık konsollar" listesinden herhangi bir konsolu
  kapatabilir.
- **Hesap değişince:** yönetici bir kullanıcıyı yasaklar, siler, oturumlarını kapatır veya parolasını
  değiştirirse o kullanıcının açık konsolları da kapanır. Kullanıcının erişimi daraldığında, sunucu başka hesaba
  geçtiğinde (önceki sahibin konsolları) ve "kullanıcı adına" oturum sona erdiğinde de kapanır.
- **İptalden önce alınmış biletler:** iptal yalnızca açık bağlantıları kapatmaz; **henüz kullanılmamış** biletleri de
  geçersiz kılar. API, her iptalde Redis'e kısa ömürlü bir işaret bırakır (kullanıcı, oturum ya da sunucu için);
  bilet de alındığı anı taşır. Geçit, bileti kabul ederken bu işaretlere bakar ve işaretten **önce** alınmış bir
  bileti reddeder (`CONSOLE_REVOKED`, host terminalinde `TERMINAL_REVOKED`). Böylece devirden, çıkıştan ya da
  yasaklamadan saniyeler önce alınmış bir bilet sonradan oturum açamaz; işaret Redis'te durduğu için geçidin o anda
  yeniden bağlanıyor olması da bunu değiştirmez. Kişi konsolu yeniden açarak yeni bir bilet alır.
- **En uzun süre:** varsayılan 60 dakika (`CONSOLE_MAX_MINUTES`). Süre dolunca konsol yeniden
  açılabilir ve yeni bir bilet alınır.
- **Eşzamanlı konsol sınırı:** kullanıcı başına 3 (`CONSOLE_MAX_PER_USER`), toplamda 100.
- **Origin:** sayfanın origin'i, bağlanılan host ile aynı olmalıdır. Başka bir siteden açılan
  WebSocket, bağlantı yükseltilmeden önce `403` ile reddedilir. HTTPS ile sunulan panel `http://` origin'ini kabul
  etmez. Ek origin'ler `.env` içindeki `CONSOLE_ALLOWED_ORIGINS` ile verilir (virgülle ayrılmış,
  `https://host[:port]` biçiminde; bu biçime uymayan girdi yok sayılır ve günlüğe `allowed_origin_ignored` yazılır).
- **Denetim kaydı:** oturum verilmesi `console.session_issued` olarak API tarafından yazılır. Geçidin
  olayları (`opened`, `closed` ve süresi, `denied`, `failed`) Redis akışı `console:events`
  üzerinden worker tarafından `audit_events` tablosuna aktarılır. Bilinmeyen bir biletle gelen (kimliği belirsiz)
  istekler için dakikada en çok 5 `console.denied` / `terminal.denied` olayı yazılır; bastırılanların sayısı olayda
  taşınır.

Bilinen sınır: kullanıcı başına sınır ve iptal, tek bir geçit örneği için tasarlandı. Birden fazla
geçit örneği çalıştırmak için ortak bir sayaç gerekir.

## VMware HTML Console SDK (kurulumu yapan kişi sağlar)
Ekranı çizen istemci VMware'in HTML Console SDK'sıdır (`wmks.min.js`).
- **Lisans:** Broadcom geliştirici portalından Broadcom hesabıyla indirilir. Yayın notları yeniden
  dağıtım izni belirtmediği için bu projeyle **dağıtılmaz**. Kurmadan önce SDK'nın kendi lisansını
  okuyun.
- **Dosyalar:** `console-sdk/` klasörüne konur ve Caddy bunları `/console-sdk/` altında sunar:
  ```
  console-sdk/wmks.min.js
  console-sdk/css/wmks-all.css   (SDK'daki css/ ve img/ klasörleriyle)
  console-sdk/jquery.min.js      (SDK belgesinin belirttiği sürüm)
  console-sdk/jquery-ui.min.js   (SDK belgesinin belirttiği sürüm)
  ```
- **SDK yoksa:** konsol sayfası bunu açıkça gösterir.
- **Geçit testi:** SDK olmadan da konsol sayfasındaki "Geçit bağlantısını test et" düğmesi çalışır.
  Taze bir oturum alır, geçit üzerinden VM'nin konsol ucuna bağlanır ve veri gelip gelmediğini
  bildirir. Bu test ağ yolunu, sertifika sabitlemesini ve bileti doğrular; ekranın çizildiğini
  doğrulamaz.
- **SDK kullanımı:** sayfa SDK'yı programlama kılavuzundaki örneğe göre kullanır: `WMKS.createWMKS`,
  `CONNECTION_STATE_CHANGE` olayı, `connect(url)` ve `sendCAD()`. Bu entegrasyon gerçek SDK ile
  **denenmedi**.

## Reverse proxy ve HTTPS
Konsol, panel ile aynı alan adı ve aynı sertifikayla `wss://<panel>/console/ws` üzerinden çalışır.
- **Caddy:** WebSocket'i kendiliğinden aktarır.
- **Önde başka bir proxy varsa:** `Upgrade`/`Connection` başlıklarını iletmesi ve uzun okuma süresi
  tanıması gerekir (docs/domain-https.md'deki Nginx örneği).
- **Test:** gerçek Let's Encrypt sertifikasıyla Caddy arkasından, tarayıcıdan test edildi
  (docs/validation.md).

## Test ortamı
Simülatör AcquireTicket'ı desteklemez ve konsol ekranı yoktur. Teste özel simülatör
(`compose.simulator.yaml`) şu ikisini ekler:
- bilet döndüren bir VM;
- `172.29.250.10:8443` adresinde, kendi sertifikasıyla çalışan ve "fake-webmks" diye selam verip
  gelen her şeyi geri yollayan bir TLS WebSocket ucu.

Bu, VMware'in konsol protokolü değildir; zinciri (API → adaptör → geçit → host) doğrular, ekranı değil.

## Gerçek ortam kabul testleri (henüz yapılmadı)
1. ESXi 7/8 ve vCenter 7/8 üzerinde `AcquireTicket("webmks")` hangi host adını, portu ve parmak izi
   türlerini döndürüyor? `url` alanı dolu mu?
2. Geçit vCenter'daki bir VM için doğru ESXi hostuna, sertifika sabitlemesiyle bağlanıyor mu?
3. Gerçek SDK ile ekran görünüyor mu? Klavye/fare, Ctrl+Alt+Del ve yeniden boyutlandırma çalışıyor mu?
4. Kapalı VM'de `VM_POWERED_OFF`, yönetim ağı kapalıyken `CONSOLE_UNREACHABLE` görünüyor mu?
5. Biletin ESXi tarafındaki geçerlilik süresi ve tek kullanımlığı nasıl?
6. Çıkış yapınca ve yönetici kapattığında açık konsol hemen kapanıyor mu?
7. Nginx/Cloudflare arkasında WebSocket ve uzun süren oturumlar sorunsuz mu?
