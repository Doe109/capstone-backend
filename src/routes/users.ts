/**
 * Users Routes (protected)
 * GET   /api/users/me        — get current user profile
 * PATCH /api/users/me        — update profile fields
 * POST  /api/users/me/photo  — upload profile photo (multer)
 */

import { Router, Request, Response } from 'express';
import * as usersRepository from '../repositories/usersRepository';
import { authenticate } from '../middleware/auth';
import { upload } from '../middleware/upload';

const router = Router();

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
    const { fullName, firstName, lastName, phone, address, profilePhotoUri } = req.body;

    const user = await usersRepository.updateUser(req.user!.userId, {
      fullName,
      firstName,
      lastName,
      phone,
      address,
      profilePhotoUri,
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

// ── POST /api/users/me/photo ────────────────────────────────────────

router.post(
  '/me/photo',
  authenticate,
  upload.single('photo'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ success: false, error: 'Photo file is required.' });
        return;
      }

      const profilePhotoUri = `/uploads/${file.filename}`;

      const user = await usersRepository.updateUser(req.user!.userId, { profilePhotoUri });
      if (!user) {
        res.status(404).json({ success: false, error: 'User not found.' });
        return;
      }

      res.json({ success: true, user });
    } catch (error) {
      console.error('Upload photo error:', error);
      res.status(500).json({ success: false, error: 'Internal server error.' });
    }
  },
);

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

export default router;
