// Port of the pilot Discovery errors module:
// ~/workspace/workstreams/pilot-impl/repo/src/Discovery/errors.ts
// Error shape for all admin API handlers: { error: { code, message } }.
// Auth failures (401 and 403 with a plain { message } body) are produced by
// the decodeAdminToken middleware, not by this helper.
import { Response } from 'express';

export type ApiErrorCode =
  | 'invalid_parameter'
  | 'unauthenticated'
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'unprocessable_entity'
  | 'service_unavailable'
  | 'too_many_requests'
  | 'internal_error';

export class ApiError extends Error {
  status: number;
  code: ApiErrorCode;
  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const invalidParameter = (message: string) => new ApiError(400, 'invalid_parameter', message);
export const notFound = (message: string) => new ApiError(404, 'not_found', message);
export const conflict = (message: string) => new ApiError(409, 'conflict', message);
export const unprocessable = (message: string) => new ApiError(422, 'unprocessable_entity', message);
export const serviceUnavailable = (message: string) => new ApiError(503, 'service_unavailable', message);
export const tooManyRequests = (message: string) => new ApiError(429, 'too_many_requests', message);

export const sendError = (res: Response, err: unknown) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  console.error('Admin handler error', err);
  return res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error.' } });
};
