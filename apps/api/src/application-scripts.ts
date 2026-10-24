// The installation script of an application (pure; the controllers are in applications.ts).
import { createHash } from 'node:crypto';

export type Application = { id: string; name: string; kind: 'cpanel' | 'plesk' | 'custom'; script: string; license_mode: 'none' | 'pool';
  min_memory_mb: number; min_disk_gb: number; price_monthly: string };

// Starting scripts; the admin can change them. Both installers need a fresh, supported OS image.
export const defaultScripts = {
  cpanel: `# cPanel & WHM: AlmaLinux / Rocky Linux 8-9 or Ubuntu 22.04, at least 2 GB RAM and 40 GB disk.
# The licence is bound to the server's IP: buy it for {IP} from cPanel or a partner.
hostnamectl set-hostname {HOSTNAME}
cd /home && curl -fsSL -o latest https://securedownloads.cpanel.net/latest && sh latest`,
  plesk: `# Plesk Obsidian (one-click installer): Ubuntu 22.04/24.04, AlmaLinux / Rocky Linux 8-9.
hostnamectl set-hostname {HOSTNAME}
curl -fsSL https://autoinstall.plesk.com/one-click-installer -o /root/plesk-installer.sh && sh /root/plesk-installer.sh
plesk bin license --install {LICENSE}`,
  custom: '# Your installation script (runs as root after the first boot).\n',
};

export const keyPattern = /^[A-Za-z0-9._+=\/-]{1,300}$/; // licence keys go into a shell script: no quotes or spaces
export const marker = 'LVM_APP_EOF';

// The script cloud-init starts in the background: runs the application script, reports the outcome.
export function renderInstall(app: Pick<Application, 'name' | 'script'>, values: { license: string; hostname: string; ip: string }, callbackUrl: string, token: string) {
  const body = app.script.replaceAll('{LICENSE}', values.license).replaceAll('{HOSTNAME}', values.hostname).replaceAll('{IP}', values.ip);
  return `#!/bin/sh
# ${app.name.replace(/[\r\n]/g, ' ')}: installed by Lightning VM; the result is reported to the panel.
command -v curl >/dev/null || apt-get install -y curl >/dev/null 2>&1 || dnf install -y curl >/dev/null 2>&1 || yum install -y curl >/dev/null 2>&1
report() { curl -fsS -m 20 --retry 5 --retry-delay 10 -X POST -H 'content-type: application/json' -H 'x-lightning-csrf: 1' \\
  -d "{\\"token\\":\\"${token}\\",\\"status\\":\\"$1\\",\\"message\\":\\"$2\\"}" '${callbackUrl}' >/dev/null 2>&1 || true; }
report installing ""
cat > /root/lightning-app-install.sh <<'${marker}'
${body}
${marker}
if sh /root/lightning-app-install.sh; then report installed ""; else rc=$?; report failed "exit $rc"; fi
rm -f /root/lightning-app-install.sh
`;
}

export const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');
