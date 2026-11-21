// The account's own e-mail address verification (address-check.ts has the rules): its state, a new mail, and the
// code. Every route answers about the signed-in account only, so none of them says whether an address has an account.
import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { clearVerification, confirmVerification, sendVerification, verificationAvailable, verificationState } from './address-check';
import { audit, SessionGuard, type AuthedRequest } from './auth';
import { pool } from './db';
import { apiError } from './errors';
import { publishLive } from './live-bus';

// In a browser session of the person themselves: an API token is a program, and staff acting as someone are not the
// person whose mailbox this is about (staff mark an address verified in Admin → Users, with their own name on it).
function ownSession(req: AuthedRequest) {
  if (req.sessionId?.startsWith('token:')) throw apiError(403, 'TOKEN_NOT_ALLOWED', 'Verify the address from the panel');
  if (req.user.impersonatedBy) throw apiError(403, 'NOT_WHILE_IMPERSONATING', 'Not while acting as another user');
}
const codeOf = (err: unknown) => (err as { getResponse?: () => { code?: string } })?.getResponse?.()?.code;

@Controller('account/email-verification') @UseGuards(SessionGuard)
export class EmailVerificationController {
  @Get()
  state(@Req() req: AuthedRequest) { return verificationState(req.user.id); }

  @Post('send') @HttpCode(200)
  async send(@Req() req: AuthedRequest) {
    ownSession(req);
    if (!(await verificationAvailable())) throw apiError(501, 'MAIL_NOT_CONFIGURED', 'Mail is not configured');
    const { rows: [u] } = await pool.query('SELECT id, email, locale, email_verified FROM users WHERE id = $1', [req.user.id]);
    if (!u) throw apiError(401, 'UNAUTHENTICATED', 'Sign in required');
    if (u.email_verified) throw apiError(409, 'EMAIL_ALREADY_VERIFIED', 'This address is verified already');
    try { await sendVerification(u); }
    catch (err) {
      // The limits and "no mail" keep their own answers; a mail server that refused is said as that, without its words.
      if (codeOf(err)) throw err;
      await audit(req, 'auth.email_verification_sent', 'failure', req.user.id);
      throw apiError(502, 'MAIL_SEND_FAILED', 'The mail could not be sent');
    }
    await audit(req, 'auth.email_verification_sent', 'success', req.user.id);
    return verificationState(req.user.id);
  }

  @Post('confirm') @HttpCode(200)
  async confirm(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    ownSession(req);
    const { rows: [u] } = await pool.query('SELECT id, email, email_verified FROM users WHERE id = $1', [req.user.id]);
    if (!u) throw apiError(401, 'UNAUTHENTICATED', 'Sign in required');
    // Verified meanwhile (the link opened in two tabs, or staff did it): nothing left to do, and said as success.
    if (u.email_verified) { await clearVerification(u.id); return { verified: true }; }
    let changed: boolean;
    try { changed = await confirmVerification(u, typeof body?.code === 'string' ? body.code.replace(/\s+/g, '') : body?.code); }
    catch (err) {
      if (codeOf(err) === 'VERIFICATION_CODE_INVALID') await audit(req, 'auth.email_verified', 'failure', req.user.id, { method: 'code' });
      throw err;
    }
    if (changed) {
      await audit(req, 'auth.email_verified', 'success', req.user.id, { method: 'code' });
      await publishLive(req.user.id, 'account');
    }
    return { verified: true };
  }
}
