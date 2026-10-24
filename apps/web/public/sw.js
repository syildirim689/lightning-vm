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
  const url = new URL(event.notification.data?.link || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
    const tab = tabs.find((c) => c.url.startsWith(self.location.origin));
    return tab ? tab.focus().then((c) => c.navigate(url)) : self.clients.openWindow(url);
  }));
});
