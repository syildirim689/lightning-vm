// Shared by the firewall pages, the server page and the order page.
export type Rule = { direction: 'in' | 'out'; protocol: 'tcp' | 'udp' | 'icmp' | 'esp' | 'gre'; port: string | null; ips: string[]; description: string };
export type FirewallServer = { id: string; name: string; status: 'applied' | 'pending' | 'failed'; address?: string | null; errorCode?: string | null; appliedAt?: string | null };
export type Firewall = { id: string; name: string; rules: Rule[]; servers: FirewallServer[]; ownerEmail?: string; createdAt: string; updatedAt: string };
export type Limits = { rulesPerFirewall: number; ipsPerRule: number; firewallsPerServer: number };

export const anywhere = ['0.0.0.0/0', '::/0'];
export const protocols: Rule['protocol'][] = ['tcp', 'udp', 'icmp', 'esp', 'gre'];
export const hasPort = (p: Rule['protocol']) => p === 'tcp' || p === 'udp';

// One-click rules (Hetzner offers the same shortcuts).
export const quick: Record<string, Omit<Rule, 'direction'>> = {
  ssh: { protocol: 'tcp', port: '22', ips: anywhere, description: 'SSH' },
  http: { protocol: 'tcp', port: '80', ips: anywhere, description: 'HTTP' },
  https: { protocol: 'tcp', port: '443', ips: anywhere, description: 'HTTPS' },
  icmp: { protocol: 'icmp', port: null, ips: anywhere, description: 'Ping' },
  rdp: { protocol: 'tcp', port: '3389', ips: anywhere, description: 'RDP' },
  dns: { protocol: 'udp', port: '53', ips: anywhere, description: 'DNS' },
};

// Starting points when creating a firewall.
export const templates: Record<string, Rule[]> = {
  empty: [],
  web: ['ssh', 'http', 'https', 'icmp'].map((k) => ({ direction: 'in', ...quick[k] })),
  ssh: ['ssh', 'icmp'].map((k) => ({ direction: 'in', ...quick[k] })),
  windows: ['rdp', 'icmp'].map((k) => ({ direction: 'in', ...quick[k] })),
};

export const statusTone = { applied: 'success', pending: 'accent', failed: 'danger' } as const;
