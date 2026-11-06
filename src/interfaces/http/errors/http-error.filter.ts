import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import { toHttpError } from './http-error-mapping';

interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

/** Catches everything thrown by HTTP handlers and renders the uniform error body. */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  // Nest's Logger delegates to pino once `app.useLogger` is set, keeping structured JSON logs.
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const mapped = toHttpError(error);
    const response = host.switchToHttp().getResponse<HttpResponse>();

    const context = { status: mapped.status, code: mapped.body.error.code };
    if (mapped.severity === 'error') {
      this.logger.error({ ...context, err: error, msg: 'Request failed' });
    } else if (mapped.severity === 'warn') {
      this.logger.warn({ ...context, msg: 'Request failed transiently' });
    } else {
      this.logger.debug({ ...context, msg: 'Request rejected' });
    }

    if (mapped.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    }
    response.status(mapped.status).json(mapped.body);
  }
}
