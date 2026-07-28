import { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from './errors';

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({
      error: error.message,
      details: error.details,
    });
  }

  if (error instanceof ZodError) {
    return res.status(400).json({
      error: 'Invalid request',
      details: error.issues,
    });
  }

  console.error('[HTTP] Unhandled error:', error);
  return res.status(500).json({
    error: 'Internal server error',
  });
};
