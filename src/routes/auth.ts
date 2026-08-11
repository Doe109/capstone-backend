/**
 * Auth Routes
 * POST /api/auth/register
 * POST /api/auth/login
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt, { SignOptions } from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import * as usersRepository from '../repositories/usersRepository';
import { JwtPayload } from '../types/auth';

const router = Router();
const SALT_ROUNDS = 12;
const JWT_SIGN_OPTIONS: SignOptions = { expiresIn: 604800 }; // 7 days in seconds

function getSecret(): string {
  return process.env.JWT_SECRET || 'fallback_dev_secret';
}

// ── POST /api/auth/register ─────────────────────────────────────────

router.post('/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const { firstName, lastName, email, password, confirmPassword } = req.body;

    if (!firstName || !lastName || !email || !password || !confirmPassword) {
      res.status(400).json({
        success: false,
        error: 'firstName, lastName, email, password, and confirmPassword are required.',
      });
      return;
    }

    if (password !== confirmPassword) {
      res.status(400).json({ success: false, error: 'Passwords do not match.' });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });
      return;
    }

    const existing = await usersRepository.findUserByEmail(email);
    if (existing) {
      res.status(409).json({ success: false, error: 'Email is already registered.' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const fullName = `${firstName} ${lastName}`.trim();

    const user = await usersRepository.createUser({
      id: uuidv4(),
      email,
      passwordHash,
      fullName,
      firstName,
      lastName,
      createdAt: now,
    });

    const payload: JwtPayload = { userId: user.id, email: user.email };
    const token = jwt.sign(payload, getSecret(), JWT_SIGN_OPTIONS);

    res.status(201).json({ success: true, user, token });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// ── POST /api/auth/login ────────────────────────────────────────────

router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ success: false, error: 'Email and password are required.' });
      return;
    }

    const userRow = await usersRepository.findUserByEmail(email);
    if (!userRow) {
      res.status(401).json({ success: false, error: 'Invalid email or password.' });
      return;
    }

    const match = await bcrypt.compare(password, userRow.passwordHash);
    if (!match) {
      res.status(401).json({ success: false, error: 'Invalid email or password.' });
      return;
    }

    // Strip passwordHash before returning
    const { passwordHash: _, ...user } = userRow;

    const payload: JwtPayload = { userId: user.id, email: user.email };
    const token = jwt.sign(payload, getSecret(), JWT_SIGN_OPTIONS);

    res.json({ success: true, user, token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

export default router;
