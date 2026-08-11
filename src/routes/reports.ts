/**
 * Reports Routes (protected)
 * POST  /api/reports            — create report (multer for photo)
 * GET   /api/reports             — list with optional filters
 * GET   /api/reports/:id         — single report
 * POST  /api/reports/:id/vote    — community vote + recompute score
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as reportsRepository from '../repositories/reportsRepository';
import * as votesRepository from '../repositories/votesRepository';
import { authenticate } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { ReportStatus, VoteType } from '../types/report';
import { sendRoadAdvisoryNotification } from '../services/pushNotificationService';

const router = Router();

// ── POST /api/reports ───────────────────────────────────────────────

router.post(
  '/',
  authenticate,
  upload.single('photo'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const user = req.user!;
      const file = req.file;

      if (!file) {
        res.status(400).json({ success: false, error: 'Photo file is required.' });
        return;
      }

      const {
        conditionType, description, photoCapturedAt,
        capturedLatitude, capturedLongitude, locationAccuracyMeters,
        reportLatitude, reportLongitude,
        selectedBarangay, locationEvidenceStatus, citizenName,
      } = req.body;

      if (!conditionType || !selectedBarangay) {
        res.status(400).json({
          success: false,
          error: 'conditionType and selectedBarangay are required.',
        });
        return;
      }

      const finalDescription =
        description && typeof description === 'string' && description.trim()
          ? description.trim()
          : `${conditionType} reported at Brgy. ${selectedBarangay}`;

      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const photoUri = `/uploads/${file.filename}`;

      const report = await reportsRepository.createReport({
        id: uuidv4(),
        citizenId: user.userId,
        citizenName: citizenName || 'Citizen',
        conditionType,
        description: finalDescription,
        photoUri,
        photoCapturedAt: photoCapturedAt || now,
        capturedLatitude: parseFloat(capturedLatitude) || 0,
        capturedLongitude: parseFloat(capturedLongitude) || 0,
        locationAccuracyMeters: parseFloat(locationAccuracyMeters) || 0,
        reportLatitude: parseFloat(reportLatitude) || 0,
        reportLongitude: parseFloat(reportLongitude) || 0,
        selectedBarangay,
        createdAt: now,
        updatedAt: now,
        submittedAt: now,
        locationEvidenceStatus: locationEvidenceStatus || 'Captured',
      });

      res.status(201).json({ success: true, report });
    } catch (error) {
      console.error('Create report error:', error);
      res.status(500).json({ success: false, error: 'Internal server error.' });
    }
  },
);

// ── GET /api/reports ────────────────────────────────────────────────

router.get('/', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { status, barangay, mine } = req.query;

    const filters: reportsRepository.ReportFilters = {};

    if (status && typeof status === 'string') {
      filters.status = status as ReportStatus;
    }
    if (barangay && typeof barangay === 'string') {
      filters.barangay = barangay;
    }
    if (mine === 'true') {
      filters.citizenId = req.user!.userId;
    }

    const reports = await reportsRepository.listReports(filters);
    res.json({ success: true, reports });
  } catch (error) {
    console.error('List reports error:', error);
    res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// ── GET /api/reports/:id ────────────────────────────────────────────

router.get('/:id', authenticate, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  try {
    const report = await reportsRepository.findReportById(req.params.id);
    if (!report) {
      res.status(404).json({ success: false, error: 'Report not found.' });
      return;
    }
    res.json({ success: true, report });
  } catch (error) {
    console.error('Get report error:', error);
    res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// ── POST /api/reports/:id/vote ──────────────────────────────────────

router.post('/:id/vote', authenticate, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const reportId = req.params.id;
    const { voteType } = req.body as { voteType: VoteType };

    if (!voteType || !['agree', 'disagree'].includes(voteType)) {
      res.status(400).json({ success: false, error: 'voteType must be "agree" or "disagree".' });
      return;
    }

    // Verify report exists
    const report = await reportsRepository.findReportById(reportId);
    if (!report) {
      res.status(404).json({ success: false, error: 'Report not found.' });
      return;
    }

    // Insert vote (catches duplicate-key cleanly)
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const voteResult = await votesRepository.createVote({
      id: uuidv4(),
      reportId,
      citizenId: user.userId,
      voteType,
      votedAt: now,
    });

    if (!voteResult.success) {
      res.status(409).json({ success: false, error: voteResult.error });
      return;
    }

    // Increment the count on the report row
    await reportsRepository.incrementVoteCount(reportId, voteType);

    // Recompute communityValidationScore and reportReliabilityScore from actual tallies
    const { agreeCount, disagreeCount } = await votesRepository.getVoteCounts(reportId);
    const total = agreeCount + disagreeCount;
    const communityValidationScore = total > 0
      ? parseFloat((agreeCount / total).toFixed(3))
      : 0;

    const locationValidationScore = report.locationAccuracyMeters <= 20 ? 1.0 : 0.5;
    const reportReliabilityScore = parseFloat(
      ((0.6 * communityValidationScore) + (0.4 * locationValidationScore)).toFixed(3)
    );

    const isTestingOverride = process.env.TESTING_SINGLE_VOTE_VERIFY === 'true';
    const shouldVerify = isTestingOverride
      ? agreeCount >= 1 // TEMP: 1 agree vote = instantly verified, for testing only
      : reportReliabilityScore >= 0.80; // real manuscript production threshold

    const wasNotVerified = report.reportStatus !== 'Verified';

    let newStatus: any = undefined;

    if (shouldVerify && wasNotVerified) {
      newStatus = 'Verified';

      if (isTestingOverride) {
        console.log(
          `[AdvisoryTrigger] TEMPORARY OVERRIDE TRIGGERED: 1 agree vote (agreeCount=${agreeCount}) marked report ${reportId} as Verified.`
        );
      } else {
        console.log(
          `[AdvisoryTrigger] MANUSCRIPT RRS THRESHOLD MET: RRS (${reportReliabilityScore}) >= 0.80 marked report ${reportId} as Verified.`
        );
      }

      // Trigger automatic push notification alert to all registered devices
      sendRoadAdvisoryNotification({
        reportId: report.id,
        conditionType: report.conditionType,
        selectedBarangay: report.selectedBarangay,
      }).catch((pushErr) => console.error('[PushNotification] Error sending push advisory:', pushErr));
    }

    // Update score and status on the report row
    const updatedReport = await reportsRepository.updateReportScores(reportId, {
      communityValidationScore,
      locationValidationScore,
      reportReliabilityScore,
      ...(newStatus ? { reportStatus: newStatus } : {}),
    });

    res.status(201).json({
      success: true,
      agreeCount,
      disagreeCount,
      communityValidationScore,
      userVote: voteType,
      report: updatedReport,
    });
  } catch (error) {
    console.error('Vote error:', error);
    res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

export default router;
