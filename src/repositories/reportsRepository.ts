/**
 * Reports Repository
 * createReport, findReportById, listReports,
 * incrementVoteCount, updateReportScores
 */

import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { getPool } from '../database/connection';
import { ReportStatus, RoadReport, VoteType } from '../types/report';

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

  return {
    id: row.id,
    citizenId: row.citizenId,
    citizenName: row.citizenName,
    conditionType: row.conditionType,
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
    communityValidationScore: Number(row.communityValidationScore ?? 0),
    // Aliases for the RN app
    confirmCount: agreeCount,
    disputeCount: disagreeCount,
    locationValidationScore: Number(row.locationValidationScore ?? 0),
    reportReliabilityScore: Number(row.reportReliabilityScore ?? 0),
    advisoryText: row.advisoryText ?? null,
    resolvedAt: row.resolvedAt ? formatIsoTimestamp(row.resolvedAt) : null,
    resolutionPhotoUri: row.resolutionPhotoUri ?? null,
    resolvedByCitizenId: row.resolvedByCitizenId ?? null,
    repairAgreeCount: Number(row.repairAgreeCount ?? 0),
    repairDisagreeCount: Number(row.repairDisagreeCount ?? 0),
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
  await pool.query<ResultSetHeader>(
    `INSERT INTO reports
       (id, citizenId, citizenName, conditionType, description,
        photoUri, photoCapturedAt,
        capturedLatitude, capturedLongitude, locationAccuracyMeters,
        reportLatitude, reportLongitude, selectedBarangay,
        createdAt, updatedAt, submittedAt,
        reportStatus, syncStatus, locationEvidenceStatus)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending Validation', 'synced', ?)`,
    [
      report.id, report.citizenId, report.citizenName,
      report.conditionType, report.description,
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
 * Find a report by ID.
 * Disputed reports are immediately excluded and disappear totally from public queries.
 */
export async function findReportById(id: string, includeDisputed: boolean = false): Promise<RoadReport | null> {
  const pool = getPool();
  const cleanId = (id || '').trim();
  const disputedClause = includeDisputed ? '' : "AND reportStatus != 'Disputed'";
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM reports 
     WHERE (id = ? OR id = ?) ${disputedClause}
     LIMIT 1`,
    [cleanId, id],
  );
  if (rows.length === 0) return null;
  return rowToReport(rows[0]);
}

/**
 * List reports with optional filtering by status, barangay, or citizenId.
 * Disputed reports are immediately excluded and disappear totally.
 */
export async function listReports(filters?: ReportFilters): Promise<RoadReport[]> {
  const pool = getPool();
  let sql = 'SELECT * FROM reports';
  const params: unknown[] = [];
  const clauses: string[] = [
    "reportStatus != 'Disputed'",
  ];

  if (filters?.status) {
    clauses.push('reportStatus = ?');
    params.push(filters.status);
  }
  if (filters?.barangay) {
    clauses.push('selectedBarangay = ?');
    params.push(filters.barangay);
  }
  if (filters?.citizenId) {
    clauses.push('citizenId = ?');
    params.push(filters.citizenId);
  }

  if (clauses.length > 0) {
    sql += ' WHERE ' + clauses.join(' AND ');
  }
  sql += ' ORDER BY createdAt DESC';

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
  if (scores.reportStatus) {
    updates.reportStatus = scores.reportStatus;
    if (scores.reportStatus === 'Resolved') {
      updates.resolvedAt = now;
    }
  }

  const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  const values = Object.values(updates);

  await pool.query<ResultSetHeader>(
    `UPDATE reports SET ${setClauses} WHERE id = ?`,
    [...values, reportId],
  );

  return findReportById(reportId, true);
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

    // Insert submitter's implicit positive vote
    const { v4: uuidv4 } = await import('uuid');
    await pool.query(
      `INSERT INTO repair_votes (id, reportId, citizenId, voteType, votedAt) VALUES (?, ?, ?, 'agree', ?)`,
      [uuidv4(), reportId, resolvedByCitizenId, now]
    );
  } catch (rvErr) {
    console.warn('[submitRepairProof] Notice updating repair_votes:', rvErr);
  }

  await pool.query<ResultSetHeader>(
    `UPDATE reports 
     SET reportStatus = 'Under Review', 
         resolutionPhotoUri = ?, 
         resolvedByCitizenId = ?, 
         repairAgreeCount = 1, 
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
export async function revertRepairToVerified(reportId: string): Promise<RoadReport | null> {
  const pool = getPool();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  try {
    await pool.query(`DELETE FROM repair_votes WHERE reportId = ?`, [reportId]);
  } catch (e) {
    console.warn('[revertRepairToVerified] Notice deleting repair_votes:', e);
  }
  await pool.query<ResultSetHeader>(
    `UPDATE reports 
     SET reportStatus = 'Verified', 
         resolutionPhotoUri = NULL, 
         resolvedByCitizenId = NULL, 
         repairAgreeCount = 0, 
         repairDisagreeCount = 0, 
         updatedAt = ? 
     WHERE id = ?`,
    [now, reportId]
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
