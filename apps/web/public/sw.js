// Browser notifications (Web Push) for Lightning VM: shows what the API sends and opens its link.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || data.brand || 'Lightning VM', {
    body: data.body || '', icon: '/api/public/branding/favicon', badge: '/api/public/branding/favicon', data: { link: data.link || '/' }, tag: data.tag,
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Only a page of this panel is opened: a link that leads anywhere else opens the start page instead.
  let to = new URL('/', self.location.origin);
  try { const asked = new URL(event.notification.data?.link || '/', self.location.origin); if (asked.origin === self.location.origin) to = asked; } catch { /* not a link */ }
  const url = to.href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
    const tab = tabs.find((c) => c.url.startsWith(self.location.origin));
    return tab ? tab.focus().then((c) => c.navigate(url)) : self.clients.openWindow(url);
  }));
});
