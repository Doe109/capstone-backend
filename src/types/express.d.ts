/**
 * Express Request augmentation
 * Adds the `user` property set by the JWT auth middleware.
 */

import { JwtPayload } from './auth';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
