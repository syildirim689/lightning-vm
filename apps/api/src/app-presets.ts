// One-click application templates the admin starts from (Catalog → Applications → New → template).
// Each is a POSIX sh script for Debian/Ubuntu images (apt), run as root after the first boot. Generated
// passwords go to /root/lightning-app-credentials.txt (0600); nothing secret is reported to the panel.
export type Preset = { id: string; name: string; kind: 'cpanel' | 'plesk' | 'custom'; minMemoryMb: number; minDiskGb: number; licenseMode: 'none' | 'pool'; script: string };

const apt = `export DEBIAN_FRONTEND=noninteractive
command -v apt-get >/dev/null || { echo "This template needs a Debian or Ubuntu image" >&2; exit 2; }
apt-get update -q`;
const secret = `secret() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \\n'; }
note() { umask 077; echo "$1" >> /root/lightning-app-credentials.txt; }`;
const docker = `command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
systemctl enable --now docker`;

export const presets: Preset[] = [
  { id: 'cpanel', name: 'cPanel & WHM', kind: 'cpanel', minMemoryMb: 2048, minDiskGb: 40, licenseMode: 'none', script: '' },
  { id: 'plesk', name: 'Plesk Obsidian', kind: 'plesk', minMemoryMb: 2048, minDiskGb: 40, licenseMode: 'pool', script: '' },
  { id: 'wordpress', name: 'WordPress (LAMP)', kind: 'custom', minMemoryMb: 1024, minDiskGb: 20, licenseMode: 'none', script: `${apt}
${secret}
apt-get install -yq apache2 mariadb-server php php-mysql php-curl php-gd php-mbstring php-xml php-zip php-intl libapache2-mod-php curl
DBPASS=$(secret)
mysql -e "CREATE DATABASE IF NOT EXISTS wordpress; CREATE USER IF NOT EXISTS 'wordpress'@'localhost' IDENTIFIED BY '$DBPASS'; GRANT ALL ON wordpress.* TO 'wordpress'@'localhost'; FLUSH PRIVILEGES;"
curl -fsSL https://wordpress.org/latest.tar.gz | tar -xz -C /var/www
rm -rf /var/www/html && mv /var/www/wordpress /var/www/html
cp /var/www/html/wp-config-sample.php /var/www/html/wp-config.php
sed -i "s/database_name_here/wordpress/; s/username_here/wordpress/; s/password_here/$DBPASS/" /var/www/html/wp-config.php
curl -fsSL https://api.wordpress.org/secret-key/1.1/salt/ > /tmp/salts && sed -i '/AUTH_KEY/,/NONCE_SALT/d' /var/www/html/wp-config.php && sed -i '/stop editing/r /tmp/salts' /var/www/html/wp-config.php && rm -f /tmp/salts
chown -R www-data:www-data /var/www/html
a2enmod rewrite && systemctl restart apache2
note "WordPress: http://{IP}/ (finish the setup in the browser). Database wordpress / user wordpress / password $DBPASS"` },
  { id: 'lemp', name: 'LEMP (Nginx, MariaDB, PHP-FPM)', kind: 'custom', minMemoryMb: 1024, minDiskGb: 15, licenseMode: 'none', script: `${apt}
${secret}
apt-get install -yq nginx mariadb-server php-fpm php-mysql php-curl php-gd php-mbstring php-xml php-zip
ROOTPASS=$(secret)
mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED BY '$ROOTPASS'; FLUSH PRIVILEGES;"
SOCK=$(ls /run/php/php*-fpm.sock | head -n1)
cat > /etc/nginx/sites-available/default <<NGINX
server {
  listen 80 default_server;
  root /var/www/html;
  index index.php index.html;
  location / { try_files \\$uri \\$uri/ /index.php?\\$args; }
  location ~ \\.php$ { include snippets/fastcgi-php.conf; fastcgi_pass unix:$SOCK; }
}
NGINX
echo '<?php phpinfo();' > /var/www/html/info.php
systemctl restart nginx
note "LEMP: http://{IP}/info.php (remove it when done). MariaDB root password $ROOTPASS"` },
  { id: 'docker', name: 'Docker CE + Compose', kind: 'custom', minMemoryMb: 1024, minDiskGb: 20, licenseMode: 'none', script: `${docker}
docker compose version` },
  { id: 'portainer', name: 'Portainer CE (Docker)', kind: 'custom', minMemoryMb: 1024, minDiskGb: 20, licenseMode: 'none', script: `${docker}
docker volume create portainer_data
docker run -d --name portainer --restart=always -p 9443:9443 -v /var/run/docker.sock:/var/run/docker.sock -v portainer_data:/data portainer/portainer-ce:lts
echo "Portainer: https://{IP}:9443/ (create the admin user within 5 minutes)" > /root/lightning-app-credentials.txt` },
  { id: 'coolify', name: 'Coolify (self-hosted PaaS)', kind: 'custom', minMemoryMb: 2048, minDiskGb: 30, licenseMode: 'none', script: `curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
echo "Coolify: http://{IP}:8000/ (register the first user as the admin)" > /root/lightning-app-credentials.txt` },
  { id: 'nodejs', name: 'Node.js LTS + PM2', kind: 'custom', minMemoryMb: 512, minDiskGb: 10, licenseMode: 'none', script: `${apt}
apt-get install -yq ca-certificates curl gnupg
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
apt-get install -yq nodejs
npm install -g pm2
pm2 startup systemd -u root --hp /root` },
  { id: 'nextcloud', name: 'Nextcloud (snap)', kind: 'custom', minMemoryMb: 2048, minDiskGb: 30, licenseMode: 'none', script: `${apt}
${secret}
apt-get install -yq snapd
snap install nextcloud
PASS=$(secret)
nextcloud.manual-install admin "$PASS"
nextcloud.occ config:system:set trusted_domains 1 --value={IP}
nextcloud.occ config:system:set trusted_domains 2 --value={HOSTNAME}
note "Nextcloud: http://{IP}/ user admin / password $PASS"` },
  { id: 'webmin', name: 'Webmin', kind: 'custom', minMemoryMb: 512, minDiskGb: 10, licenseMode: 'none', script: `${apt}
apt-get install -yq curl
curl -fsSL -o /tmp/setup-repos.sh https://raw.githubusercontent.com/webmin/webmin/master/setup-repos.sh
sh /tmp/setup-repos.sh -f
apt-get install -yq --install-recommends webmin
echo "Webmin: https://{IP}:10000/ (sign in as root with the server's root password)" > /root/lightning-app-credentials.txt` },
  { id: 'n8n', name: 'n8n (workflow automation)', kind: 'custom', minMemoryMb: 1024, minDiskGb: 20, licenseMode: 'none', script: `${docker}
docker volume create n8n_data
docker run -d --name n8n --restart=always -p 5678:5678 -e N8N_SECURE_COOKIE=false -v n8n_data:/home/node/.n8n docker.n8n.io/n8nio/n8n
echo "n8n: http://{IP}:5678/ (create the owner account; put it behind HTTPS for production)" > /root/lightning-app-credentials.txt` },
  { id: 'uptime-kuma', name: 'Uptime Kuma (monitoring)', kind: 'custom', minMemoryMb: 512, minDiskGb: 10, licenseMode: 'none', script: `${docker}
docker run -d --name uptime-kuma --restart=always -p 3001:3001 -v uptime-kuma:/app/data louislam/uptime-kuma:1
echo "Uptime Kuma: http://{IP}:3001/" > /root/lightning-app-credentials.txt` },
  { id: 'mariadb', name: 'MariaDB server', kind: 'custom', minMemoryMb: 1024, minDiskGb: 20, licenseMode: 'none', script: `${apt}
${secret}
apt-get install -yq mariadb-server
PASS=$(secret)
mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED BY '$PASS'; DELETE FROM mysql.user WHERE User=''; DROP DATABASE IF EXISTS test; FLUSH PRIVILEGES;"
note "MariaDB root password $PASS (listens on localhost only)"` },
  { id: 'postgresql', name: 'PostgreSQL server', kind: 'custom', minMemoryMb: 1024, minDiskGb: 20, licenseMode: 'none', script: `${apt}
${secret}
apt-get install -yq postgresql
PASS=$(secret)
su - postgres -c "psql -c \\"ALTER USER postgres PASSWORD '$PASS';\\""
note "PostgreSQL user postgres / password $PASS (listens on localhost only)"` },
];
