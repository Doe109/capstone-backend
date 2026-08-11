/**
 * Auth Middleware
 * Verifies JWTs and attaches decoded user id to req.user.
 * Returns 401 if token is missing or invalid.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../types/auth';

/**
 * Verify the Bearer token on the request.
 * On success sets req.user = { userId, email }.
 */
export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Missing or invalid Authorization header.' });
    return;
  }

  const token = header.split(' ')[1];
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    console.error('JWT_SECRET is not set in .env');
    res.status(500).json({ success: false, error: 'Server misconfiguration.' });
    return;
  }

  try {
    const decoded = jwt.verify(token, secret) as JwtPayload;
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired token.' });
  }
}
