/**
 * Reports Routes (protected)
 * POST  /api/reports            — create report (multer for photo)
 * GET   /api/reports             — list with optional filters
 * GET   /api/reports/:id         — single report
 * POST  /api/reports/:id/vote    — community vote + recompute score
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../database/connection';
import * as reportsRepository from '../repositories/reportsRepository';
import * as votesRepository from '../repositories/votesRepository';
import * as advisoriesRepository from '../repositories/advisoriesRepository';
import { authenticate, optionalAuthenticate } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { ReportStatus, SeverityLevel, VoteType } from '../types/report';
import {
  VALIDATION_RULES,
  computeLVS,
  computeCV,
  computeRRS,
  evaluateVerificationStatus,
} from '../config/validationRules';
import {
  sendNewReportNotification,
  sendRoadAdvisoryNotification,
  sendRepairUnderReviewNotification,
  sendRepairResolvedNotification,
  sendSubmitterRepairCelebrationNotification,
  sendTwoWeekFollowUpReminderNotification,
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
    return "Slow down when you see a hole in the road. Be extra careful if there is water on the road, since it may be covering a pothole. If you drive over it, hold the steering wheel firmly. Don't slam on the brakes or swerve, because this can cause an accident or endanger other drivers.";
  }
  if (normalized === 'alligator cracks' || normalized === 'alligator crack') {
    return 'Slow down when you see many small, connected cracks in the road. Cracks can make a motorcycle rider lose control, so look ahead and avoid last-minute moves.';
  }
  if (normalized === 'raveling' || normalized === 'damaged road pavement' || normalized === 'damaged pavement') {
    return "Slow down when you see loose stones or gravel on the road. Loose gravel acts like marbles under your tires and can make your vehicle skid, especially when turning. Hold the steering wheel firmly and avoid swerving. Don't speed up over the stones, and don't slam on the brakes.";
  }
  if (normalized === 'longitudinal cracks' || normalized === 'longitudinal crack') {
    return 'Slow down when you see a long crack running the same way as the road. If you must cross it, approach at close to 90° and no less than 45°. Stay relaxed on the controls and brake or accelerate gradually.';
  }
  if (normalized === 'transverse cracks' || normalized === 'transverse crack') {
    return 'Slow down when you see a crack running across the road. Cross it at close to 90° where possible. Stay relaxed on the controls and brake or accelerate gradually.';
  }
  // Generic fallback
  if (normalized.includes('crack')) {
    return 'Slow down when you see many small, connected cracks in the road. Cracks can make a motorcycle rider lose control, so look ahead and avoid last-minute moves.';
  }
  if (normalized.includes('pothole')) {
    return "Slow down when you see a hole in the road. Be extra careful if there is water on the road, since it may be covering a pothole. If you drive over it, hold the steering wheel firmly. Don't slam on the brakes or swerve, because this can cause an accident or endanger other drivers.";
  }
  if (normalized.includes('pavement') || normalized.includes('raveling')) {
    return "Slow down when you see loose stones or gravel on the road. Loose gravel acts like marbles under your tires and can make your vehicle skid, especially when turning. Hold the steering wheel firmly and avoid swerving. Don't speed up over the stones, and don't slam on the brakes.";
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
        conditionType, severityLevel, description, photoCapturedAt,
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
        if (
          r.reportStatus === 'Resolved' ||
          r.reportStatus === 'Closed'
        ) {
          return false;
        }
        if (r.conditionType.toLowerCase().trim() !== conditionType.toLowerCase().trim()) return false;
        const dist = calculateHaversineDistanceMeters(targetLat, targetLng, r.reportLatitude, r.reportLongitude);
        return dist <= 30;
      });

      if (existingDuplicate) {
        const isVerified = existingDuplicate.reportStatus === 'Verified' || existingDuplicate.reportStatus === 'Under Review';
        const errorMsg = isVerified
          ? `A ${conditionType} hazard is already active and verified in this exact area (${existingDuplicate.selectedBarangay}).`
          : `A ${conditionType} hazard is currently pending validation in this exact area (${existingDuplicate.selectedBarangay}). Please vote on the existing report to validate it for the community.`;

        res.status(409).json({
          success: false,
          isDuplicate: true,
          error: errorMsg,
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
        severityLevel: severityLevel || 'POOR',
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
    const targetReportId = report.id || reportId;
    const rawVote = req.user ? await votesRepository.getUserVoteDetails(targetReportId, req.user.userId) : null;
    const userVote = rawVote ? rawVote.voteType : null;
    const userSeverityVote = rawVote ? rawVote.severityLevel : null;
    const userRepairVote = req.user ? await reportsRepository.getUserRepairVote(targetReportId, req.user.userId) : null;
    const voteCounts = await votesRepository.getVoteCounts(targetReportId);
    const votes = await votesRepository.getVotesForReport(targetReportId);

    const onsiteAgree = voteCounts.onsiteAgreeCount ?? report.onsiteAgreeCount ?? 0;
    const onsiteDisagree = voteCounts.onsiteDisagreeCount ?? report.onsiteDisagreeCount ?? 0;
    const totalVotes = voteCounts.agreeCount + voteCounts.disagreeCount;

    let finalLvs = report.locationValidationScore ?? 0;
    let finalCv = report.communityValidationScore ?? 0.5;
    let finalRrs = report.reportReliabilityScore ?? 0.2;

    if (totalVotes > 0) {
      finalCv = computeCV(voteCounts.agreeCount, totalVotes);
      if (onsiteAgree + onsiteDisagree > 0) {
        finalLvs = computeLVS(onsiteAgree, onsiteDisagree);
      } else if (report.reportStatus === 'Verified' && (report.locationValidationScore ?? 0) > 0) {
        finalLvs = report.locationValidationScore;
      }
      finalRrs = computeRRS(finalLvs, finalCv);
    } else if (report.reportStatus === 'Verified') {
      finalLvs = Math.max(report.locationValidationScore ?? 1.0, 1.0);
      finalCv = Math.max(report.communityValidationScore ?? 0.857, 0.700);
      finalRrs = computeRRS(finalLvs, finalCv);
    }

    const enrichedReport = {
      ...report,
      onsiteAgreeCount: onsiteAgree,
      onsiteDisagreeCount: onsiteDisagree,
      locationValidationScore: finalLvs,
      communityValidationScore: finalCv,
      reportReliabilityScore: finalRrs,
      voteCounts,
      votes,
    };

    res.json({
      success: true,
      report: enrichedReport,
      userVote,
      userSeverityVote,
      userRepairVote,
      voteCounts,
      votes,
    });
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
    const { voteType, voterLatitude, voterLongitude, severityLevel } = req.body as {
      voteType: VoteType;
      voterLatitude?: number;
      voterLongitude?: number;
      severityLevel?: SeverityLevel;
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

    // Lock Voting: reject new votes if report is already Verified, Closed, or Resolved
    if (report.reportStatus === 'Verified' || report.reportStatus === 'Closed' || report.reportStatus === 'Resolved') {
      res.status(400).json({ success: false, error: 'Voting is closed for this report.' });
      return;
    }

    const isSimulated = req.body.isSimulatedPeerVote === true;
    let voterCitizenId = user.userId;
    if (isSimulated) {
      voterCitizenId = uuidv4();
      const pool = getPool();
      await pool.query(
        `INSERT IGNORE INTO users (id, email, passwordHash, fullName, firstName, lastName)
         VALUES (?, ?, 'simulated_dummy_hash', 'Simulated Citizen', 'Simulated', 'Citizen')`,
        [voterCitizenId, `simulated_${voterCitizenId}@example.com`]
      );
    }

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
      if (distanceMeters > VALIDATION_RULES.VOTE_RADIUS_M) {
        res.status(403).json({
          success: false,
          error: `Voting is only permitted within ${VALIDATION_RULES.VOTE_RADIUS_M} meters of the reported road condition (you are currently ${Math.round(distanceMeters)}m away).`,
        });
        return;
      }
    }

    // Insert vote with distanceMeters and optional severityLevel (catches duplicate-key cleanly)
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const voteResult = await votesRepository.createVote({
      id: uuidv4(),
      reportId,
      citizenId: voterCitizenId,
      voteType,
      severityLevel: severityLevel ?? null,
      votedAt: now,
      distanceMeters,
    });

    if (!voteResult.success) {
      res.status(409).json({ success: false, error: voteResult.error });
      return;
    }

    // Increment the count on the report row
    await reportsRepository.incrementVoteCount(reportId, voteType);

    // Recompute scores using new validation rules:
    // - LVS is based only on votes cast within 30m (onsiteAgree vs onsiteDisagree)
    // - CV uses Laplace Smoothing across all accepted votes (agree + 1) / (total + 2)
    // - RRS = 0.60 * LVS + 0.40 * CV
    const { agreeCount, disagreeCount, onsiteAgreeCount, onsiteDisagreeCount } =
      await votesRepository.getVoteCounts(reportId);
    const total = agreeCount + disagreeCount;

    const {
      lvs: locationValidationScore,
      cv: communityValidationScore,
      rrs: reportReliabilityScore,
      shouldVerify,
      shouldClose,
    } = evaluateVerificationStatus({
      total,
      agreeCount,
      disagreeCount,
      onsiteAgreeCount,
      onsiteDisagreeCount,
    });

    let newStatus: ReportStatus | undefined = undefined;

    // Determine majority severity across all validation votes
    const determinedSeverity = await votesRepository.calculateMajoritySeverity(
      reportId,
      report.severityLevel
    );

    if (shouldVerify) {
      newStatus = 'Verified';

      console.log(
        `[AdvisoryTrigger] VERIFICATION THRESHOLD MET: Total votes (${total}) >= 5, LVS=1, agree (${agreeCount}) > disagree (${disagreeCount}), RRS (${reportReliabilityScore}) >= 0.70 marked report ${reportId} as Verified. Determined Severity: ${determinedSeverity}`
      );

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

      let advTitle = `⚠️ Road Hazard: ${report.conditionType} Advisory`;
      let speedRange = '30-40 kph zone';
      if (determinedSeverity === 'BAD') {
        advTitle = `🚨 Critical Hazard: ${report.conditionType} Warning`;
        speedRange = '20-30 kph zone';
      } else if (determinedSeverity === 'FAIR') {
        advTitle = `ℹ️ Road Notice: ${report.conditionType} Advisory`;
        speedRange = '50-60 kph zone';
      }

      const safetyAction = getRecommendedAction(report.conditionType);
      advisoriesRepository.create({
        id: uuidv4(),
        title: advTitle,
        location: `Brgy. ${report.selectedBarangay}, ${lguName}`,
        selectedBarangay: report.selectedBarangay,
        severityLevel: determinedSeverity,
        message: `${determinedSeverity} condition (${speedRange}) sa Brgy. ${report.selectedBarangay}, ${lguName} — ${report.conditionType}. ${safetyAction}`,
        issuedAt: now,
      }).catch((advErr) => console.error('[AdvisoryTrigger] Error creating advisory:', advErr));

      // Trigger automatic push notification alert to all registered devices (excluding original reporter)
      sendRoadAdvisoryNotification({
        reportId: report.id,
        conditionType: report.conditionType,
        selectedBarangay: report.selectedBarangay,
        reporterUserId: report.citizenId,
        severityLevel: determinedSeverity,
      }).catch((pushErr) => console.error('[PushNotification] Error sending push advisory:', pushErr));
    }

    // Update score, status, and majority severity on the report row
    const updatedReport = await reportsRepository.updateReportScores(reportId, {
      communityValidationScore,
      locationValidationScore,
      reportReliabilityScore,
      severityLevel: determinedSeverity,
      ...(newStatus ? { reportStatus: newStatus } : {}),
    });

    const votes = await votesRepository.getVotesForReport(reportId);
    const enrichedReport = {
      ...updatedReport,
      onsiteAgreeCount,
      onsiteDisagreeCount,
      voteCounts: {
        agreeCount,
        disagreeCount,
        onsiteAgreeCount,
        onsiteDisagreeCount,
      },
      votes,
    };

    res.status(201).json({
      success: true,
      agreeCount,
      disagreeCount,
      onsiteAgreeCount,
      onsiteDisagreeCount,
      voteCounts: {
        agreeCount,
        disagreeCount,
        onsiteAgreeCount,
        onsiteDisagreeCount,
      },
      communityValidationScore,
      locationValidationScore,
      reportReliabilityScore,
      userVote: voteType,
      votes,
      report: enrichedReport,
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

      // Enforce 30m Proximity Gate for repair photo capture (Table 7 R10-R11 & Test CR06)
      const targetLat = report.reportLatitude || report.capturedLatitude;
      const targetLng = report.reportLongitude || report.capturedLongitude;
      const numLat = typeof voterLatitude === 'string' ? parseFloat(voterLatitude) : voterLatitude;
      const numLng = typeof voterLongitude === 'string' ? parseFloat(voterLongitude) : voterLongitude;

      const isTester = Boolean(
        user.email?.toLowerCase().includes('tester') ||
        user.userId === 'usr_tester_roadwatch' ||
        (user as any).role === 'tester' ||
        (user as any).role === 'admin'
      );

      if (!isTester && typeof numLat === 'number' && !isNaN(numLat) && typeof numLng === 'number' && !isNaN(numLng) && targetLat && targetLng) {
        const distanceMeters = calculateHaversineDistanceMeters(numLat, numLng, targetLat, targetLng);
        if (distanceMeters > VALIDATION_RULES.LOCATION_RADIUS_M) {
          res.status(403).json({
            success: false,
            error: `Capturing repair evidence is only permitted within 30 meters of the road condition (you are currently ${Math.round(distanceMeters)}m away).`,
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

      const isTester = Boolean(
        user.email?.toLowerCase().includes('tester') ||
        user.userId === 'usr_tester_roadwatch' ||
        (user as any).role === 'tester' ||
        (user as any).role === 'admin'
      );

      // Check if user is the submitter of the repair evidence (unless in simulated test mode or isTester)
      if (report.resolvedByCitizenId === user.userId && !isSimulated && !isTester) {
        res.status(403).json({
          success: false,
          error: 'The person who submitted the repair photo cannot vote on their own repair verification.',
        });
        return;
      }

      // 100m Proximity Gate for Voting (bypassed for tester and simulated peer votes)
      const targetLat = report.reportLatitude || report.capturedLatitude;
      const targetLng = report.reportLongitude || report.capturedLongitude;
      if (!isTester && !isSimulated && typeof voterLatitude === 'number' && typeof voterLongitude === 'number' && targetLat && targetLng) {
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
      const totalRepairVotes = repairAgree + repairDisagree;

      // 5 independent peer votes required to evaluate resolution status
      // (5-0 and 3-2 -> Resolved; 2-3 -> Revert to Verified)
      const shouldResolve = totalRepairVotes >= VALIDATION_RULES.MIN_REPAIR_VOTES && repairAgree > repairDisagree;
      const shouldRevertToVerified = totalRepairVotes >= VALIDATION_RULES.MIN_REPAIR_VOTES && repairDisagree >= repairAgree;

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

// ── POST /api/reports/:id/set-age ─────────────────────────────────────
// Explicitly sets report age in days (7 for 'Ni Tung-Tung', 8 for 'Ni Lapas', 0 for today)
router.post(
  '/:id/set-age',
  optionalAuthenticate,
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    try {
      const rawId = req.params.id;
      const reportId = decodeURIComponent(rawId || '').trim();
      const { daysAgo } = req.body as { daysAgo?: number };
      const parsedDays = typeof daysAgo === 'number' ? daysAgo : 7;

      const updated = await reportsRepository.setReportAgeDays(reportId, parsedDays);
      if (!updated) {
        res.status(404).json({ success: false, error: 'Report not found.' });
        return;
      }
      res.status(200).json({
        success: true,
        message: `Report age successfully set to ${parsedDays} day(s) ago.`,
        report: updated,
      });
    } catch (error) {
      console.error('Set report age error:', error);
      res.status(500).json({ success: false, error: 'Internal server error.' });
    }
  }
);

// ── POST /api/reports/:id/reset-votes ─────────────────────────────────
// Resets all community votes for this report back to 0 (Pending Validation) for demo
router.post(
  '/:id/reset-votes',
  optionalAuthenticate,
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    try {
      const rawId = req.params.id;
      const reportId = decodeURIComponent(rawId || '').trim();
      const updated = await reportsRepository.resetReportVotes(reportId);
      if (!updated) {
        res.status(404).json({ success: false, error: 'Report not found.' });
        return;
      }
      res.status(200).json({
        success: true,
        message: 'Report votes and reliability score reset to baseline.',
        report: updated,
      });
    } catch (error) {
      console.error('Reset report votes error:', error);
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
      const targetReportId = updated.id || reportId;
      const voteCounts = await votesRepository.getVoteCounts(targetReportId);
      const votes = await votesRepository.getVotesForReport(targetReportId);
      const enriched = {
        ...updated,
        voteCounts,
        votes,
      };
      res.status(200).json({
        success: true,
        message: 'Report test modifications saved successfully.',
        report: enriched,
      });
    } catch (error) {
      console.error('Test edit report error:', error);
      res.status(500).json({ success: false, error: 'Internal server error.' });
    }
  }
);

// ── POST /api/reports/:id/trigger-followup ──────────────────────────
// Broadcasts 2-week follow-up status check reminder to ALL registered users (Table 7 R15)
router.post(
  '/:id/trigger-followup',
  optionalAuthenticate,
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    try {
      const rawId = req.params.id;
      const reportId = decodeURIComponent(rawId || '').trim();
      const report = await reportsRepository.findReportById(reportId);
      if (!report) {
        res.status(404).json({ success: false, error: 'Report not found.' });
        return;
      }

      // Fast-forward report age in database to 15 days ago
      await reportsRepository.fastForwardReportDays(reportId, 15);

      // Broadcast push notification to ALL registered users via Expo Push Service
      await sendTwoWeekFollowUpReminderNotification({
        reportId: report.id,
        conditionType: report.conditionType,
        selectedBarangay: report.selectedBarangay,
      });

      res.status(200).json({
        success: true,
        message: 'Two-week follow-up reminder broadcasted to all registered devices.',
      });
    } catch (error) {
      console.error('Trigger follow-up error:', error);
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

