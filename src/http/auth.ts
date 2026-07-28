import { NextFunction, Request, Response } from 'express';
import { AppConfig } from '../config';

export function createApiKeyMiddleware(config: Pick<AppConfig, 'apiKey'>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') || '';
    const [scheme, token] = header.split(/\s+/);

    if (scheme?.toLowerCase() === 'bearer' && token === config.apiKey) {
      return next();
    }

    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid bearer token.',
    });
  };
}
