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
import * as advisoriesRepository from '../repositories/advisoriesRepository';
import { authenticate } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { ReportStatus, VoteType } from '../types/report';
import { sendNewReportNotification, sendRoadAdvisoryNotification } from '../services/pushNotificationService';

const router = Router();

function formatMysqlDateTime(dateStr?: string): string {
  if (!dateStr) return new Date().toISOString().slice(0, 19).replace('T', ' ');
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 19).replace('T', ' ');
    return d.toISOString().slice(0, 19).replace('T', ' ');
  } catch {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
  }
}

function calculateHaversineDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

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
        id,
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

      const targetLat = parseFloat(reportLatitude) || parseFloat(capturedLatitude) || 0;
      const targetLng = parseFloat(reportLongitude) || parseFloat(capturedLongitude) || 0;

      // Duplicate Prevention Check: Search active reports of same condition within 30 meters
      const allActiveReports = await reportsRepository.listReports();
      const existingDuplicate = allActiveReports.find((r) => {
        if (r.reportStatus === 'Resolved') return false;
        if (r.conditionType.toLowerCase().trim() !== conditionType.toLowerCase().trim()) return false;
        const dist = calculateHaversineDistanceMeters(targetLat, targetLng, r.reportLatitude, r.reportLongitude);
        return dist <= 30;
      });

      if (existingDuplicate) {
        res.status(409).json({
          success: false,
          isDuplicate: true,
          error: `A ${conditionType} hazard is already active in this exact area (${existingDuplicate.selectedBarangay}). Please vote on the existing report to validate it for the community.`,
          existingReport: existingDuplicate,
        });
        return;
      }

      const finalDescription =
        description && typeof description === 'string' && description.trim()
          ? description.trim()
          : `${conditionType} reported at Brgy. ${selectedBarangay}`;

      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const photoUri = `/uploads/${file.filename}`;
      const finalId = (id && typeof id === 'string' && id.trim()) ? id.trim() : uuidv4();

      const report = await reportsRepository.createReport({
        id: finalId,
        citizenId: user.userId,
        citizenName: citizenName || 'Citizen',
        conditionType,
        description: finalDescription,
        photoUri,
        photoCapturedAt: formatMysqlDateTime(photoCapturedAt),
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

      // Broadcast community awareness notification for new report
      sendNewReportNotification({
        reportId: report.id,
        conditionType: report.conditionType,
        selectedBarangay: report.selectedBarangay,
      }).catch((notifErr) => console.error('[CreateReport] Error broadcasting new report notification:', notifErr));

      res.status(201).json({ success: true, report });
    } catch (error: any) {
      console.error('Create report error:', error);
      res.status(500).json({ success: false, error: error?.message || 'Internal server error.' });
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
    const rawId = req.params.id;
    const reportId = decodeURIComponent(rawId || '').trim();
    const report = await reportsRepository.findReportById(reportId);
    if (!report) {
      res.status(404).json({ success: false, error: 'Report not found.' });
      return;
    }
    const userVote = req.user ? await votesRepository.getUserVote(reportId, req.user.userId) : null;
    res.json({ success: true, report, userVote });
  } catch (error) {
    console.error('Get report error:', error);
    res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// ── POST /api/reports/:id/vote ──────────────────────────────────────

router.post('/:id/vote', authenticate, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const rawId = req.params.id;
    const reportId = decodeURIComponent(rawId || '').trim();
    const { voteType, voterLatitude, voterLongitude } = req.body as {
      voteType: VoteType;
      voterLatitude?: number;
      voterLongitude?: number;
    };

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

    // Prevent author from voting on own report
    if (report.citizenId === user.userId) {
      res.status(403).json({
        success: false,
        error: 'As the author of this report, you cannot submit a community validation vote on your own submission.',
      });
      return;
    }

    // Prevent double voting
    const existingVote = await votesRepository.getUserVote(reportId, user.userId);
    if (existingVote) {
      res.status(409).json({
        success: false,
        error: `You have already submitted a validation vote (${existingVote === 'agree' ? 'Confirmed' : 'Disputed'}) on this road hazard.`,
        userVote: existingVote,
      });
      return;
    }

    // Enforce 100m Proximity Voting Gate if voter coordinates are supplied
    const targetLat = report.reportLatitude || report.capturedLatitude;
    const targetLng = report.reportLongitude || report.capturedLongitude;
    let distanceMeters: number | null = null;

    if (
      typeof voterLatitude === 'number' &&
      typeof voterLongitude === 'number' &&
      targetLat &&
      targetLng
    ) {
      distanceMeters = calculateHaversineDistanceMeters(voterLatitude, voterLongitude, targetLat, targetLng);
      if (distanceMeters > 100) {
        res.status(403).json({
          success: false,
          error: `Voting is only permitted within 100 meters of the reported road condition (you are currently ${Math.round(distanceMeters)}m away).`,
        });
        return;
      }
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

    // Recompute communityValidationScore (CV) using Laplace Smoothing: (agreeCount + 1) / (total + 2)
    const { agreeCount, disagreeCount } = await votesRepository.getVoteCounts(reportId);
    const total = agreeCount + disagreeCount;
    const communityValidationScore = parseFloat(((agreeCount + 1) / (total + 2)).toFixed(3));

    // Dual-Radii Location Verification Score (LVS):
    // If vote was cast on-site within 30m -> LVS = 1.0; else (30m - 100m) -> LVS = 0.0 (or default capture accuracy score if no voter coords)
    const isWithin30m = distanceMeters !== null ? distanceMeters <= 30 : report.locationAccuracyMeters <= 20;
    const locationValidationScore = isWithin30m ? 1.0 : 0.0;

    // Road Reliability Score: RRS = 0.60 * CV + 0.40 * LVS
    const reportReliabilityScore = parseFloat(
      ((0.6 * communityValidationScore) + (0.4 * locationValidationScore)).toFixed(3)
    );

    const isTestingOverride = process.env.TESTING_SINGLE_VOTE_VERIFY === 'true';
    // Production verification requires minimum 3 independent validators and RRS >= 0.70
    const shouldVerify = isTestingOverride
      ? agreeCount >= 1 // DEMO/TESTING OVERRIDE ONLY
      : total >= 3 && reportReliabilityScore >= 0.70;

    const wasNotVerified = report.reportStatus !== 'Verified';

    let newStatus: any = undefined;

    const shouldDispute = !isTestingOverride && total >= 3 && disagreeCount > agreeCount && communityValidationScore < 0.50;

    if (shouldVerify && wasNotVerified) {
      newStatus = 'Verified';

      if (isTestingOverride) {
        console.log(
          `[AdvisoryTrigger] TEMPORARY OVERRIDE TRIGGERED: 1 agree vote (agreeCount=${agreeCount}) marked report ${reportId} as Verified.`
        );
      } else {
        console.log(
          `[AdvisoryTrigger] MANUSCRIPT RRS THRESHOLD MET: Total votes (${total}) >= 3 and RRS (${reportReliabilityScore}) >= 0.70 marked report ${reportId} as Verified.`
        );
      }

      // Auto-generate GIS Advisory entry
      const jimenezList = [
        'Adorable', 'Butuay', 'Carmen', 'Corrales', 'Dicoloc', 'Gata', 'Guintomoyan',
        'Macabayao', 'Malibacsan', 'Matugas Alto', 'Matugas Bajo', 'Mialem',
        'Nacional (Poblacion)', 'Naga (Poblacion)', 'Palilan', 'Rizal (Poblacion)',
        'San Isidro', 'Santa Cruz (Poblacion)', 'Seti', 'Sibaroc', 'Sinara Alto',
        'Sinara Bajo', 'Tabo-o', 'Taraka (Poblacion)',
      ];
      const isJimenez = jimenezList.some((b) => b.toLowerCase() === (report.selectedBarangay || '').toLowerCase().trim());
      const lguName = isJimenez ? 'Jimenez' : 'Ozamiz City';

      advisoriesRepository.create({
        id: uuidv4(),
        title: `${report.conditionType} Warning`,
        location: `Brgy. ${report.selectedBarangay}, ${lguName}`,
        selectedBarangay: report.selectedBarangay,
        message: `Validated ${report.conditionType.toLowerCase()} reported in Brgy. ${report.selectedBarangay}, ${lguName}. Motorists are advised to take caution.`,
        issuedAt: now,
      }).catch((advErr) => console.error('[AdvisoryTrigger] Error creating advisory:', advErr));

      // Trigger automatic push notification alert to all registered devices
      sendRoadAdvisoryNotification({
        reportId: report.id,
        conditionType: report.conditionType,
        selectedBarangay: report.selectedBarangay,
      }).catch((pushErr) => console.error('[PushNotification] Error sending push advisory:', pushErr));
    } else if (shouldDispute && report.reportStatus === 'Pending Validation') {
      newStatus = 'Disputed';
      console.log(
        `[DisputeTrigger] DISPUTE THRESHOLD MET: Total votes (${total}) with ${disagreeCount} disputes marked report ${reportId} as Disputed.`
      );
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

// ── POST /api/reports/:id/resolution ───────────────────────────────
// Community Resolution / Status Update -> Has Road Condition Been Fixed?
// YES -> Mark as Resolved Road Condition (reportStatus = 'Resolved', resolvedAt = NOW(), save resolution photo, deactivate advisory)
// NO  -> Keep Advisory Active (reportStatus remains 'Verified', advisory stays active)
router.post(
  '/:id/resolution',
  authenticate,
  upload.single('resolutionPhoto'),
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    try {
      const rawId = req.params.id;
      const reportId = decodeURIComponent(rawId || '').trim();
      const user = req.user!;
      const file = req.file;
      const rawIsFixed = req.body.isFixed;
      const isFixed = rawIsFixed === true || rawIsFixed === 'true' || rawIsFixed === 1 || rawIsFixed === '1';

      const report = await reportsRepository.findReportById(reportId);
      if (!report) {
        res.status(404).json({ success: false, error: 'Report not found.' });
        return;
      }

      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const resolutionPhotoUri = file ? `/uploads/${file.filename}` : null;

      if (isFixed) {
        // "Has Road Condition Been Fixed?" -> YES
        // 1. Mark report as Resolved with resolution photo & verifier ID
        const resolvedReport = await reportsRepository.resolveReport(reportId, resolutionPhotoUri, user.userId);

        // 2. Deactivate active advisory for this road section
        await advisoriesRepository.deactivateByBarangay(report.selectedBarangay);

        res.status(200).json({
          success: true,
          isFixed: true,
          reportStatus: 'Resolved',
          resolvedAt: now,
          resolutionPhotoUri: resolvedReport?.resolutionPhotoUri || resolutionPhotoUri,
          message: 'Road condition marked as Resolved with verification photo. Advisory deactivated.',
          report: resolvedReport,
        });
      } else {
        // "Has Road Condition Been Fixed?" -> NO
        // Keep Advisory Active
        res.status(200).json({
          success: true,
          isFixed: false,
          reportStatus: report.reportStatus,
          message: 'Road condition still active. Advisory remains active on GIS Map.',
          report,
        });
      }
    } catch (error) {
      console.error('Resolution error:', error);
      res.status(500).json({ success: false, error: 'Internal server error.' });
    }
  }
);

export default router;
