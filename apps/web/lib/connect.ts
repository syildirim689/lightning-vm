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

// The command that installs and starts open-vm-tools on the guest's OS, when it is one we know; null otherwise
// (Windows takes the VMware Tools installer instead). Matched on VMware's OS name, the guest id or the image name.
export function toolsCommand(os: string): string | null {
  const s = os.toLowerCase();
  if (/windows/.test(s)) return null;
  if (/ubuntu|debian/.test(s)) return 'sudo apt-get update && sudo apt-get install -y open-vm-tools && sudo systemctl enable --now open-vm-tools';
  if (/red ?hat|rhel|centos|rocky|alma|fedora|oracle linux|amazon/.test(s)) return 'sudo dnf install -y open-vm-tools && sudo systemctl enable --now vmtoolsd';
  if (/suse|sles/.test(s)) return 'sudo zypper install -y open-vm-tools && sudo systemctl enable --now vmtoolsd';
  if (/alpine/.test(s)) return 'apk add open-vm-tools && rc-update add open-vm-tools && rc-service open-vm-tools start';
  if (/freebsd/.test(s)) return 'pkg install -y open-vm-tools-nox11 && sysrc vmware_guestd_enable=YES && service vmware-guestd start';
  return null;
}
