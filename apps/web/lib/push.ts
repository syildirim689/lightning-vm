"use client";
import { apiFetch } from './api';
import { closeNotifications } from './session-end';

// Web Push: register the service worker, ask the browser's permission, send the subscription to the API.
export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(base64url: string) {
  const s = atob(base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '='));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function enablePush(): Promise<'granted' | 'denied' | 'unsupported'> {
  if (!pushSupported()) return 'unsupported';
  if ((await Notification.requestPermission()) !== 'granted') return 'denied';
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const { publicKey } = await apiFetch<{ publicKey: string }>('/notifications/push-key');
  const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await apiFetch('/notifications/push-subscriptions', { method: 'POST', body: sub.toJSON() });
  return 'granted';
}

// Also when signing out (lib/auth-client.ts): what is still on screen from this account is closed with it.
export async function disablePush() {
  await closeNotifications();
  const sub = await currentSubscription();
  if (!sub) return;
  await apiFetch('/notifications/push-subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => undefined);
  await sub.unsubscribe();
}
