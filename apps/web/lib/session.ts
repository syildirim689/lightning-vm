import { cookies } from 'next/headers';

export type User = { id: string; email: string; role: 'admin' | 'user'; locale: 'tr' | 'en' };

// Server components talk to the API directly on the internal network, forwarding the session cookie.
const apiUrl = process.env.API_INTERNAL_URL || 'http://api:4000';

async function serverGet(path: string) {
  const cookie = (await cookies()).toString();
  return fetch(`${apiUrl}${path}`, { headers: { cookie }, cache: 'no-store' });
}

export async function getUser(): Promise<User | null> {
  const res = await serverGet('/auth/me');
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`auth/me failed: ${res.status}`);
  return res.json();
}

export async function getSetupStatus(): Promise<{ adminCreated: boolean; completed: boolean }> {
  const res = await serverGet('/setup/status');
  if (!res.ok) throw new Error(`setup/status failed: ${res.status}`);
  return res.json();
}
