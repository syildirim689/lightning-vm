// Operator commands, run inside the api container:
//   node dist/cli.js migrate           apply pending database migrations
//   node dist/cli.js bootstrap-token   print a one-hour token for creating the first admin
//   node dist/cli.js recover-setup     reopen the setup wizard for admins (accounts and data are kept)
//   node dist/cli.js create-admin EMAIL [tr|en]
//                                      unattended install: first admin with a generated password (printed once)
import { closeConnections, pool } from './db';
import { logEvent } from './log';
import { runMigrations } from './migrate';
import { issueBootstrapToken, provisionAdmin, reopenSetup } from './setup';

async function main(command: string | undefined) {
  if (command === 'migrate') {
    const applied = await runMigrations(pool);
    logEvent('info', 'migrations_applied', { versions: applied });
    return 0;
  }
  if (command === 'bootstrap-token') {
    const issued = await issueBootstrapToken();
    if (!issued) { logEvent('warn', 'setup_admin_exists'); return 3; }
    process.stdout.write(`${issued.token}\n`); // stdout only: the caller decides where it goes
    return 0;
  }
  if (command === 'recover-setup') {
    logEvent('info', (await reopenSetup()) ? 'setup_reopened' : 'setup_not_completed');
    return 0;
  }
  if (command === 'create-admin') {
    const created = await provisionAdmin(process.argv[3] ?? '', process.argv[4] === 'tr' ? 'tr' : 'en');
    if (!created) { logEvent('warn', 'setup_admin_exists'); return 3; }
    process.stdout.write(`${created.password}\n`); // stdout only: the installer shows it once
    return 0;
  }
  process.stderr.write('usage: node dist/cli.js migrate | bootstrap-token | recover-setup | create-admin EMAIL [tr|en]\n');
  return 2;
}

main(process.argv[2])
  .then(async (code) => { await closeConnections(); process.exit(code); })
  .catch(async (err) => { logEvent('fatal', 'cli_failed', { error: err instanceof Error ? err.message : 'unknown' }); await closeConnections(); process.exit(1); });
