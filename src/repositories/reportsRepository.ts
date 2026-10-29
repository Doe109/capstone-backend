/**
 * Reports Repository
 * createReport, findReportById, listReports,
 * incrementVoteCount, updateReportScores
 */

import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { getPool } from '../database/connection';
import { ReportStatus, RoadReport, SeverityLevel, VoteType } from '../types/report';
import * as advisoriesRepository from './advisoriesRepository';
import * as votesRepository from './votesRepository';
import { computeCV, computeLVS, computeRRS } from '../config/validationRules';

function formatIsoTimestamp(val: any): string {
  if (!val) return val;
  if (val instanceof Date) return val.toISOString();
  const str = String(val).trim();
  if (str.endsWith('Z')) return str;
  const isoStr = str.replace(' ', 'T');
  return isoStr.endsWith('Z') ? isoStr : `${isoStr}Z`;
}

function rowToReport(row: RowDataPacket): RoadReport {
  const agreeCount = Number(row.communityAgreeCount ?? 0);
  const disagreeCount = Number(row.communityDisagreeCount ?? 0);
  const total = agreeCount + disagreeCount;
  const cv = total > 0 ? computeCV(agreeCount, total) : Number(row.communityValidationScore ?? 0.5);

  const onsiteAgree = row.onsiteAgreeCount !== undefined ? Number(row.onsiteAgreeCount) : 0;
  const onsiteDisagree = row.onsiteDisagreeCount !== undefined ? Number(row.onsiteDisagreeCount) : 0;

  const lvs = (onsiteAgree > 0 || onsiteDisagree > 0)
    ? computeLVS(onsiteAgree, onsiteDisagree)
    : Number(row.locationValidationScore ?? 0);

  const rrs = (onsiteAgree > 0 || onsiteDisagree > 0 || total > 0)
    ? computeRRS(lvs, cv)
    : Number(row.reportReliabilityScore ?? 0.2);

  return {
    id: row.id,
    reportNumber: row.reportNumber ? Number(row.reportNumber) : undefined,
    citizenId: row.citizenId,
    citizenName: row.citizenName,
    conditionType: row.conditionType,
    severityLevel: (row.severityLevel as SeverityLevel) || 'POOR',
    description: row.description,
    photoUri: row.photoUri,
    photoCapturedAt: formatIsoTimestamp(row.photoCapturedAt),
    capturedLatitude: Number(row.capturedLatitude),
    capturedLongitude: Number(row.capturedLongitude),
    locationAccuracyMeters: Number(row.locationAccuracyMeters),
    reportLatitude: Number(row.reportLatitude),
    reportLongitude: Number(row.reportLongitude),
    selectedBarangay: row.selectedBarangay,
    createdAt: formatIsoTimestamp(row.createdAt),
    updatedAt: formatIsoTimestamp(row.updatedAt),
    submittedAt: formatIsoTimestamp(row.submittedAt),
    reportStatus: row.reportStatus,
    syncStatus: row.syncStatus,
    locationEvidenceStatus: row.locationEvidenceStatus,
    communityAgreeCount: agreeCount,
    communityDisagreeCount: disagreeCount,
    communityValidationScore: cv,
    // Aliases for the RN app
    confirmCount: agreeCount,
    disputeCount: disagreeCount,
    locationValidationScore: lvs,
    reportReliabilityScore: rrs,
    onsiteAgreeCount: onsiteAgree,
    onsiteDisagreeCount: onsiteDisagree,
    voteCounts: {
      agreeCount,
      disagreeCount,
      onsiteAgreeCount: onsiteAgree,
      onsiteDisagreeCount: onsiteDisagree,
    },
    advisoryText: row.advisoryText ?? null,
    verifiedAt: row.verifiedAt ? formatIsoTimestamp(row.verifiedAt) : null,
    resolvedAt: row.resolvedAt ? formatIsoTimestamp(row.resolvedAt) : null,
    closedAt: row.closedAt ? formatIsoTimestamp(row.closedAt) : null,
    resolutionPhotoUri: row.resolutionPhotoUri ?? null,
    resolvedByCitizenId: row.resolvedByCitizenId ?? null,
    repairAgreeCount: Number(row.repairAgreeCount ?? 0),
    repairDisagreeCount: Number(row.repairDisagreeCount ?? 0),
    previousRepairAgreeCount: Number(row.previousRepairAgreeCount ?? 0),
    previousRepairDisagreeCount: Number(row.previousRepairDisagreeCount ?? 0),
    previousResolutionAttemptAt: row.previousResolutionAttemptAt ? formatIsoTimestamp(row.previousResolutionAttemptAt) : null,
    repairPhotoDistanceMeters: row.repairPhotoDistanceMeters !== null && row.repairPhotoDistanceMeters !== undefined ? Number(row.repairPhotoDistanceMeters) : null,
    resolutionHistory: (() => {
      try {
        if (row.resolutionHistory) {
          const parsed = typeof row.resolutionHistory === 'string' ? JSON.parse(row.resolutionHistory) : row.resolutionHistory;
          return Array.isArray(parsed) ? parsed : [];
        }
      } catch {}
      return [];
    })(),
  };
}

// ── Repository functions ────────────────────────────────────────────

export interface ReportFilters {
  status?: ReportStatus;
  barangay?: string;
  citizenId?: string;
}

export async function createReport(report: {
  id: string;
  citizenId: string;
  citizenName: string;
  conditionType: string;
  severityLevel?: string;
  description: string;
  photoUri: string;
  photoCapturedAt: string;
  capturedLatitude: number;
  capturedLongitude: number;
  locationAccuracyMeters: number;
  reportLatitude: number;
  reportLongitude: number;
  selectedBarangay: string;
  createdAt: string;
  updatedAt: string;
  submittedAt: string;
  locationEvidenceStatus: string;
}): Promise<RoadReport> {
  const pool = getPool();
  const severity = report.severityLevel || 'POOR';

  let nextReportNumber = 1001;
  try {
    const [numRows] = await pool.query<RowDataPacket[]>('SELECT MAX(reportNumber) AS maxNum FROM reports');
    if (numRows && numRows[0] && numRows[0].maxNum) {
      nextReportNumber = Math.max(1001, Number(numRows[0].maxNum) + 1);
    }
  } catch {}

  await pool.query<ResultSetHeader>(
    `INSERT INTO reports
       (id, reportNumber, citizenId, citizenName, conditionType, severityLevel, description,
        photoUri, photoCapturedAt,
        capturedLatitude, capturedLongitude, locationAccuracyMeters,
        reportLatitude, reportLongitude, selectedBarangay,
        createdAt, updatedAt, submittedAt,
        reportStatus, syncStatus, locationEvidenceStatus)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending Validation', 'synced', ?)`,
    [
      report.id, nextReportNumber, report.citizenId, report.citizenName,
      report.conditionType, severity, report.description,
      report.photoUri, report.photoCapturedAt,
      report.capturedLatitude, report.capturedLongitude, report.locationAccuracyMeters,
      report.reportLatitude, report.reportLongitude, report.selectedBarangay,
      report.createdAt, report.updatedAt, report.submittedAt,
      report.locationEvidenceStatus,
    ],
  );
  const created = await findReportById(report.id);
  if (!created) throw new Error('Report creation failed — row not found after insert.');
  return created;
}

/**
 * 7-Day Window Evaluation:
 * At the end of the 7-day validation window, unverified 'Pending Validation' reports:
 * - Become 'Closed' whatever the reason (insufficient votes, tie, disagreement, or low RRS).
 * 
 * For 'Under Review' repair reports:
 * - If repairAgreeCount >= 5 and repairAgreeCount > repairDisagreeCount -> Become 'Resolved'.
 * - Otherwise -> Revert to 'Verified' with advisory remaining active.
 */
export async function evaluateExpiredPendingReports(): Promise<void> {
  const pool = getPool();
  try {
    // 1. Expire unverified Pending Validation reports to Closed when exceeding 7 full days
    const [expiredRows] = await pool.query<RowDataPacket[]>(
      `SELECT selectedBarangay FROM reports 
       WHERE reportStatus = 'Pending Validation' 
         AND createdAt < DATE_SUB(NOW(), INTERVAL 7 DAY)`
    );

    await pool.query(
      `UPDATE reports 
       SET reportStatus = 'Closed',
           closedAt = COALESCE(closedAt, DATE_ADD(createdAt, INTERVAL 7 DAY)),
           updatedAt = NOW()
       WHERE reportStatus = 'Pending Validation' 
         AND createdAt < DATE_SUB(NOW(), INTERVAL 7 DAY)`
    );

    if (expiredRows && expiredRows.length > 0) {
      for (const row of expiredRows) {
        if (row.selectedBarangay) {
          await advisoriesRepository.deactivateByBarangay(row.selectedBarangay).catch(() => {});
        }
      }
    }

    // 2. Evaluate expired Under Review reports (7 days after submitted repair)
    const [expiredRepairs] = await pool.query<RowDataPacket[]>(
      `SELECT id, selectedBarangay, repairAgreeCount, repairDisagreeCount FROM reports
       WHERE reportStatus = 'Under Review'
         AND updatedAt < DATE_SUB(NOW(), INTERVAL 7 DAY)`
    );

    if (expiredRepairs && expiredRepairs.length > 0) {
      for (const rep of expiredRepairs) {
        const agree = Number(rep.repairAgreeCount ?? 0);
        const disagree = Number(rep.repairDisagreeCount ?? 0);
        if (agree >= 5 && agree > disagree) {
          await pool.query(
            `UPDATE reports SET reportStatus = 'Resolved', resolvedAt = NOW(), updatedAt = NOW() WHERE id = ?`,
            [rep.id]
          );
          if (rep.selectedBarangay) {
            await advisoriesRepository.deactivateByBarangay(rep.selectedBarangay).catch(() => {});
          }
        } else {
          // Revert back to Verified with full resolutionHistory preservation
          const reason = (agree + disagree === 0)
            ? 'No votes'
            : agree < 5 && agree >= disagree
            ? 'Fewer than five votes'
            : 'Claim Rejected';
          await revertRepairToVerified(rep.id, reason);
        }
      }
    }
  } catch (err) {
    console.warn('[evaluateExpiredPendingReports] Notice evaluating 7-day window:', err);
  }
}

/**
 * Find a report by ID.
 */
export async function findReportById(id: string): Promise<RoadReport | null> {
  const pool = getPool();
  await evaluateExpiredPendingReports();
  const cleanId = (id || '').trim();
  const cleanNumStr = cleanId.replace(/^RW-/i, '').replace(/^#/, '').trim();
  const numId = /^\d+$/.test(cleanNumStr) ? parseInt(cleanNumStr, 10) : null;
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT 
       r.*,
       COALESCE(SUM(CASE WHEN v.voteType = 'agree' AND v.distanceMeters IS NOT NULL AND v.distanceMeters <= 30 THEN 1 ELSE 0 END), 0) AS onsiteAgreeCount,
       COALESCE(SUM(CASE WHEN v.voteType = 'disagree' AND v.distanceMeters IS NOT NULL AND v.distanceMeters <= 30 THEN 1 ELSE 0 END), 0) AS onsiteDisagreeCount
     FROM reports r
     LEFT JOIN community_votes v ON v.reportId = r.id
     WHERE (r.id = ? OR r.id = ? OR r.reportNumber = ?)
     GROUP BY r.id
     LIMIT 1`,
    [cleanId, id, numId],
  );
  if (rows.length === 0) return null;
  return rowToReport(rows[0]);
}

/**
 * List reports with optional filtering by status, barangay, or citizenId.
 */
export async function listReports(filters?: ReportFilters): Promise<RoadReport[]> {
  const pool = getPool();
  await evaluateExpiredPendingReports();
  let sql = `
    SELECT 
      r.*,
      COALESCE(SUM(CASE WHEN v.voteType = 'agree' AND v.distanceMeters IS NOT NULL AND v.distanceMeters <= 30 THEN 1 ELSE 0 END), 0) AS onsiteAgreeCount,
      COALESCE(SUM(CASE WHEN v.voteType = 'disagree' AND v.distanceMeters IS NOT NULL AND v.distanceMeters <= 30 THEN 1 ELSE 0 END), 0) AS onsiteDisagreeCount
    FROM reports r
    LEFT JOIN community_votes v ON v.reportId = r.id
  `;
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (filters?.status) {
    clauses.push('r.reportStatus = ?');
    params.push(filters.status);
  }
  if (filters?.barangay) {
    clauses.push('r.selectedBarangay = ?');
    params.push(filters.barangay);
  }
  if (filters?.citizenId) {
    clauses.push('r.citizenId = ?');
    params.push(filters.citizenId);
  }

  if (clauses.length > 0) {
    sql += ' WHERE ' + clauses.join(' AND ');
  }
  sql += ' GROUP BY r.id ORDER BY r.createdAt DESC';

  const [rows] = await pool.query<RowDataPacket[]>(sql, params);
  return rows.map(rowToReport);
}

/**
 * Increment communityAgreeCount or communityDisagreeCount by 1.
 */
export async function incrementVoteCount(
  reportId: string,
  voteType: VoteType,
): Promise<void> {
  const pool = getPool();
  const column = voteType === 'agree' ? 'communityAgreeCount' : 'communityDisagreeCount';
  await pool.query<ResultSetHeader>(
    `UPDATE reports SET ${column} = ${column} + 1, updatedAt = ? WHERE id = ?`,
    [new Date().toISOString().slice(0, 19).replace('T', ' '), reportId],
  );
}

/**
 * Update the DSS scores and optionally the status on a report.
 */
export async function updateReportScores(
  reportId: string,
  scores: {
    communityValidationScore: number;
    locationValidationScore?: number;
    reportReliabilityScore?: number;
    reportStatus?: ReportStatus;
    severityLevel?: SeverityLevel;
  },
): Promise<RoadReport | null> {
  const pool = getPool();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const updates: Record<string, unknown> = {
    communityValidationScore: scores.communityValidationScore,
    updatedAt: now,
  };

  if (scores.locationValidationScore !== undefined) {
    updates.locationValidationScore = scores.locationValidationScore;
  }
  if (scores.reportReliabilityScore !== undefined) {
    updates.reportReliabilityScore = scores.reportReliabilityScore;
  }
  if (scores.severityLevel) {
    updates.severityLevel = scores.severityLevel;
  }
  if (scores.reportStatus) {
    updates.reportStatus = scores.reportStatus;
    if (scores.reportStatus === 'Verified') {
      updates.verifiedAt = now;
    } else if (scores.reportStatus === 'Resolved') {
      updates.resolvedAt = now;
    } else if (scores.reportStatus === 'Closed') {
      updates.closedAt = now;
    }
  }

  const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  const values = Object.values(updates);

  await pool.query<ResultSetHeader>(
    `UPDATE reports SET ${setClauses} WHERE id = ?`,
    [...values, reportId],
  );

  return findReportById(reportId);
}

/**
 * Submit repair evidence: marks report as 'Under Review' and stores resolution photo.
 */
export async function submitRepairProof(
  reportId: string,
  resolutionPhotoUri: string,
  resolvedByCitizenId: string
): Promise<RoadReport | null> {
  const pool = getPool();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  // Clear any old repair votes for fresh review
  try {
    await pool.query(`DELETE FROM repair_votes WHERE reportId = ?`, [reportId]);
  } catch (rvErr) {
    console.warn('[submitRepairProof] Notice clearing old repair_votes:', rvErr);
  }

  // The person who takes the repair photo does NOT count as a "fixed" vote.
  // We initialize repairAgreeCount to 0. 3 independent community peers must verify and vote.
  await pool.query<ResultSetHeader>(
    `UPDATE reports 
     SET reportStatus = 'Under Review', 
         resolutionPhotoUri = ?, 
         resolvedByCitizenId = ?, 
         repairAgreeCount = 0, 
         repairDisagreeCount = 0, 
         updatedAt = ? 
     WHERE id = ?`,
    [resolutionPhotoUri, resolvedByCitizenId, now, reportId]
  );
  return findReportById(reportId);
}

/**
 * Record a citizen's vote on repair verification ('agree' for Fixed, 'disagree' for Still Damaged).
 */
export async function voteOnRepair(
  reportId: string,
  citizenId: string,
  voteType: VoteType
): Promise<{ success: boolean; error?: string }> {
  const pool = getPool();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const { v4: uuidv4 } = await import('uuid');

  try {
    // Block submitter from voting on their own repair evidence
    const [reportRows] = await pool.query<RowDataPacket[]>(
      'SELECT resolvedByCitizenId FROM reports WHERE id = ?',
      [reportId]
    );
    if (reportRows && reportRows.length > 0 && reportRows[0].resolvedByCitizenId === citizenId) {
      return {
        success: false,
        error: 'The person who submitted the repair photo cannot vote on their own repair verification.',
      };
    }

    await pool.query(
      `INSERT INTO repair_votes (id, reportId, citizenId, voteType, votedAt) VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), reportId, citizenId, voteType, now]
    );

    const col = voteType === 'agree' ? 'repairAgreeCount' : 'repairDisagreeCount';
    await pool.query<ResultSetHeader>(
      `UPDATE reports SET ${col} = ${col} + 1, updatedAt = ? WHERE id = ?`,
      [now, reportId]
    );
    return { success: true };
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') {
      return { success: false, error: 'You have already voted on this repair verification.' };
    }
    throw err;
  }
}

/**
 * Get citizen's vote on repair verification if any.
 */
export async function getUserRepairVote(
  reportId: string,
  citizenId: string
): Promise<VoteType | null> {
  try {
    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT voteType FROM repair_votes WHERE reportId = ? AND citizenId = ? LIMIT 1`,
      [reportId, citizenId]
    );
    if (!rows || rows.length === 0) return null;
    return rows[0].voteType as VoteType;
  } catch (err) {
    console.warn('[reportsRepository.getUserRepairVote] Notice querying repair_votes:', err);
    return null;
  }
}

/**
 * Revert a repair claim back to 'Verified' (Active Hazard) when community votes 'Still Damaged'.
 */
export async function revertRepairToVerified(reportId: string, customResult?: string): Promise<RoadReport | null> {
  const pool = getPool();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const current = await findReportById(reportId);
  const prevAgree = current?.repairAgreeCount ?? 0;
  const prevDisagree = current?.repairDisagreeCount ?? 0;

  let history: any[] = [];
  try {
    if (current?.resolutionHistory) {
      history = typeof current.resolutionHistory === 'string' ? JSON.parse(current.resolutionHistory) : current.resolutionHistory;
    }
  } catch {}
  if (!Array.isArray(history)) history = [];

  const verdict = customResult || (
    prevAgree + prevDisagree === 0
      ? 'No votes'
      : (prevAgree < 5 && prevAgree >= prevDisagree)
      ? 'Fewer than five votes'
      : 'Claim Rejected'
  );

  history.push({
    attemptNumber: history.length + 1,
    evaluatedAt: now,
    agreeCount: prevAgree,
    disagreeCount: prevDisagree,
    totalVotes: prevAgree + prevDisagree,
    result: verdict,
  });

  try {
    await pool.query(`DELETE FROM repair_votes WHERE reportId = ?`, [reportId]);
  } catch (e) {
    console.warn('[revertRepairToVerified] Notice deleting repair_votes:', e);
  }
  await pool.query<ResultSetHeader>(
    `UPDATE reports 
     SET reportStatus = 'Verified', 
         previousRepairAgreeCount = ?,
         previousRepairDisagreeCount = ?,
         previousResolutionAttemptAt = ?,
         resolutionHistory = ?,
         resolutionPhotoUri = NULL, 
         resolvedByCitizenId = NULL, 
         repairAgreeCount = 0, 
         repairDisagreeCount = 0, 
         updatedAt = ? 
     WHERE id = ?`,
    [prevAgree, prevDisagree, now, JSON.stringify(history), now, reportId]
  );
  return findReportById(reportId);
}

/**
 * Mark a road condition report as Resolved, save the resolution photo, and set resolvedAt timestamp.
 */
export async function resolveReport(
  reportId: string,
  resolutionPhotoUri?: string | null,
  resolvedByCitizenId?: string | null
): Promise<RoadReport | null> {
  const pool = getPool();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await pool.query<ResultSetHeader>(
    `UPDATE reports SET reportStatus = 'Resolved', resolvedAt = ?, updatedAt = ?, resolutionPhotoUri = COALESCE(?, resolutionPhotoUri), resolvedByCitizenId = COALESCE(?, resolvedByCitizenId) WHERE id = ?`,
    [now, now, resolutionPhotoUri ?? null, resolvedByCitizenId ?? null, reportId],
  );
  return findReportById(reportId);
}


/**
 * Fast forward a report's createdAt timestamp by X days (for research testing of 7-day validation window expiration).
 */
export async function fastForwardReportDays(reportId: string, daysAgo: number = 8): Promise<RoadReport | null> {
  return setReportAgeDays(reportId, daysAgo);
}

/**
 * Explicitly set report age in days (e.g. 7 for 'Ni Tung-Tung', 8+ for 'Ni Lapas', 0 for today).
 * Updates both createdAt and photoCapturedAt so all metadata stays consistent.
 */
export async function setReportAgeDays(reportId: string, daysAgo: number): Promise<RoadReport | null> {
  const pool = getPool();
  const report = await findReportById(reportId);
  if (!report) return null;

  if (daysAgo === 7) {
    // 5 minutes before 7 days end: (7 * 1440 - 5) = 10075 minutes ago, leaving 5 minutes of voting time
    if (report.reportStatus === 'Under Review') {
      await pool.query<ResultSetHeader>(
        `UPDATE reports 
         SET updatedAt = DATE_SUB(NOW(), INTERVAL 10075 MINUTE)
         WHERE id = ?`,
        [reportId]
      );
    } else {
      await pool.query<ResultSetHeader>(
        `UPDATE reports 
         SET createdAt = DATE_SUB(NOW(), INTERVAL 10075 MINUTE),
             photoCapturedAt = DATE_SUB(NOW(), INTERVAL 10075 MINUTE),
             reportStatus = 'Pending Validation',
             updatedAt = NOW()
         WHERE id = ?`,
        [reportId]
      );
    }
  } else if (daysAgo >= 8) {
    if (report.reportStatus === 'Under Review') {
      const agree = Number(report.repairAgreeCount || 0);
      const disagree = Number(report.repairDisagreeCount || 0);
      if (agree >= 5 && agree > disagree) {
        return resolveReport(reportId);
      } else {
        const reason = (agree + disagree === 0)
          ? 'No votes'
          : (agree < 5 && agree >= disagree)
          ? 'Fewer than five votes'
          : 'Claim Rejected';
        return revertRepairToVerified(reportId, reason);
      }
    }
    // 'Ni Lapas sa 7 Days': 8+ days old. If community quorum not reached, transition to Closed
    const agree = Number(report.communityAgreeCount || 0);
    const disagree = Number(report.communityDisagreeCount || 0);
    const total = agree + disagree;
    const finalStatus = total >= 5 && agree > disagree ? 'Verified' : 'Closed';
    const nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await pool.query<ResultSetHeader>(
      `UPDATE reports 
       SET createdAt = DATE_SUB(NOW(), INTERVAL ? DAY),
           photoCapturedAt = DATE_SUB(NOW(), INTERVAL ? DAY),
           reportStatus = ?,
           verifiedAt = CASE WHEN ? = 'Verified' THEN COALESCE(verifiedAt, ?) ELSE verifiedAt END,
           closedAt = CASE WHEN ? = 'Closed' THEN COALESCE(closedAt, ?) ELSE closedAt END,
           updatedAt = NOW()
       WHERE id = ?`,
      [daysAgo, daysAgo, finalStatus, finalStatus, nowIso, finalStatus, nowIso, reportId]
    );
    if (finalStatus === 'Closed' && report.selectedBarangay) {
      await advisoriesRepository.deactivateByBarangay(report.selectedBarangay).catch(() => {});
    }
  } else if (daysAgo === 0) {
    // Fresh report (Just Now / Today)
    const freshStatus = report.reportStatus === 'Under Review' ? 'Under Review' : 'Pending Validation';
    await pool.query<ResultSetHeader>(
      `UPDATE reports 
       SET createdAt = NOW(),
           photoCapturedAt = NOW(),
           reportStatus = ?,
           closedAt = NULL,
           updatedAt = NOW()
       WHERE id = ?`,
      [freshStatus, reportId]
    );
  } else {
    await pool.query<ResultSetHeader>(
      `UPDATE reports 
       SET createdAt = DATE_SUB(NOW(), INTERVAL ? DAY),
           photoCapturedAt = DATE_SUB(NOW(), INTERVAL ? DAY),
           reportStatus = ?,
           updatedAt = NOW()
       WHERE id = ?`,
      [daysAgo, daysAgo, report.reportStatus === 'Under Review' ? 'Under Review' : 'Pending Validation', reportId]
    );
  }

  return findReportById(reportId);
}

/**
 * Resets all votes for a report back to 0 and reverts status to Pending Validation.
 * Allows test accounts to demonstrate the consensus voting process from scratch.
 */
export async function resetReportVotes(reportId: string): Promise<RoadReport | null> {
  const pool = getPool();
  const report = await findReportById(reportId);
  if (!report) return null;

  try {
    await pool.query(`DELETE FROM community_votes WHERE reportId = ?`, [reportId]);
  } catch (err) {
    console.warn('[resetReportVotes] Notice deleting community_votes:', err);
  }

  try {
    await pool.query(`DELETE FROM repair_votes WHERE reportId = ?`, [reportId]);
  } catch (err) {
    console.warn('[resetReportVotes] Notice deleting repair_votes:', err);
  }

  // Initial Laplace default score: CV = 0.500, LVS = 0.000, RRS = 0.200
  await pool.query<ResultSetHeader>(
    `UPDATE reports 
     SET communityAgreeCount = 0,
         communityDisagreeCount = 0,
         communityValidationScore = 0.500,
         locationValidationScore = 0.000,
         reportReliabilityScore = 0.200,
         repairAgreeCount = 0,
         repairDisagreeCount = 0,
         reportStatus = 'Pending Validation',
         resolutionPhotoUri = NULL,
         resolvedAt = NULL,
         updatedAt = NOW()
     WHERE id = ?`,
    [reportId]
  );

  if (report.selectedBarangay) {
    await advisoriesRepository.deactivateByBarangay(report.selectedBarangay).catch(() => {});
  }

  return findReportById(reportId);
}

/**
 * Edit report properties and optionally reset/override vote counts for empirical testing.
 */
export async function testEditReport(
  reportId: string,
  updates: {
    conditionType?: string;
    description?: string;
    photoUri?: string;
    resolutionPhotoUri?: string;
    communityAgreeCount?: number;
    communityDisagreeCount?: number;
    repairAgreeCount?: number;
    repairDisagreeCount?: number;
    reportStatus?: ReportStatus;
    reportLatitude?: number;
    reportLongitude?: number;
    capturedLatitude?: number;
    capturedLongitude?: number;
    selectedBarangay?: string;
    createdAt?: string;
    photoCapturedAt?: string;
    verifiedAt?: string | null;
    resolvedAt?: string | null;
    closedAt?: string | null;
    previousRepairAgreeCount?: number;
    previousRepairDisagreeCount?: number;
    previousResolutionAttemptAt?: string | null;
    resolutionHistory?: any[];
    repairPhotoDistanceMeters?: number | null;
  }
): Promise<RoadReport | null> {
  const pool = getPool();
  const report = await findReportById(reportId);
  if (!report) return null;

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const voteCounts = await votesRepository.getVoteCounts(reportId);
  const agree = updates.communityAgreeCount !== undefined ? Number(updates.communityAgreeCount) : report.communityAgreeCount;
  const disagree = updates.communityDisagreeCount !== undefined ? Number(updates.communityDisagreeCount) : report.communityDisagreeCount;
  const total = agree + disagree;
  const communityValidationScore = computeCV(agree, total);

  let onsiteAgree = voteCounts.onsiteAgreeCount;
  let onsiteDisagree = voteCounts.onsiteDisagreeCount;

  if (agree > 0 && onsiteAgree === 0 && (updates.communityAgreeCount !== undefined || updates.reportStatus === 'Verified')) {
    onsiteAgree = Math.min(agree, 2);
    try {
      const votes = await votesRepository.getVotesForReport(reportId);
      if (votes.length === 0) {
        for (let i = 0; i < agree; i++) {
          await pool.query(
            `INSERT INTO community_votes (id, reportId, citizenId, voteType, votedAt, distanceMeters)
             VALUES (?, ?, ?, 'agree', NOW(), ?)`,
            [`vote_test_${Date.now()}_${i}`, reportId, `peer_tester_${i + 1}`, i < onsiteAgree ? 15 : 45]
          );
        }
      }
    } catch {}
  }
  if (disagree > agree && onsiteDisagree === 0 && updates.communityDisagreeCount !== undefined) {
    onsiteDisagree = Math.min(disagree, 2);
  }

  const locationValidationScore = computeLVS(onsiteAgree, onsiteDisagree);
  const reportReliabilityScore = computeRRS(locationValidationScore, communityValidationScore);

  const lat = updates.reportLatitude ?? updates.capturedLatitude ?? null;
  const lng = updates.reportLongitude ?? updates.capturedLongitude ?? null;

  const formattedCreatedAt = updates.createdAt
    ? new Date(updates.createdAt).toISOString().slice(0, 19).replace('T', ' ')
    : null;
  const formattedCapturedAt = updates.photoCapturedAt
    ? new Date(updates.photoCapturedAt).toISOString().slice(0, 19).replace('T', ' ')
    : null;
  const formattedVerifiedAt = updates.verifiedAt
    ? new Date(updates.verifiedAt).toISOString().slice(0, 19).replace('T', ' ')
    : updates.verifiedAt === null
    ? null
    : (updates.reportStatus === 'Verified' && !report.verifiedAt ? now : null);
  const shouldUpdateVerifiedAt = updates.verifiedAt !== undefined || (updates.reportStatus === 'Verified' && !report.verifiedAt);
  const formattedResolvedAt = updates.resolvedAt
    ? new Date(updates.resolvedAt).toISOString().slice(0, 19).replace('T', ' ')
    : updates.resolvedAt === null
    ? null
    : (updates.reportStatus === 'Resolved' && !report.resolvedAt ? now : null);
  const shouldUpdateResolvedAt = updates.resolvedAt !== undefined || (updates.reportStatus === 'Resolved' && !report.resolvedAt);
  const formattedClosedAt = updates.closedAt
    ? new Date(updates.closedAt).toISOString().slice(0, 19).replace('T', ' ')
    : updates.closedAt === null
    ? null
    : (updates.reportStatus === 'Closed' && !report.closedAt ? (report.createdAt ? new Date(new Date(report.createdAt).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ') : now) : null);
  const shouldUpdateClosedAt = updates.closedAt !== undefined || (updates.reportStatus === 'Closed' && !report.closedAt);

  await pool.query<ResultSetHeader>(
    `UPDATE reports 
     SET conditionType = COALESCE(?, conditionType),
         description = COALESCE(?, description),
         photoUri = COALESCE(?, photoUri),
         resolutionPhotoUri = COALESCE(?, resolutionPhotoUri),
         capturedLatitude = COALESCE(?, capturedLatitude),
         capturedLongitude = COALESCE(?, capturedLongitude),
         reportLatitude = COALESCE(?, reportLatitude),
         reportLongitude = COALESCE(?, reportLongitude),
         selectedBarangay = COALESCE(?, selectedBarangay),
         communityAgreeCount = ?,
         communityDisagreeCount = ?,
         communityValidationScore = ?,
         locationValidationScore = ?,
         reportReliabilityScore = ?,
         repairAgreeCount = COALESCE(?, repairAgreeCount),
         repairDisagreeCount = COALESCE(?, repairDisagreeCount),
         previousRepairAgreeCount = COALESCE(?, previousRepairAgreeCount),
         previousRepairDisagreeCount = COALESCE(?, previousRepairDisagreeCount),
         previousResolutionAttemptAt = CASE WHEN ? = 1 THEN ? ELSE previousResolutionAttemptAt END,
         resolutionHistory = CASE WHEN ? = 1 THEN ? ELSE resolutionHistory END,
         repairPhotoDistanceMeters = CASE WHEN ? = 1 THEN ? ELSE repairPhotoDistanceMeters END,
         reportStatus = COALESCE(?, reportStatus),
         createdAt = COALESCE(?, createdAt),
         photoCapturedAt = COALESCE(?, photoCapturedAt),
         verifiedAt = CASE WHEN ? = 1 THEN ? ELSE verifiedAt END,
         resolvedAt = CASE WHEN ? = 1 THEN ? ELSE resolvedAt END,
         closedAt = CASE WHEN ? = 1 THEN ? ELSE closedAt END,
         updatedAt = ?
     WHERE id = ?`,
    [
      updates.conditionType ?? null,
      updates.description ?? null,
      updates.photoUri ?? null,
      updates.resolutionPhotoUri ?? null,
      lat,
      lng,
      lat,
      lng,
      updates.selectedBarangay ?? null,
      agree,
      disagree,
      communityValidationScore,
      locationValidationScore,
      reportReliabilityScore,
      updates.repairAgreeCount ?? null,
      updates.repairDisagreeCount ?? null,
      updates.previousRepairAgreeCount ?? null,
      updates.previousRepairDisagreeCount ?? null,
      updates.previousResolutionAttemptAt !== undefined ? 1 : 0,
      updates.previousResolutionAttemptAt ? new Date(updates.previousResolutionAttemptAt).toISOString().slice(0, 19).replace('T', ' ') : null,
      updates.resolutionHistory !== undefined ? 1 : 0,
      updates.resolutionHistory ? JSON.stringify(updates.resolutionHistory) : null,
      updates.repairPhotoDistanceMeters !== undefined ? 1 : 0,
      updates.repairPhotoDistanceMeters !== undefined ? updates.repairPhotoDistanceMeters : null,
      updates.reportStatus ?? null,
      formattedCreatedAt,
      formattedCapturedAt,
      shouldUpdateVerifiedAt ? 1 : 0,
      formattedVerifiedAt,
      shouldUpdateResolvedAt ? 1 : 0,
      formattedResolvedAt,
      shouldUpdateClosedAt ? 1 : 0,
      formattedClosedAt,
      now,
      reportId,
    ]
  );

  if (updates.reportStatus === 'Closed' || updates.reportStatus === 'Resolved') {
    if (report.selectedBarangay) {
      await advisoriesRepository.deactivateByBarangay(report.selectedBarangay).catch(() => {});
    }
  }

  return findReportById(reportId);
}

export async function deleteReport(reportId: string): Promise<boolean> {
  const pool = getPool();
  const report = await findReportById(reportId);

  try {
    await pool.query(`DELETE FROM repair_votes WHERE reportId = ?`, [reportId]);
  } catch (err) {
    console.warn('[deleteReport] Notice deleting repair_votes:', err);
  }

  try {
    await pool.query(`DELETE FROM community_votes WHERE reportId = ?`, [reportId]);
  } catch (err) {
    console.warn('[deleteReport] Notice deleting community_votes:', err);
  }

  const [result] = await pool.query<ResultSetHeader>(`DELETE FROM reports WHERE id = ?`, [reportId]);

  if (report?.selectedBarangay) {
    await advisoriesRepository.deactivateByBarangay(report.selectedBarangay).catch(() => {});
  }

  return result.affectedRows > 0;
}

