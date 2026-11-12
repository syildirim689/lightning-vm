import type { Text } from './types';

// Groups of the API reference, in the order they are shown and printed.
export const tags: Record<string, { name: Text; text: Text }> = {
  servers: { name: { tr: 'Sunucular', en: 'Servers' }, text: { tr: 'Sipariş, güç, yeniden kurulum, boyut değiştirme, silme ve sunucu ayrıntıları.', en: 'Ordering, power, reinstall, resize, delete and server details.' } },
  'server-data': { name: { tr: 'Anlık görüntü, yedek ve disk', en: 'Snapshots, backups and disks' }, text: { tr: 'Sunucunun anlık görüntüleri, yedekleri, ek diskleri ve ISO\'ları.', en: 'A server\'s snapshots, backups, extra disks and ISOs.' } },
  operations: { name: { tr: 'İşlemler ve zamanlamalar', en: 'Operations and schedules' }, text: { tr: 'Arka planda süren işlemler, güç zamanlamaları, devir ve konsol.', en: 'Background operations, power schedules, transfers and consoles.' } },
  catalog: { name: { tr: 'Katalog ve sipariş', en: 'Catalog and ordering' }, text: { tr: 'Paketler, konumlar, imajlar, uygulamalar ve fiyat teklifi.', en: 'Packages, locations, images, applications and quotes.' } },
  network: { name: { tr: 'Ağ', en: 'Networking' }, text: { tr: 'Firewall\'lar, özel ağlar, IP adresleri ve ters DNS.', en: 'Firewalls, private networks, IP addresses and reverse DNS.' } },
  vdc: { name: { tr: 'Sanal veri merkezi', en: 'Virtual data center' }, text: { tr: 'Ayrılmış kaynak havuzundan sunucu oluşturma.', en: 'Servers from a reserved pool of resources.' } },
  billing: { name: { tr: 'Faturalama', en: 'Billing' }, text: { tr: 'Faturalar, abonelikler, ödemeler, bakiye ve itirazlar.', en: 'Invoices, subscriptions, payments, balance and disputes.' } },
  support: { name: { tr: 'Destek', en: 'Support' }, text: { tr: 'Destek talepleri, mesajlar ve ekler.', en: 'Support tickets, messages and attachments.' } },
  account: { name: { tr: 'Hesap', en: 'Account' }, text: { tr: 'Profil, oturumlar, bildirimler, API anahtarları ve webhook\'lar.', en: 'Profile, sessions, notifications, API tokens and webhooks.' } },
  insights: { name: { tr: 'Öneriler ve durum', en: 'Insights and status' }, text: { tr: 'Akıllı öneriler, kullanım özeti, duyurular ve durum sayfası.', en: 'Smart suggestions, usage summary, announcements and the status page.' } },
  reseller: { name: { tr: 'Bayilik', en: 'Reselling' }, text: { tr: 'Bayinin müşterileri, fiyatları ve markası.', en: 'A reseller\'s customers, prices and brand.' } },
  'admin-servers': { name: { tr: 'Yönetim: sunucular', en: 'Admin: servers' }, text: { tr: 'Tüm müşterilerin sunucuları, işlemler, uzlaştırma ve yerleşim.', en: 'Every customer\'s servers, operations, reconciliation and placement.' } },
  'admin-vmware': { name: { tr: 'Yönetim: VMware', en: 'Admin: VMware' }, text: { tr: 'ESXi / vCenter bağlantıları, envanter, ağ taraması ve topoloji.', en: 'ESXi / vCenter connections, inventory, network scans and topology.' } },
  'admin-catalog': { name: { tr: 'Yönetim: katalog', en: 'Admin: catalog' }, text: { tr: 'Konumlar, kaynak ve IP havuzları, paketler, imajlar, ISO\'lar, uygulamalar.', en: 'Locations, resource and IP pools, packages, images, ISOs, applications.' } },
  'admin-billing': { name: { tr: 'Yönetim: faturalama', en: 'Admin: billing' }, text: { tr: 'Faturalar, tahsilat, kuponlar, itirazlar, ödeme ve e-fatura ayarları.', en: 'Invoices, collection, coupons, disputes, payment and e-invoice settings.' } },
  'admin-users': { name: { tr: 'Yönetim: kullanıcılar ve roller', en: 'Admin: users and roles' }, text: { tr: 'Kullanıcılar, roller, yetkiler, bayiler ve denetim kaydı.', en: 'Users, roles, permissions, resellers and the audit log.' } },
  'admin-settings': { name: { tr: 'Yönetim: ayarlar', en: 'Admin: settings' }, text: { tr: 'Genel, e-posta, SMS, giriş, bildirim, sohbet, dizin ve diğer ayarlar.', en: 'General, mail, SMS, sign-in, notification, chat, directory and other settings.' } },
  'admin-system': { name: { tr: 'Yönetim: sistem', en: 'Admin: system' }, text: { tr: 'Sistem durumu, bakım, enerji, kötüye kullanım, olaylar ve istatistik.', en: 'System state, maintenance, energy, abuse, incidents and statistics.' } },
  'admin-support': { name: { tr: 'Yönetim: destek', en: 'Admin: support' }, text: { tr: 'Tüm talepler, atama, kalıp yanıtlar ve destek kuralları.', en: 'All tickets, assignment, canned replies and support rules.' } },
  internal: { name: { tr: 'Panelin iç kullanımı', en: 'Used by the panel itself' }, text: { tr: 'Kurulum sihirbazı, sağlayıcı geri çağrıları, canlı akış ve sağlık denetimleri. Entegrasyonlar için değildir.', en: 'Setup wizard, provider callbacks, live stream and health probes. Not meant for integrations.' } },
};
