import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');
// Set here as well as at the proxy (deploy/caddy/Caddyfile), so a panel reached some other way, another proxy or the
// port itself, still cannot be framed or have its content type guessed. No script policy here.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
];
export default withNextIntl({ output: 'standalone', poweredByHeader: false, headers: async () => [{ source: '/:path*', headers: securityHeaders }] });
