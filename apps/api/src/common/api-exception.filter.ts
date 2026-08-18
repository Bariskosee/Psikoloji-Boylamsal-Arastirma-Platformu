import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";
import type { ApiErrorCode, ApiErrorResponse } from "@lpr/contracts";
import { ApiException } from "./api-error.js";

/**
 * The single exit for every error.
 *
 * Two responsibilities, both security-relevant:
 *
 * 1. Every response body has the shape in `apiErrorResponseSchema`, so a
 *    client never has to guess whether it got `{message}` or `{error}`.
 * 2. An UNEXPECTED error never reaches the client. A stack trace or a
 *    PostgreSQL message can disclose schema names, query structure, and file
 *    paths; unrecognised failures become a bare `INTERNAL_ERROR` and the
 *    detail goes to the log instead.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("ApiException");

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof ApiException) {
      const body: ApiErrorResponse = {
        error: {
          code: exception.code,
          message: exception.message,
          ...(exception.details ? { details: exception.details } : {}),
        },
      };
      response.status(exception.getStatus()).json(body);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code: ApiErrorCode =
        status === HttpStatus.NOT_FOUND
          ? "NOT_FOUND"
          : status === HttpStatus.UNAUTHORIZED
            ? "AUTHENTICATION_REQUIRED"
            : status === HttpStatus.FORBIDDEN
              ? "FORBIDDEN"
              : status === HttpStatus.TOO_MANY_REQUESTS
                ? "RATE_LIMITED"
                : status < 500
                  ? "VALIDATION_FAILED"
                  : "INTERNAL_ERROR";
      response.status(status).json({ error: { code, message: exception.message } });
      return;
    }

    // The message is logged, never returned. Response payloads are never
    // logged at any level (AGENT.md §5), and an error object from a failed
    // insert can contain the row that failed — so only the message is taken.
    this.logger.error(exception instanceof Error ? exception.message : "unknown error");
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
  }
}
