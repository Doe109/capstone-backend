/**
 * Users Routes (protected)
 * GET   /api/users/me        — get current user profile
 * PATCH /api/users/me        — update profile fields
 * POST  /api/users/me/photo  — upload profile photo (multer)
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import * as usersRepository from '../repositories/usersRepository';
import { authenticate } from '../middleware/auth';
import * as pushNotificationService from '../services/pushNotificationService';

const router = Router();
const SALT_ROUNDS = 12;

// ── GET /api/users/me ───────────────────────────────────────────────

router.get('/me', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await usersRepository.findUserById(req.user!.userId);
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found.' });
      return;
    }
    res.json({ success: true, user });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// ── PATCH /api/users/me ─────────────────────────────────────────────

router.patch('/me', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { fullName, firstName, lastName, email } = req.body;

    if (email) {
      const existing = await usersRepository.findUserByEmail(email);
      if (existing && existing.id !== req.user!.userId) {
        res.status(409).json({ success: false, error: 'Email address is already in use.' });
        return;
      }
    }

    const user = await usersRepository.updateUser(req.user!.userId, {
      fullName,
      firstName,
      lastName,
      email,
    });

    if (!user) {
      res.status(404).json({ success: false, error: 'User not found.' });
      return;
    }

    res.json({ success: true, user });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// ── POST /api/users/me/push-token ──────────────────────────────────

router.post('/me/push-token', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { pushToken } = req.body;
    if (!pushToken || typeof pushToken !== 'string') {
      res.status(400).json({ success: false, error: 'pushToken is required.' });
      return;
    }

    await usersRepository.updatePushToken(req.user!.userId, pushToken.trim());
    console.log(`[usersRoute] Updated push token for user ${req.user!.userId}: ${pushToken.trim().substring(0, 25)}...`);
    res.json({ success: true, message: 'Push token updated successfully.' });
  } catch (error) {
    console.error('Update push token error:', error);
    res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// ── POST /api/users/test-push (Diagnostic Push Broadcast) ───────────

router.post('/test-push', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pushNotificationService.sendTestPushNotification();
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('Test push error:', error);
    res.status(500).json({ success: false, error: error?.message || 'Internal server error.' });
  }
});

// ── GET /api/users/push-tokens (Diagnostic Token Count) ────────────

router.get('/push-tokens', async (_req: Request, res: Response): Promise<void> => {
  try {
    const rawTokens = await usersRepository.getAllPushTokens();
    res.json({
      success: true,
      version: 'v3-isolated',
      totalRegisteredTokens: rawTokens.length,
      tokens: rawTokens.map((t) => t.substring(0, 15) + '...'),
    });
  } catch (error: any) {
    console.error('Get push tokens error:', error);
    res.status(500).json({ success: false, error: error?.message || 'Internal server error.' });
  }
});


// ── PATCH /api/users/me/password ────────────────────────────────────

router.patch('/me/password', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword) {
      res.status(400).json({
        success: false,
        error: 'Current password and new password are required.',
      });
      return;
    }

    if (newPassword.length < 6) {
      res.status(400).json({
        success: false,
        error: 'New password must be at least 6 characters.',
      });
      return;
    }

    if (confirmPassword && newPassword !== confirmPassword) {
      res.status(400).json({
        success: false,
        error: 'New password and confirm password do not match.',
      });
      return;
    }

    const userRow = await usersRepository.findUserRowById(req.user!.userId);
    if (!userRow) {
      res.status(404).json({ success: false, error: 'User not found.' });
      return;
    }

    const match = await bcrypt.compare(currentPassword, userRow.passwordHash);
    if (!match) {
      res.status(400).json({ success: false, error: 'Incorrect current password. Please try again.' });
      return;
    }

    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await usersRepository.updatePassword(req.user!.userId, newHash);

    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

export default router;
