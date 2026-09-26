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
import { authenticate, optionalAuthenticate } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { ReportStatus, VoteType } from '../types/report';
import {
  sendNewReportNotification,
  sendRoadAdvisoryNotification,
  sendRepairUnderReviewNotification,
  sendRepairResolvedNotification,
  sendSubmitterRepairCelebrationNotification,
} from '../services/pushNotificationService';
import { optimizeUploadedImage } from '../utils/imageOptimizer';

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

export function getRecommendedAction(conditionType?: string | null): string {
  const normalized = (conditionType || '').toLowerCase().trim();
  if (normalized === 'pothole') {
    return 'Slow down and watch for the hole ahead. Avoid swerving suddenly into the opposite lane. Motorcycles and bicycles should pass around it with care.';
  }
  if (normalized === 'road crack') {
    return 'Proceed with care. Motorcycles and bicycles should avoid riding along the crack line, where tires can catch.';
  }
  if (normalized === 'damaged pavement') {
    return 'Slow down and expect broken or loose surface material. Keep a safe distance from the vehicle ahead and avoid hard braking.';
  }
  if (normalized === 'surface deterioration') {
    return 'Reduce speed. The surface may be rough or slippery, especially when wet, so allow extra braking distance.';
  }
  if (normalized === 'uneven road surface') {
    return 'Reduce speed to keep control over the uneven section. Motorcycles and bicycles should hold steady and avoid sudden movements.';
  }
  return 'Proceed with caution, reduce speed, and observe road conditions carefully.';
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

      // Optimize uploaded photo on the fly with sharp (90-95% file size reduction)
      if (file && file.path) {
        await optimizeUploadedImage(file.path);
      }

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

      // Broadcast community awareness notification for new report (excludes reporter)
      sendNewReportNotification({
        reportId: report.id,
        conditionType: report.conditionType,
        selectedBarangay: report.selectedBarangay,
        reporterUserId: user.userId,
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

router.get('/:id', optionalAuthenticate, async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const reportId = decodeURIComponent(rawId || '').trim();
    const report = await reportsRepository.findReportById(reportId);
    if (!report) {
      res.status(404).json({ success: false, error: 'Report not found.' });
      return;
    }
    const userVote = req.user ? await votesRepository.getUserVote(reportId, req.user.userId) : null;
    const userRepairVote = req.user ? await reportsRepository.getUserRepairVote(reportId, req.user.userId) : null;
    res.json({ success: true, report, userVote, userRepairVote });
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

    const isSimulated = req.body.isSimulatedPeerVote === true;
    const voterCitizenId = isSimulated ? uuidv4() : user.userId;

    // Prevent author from voting on own report (unless in simulated test mode)
    if (report.citizenId === user.userId && !isSimulated) {
      res.status(403).json({
        success: false,
        error: 'As the author of this report, you cannot submit a community validation vote on your own submission.',
      });
      return;
    }

    // Prevent double voting (unless in simulated test mode)
    if (!isSimulated) {
      const existingVote = await votesRepository.getUserVote(reportId, user.userId);
      if (existingVote) {
        res.status(409).json({
          success: false,
          error: `You have already submitted a validation vote (${existingVote === 'agree' ? 'Confirmed' : 'Disputed'}) on this road hazard.`,
          userVote: existingVote,
        });
        return;
      }
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
      citizenId: voterCitizenId,
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

    // Road Reliability Score (Manuscript Formula): RRS = 0.60 * LVS + 0.40 * CV (60% Location, 40% Community)
    const reportReliabilityScore = parseFloat(
      ((0.60 * locationValidationScore) + (0.40 * communityValidationScore)).toFixed(3)
    );

    const isTestingOverride = process.env.TESTING_SINGLE_VOTE_VERIFY === 'true';
    // Production verification requires minimum 3 independent validators, agreeCount > disagreeCount, and RRS >= 0.70
    const shouldVerify = isTestingOverride
      ? agreeCount >= 1 // DEMO/TESTING OVERRIDE ONLY
      : total >= 3 && agreeCount > disagreeCount && reportReliabilityScore >= 0.70;

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

      // Auto-generate GIS Advisory entry across all 17 LGUs
      const lguMap: Record<string, string[]> = {
        'Jimenez': [
          'adorable', 'butuay', 'carmen', 'corrales', 'dicoloc', 'gata', 'guintomoyan',
          'macabayao', 'malibacsan', 'matugas alto', 'matugas bajo', 'mialem',
          'nacional', 'naga', 'palilan', 'rizal', 'san isidro', 'santa cruz', 'seti',
          'sibaroc', 'sinara alto', 'sinara bajo', 'tabo-o', 'taraka'
        ],
        'Oroquieta City': [
          'apil', 'binuangan', 'bolibol', 'buenavista', 'bunga', 'canubay', 'clarin settlement',
          'dolipos', 'dulapo', 'dullan', 'langcangan', 'lamac', 'loboc', 'mobod', 'paypayan',
          'pines', 'poblacion 1', 'poblacion 2', 'proper langcangan', 'senote', 'taboc', 'talairon', 'tipan', 'toliyok', 'victoria', 'villaflor'
        ],
        'Tangub City': [
          'aquino', 'balatacan', 'baloc', 'banglay', 'bintana', 'bocator', 'bongabong', 'caniangan', 'capalaran', 'catagan', 'garang', 'guinabot', 'hoyohoy', 'kauswagan', 'kimat', 'labuyo', 'maloro', 'manga', 'matugnao', 'minsubong', 'prenza', 'salimpuno', 'sumirap', 'taguite', 'titunod', 'tiaman', 'tugas'
        ],
        'Clarin': ['bernad', 'bito-on', 'cabog', 'canibungan', 'dalicob', 'dolores', 'guba', 'guimbatao', 'kinangay', 'lapasan', 'lupagan', 'masabud', 'segatic', 'sebasi', 'tinaclaan'],
        'Tudela': ['balon', 'barra', 'basiric', 'biga', 'cahayag', 'camating', 'centro hulpa', 'colambutan', 'duero', 'gumbil', 'locso-on', 'maikay', 'maribojoc', 'mitugas', 'nailon', 'namut', 'pan-ay', 'silongon', 'taguima', 'tigdok', 'yahoy'],
        'Sinacaban': ['cagay-anon', 'camanse', 'colupan', 'dinas', 'estrella', 'katipunan', 'libertad', 'san lorenzo', 'señor', 'sinonoc', 'villaba'],
        'Panaon': ['baha', 'bangko', 'camanucan', 'dela paz', 'lutao', 'magsaysay', 'mapurog', 'mohon', 'punta', 'salimpuno', 'villalba'],
        'Aloran': ['balintonga', 'banisilon', 'burgos', 'calube', 'caputol', 'casus-an', 'conat', 'dalisay', 'ditoro', 'himaya', 'hinacoban', 'lobogon', 'lumbayao', 'makawa', 'manamong', 'matipaz', 'maular', 'mitazan', 'monterico', 'nabuna', 'palayan', 'pelong', 'roxas', 'sinampongan', 'taguanao', 'tuburan', 'zamora'],
        'Plaridel': ['agalayan', 'agunod', 'bato', 'buena voluntad', 'calaca-an', 'cartagena', 'catarman', 'cebulin', 'deboloc', 'divisoria', 'ilisan', 'lao', 'looc', 'mamunga', 'mangidkid', 'panalsalan', 'puntod', 'quirino', 'tipolo', 'unidos', 'usocan'],
        'Calamba': ['bonifacio', 'bunawan', 'calaran', 'dapacan', 'langub', 'liboron', 'magcamuing', 'mamalad', 'mauswagon', 'salvador', 'siloy', 'singalat', 'solinog', 'sulipat'],
        'Baliangao': ['del monte', 'landing', 'lumipac', 'lusot', 'mabini', 'mampanao', 'misom', 'mituro', 'punta miray', 'punta sulona', 'sianib', 'sina-ad'],
        'Sapang Dalaga': ['agapito yap', 'bautista', 'bitibut', 'boundary', 'caluya', 'capundag', 'casul', 'dasa', 'dioyo', 'disacan', 'el paraiso', 'locus', 'macabao', 'manla', 'masubong', 'medallo', 'sixto velez'],
        'Bonifacio': ['anonang', 'bagumbayan', 'baybay', 'bolinsong', 'buracan', 'calumbit', 'dimalco', 'dullan', 'liconan', 'lodiong', 'usogan', 'migpange', 'montol', 'pisa-an', 'remedios', 'rufino lumapas', 'sibucao', 'tingcob', 'tusik'],
        'Don Victoriano': ['bagong clarin', 'gandawan', 'lake duminagat', 'lalud', 'lampasan', 'mansawan', 'nueva vista', 'petianan', 'tuno', 'mara-mara'],
        'Concepcion': ['bagong nayon', 'capule', 'guiban', 'laya-an', 'lingatongan', 'maligubaan', 'mantukoy', 'marugang', 'pogan', 'small potongan', 'soso-on', 'virayan', 'new casul'],
      };

      const normBrgy = (report.selectedBarangay || '').toLowerCase().trim();
      let lguName = 'Misamis Occidental';

      for (const [lgu, brgys] of Object.entries(lguMap)) {
        if (brgys.some((b) => normBrgy.includes(b))) {
          lguName = lgu;
          break;
        }
      }
      if (lguName === 'Misamis Occidental') {
        lguName = 'Ozamiz City';
      }

      const safetyAction = getRecommendedAction(report.conditionType);
      advisoriesRepository.create({
        id: uuidv4(),
        title: `${report.conditionType} Warning`,
        location: `Brgy. ${report.selectedBarangay}, ${lguName}`,
        selectedBarangay: report.selectedBarangay,
        message: `${safetyAction} (Validated ${report.conditionType.toLowerCase()} in Brgy. ${report.selectedBarangay}, ${lguName})`,
        issuedAt: now,
      }).catch((advErr) => console.error('[AdvisoryTrigger] Error creating advisory:', advErr));

      // Trigger automatic push notification alert to all registered devices (excluding original reporter)
      sendRoadAdvisoryNotification({
        reportId: report.id,
        conditionType: report.conditionType,
        selectedBarangay: report.selectedBarangay,
        reporterUserId: report.citizenId,
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
// Citizen submits repair evidence photo -> Transitions status to 'Under Review'
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
      const { voterLatitude, voterLongitude } = req.body;

      const report = await reportsRepository.findReportById(reportId);
      if (!report) {
        res.status(404).json({ success: false, error: 'Report not found.' });
        return;
      }

      // Enforce 30m Proximity Gate for repair photo capture
      const targetLat = report.reportLatitude || report.capturedLatitude;
      const targetLng = report.reportLongitude || report.capturedLongitude;
      const numLat = typeof voterLatitude === 'string' ? parseFloat(voterLatitude) : voterLatitude;
      const numLng = typeof voterLongitude === 'string' ? parseFloat(voterLongitude) : voterLongitude;

      if (typeof numLat === 'number' && !isNaN(numLat) && typeof numLng === 'number' && !isNaN(numLng) && targetLat && targetLng) {
        const distanceMeters = calculateHaversineDistanceMeters(numLat, numLng, targetLat, targetLng);
        if (distanceMeters > 100) {
          res.status(403).json({
            success: false,
            error: `Capturing repair evidence is only permitted within 100 meters of the road condition (you are currently ${Math.round(distanceMeters)}m away).`,
          });
          return;
        }
      }

      if (!file) {
        res.status(400).json({ success: false, error: 'Resolution photo is required.' });
        return;
      }

      if (file.path) {
        await optimizeUploadedImage(file.path);
      }
      const resolutionPhotoUri = `/uploads/${file.filename}`;

      // Mark report as 'Under Review' and store submitter's repair proof
      const updatedReport = await reportsRepository.submitRepairProof(reportId, resolutionPhotoUri, user.userId);

      // Trigger automatic push notification alert to all barangay citizens for review
      sendRepairUnderReviewNotification({
        reportId: report.id,
        conditionType: report.conditionType,
        selectedBarangay: report.selectedBarangay,
        submitterUserId: user.userId,
      }).catch((pushErr) => console.error('[PushNotification] Error sending repair review push:', pushErr));

      res.status(200).json({
        success: true,
        isFixed: true,
        reportStatus: 'Under Review',
        message: 'Repair evidence submitted. Report is now Under Review for community verification.',
        report: updatedReport,
        userRepairVote: null,
      });
    } catch (error) {
      console.error('Resolution error:', error);
      res.status(500).json({ success: false, error: 'Internal server error.' });
    }
  }
);

// ── POST /api/reports/:id/resolution/vote ───────────────────────────
// Community Repair Validation Vote (Na-ayo Na / Fixed vs Guba Pa Gihapon / Still Damaged)
router.post(
  '/:id/resolution/vote',
  authenticate,
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
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

      const report = await reportsRepository.findReportById(reportId);
      if (!report) {
        res.status(404).json({ success: false, error: 'Report not found.' });
        return;
      }

      if (report.reportStatus !== 'Under Review') {
        res.status(400).json({
          success: false,
          error: `Repair verification voting is only allowed for reports with 'Under Review' status (current status: ${report.reportStatus}).`,
        });
        return;
      }

      const isSimulated = (req.body as any).isSimulatedPeerVote === true;
      const voterCitizenId = isSimulated ? uuidv4() : user.userId;

      // Check if user is the submitter of the repair evidence (unless in simulated test mode)
      if (report.resolvedByCitizenId === user.userId && !isSimulated) {
        res.status(403).json({
          success: false,
          error: 'The person who submitted the repair photo cannot vote on their own repair verification.',
        });
        return;
      }

      // 100m Proximity Gate for Voting
      const targetLat = report.reportLatitude || report.capturedLatitude;
      const targetLng = report.reportLongitude || report.capturedLongitude;
      if (typeof voterLatitude === 'number' && typeof voterLongitude === 'number' && targetLat && targetLng) {
        const distanceMeters = calculateHaversineDistanceMeters(voterLatitude, voterLongitude, targetLat, targetLng);
        if (distanceMeters > 100) {
          res.status(403).json({
            success: false,
            error: `Repair verification voting is only permitted within 100 meters of the road condition (you are currently ${Math.round(distanceMeters)}m away).`,
          });
          return;
        }
      }

      const voteResult = await reportsRepository.voteOnRepair(reportId, voterCitizenId, voteType);
      if (!voteResult.success) {
        res.status(409).json({ success: false, error: voteResult.error });
        return;
      }

      // Fetch fresh counts
      const freshReport = await reportsRepository.findReportById(reportId);
      const repairAgree = freshReport?.repairAgreeCount ?? 0;
      const repairDisagree = freshReport?.repairDisagreeCount ?? 0;

      const isTestingOverride = process.env.TESTING_SINGLE_VOTE_VERIFY === 'true';
      // 3 independent peer votes required to officially mark as Resolved
      const shouldResolve = isTestingOverride ? repairAgree >= 1 : repairAgree >= 3;
      const shouldRevertToVerified = isTestingOverride ? repairDisagree >= 1 : repairDisagree >= 2;

      let finalReport = freshReport;

      if (shouldResolve) {
        // Mark as Resolved & Deactivate Advisory & Send Push Notification
        finalReport = await reportsRepository.resolveReport(reportId, freshReport?.resolutionPhotoUri, freshReport?.resolvedByCitizenId);
        await advisoriesRepository.deactivateByBarangay(report.selectedBarangay);

        const repairSubmitterId = freshReport?.resolvedByCitizenId;

        // Broadcast to all other citizens in the community (excluding submitter)
        sendRepairResolvedNotification({
          reportId: report.id,
          conditionType: report.conditionType,
          selectedBarangay: report.selectedBarangay,
          excludeUserId: repairSubmitterId || user.userId,
        }).catch((pushErr) => console.error('[PushNotification] Error sending repair resolved push:', pushErr));

        // Send personal celebration push notification directly to the repair submitter
        if (repairSubmitterId) {
          sendSubmitterRepairCelebrationNotification({
            reportId: report.id,
            conditionType: report.conditionType,
            selectedBarangay: report.selectedBarangay,
            submitterUserId: repairSubmitterId,
          }).catch((pushErr) => console.error('[PushNotification] Error sending submitter celebration push:', pushErr));
        }

        console.log(`[RepairResolution] ✅ Report ${reportId} officially marked as Resolved by community vote consensus.`);
      } else if (shouldRevertToVerified) {
        // Community rejected repair claim -> Revert to Verified (Active Hazard), clear invalid photo, NO push notification
        finalReport = await reportsRepository.revertRepairToVerified(reportId);
        console.log(`[RepairResolution] ⚠️ Report ${reportId} reverted back to Verified (Active Hazard) by community vote consensus.`);
      }

      res.status(200).json({
        success: true,
        userRepairVote: voteType,
        repairAgreeCount: finalReport?.repairAgreeCount ?? repairAgree,
        repairDisagreeCount: finalReport?.repairDisagreeCount ?? repairDisagree,
        reportStatus: finalReport?.reportStatus,
        report: finalReport,
      });
    } catch (error) {
      console.error('Repair vote error:', error);
      res.status(500).json({ success: false, error: 'Internal server error.' });
    }
  }
);

// ── POST /api/reports/:id/fast-forward-7days ─────────────────────────
// Fast-forwards report createdAt by 8 days and evaluates 7-day validation decay
router.post(
  '/:id/fast-forward-7days',
  optionalAuthenticate,
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    try {
      const rawId = req.params.id;
      const reportId = decodeURIComponent(rawId || '').trim();
      const updated = await reportsRepository.fastForwardReportDays(reportId, 8);
      if (!updated) {
        res.status(404).json({ success: false, error: 'Report not found.' });
        return;
      }
      res.status(200).json({
        success: true,
        message: 'Report timestamp fast-forwarded by 8 days. 7-day decay evaluation completed.',
        report: updated,
      });
    } catch (error) {
      console.error('Fast-forward 7 days error:', error);
      res.status(500).json({ success: false, error: 'Internal server error.' });
    }
  }
);

// ── PUT /api/reports/:id/test-edit ────────────────────────────────────
// Allows editing report details, replacing photo evidence, and resetting/overriding vote counts for empirical tests
router.put(
  '/:id/test-edit',
  optionalAuthenticate,
  upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'resolutionPhoto', maxCount: 1 },
  ]),
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    try {
      const rawId = req.params.id;
      const reportId = decodeURIComponent(rawId || '').trim();
      const updates = { ...req.body };
      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

      if (files?.['photo']?.[0]?.path) {
        await optimizeUploadedImage(files['photo'][0].path);
        updates.photoUri = `/uploads/${files['photo'][0].filename}`;
      }
      if (files?.['resolutionPhoto']?.[0]?.path) {
        await optimizeUploadedImage(files['resolutionPhoto'][0].path);
        updates.resolutionPhotoUri = `/uploads/${files['resolutionPhoto'][0].filename}`;
      }

      const updated = await reportsRepository.testEditReport(reportId, updates);
      if (!updated) {
        res.status(404).json({ success: false, error: 'Report not found.' });
        return;
      }
      res.status(200).json({
        success: true,
        message: 'Report test modifications saved successfully.',
        report: updated,
      });
    } catch (error) {
      console.error('Test edit report error:', error);
      res.status(500).json({ success: false, error: 'Internal server error.' });
    }
  }
);

// ── DELETE /api/reports/:id ───────────────────────────────────────────
// Allows permanently deleting a report (tester / admin action)
router.delete(
  '/:id',
  optionalAuthenticate,
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    try {
      const rawId = req.params.id;
      const reportId = decodeURIComponent(rawId || '').trim();
      const deleted = await reportsRepository.deleteReport(reportId);
      if (!deleted) {
        res.status(404).json({ success: false, error: 'Report not found or already deleted.' });
        return;
      }
      res.status(200).json({
        success: true,
        message: 'Report and associated records deleted permanently.',
        deletedId: reportId,
      });
    } catch (error) {
      console.error('Delete report error:', error);
      res.status(500).json({ success: false, error: 'Internal server error.' });
    }
  }
);

export default router;

