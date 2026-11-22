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

export const sendError = (res: Response, err: unknown) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  console.error('Admin handler error', err);
  return res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error.' } });
};
