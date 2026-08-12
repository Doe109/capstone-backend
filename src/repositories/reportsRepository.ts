/**
 * Reports Repository
 * createReport, findReportById, listReports,
 * incrementVoteCount, updateReportScores
 */

import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { getPool } from '../database/connection';
import { RoadReport, ReportStatus, VoteType } from '../types/report';

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

export async function findReportById(id: string): Promise<RoadReport | null> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM reports WHERE id = ?',
    [id],
  );
  return rows.length > 0 ? rowToReport(rows[0]) : null;
}

export async function listReports(filters?: ReportFilters): Promise<RoadReport[]> {
  const pool = getPool();
  let sql = 'SELECT * FROM reports';
  const params: unknown[] = [];
  const clauses: string[] = [];

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

  return findReportById(reportId);
}
