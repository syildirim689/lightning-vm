// Notifications (no HTTP here; the controllers are in notifications.ts): one catalog of events, four channels (in-app inbox, browser push, e-mail, SMS).
// The admin decides per event which channels exist, the defaults and whether users may change them;
// users then choose within that (Account → Notifications). Every new feature that informs someone
// adds its event here. The API and the worker only enqueue; the consumer below delivers.
import { Queue, Worker } from 'bullmq';
import webpush from 'web-push';
import { pool, redis } from './db';
import { logEvent } from './log';
import { queueWebhooks } from './webhooks';
import { can, permissionsOf, type Permission } from './permissions';
import { decryptSecret, encryptSecret } from './secrets';
import { getSettings, mailReady, saveSettings, sendMail, type Channel, type NotificationPolicy } from './settings-store';
import { sendSms, smsReady } from './sms';
import { absolute, deliverChat } from './chat-delivery';
import { brandFor } from './mail';
import { mailHtml, mailText, type MailContent, type Tone } from './mail-layout';
import { publishLive } from './live-bus';
import { alwaysSent, inQuietHours, loudChannels } from './quiet-hours';

export type Text = { title: string; body: string };
type EventDef = {
  audience: 'user' | 'staff';
  permission?: Permission; // staff events: who receives them
  channels: Channel[];     // channels that make sense for this event
  defaults: Channel[];
  link?: (d: Record<string, string>) => string;
  text: { tr: (d: Record<string, string>) => Text; en: (d: Record<string, string>) => Text };
};

export const all: Channel[] = ['inApp', 'push', 'email', 'sms', 'chat'];
export const catalog: Record<string, EventDef> = {
  'server.ready': { audience: 'user', channels: all, defaults: ['inApp', 'push', 'email'], link: (d) => `/servers/${d.serverId}`,
    text: { tr: (d) => ({ title: `${d.name} hazır`, body: `Sunucunuz kuruldu ve çalışıyor. IP: ${d.address || '-'}` }),
      en: (d) => ({ title: `${d.name} is ready`, body: `Your server is set up and running. IP: ${d.address || '-'}` }) } },
  'server.failed': { audience: 'user', channels: all, defaults: ['inApp', 'push', 'email'], link: (d) => `/servers/${d.serverId}`,
    text: { tr: (d) => ({ title: `${d.name}: işlem başarısız`, body: `${d.kind} işlemi tamamlanamadı (${d.code}).` }),
      en: (d) => ({ title: `${d.name}: operation failed`, body: `The ${d.kind} operation could not finish (${d.code}).` }) } },
  'server.deleted': { audience: 'user', channels: ['inApp', 'push', 'email', 'chat'], defaults: ['inApp'],
    text: { tr: (d) => ({ title: `${d.name} silindi`, body: 'Sunucu ve diskleri kaldırıldı; IP adresi serbest bırakıldı.' }),
      en: (d) => ({ title: `${d.name} deleted`, body: 'The server and its disks were removed; its IP address was released.' }) } },
  'server.delete_scheduled': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: (d) => `/servers/${d.serverId}`,
    text: { tr: (d) => d.reminder ? { title: `${d.name} yakında silinecek`, body: `Geri alma süresi yaklaşık ${d.minutes} dakika sonra bitiyor; sunucu ve diskleri kalıcı olarak silinecek. Tutmak istiyorsanız sunucu sayfasından geri alın.` }
        : { title: `${d.name} silinmek üzere`, body: `Sunucu kapatıldı ve ${d.hours} saat sonra silinecek. O zamana kadar sunucu sayfasından geri alabilirsiniz.` },
      en: (d) => d.reminder ? { title: `${d.name} will be deleted soon`, body: `The grace period ends in about ${d.minutes} minutes; the server and its disks will be deleted for good. Take it back on its page to keep it.` }
        : { title: `${d.name} is about to be deleted`, body: `The server was shut down and will be deleted in ${d.hours} hours. Until then you can take it back on its page.` } } },
  'server.power': { audience: 'user', channels: ['inApp', 'push', 'chat'], defaults: ['inApp'], link: (d) => `/servers/${d.serverId}`,
    text: { tr: (d) => d.kind === 'resize' ? { title: `${d.name}: kaynaklar değiştirildi`, body: 'İşlemci, bellek ve disk yeni değerlerinde.' } : { title: `${d.name}: ${d.kind} tamamlandı`, body: 'Güç işlemi tamamlandı.' },
      en: (d) => d.kind === 'resize' ? { title: `${d.name}: resources changed`, body: 'CPU, memory and disk are at their new values.' } : { title: `${d.name}: ${d.kind} done`, body: 'The power operation finished.' } } },
  'server.traffic': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: (d) => `/servers/${d.serverId}`,
    text: { tr: (d) => ({ title: d.level === '100' ? `${d.name}: aylık trafik kotası doldu` : `${d.name}: aylık trafiğin %80'i kullanıldı`, body: `Bu ay ${d.usedGb} GB / ${d.allowanceGb} GB (gelen ve giden).${d.throttled ? ` Hız ay sonuna kadar ${d.throttled} Mbit/s ile sınırlandı; daha büyük bir pakete geçerek kaldırabilirsiniz.` : ''}` }),
      en: (d) => ({ title: d.level === '100' ? `${d.name}: monthly traffic used up` : `${d.name}: 80% of the monthly traffic used`, body: `${d.usedGb} GB of ${d.allowanceGb} GB this month (in and out).${d.throttled ? ` Speed is limited to ${d.throttled} Mbit/s until the month ends; a bigger package lifts it.` : ''}` }) } },
  'server.backup': { audience: 'user', channels: ['inApp', 'push', 'email', 'chat'], defaults: ['inApp'], link: (d) => `/servers/${d.serverId}`,
    text: { tr: (d) => ({ title: `${d.name}: yedek ${({ backup_create: 'alındı', backup_restore: 'geri yüklendi', backup_delete: 'silindi' } as Record<string, string>)[String(d.kind)] ?? 'işlendi'}`, body: d.kind === 'backup_restore' ? 'Disk yedekteki haline döndü.' : '' }),
      en: (d) => ({ title: `${d.name}: backup ${({ backup_create: 'taken', backup_restore: 'restored', backup_delete: 'removed' } as Record<string, string>)[String(d.kind)] ?? 'done'}`, body: d.kind === 'backup_restore' ? 'The disk is back as it was in the backup.' : '' }) } },
  'server.transfer': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: (d) => d.step === 'offered' ? '/account?tab=transfers' : `/servers/${d.serverId}`,
    text: { tr: (d) => ({ title: `${d.name}: ${({ offered: 'size devredilmek isteniyor', accepted: 'devir kabul edildi', declined: 'devir reddedildi', moved: 'sahibi değişti' } as Record<string, string>)[String(d.step)] ?? 'devir'}`,
        body: d.step === 'offered' ? `${d.email} bu sunucuyu hesabınıza devretmek istiyor. Teklif 7 gün açık.` : d.step === 'moved' ? `Sunucu ekibimiz tarafından ${d.email} hesabına taşındı.` : `${d.email}` }),
      en: (d) => ({ title: `${d.name}: ${({ offered: 'offered to you', accepted: 'handover accepted', declined: 'handover declined', moved: 'owner changed' } as Record<string, string>)[String(d.step)] ?? 'handover'}`,
        body: d.step === 'offered' ? `${d.email} wants to hand this server to your account. The offer is open for 7 days.` : d.step === 'moved' ? `Our team moved the server to ${d.email}.` : `${d.email}` }) } },
  'server.snapshot': { audience: 'user', channels: ['inApp', 'push', 'email', 'chat'], defaults: ['inApp'], link: (d) => `/servers/${d.serverId}`,
    text: { tr: (d) => ({ title: `${d.name}: anlık görüntü ${({ snapshot_create: 'alındı', snapshot_revert: 'geri yüklendi', snapshot_delete: 'silindi' } as Record<string, string>)[String(d.kind)] ?? 'işlendi'}`, body: String(d.snapshot ?? '') }),
      en: (d) => ({ title: `${d.name}: snapshot ${({ snapshot_create: 'taken', snapshot_revert: 'restored', snapshot_delete: 'removed' } as Record<string, string>)[String(d.kind)] ?? 'done'}`, body: String(d.snapshot ?? '') }) } },
  'server.firewall_failed': { audience: 'user', channels: all, defaults: ['inApp', 'push', 'email'], link: (d) => `/servers/${d.serverId}`,
    text: { tr: (d) => ({ title: `${d.name}: firewall uygulanamadı`, body: `Kurallar sunucuya yazılamadı (${d.code}). Önceki kurallar geçerli olabilir.` }),
      en: (d) => ({ title: `${d.name}: firewall not applied`, body: `The rules could not be written to the server (${d.code}). Earlier rules may still apply.` }) } },
  'server.app_installed': { audience: 'user', channels: all, defaults: ['inApp', 'push', 'email'], link: (d) => '/servers/' + d.serverId,
    text: { tr: (d) => ({ title: d.name + ': uygulama kuruldu', body: 'Seçtiğiniz uygulamanın kurulumu tamamlandı.' }),
      en: (d) => ({ title: d.name + ': application installed', body: 'The application you chose has been installed.' }) } },
  'server.app_failed': { audience: 'user', channels: all, defaults: ['inApp', 'push', 'email'], link: (d) => '/servers/' + d.serverId,
    text: { tr: (d) => ({ title: d.name + ': uygulama kurulamadı', body: 'Kurulum başarısız oldu (' + (d.message || '-') + '). Ayrıntı sunucuda /var/log/lightning-app.log dosyasında.' }),
      en: (d) => ({ title: d.name + ': application not installed', body: 'The installation failed (' + (d.message || '-') + '). Details on the server in /var/log/lightning-app.log.' }) } },
  'billing.budget_exceeded': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: () => '/',
    text: { tr: (d) => ({ title: 'Aylık bütçeniz aşıldı', body: `Sunucularınızın aylık tutarı ${d.monthly} ${d.currency}; belirlediğiniz bütçe ${d.amount} ${d.currency}.` }),
      en: (d) => ({ title: 'Your monthly budget is exceeded', body: `Your servers cost ${d.monthly} ${d.currency} a month; your budget is ${d.amount} ${d.currency}.` }) } },
  'support.reply': { audience: 'user', channels: all, defaults: ['inApp', 'email', 'push'], link: (d) => '/support/' + d.ticketId,
    text: { tr: (d) => ({ title: 'Destek talebinize yanıt geldi', body: '#' + d.number + ' · ' + d.subject }), en: (d) => ({ title: 'Your support ticket has a reply', body: '#' + d.number + ' · ' + d.subject }) } },
  'support.rate': { audience: 'user', channels: ['inApp', 'email', 'push', 'chat'], defaults: ['inApp', 'email'], link: (d) => '/support/' + d.ticketId,
    text: { tr: (d) => ({ title: 'Destek talebiniz kapandı: #' + d.number, body: d.subject + ' · Desteği nasıl buldunuz? 1–5 arası puan verin.' }),
      en: (d) => ({ title: 'Your support ticket is closed: #' + d.number, body: d.subject + ' · How did we do? Rate it from 1 to 5.' }) } },
  'support.overdue': { audience: 'staff', permission: 'support.view', channels: all, defaults: ['inApp', 'push'], link: (d) => '/admin/support/' + d.ticketId,
    text: { tr: (d) => ({ title: 'Süresi geçti: #' + d.number, body: d.subject + ' · yanıt süresi doldu' }), en: (d) => ({ title: 'Past its deadline: #' + d.number, body: d.subject + ' · the response time is over' }) } },
  'support.low_rating': { audience: 'staff', permission: 'support.view', channels: all, defaults: ['inApp', 'email'], link: (d) => '/admin/support/' + d.ticketId,
    text: { tr: (d) => ({ title: 'Düşük puan: #' + d.number + ' · ' + d.rating + '/5', body: d.subject + (d.comment ? ' · “' + d.comment.slice(0, 140) + '”' : '') }),
      en: (d) => ({ title: 'Low rating: #' + d.number + ' · ' + d.rating + '/5', body: d.subject + (d.comment ? ' · “' + d.comment.slice(0, 140) + '”' : '') }) } },
  'support.ticket_opened': { audience: 'staff', permission: 'support.view', channels: all, defaults: ['inApp', 'push'], link: (d) => '/admin/support/' + d.ticketId,
    text: { tr: (d) => ({ title: 'Yeni destek talebi #' + d.number, body: d.subject + ' · ' + d.email + ' · ' + d.priority }), en: (d) => ({ title: 'New support ticket #' + d.number, body: d.subject + ' · ' + d.email + ' · ' + d.priority }) } },
  'support.customer_message': { audience: 'staff', permission: 'support.view', channels: all, defaults: ['inApp', 'push'], link: (d) => '/admin/support/' + d.ticketId,
    text: { tr: (d) => ({ title: 'Müşteri yazdı: #' + d.number, body: d.subject + ' · ' + d.email }), en: (d) => ({ title: 'Customer wrote: #' + d.number, body: d.subject + ' · ' + d.email }) } },
  'support.assigned': { audience: 'staff', permission: 'support.view', channels: all, defaults: ['inApp', 'push'], link: (d) => '/admin/support/' + d.ticketId,
    text: { tr: (d) => ({ title: 'Size bir talep atandı: #' + d.number, body: d.subject }), en: (d) => ({ title: 'A ticket was assigned to you: #' + d.number, body: d.subject }) } },
  // Every sign-in goes to the inbox; one from a device and network not seen in 90 days is announced loudly.
  'auth.new_device': { audience: 'user', channels: all, defaults: ['inApp', 'email', 'push'], link: () => '/account?tab=security',
    text: { tr: (d) => ({ title: 'Yeni bir cihazdan giriş', body: `${d.device} · IP ${d.ip || '-'}. Siz değilseniz hemen parolanızı değiştirin ve oturumları kapatın.` }),
      en: (d) => ({ title: 'Sign-in from a new device', body: `${d.device} · IP ${d.ip || '-'}. If this was not you, change your password and end your sessions now.` }) } },
  'auth.sign_in': { audience: 'user', channels: all, defaults: ['inApp'], link: () => '/account?tab=security',
    text: { tr: (d) => ({ title: 'Hesabınıza yeni giriş', body: `IP ${d.ip || '-'} · ${d.agent?.slice(0, 80) || '-'}. Siz değilseniz parolanızı değiştirin.` }),
      en: (d) => ({ title: 'New sign-in to your account', body: `IP ${d.ip || '-'} · ${d.agent?.slice(0, 80) || '-'}. If this was not you, change your password.` }) } },
  // Billing (billing.ts): a new invoice, paid, a failed payment, reminders, overdue, suspension, termination, a refund.
  'billing.invoice': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: (d) => '/billing/invoices/' + d.invoiceId,
    text: { tr: (d) => ({ title: 'Yeni fatura: ' + d.total + ' ' + d.currency, body: 'Son ödeme günü ' + d.due + '. Otomatik ödeme açıksa bakiyenizden ya da kayıtlı kartınızdan çekilir.' }),
      en: (d) => ({ title: 'New invoice: ' + d.total + ' ' + d.currency, body: 'Due on ' + d.due + '. With automatic payment it is taken from your balance or saved card.' }) } },
  'billing.paid': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: (d) => '/billing/invoices/' + d.invoiceId,
    text: { tr: (d) => ({ title: 'Ödemeniz alındı: ' + d.total + ' ' + d.currency, body: 'Faturanız düzenlendi' + (d.number ? ' (' + d.number + ')' : '') + '. Teşekkür ederiz.' }),
      en: (d) => ({ title: 'Payment received: ' + d.total + ' ' + d.currency, body: 'Your invoice is issued' + (d.number ? ' (' + d.number + ')' : '') + '. Thank you.' }) } },
  'billing.payment_failed': { audience: 'user', channels: all, defaults: ['inApp', 'email', 'push'], link: (d) => '/billing/invoices/' + d.invoiceId,
    text: { tr: (d) => ({ title: 'Ödeme alınamadı', body: d.amount + ' ' + d.currency + ' çekilemedi (' + d.code + '). Fatura ödeme bekliyor; başka bir kartla ya da bakiyeyle ödeyebilirsiniz.' }),
      en: (d) => ({ title: 'Payment failed', body: d.amount + ' ' + d.currency + ' could not be charged (' + d.code + '). The invoice awaits payment; pay with another card or your balance.' }) } },
  'billing.reminder': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: (d) => '/billing/invoices/' + d.invoiceId,
    text: { tr: (d) => ({ title: 'Ödeme hatırlatması', body: d.total + ' ' + d.currency + ' tutarındaki faturanın son ödeme günü ' + d.due + '.' }),
      en: (d) => ({ title: 'Payment reminder', body: 'Your invoice of ' + d.total + ' ' + d.currency + ' is due on ' + d.due + '.' }) } },
  'billing.overdue': { audience: 'user', channels: all, defaults: ['inApp', 'email', 'push', 'sms'], link: (d) => '/billing/invoices/' + d.invoiceId,
    text: { tr: (d) => ({ title: 'Ödemesi geciken fatura', body: d.total + ' ' + d.currency + ' ödenmedi. ' + d.days + ' gün içinde ödenmezse hizmet askıya alınır.' }),
      en: (d) => ({ title: 'Invoice overdue', body: d.total + ' ' + d.currency + ' is unpaid. Service is suspended if not paid within ' + d.days + ' days.' }) } },
  'billing.suspended': { audience: 'user', channels: all, defaults: ['inApp', 'email', 'push', 'sms'], link: (d) => '/billing/invoices/' + d.invoiceId,
    text: { tr: (d) => ({ title: 'Hizmet askıya alındı', body: 'Ödenmeyen fatura nedeniyle sunucunuz kapatıldı ve kilitlendi. Ödeme yapıldığında hemen açılır.' + (d.days !== '0' ? ' ' + d.days + ' gün içinde ödenmezse silinir.' : '') }),
      en: (d) => ({ title: 'Service suspended', body: 'Your server was shut down and held for an unpaid invoice. It starts again as soon as it is paid.' + (d.days !== '0' ? ' Unpaid after ' + d.days + ' days it is deleted.' : '') }) } },
  'billing.dispute_opened': { audience: 'staff', permission: 'billing.manage', channels: all, defaults: ['inApp', 'email'], link: () => '/admin/billing?tab=disputes',
    text: { tr: (d) => ({ title: `Fatura itirazı #${d.number}`, body: `${d.email}: ${d.invoice} için ${d.amount} ${d.currency}` }),
      en: (d) => ({ title: `Invoice dispute #${d.number}`, body: `${d.email}: ${d.amount} ${d.currency} on ${d.invoice}` }) } },
  'billing.dispute_overdue': { audience: 'staff', permission: 'billing.manage', channels: all, defaults: ['inApp', 'email', 'push'], link: () => '/admin/billing?tab=disputes',
    text: { tr: (d) => ({ title: `İtiraz #${d.number} için karar süresi geçti`, body: `${d.amount} ${d.currency}; müşteri karar bekliyor.` }),
      en: (d) => ({ title: `Dispute #${d.number} is past its decision date`, body: `${d.amount} ${d.currency}; the customer is waiting for a decision.` }) } },
  'billing.dispute_update': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: () => '/billing?tab=disputes',
    text: { tr: (d) => ({ title: `İtiraz #${d.number}: ${({ under_review: 'incelemede', accepted: 'kabul edildi', partially_accepted: 'kısmen kabul edildi', rejected: 'reddedildi' } as Record<string, string>)[String(d.status)] ?? String(d.status)}`,
        body: d.amount ? `${d.amount} ${d.currency} ${({ balance: 'bakiyenize eklendi', refund: 'kartınıza iade edildi', cancel: 'tutarındaki fatura geri çekildi' } as Record<string, string>)[String(d.remedy)] ?? ''}.` : d.status === 'under_review' ? 'Ekibimiz itirazınızı inceliyor.' : 'Ayrıntılar destek talebinde.' }),
      en: (d) => ({ title: `Dispute #${d.number}: ${({ under_review: 'in review', accepted: 'accepted', partially_accepted: 'partly accepted', rejected: 'rejected' } as Record<string, string>)[String(d.status)] ?? String(d.status)}`,
        body: d.amount ? `${d.amount} ${d.currency} ${({ balance: 'added to your balance', refund: 'refunded to your card', cancel: 'invoice withdrawn' } as Record<string, string>)[String(d.remedy)] ?? ''}.` : d.status === 'under_review' ? 'Our team is looking into your dispute.' : 'The details are in the support ticket.' }) } },
  'billing.balance_low': { audience: 'user', channels: all, defaults: ['inApp', 'email', 'push'], link: () => '/billing?tab=balance',
    text: { tr: (d) => ({ title: 'Bakiyeniz azalıyor', body: `Kullanılabilir bakiye ${d.amount} ${d.currency}; saatlik sunucularınız yaklaşık ${d.hours} saat daha çalışır. Kesinti olmaması için bakiye yükleyin.` }),
      en: (d) => ({ title: 'Your balance is running low', body: `${d.amount} ${d.currency} left to spend; your hourly servers run about ${d.hours} more hours. Top up to avoid a stop.` }) } },
  'billing.hourly_hold': { audience: 'user', channels: all, defaults: ['inApp', 'email', 'push', 'sms'], link: () => '/billing?tab=balance',
    text: { tr: (d) => ({ title: 'Bakiye bitti: saatlik sunucular durduruldu', body: `Kullanılabilir bakiye ${d.amount} ${d.currency}. Bakiye yüklediğinizde sunucular kendiliğinden yeniden açılır.` }),
      en: (d) => ({ title: 'Balance used up: hourly servers stopped', body: `${d.amount} ${d.currency} left. Your servers start again by themselves once you top up.` }) } },
  'billing.terminated': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: () => '/billing',
    text: { tr: () => ({ title: 'Hizmet sonlandırıldı', body: 'Ödenmeyen fatura nedeniyle hizmetiniz sonlandırıldı ve sunucu silindi.' }),
      en: () => ({ title: 'Service terminated', body: 'Your service was terminated for an unpaid invoice and the server deleted.' }) } },
  'billing.refunded': { audience: 'user', channels: ['inApp', 'email', 'push', 'chat'], defaults: ['inApp', 'email'], link: (d) => '/billing/invoices/' + d.invoiceId,
    text: { tr: (d) => ({ title: 'İade yapıldı: ' + d.amount + ' ' + d.currency, body: 'İade tutarı kartınıza ya da bakiyenize aktarıldı.' }),
      en: (d) => ({ title: 'Refunded: ' + d.amount + ' ' + d.currency, body: 'The amount went back to your card or balance.' }) } },
  'billing.payment_received': { audience: 'staff', permission: 'billing.view', channels: all, defaults: ['inApp'], link: (d) => '/admin/billing/invoices/' + d.invoiceId,
    text: { tr: (d) => ({ title: 'Ödeme alındı: ' + d.total + ' ' + d.currency, body: (d.number || 'Bakiye') + ' · ' + d.email }),
      en: (d) => ({ title: 'Payment received: ' + d.total + ' ' + d.currency, body: (d.number || 'Balance') + ' · ' + d.email }) } },
  'billing.einvoice_failed': { audience: 'staff', permission: 'billing.view', channels: all, defaults: ['inApp', 'email'], link: (d) => '/admin/billing/invoices/' + d.invoiceId,
    text: { tr: (d) => ({ title: 'e-Fatura gönderilemedi' + (d.number ? ': ' + d.number : ''), body: d.error }), en: (d) => ({ title: 'e-Invoice not sent' + (d.number ? ': ' + d.number : ''), body: d.error }) } },
  'billing.einvoice_return': { audience: 'staff', permission: 'billing.view', channels: all, defaults: ['inApp', 'email'], link: (d) => '/admin/billing/invoices/' + d.invoiceId,
    text: { tr: (d) => ({ title: 'İade faturası gerekiyor: ' + d.number, body: d.amount + ' ' + d.currency + ' iade edildi. ' + (d.who === 'buyer' ? 'e-Fatura alıcısı iade faturasını size kesmeli.' : 'e-Arşiv faturası iptal süresini geçti; iade için muhasebenizle iade faturası düzenleyin.') + (d.reason ? ' (' + d.reason + ')' : '') }),
      en: (d) => ({ title: 'Return invoice needed: ' + d.number, body: d.amount + ' ' + d.currency + ' was refunded. ' + (d.who === 'buyer' ? 'The e-Fatura buyer must issue the return invoice to you.' : 'The e-Arşiv invoice is past its cancel window; issue a return invoice with your accountant.') + (d.reason ? ' (' + d.reason + ')' : '') }) } },
  // A message staff send to people picked from the users list (admin.ts, users/actions); same words in every language.
  'account.api_token_created': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: () => '/account?tab=api',
    text: { tr: (d) => ({ title: 'Yeni API anahtarı oluşturuldu', body: `"${d.name}" (${d.scope === 'read' ? 'salt okunur' : 'tam yetki'}) hesabınıza erişebilir. Siz değilseniz Hesap → API'den silin ve parolanızı değiştirin.` }),
      en: (d) => ({ title: 'A new API token was created', body: `"${d.name}" (${d.scope === 'read' ? 'read-only' : 'full access'}) can use your account. If this was not you, remove it in Account → API and change your password.` }) } },
  'account.webhook_disabled': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: () => '/account?tab=api',
    text: { tr: (d) => ({ title: 'Webhook kapatıldı', body: `${d.url} adresine üst üste ${d.failures} teslimat başarısız oldu. Adresi düzeltip yeniden açın.` }),
      en: (d) => ({ title: 'Webhook switched off', body: `${d.failures} deliveries in a row to ${d.url} failed. Fix the address and switch it on again.` }) } },
  'account.message': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: () => '/',
    text: { tr: (d) => ({ title: d.subject, body: d.message }), en: (d) => ({ title: d.subject, body: d.message }) } },
  'auth.account_linked': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: () => '/account?tab=security',
    text: { tr: (d) => ({ title: 'Hesabınıza bir giriş yolu bağlandı', body: `${d.provider} ile artık giriş yapılabilir. Siz yapmadıysanız Hesap → Güvenlik'ten kaldırın ve parolanızı değiştirin.` }),
      en: (d) => ({ title: 'A way to sign in was linked to your account', body: `${d.provider} can now sign in to your account. If this was not you, remove it in Account → Security and change your password.` }) } },
  'auth.password_changed': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: () => '/account?tab=security',
    text: { tr: () => ({ title: 'Parolanız değişti', body: 'Bu değişikliği siz yapmadıysanız hemen yöneticinize başvurun.' }),
      en: () => ({ title: 'Your password changed', body: 'If you did not make this change, contact your administrator now.' }) } },
  'auth.two_factor_changed': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: () => '/account?tab=security',
    text: { tr: (d) => ({ title: d.enabled === 'true' ? 'İki adımlı doğrulama açıldı' : 'İki adımlı doğrulama kapatıldı', body: 'Hesap güvenlik ayarınız değişti.' }),
      en: (d) => ({ title: d.enabled === 'true' ? 'Two-factor authentication on' : 'Two-factor authentication off', body: 'Your account security setting changed.' }) } },
  'admin.user_registered': { audience: 'staff', permission: 'users.view', channels: ['inApp', 'push', 'email', 'chat'], defaults: ['inApp'], link: () => '/admin/users',
    text: { tr: (d) => ({ title: 'Yeni kullanıcı kaydı', body: d.email }), en: (d) => ({ title: 'New user registered', body: d.email }) } },
  'admin.operation_failed': { audience: 'staff', permission: 'servers.view_all', channels: all, defaults: ['inApp', 'push'], link: (d) => `/servers/${d.serverId}`,
    text: { tr: (d) => ({ title: `İşlem başarısız: ${d.name}`, body: `${d.kind} · ${d.code} · ${d.owner}` }),
      en: (d) => ({ title: `Operation failed: ${d.name}`, body: `${d.kind} · ${d.code} · ${d.owner}` }) } },
  'admin.traffic_exceeded': { audience: 'staff', permission: 'servers.view_all', channels: all, defaults: ['inApp'], link: (d) => `/servers/${d.serverId}`,
    text: { tr: (d) => ({ title: `Trafik kotası doldu: ${d.name}`, body: `Bu ay ${d.usedGb} GB / ${d.allowanceGb} GB.` }),
      en: (d) => ({ title: `Traffic allowance used up: ${d.name}`, body: `${d.usedGb} GB of ${d.allowanceGb} GB this month.` }) } },
  'admin.abuse': { audience: 'staff', permission: 'servers.view_all', channels: all, defaults: ['inApp', 'push', 'email'], link: () => '/admin/abuse',
    text: { tr: (d) => ({ title: d.kind === 'cpu' ? 'Madencilik şüphesi: ' + d.name : 'Açık port: ' + d.name + ' ' + d.address + ':' + d.port,
        body: d.kind === 'cpu' ? 'CPU uzun süredir ortalama %' + d.cpu + ' (' + d.owner + ').' : (d.label || 'Port') + ' internete açık (' + d.owner + ').' }),
      en: (d) => ({ title: d.kind === 'cpu' ? 'Mining suspected: ' + d.name : 'Open port: ' + d.name + ' ' + d.address + ':' + d.port,
        body: d.kind === 'cpu' ? 'CPU has averaged ' + d.cpu + '% for hours (' + d.owner + ').' : (d.label || 'Port') + ' is open to the Internet (' + d.owner + ').' }) } },
  'server.port_open': { audience: 'user', channels: all, defaults: ['inApp', 'email'], link: (d) => '/servers/' + d.serverId,
    text: { tr: (d) => ({ title: d.name + ': ' + (d.label || 'port') + ' internete açık', body: d.address + ':' + d.port + ' herkese açık görünüyor. Gerekmiyorsa kapatın veya bir firewall uygulayın.' }),
      en: (d) => ({ title: d.name + ': ' + (d.label || 'port') + ' open to the Internet', body: d.address + ':' + d.port + ' is reachable by anyone. Close it or apply a firewall if it is not needed.' }) } },
  'admin.iso_ready': { audience: 'staff', permission: 'catalog.manage', channels: ['inApp', 'push', 'email', 'chat'], defaults: ['inApp'], link: () => '/admin/catalog?tab=isos',
    text: { tr: (d) => ({ title: 'ISO hazır: ' + d.name, body: d.pool + ' konumunda müşterilerin kullanımına açık.' }),
      en: (d) => ({ title: 'ISO ready: ' + d.name, body: 'Available in ' + d.pool + '.' }) } },
  'admin.iso_failed': { audience: 'staff', permission: 'catalog.manage', channels: ['inApp', 'push', 'email', 'chat'], defaults: ['inApp', 'push'], link: () => '/admin/catalog?tab=isos',
    text: { tr: (d) => ({ title: 'ISO kopyalanamadı: ' + d.name, body: d.error }), en: (d) => ({ title: 'ISO copy failed: ' + d.name, body: d.error }) } },
  'admin.vmware_found': { audience: 'staff', permission: 'vmware.manage', channels: ['inApp', 'push', 'email', 'chat'], defaults: ['inApp', 'email'], link: () => '/admin/vmware',
    text: { tr: (d) => ({ title: `Ağda ${d.count} yeni ESXi / vCenter bulundu`, body: `${d.list}. Bağlantı olarak eklemek için VMware sayfasına bakın.` }),
      en: (d) => ({ title: `${d.count} new ESXi / vCenter found on the network`, body: `${d.list}. Open the VMware page to add them as connections.` }) } },
  // From Alertmanager (alerts.ts): the monitoring stack's alert rules, firing and resolved.
  'admin.alert': { audience: 'staff', permission: 'system.view', channels: all, defaults: ['inApp', 'email', 'push'], link: () => '/admin/system',
    text: { tr: (d) => ({ title: d.titleTr, body: d.bodyTr }), en: (d) => ({ title: d.titleEn, body: d.bodyEn }) } },
  // From os-alerts.ts: the panel's own server has security updates waiting or needs a restart.
  'admin.os_updates': { audience: 'staff', permission: 'system.view', channels: all, defaults: ['inApp', 'email'], link: () => '/admin/system',
    text: { tr: (d) => d.kind === 'restart' ? { title: 'Panel sunucusu yeniden başlatılmalı', body: 'Kurulan güncellemeler (çekirdek ya da temel kitaplıklar) ancak yeniden başlatınca etkin olur. Sistem sayfasından uygun bir zamanda yeniden başlatın.' }
        : { title: `Panel sunucusunda ${d.count} güvenlik güncellemesi bekliyor`, body: `Toplam ${d.total} güncelleme var. Sistem sayfasından kurabilir ya da otomatik güvenlik güncellemelerini açabilirsiniz.` },
      en: (d) => d.kind === 'restart' ? { title: 'The panel server needs a restart', body: 'Installed updates (the kernel or core libraries) only take effect after a restart. Restart it from the System page at a convenient time.' }
        : { title: `${d.count} security updates wait on the panel server`, body: `${d.total} updates in total. Install them from the System page, or turn automatic security updates on.` } } },
  'admin.insight': { audience: 'staff', permission: 'dashboard.view', channels: all, defaults: ['inApp', 'email'], link: () => '/admin',
    text: { tr: (d) => ({ title: d.titleTr, body: d.bodyTr }), en: (d) => ({ title: d.titleEn, body: d.bodyEn }) } },
};
export type EventKey = keyof typeof catalog;

const defaultPolicy = (e: EventDef): NotificationPolicy => ({ enabled: true, allowed: e.channels, defaults: e.defaults, userCanChange: true });
export async function policies() {
  const saved = await getSettings('notifications');
  return Object.fromEntries(Object.entries(catalog).map(([k, e]) => {
    const p = { ...defaultPolicy(e), ...saved[k] };
    // Channels are always limited to what the event supports; defaults to what is allowed.
    const allowed = p.allowed.filter((c) => e.channels.includes(c));
    return [k, { ...p, allowed, defaults: p.defaults.filter((c) => allowed.includes(c)) }];
  })) as Record<string, NotificationPolicy>;
}

export const notificationQueue = new Queue('notifications', { connection: redis });
const queue = notificationQueue;
// Recipients: user ids, or 'staff:<permission>' for everyone holding it.
export async function notify(event: EventKey, to: string[] | `staff:${Permission}`, data: Record<string, unknown>) {
  const clean = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? '')]));
  await queue.add('notify', { event, to, data: clean }, { attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true, removeOnFail: 100 })
    .catch(() => logEvent('error', 'notify_enqueue_failed', { event }));
}

async function recipients(to: string[] | string) {
  const { rows } = Array.isArray(to)
    ? await pool.query('SELECT id, email, locale, role, phone_number, phone_number_verified, quiet_hours, time_zone FROM users WHERE id = ANY($1::uuid[]) AND NOT coalesce(banned, false)', [to])
    : await pool.query('SELECT id, email, locale, role, phone_number, phone_number_verified, quiet_hours, time_zone FROM users WHERE NOT coalesce(banned, false) AND disabled_at IS NULL');
  if (Array.isArray(to)) return rows;
  const perm = to.replace('staff:', '') as Permission;
  const out = [];
  for (const u of rows) if (can(await permissionsOf(u.id, u.role), perm)) out.push(u);
  return out;
}

// The channels one user gets for one event: the admin's policy, then the user's choice within it.
async function channelsFor(userId: string, event: string, p: NotificationPolicy): Promise<Channel[]> {
  if (!p.enabled) return [];
  if (!p.userCanChange) return p.defaults;
  const { rows: [pref] } = await pool.query('SELECT channels FROM notification_preferences WHERE user_id = $1 AND event = $2', [userId, event]);
  return pref ? (pref.channels as Channel[]).filter((c) => p.allowed.includes(c)) : p.defaults;
}

export async function vapid() {
  let v = await getSettings('vapid');
  if (!v.publicKey || !v.privateKeyEnc) {
    const keys = webpush.generateVAPIDKeys();
    v = { publicKey: keys.publicKey, privateKeyEnc: encryptSecret(keys.privateKey, 'settings:vapid') };
    await saveSettings('vapid', v);
  }
  return { publicKey: v.publicKey, privateKey: decryptSecret(v.privateKeyEnc!, 'settings:vapid') };
}

async function sendPush(userId: string, payload: object) {
  const { rows } = await pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
  if (!rows.length) return;
  const keys = await vapid();
  const brand = (await getSettings('branding')).name;
  await Promise.all(rows.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ ...payload, brand }),
    { vapidDetails: { subject: 'mailto:noreply@lightning-vm.invalid', publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 3600 })
    // Gone or expired subscriptions are removed; anything else is logged.
    .catch(async (err) => {
      if (err?.statusCode === 404 || err?.statusCode === 410) await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
      else logEvent('error', 'push_failed', { status: err?.statusCode ?? 0 });
    })));
}

// The e-mail's tag and colour: what area the event is from, and whether it is good news, a warning or a failure.
const mailLabels: Record<string, { tr: string; en: string }> = {
  server: { tr: 'Sunucu', en: 'Server' }, billing: { tr: 'Fatura', en: 'Billing' }, support: { tr: 'Destek', en: 'Support' },
  auth: { tr: 'Hesap güvenliği', en: 'Account security' }, account: { tr: 'Hesap', en: 'Account' }, admin: { tr: 'Yönetici uyarısı', en: 'Admin alert' },
};
export function mailTone(event: string): Tone {
  if (/failed|overdue|suspended|terminated|abuse|exceeded|hold|disabled|port_open|einvoice_return/.test(event)) return 'danger';
  if (/^admin\.|low|reminder|delete_scheduled|new_device|sign_in|dispute|changed|budget/.test(event)) return 'warning';
  if (/ready|paid|payment_received|installed|refunded|snapshot|backup|reply/.test(event)) return 'success';
  return 'info';
}

type Recipient = { id: string; email: string; locale: string; phone_number: string | null; phone_number_verified: boolean; time_zone?: string | null };
// texts: both languages, so the inbox can follow the panel's language; the other channels use the account's.
export async function deliver(u: Recipient, channel: Channel, t: Text, link: string | null, event: string, texts?: { tr: Text; en: Text }) {
  const brand = (await getSettings('branding')).name;
  if (channel === 'inApp') {
    await pool.query('INSERT INTO notifications (user_id, event, title, body, link, texts) VALUES ($1, $2, $3, $4, $5, $6)', [u.id, event, t.title, t.body, link, texts ?? null]);
    await publishLive(u.id, 'notification');
  }
  if (channel === 'push') await sendPush(u.id, { title: t.title, body: t.body, link });
  if (channel === 'email' && (await mailReady())) {
    const b = await brandFor(u.locale);
    const url = await absolute(link);
    const label = mailLabels[event.split('.')[0]]?.[b.locale];
    // When it happened, in the account's time zone (Turkey's when none is set; an unknown zone falls back to UTC).
    const when = (tz: string) => new Intl.DateTimeFormat(b.locale === 'tr' ? 'tr-TR' : 'en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: tz, timeZoneName: 'short' }).format(new Date());
    let at: string; try { at = when(u.time_zone || 'Europe/Istanbul'); } catch { at = when('UTC'); }
    const c: MailContent = { preheader: t.body, label, tone: mailTone(event), heading: t.title, intro: [t.body], details: [[b.locale === 'tr' ? 'Zaman' : 'Time', at]], button: url ? { label: b.locale === 'tr' ? 'Panelde aç' : 'Open in the panel', url } : undefined,
      note: b.locale === 'tr' ? 'Hangi bildirimleri e-postayla alacağınızı Hesap sayfasındaki Bildirimler bölümünden değiştirebilirsiniz.'
        : 'Choose which notifications reach you by e-mail in the Notifications section of the Account page.' };
    await sendMail(u.email, `${brand}: ${t.title}`, mailText(c, b), mailHtml(c, b));
  }
  if (channel === 'chat') await deliverChat(u.id, t, link, event);
  if (channel === 'sms' && u.phone_number && u.phone_number_verified && (await smsReady())) await sendSms(u.phone_number, `${brand}: ${t.title}. ${t.body}`.slice(0, 300));
}

// One consumer in the API process; failures of one channel never stop the others.
export function startNotificationWorker() {
  const connection = redis.duplicate({ maxRetriesPerRequest: null });
  const worker = new Worker('notifications', async (job) => {
    const { event, to, data } = job.data as { event: string; to: string[] | string; data: Record<string, string> };
    const def = catalog[event];
    if (!def) return;
    const p = (await policies())[event];
    const texts = { tr: def.text.tr(data), en: def.text.en(data) };
    const people = await recipients(to);
    // Webhooks get the event for everyone it reached, whatever their notification channels.
    await queueWebhooks(event, people.map((u) => u.id), data).catch(() => logEvent('error', 'webhook_queue_failed', { event }));
    for (const u of people) {
      const t = texts[u.locale === 'tr' ? 'tr' : 'en'];
      // Quiet hours: nothing that buzzes a phone, except security notices; the inbox and e-mail still get it.
      const quiet = !alwaysSent(event) && inQuietHours(u.quiet_hours);
      for (const c of await channelsFor(u.id, event, p)) {
        if (quiet && loudChannels.has(c)) continue;
        await deliver(u, c, t, def.link?.(data) ?? null, event, texts).catch((err) => logEvent('error', 'notification_failed', { event, channel: c, error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' }));
      }
    }
  }, { connection, concurrency: 2 });
  worker.on('error', () => logEvent('error', 'notification_queue_error'));
  // BullMQ leaves a connection it was given open; this one belongs to the worker alone.
  worker.on('closed', () => connection.disconnect());
  return worker;
}

