// The connection check's rules, kept apart from the page so they can be tested (node --test lib/*.test.ts).
export type FwRule = { direction: 'in' | 'out'; protocol: string; port: string | null };

// The login port: RDP for Windows guests, SSH for everything else.
export const loginPort = (os: string) => (/windows/i.test(os) ? 3389 : 22);

// "22", "8000-8100" or empty (every port).
const covers = (port: string | null, n: number) => { if (!port) return true; const [a, b = a] = port.split('-').map(Number); return a <= n && n <= b; };

// Whether an inbound TCP rule lets the port in.
export const allows = (rules: FwRule[], port: number) => rules.some((r) => r.direction === 'in' && r.protocol === 'tcp' && covers(r.port, port));

// The guest's addresses without prefix lengths; whether it uses the address the panel gave it.
export const bare = (ips: string[]) => ips.map((x) => x.split('/')[0]);
export const usesAddress = (guestIps: string[], address: string | null) => !address || !guestIps.length || bare(guestIps).includes(address);
