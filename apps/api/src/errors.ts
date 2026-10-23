import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import type { FastifyReply } from 'fastify';
import { logEvent } from './log';

// `code` is a stable English key the web UI translates; `fields` maps input names to codes.
export function apiError(status: number, code: string, message: string, fields?: Record<string, string>) {
  return new HttpException({ code, message, ...(fields && { fields }) }, status);
}

// Every error body is { code, message, fields? }.
@Catch()
export class ErrorCodeFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (!(err instanceof HttpException)) {
      logEvent('error', 'unhandled_error', { error: err instanceof Error ? err.name : 'unknown' });
      return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Internal error' });
    }
    const body = err.getResponse();
    const status = err.getStatus();
    if (typeof body === 'object' && 'code' in body) return reply.status(status).send(body);
    reply.status(status).send({ code: (STATUS_CODES[status] ?? 'UNKNOWN').toUpperCase().replace(/\W+/g, '_'), message: err.message });
  }
}
