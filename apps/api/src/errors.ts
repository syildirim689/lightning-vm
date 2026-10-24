import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import type { FastifyReply } from 'fastify';
import { logEvent } from './log';

// `code` is a stable English key the web UI translates; `fields` maps input names to codes;
// `extra` carries structured, non-secret context (for example a certificate to show the admin).
export function apiError(status: number, code: string, message: string, fields?: Record<string, string>, extra?: Record<string, unknown>) {
  return new HttpException({ code, message, ...(fields && { fields }), ...extra }, status);
}

// Every error body is { code, message, fields?, ...extra }.
@Catch()
export class ErrorCodeFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (!(err instanceof HttpException)) {
      // The SQLSTATE (or Node error code) is safe to log; messages can contain data, so only when asked for.
      logEvent('error', 'unhandled_error', { error: err instanceof Error ? err.name : 'unknown', code: (err as { code?: string })?.code,
        ...(process.env.LOG_ERROR_DETAIL === '1' && { detail: String((err as Error)?.stack ?? err).slice(0, 800) }) });
      return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Internal error' });
    }
    const body = err.getResponse();
    const status = err.getStatus();
    if (typeof body === 'object' && 'code' in body) return reply.status(status).send(body);
    reply.status(status).send({ code: (STATUS_CODES[status] ?? 'UNKNOWN').toUpperCase().replace(/\W+/g, '_'), message: err.message });
  }
}
