/**
 * Votes Repository
 * createVote (catches duplicate-key), getVoteCounts
 */

import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { getPool } from '../database/connection';
import { CommunityVote, SeverityLevel, VoteType } from '../types/report';

/**
 * Insert a community vote.
 * The UNIQUE(reportId, citizenId) constraint prevents double-voting.
 * Instead of letting a raw SQL error propagate, we catch the duplicate-key
 * error (code ER_DUP_ENTRY) and return a clean result.
 */
export async function createVote(vote: {
  id: string;
  reportId: string;
  citizenId: string;
  voteType: VoteType;
  severityLevel?: SeverityLevel | null;
  votedAt: string;
  distanceMeters?: number | null;
}): Promise<{ success: true; vote: CommunityVote } | { success: false; error: string }> {
  const pool = getPool();
  try {
    await pool.query<ResultSetHeader>(
      `INSERT INTO community_votes (id, reportId, citizenId, voteType, severityLevel, votedAt, distanceMeters)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [vote.id, vote.reportId, vote.citizenId, vote.voteType, vote.severityLevel ?? null, vote.votedAt, vote.distanceMeters ?? null],
    );
    return { success: true, vote };
  } catch (err: unknown) {
    // MySQL duplicate entry error code
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ER_DUP_ENTRY') {
      return { success: false, error: 'You have already voted on this report.' };
    }
    throw err; // Re-throw unexpected errors
  }
}

/**
 * Get a citizen's vote on a specific report.
 */
export async function getUserVote(
  reportId: string,
  citizenId: string,
): Promise<VoteType | null> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT voteType FROM community_votes WHERE reportId = ? AND citizenId = ? LIMIT 1`,
    [reportId, citizenId],
  );
  if (rows.length === 0) return null;
  return rows[0].voteType as VoteType;
}

/**
 * Get a citizen's complete vote details (including severityLevel).
 */
export async function getUserVoteDetails(
  reportId: string,
  citizenId: string,
): Promise<{ voteType: VoteType; severityLevel: SeverityLevel | null } | null> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT voteType, severityLevel FROM community_votes WHERE reportId = ? AND citizenId = ? LIMIT 1`,
    [reportId, citizenId],
  );
  if (rows.length === 0) return null;
  return {
    voteType: rows[0].voteType as VoteType,
    severityLevel: (rows[0].severityLevel as SeverityLevel) || null,
  };
}

/**
 * Get the current agree/disagree tallies and on-site (<= 30m) tallies for a report.
 */
export async function getVoteCounts(
  reportId: string,
): Promise<{
  agreeCount: number;
  disagreeCount: number;
  onsiteAgreeCount: number;
  onsiteDisagreeCount: number;
}> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
       SUM(CASE WHEN voteType = 'agree' THEN 1 ELSE 0 END) AS agreeCount,
       SUM(CASE WHEN voteType = 'disagree' THEN 1 ELSE 0 END) AS disagreeCount,
       SUM(CASE WHEN voteType = 'agree' AND distanceMeters IS NOT NULL AND distanceMeters <= 30 THEN 1 ELSE 0 END) AS onsiteAgreeCount,
       SUM(CASE WHEN voteType = 'disagree' AND distanceMeters IS NOT NULL AND distanceMeters <= 30 THEN 1 ELSE 0 END) AS onsiteDisagreeCount
     FROM community_votes
     WHERE reportId = ?`,
    [reportId],
  );
  const row = rows[0];
  return {
    agreeCount: Number(row?.agreeCount ?? 0),
    disagreeCount: Number(row?.disagreeCount ?? 0),
    onsiteAgreeCount: Number(row?.onsiteAgreeCount ?? 0),
    onsiteDisagreeCount: Number(row?.onsiteDisagreeCount ?? 0),
  };
}

/**
 * Compute the majority severity among the original report and all peer validation votes.
 * In case of a tie, priority order is BAD > POOR > FAIR (precautionary road safety principle).
 */
export async function calculateMajoritySeverity(
  reportId: string,
  initialReporterSeverity?: SeverityLevel | null,
): Promise<SeverityLevel> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT severityLevel FROM community_votes 
     WHERE reportId = ? AND voteType = 'agree' AND severityLevel IS NOT NULL`,
    [reportId],
  );

  const tallies: Record<SeverityLevel, number> = {
    BAD: 0,
    POOR: 0,
    FAIR: 0,
  };

  // 1. Count the reporter's initial severity assessment
  const reporterSev = initialReporterSeverity || 'POOR';
  if (tallies[reporterSev] !== undefined) {
    tallies[reporterSev] += 1;
  }

  // 2. Count each confirming peer voter's severity assessment
  for (const row of rows) {
    const sev = (row.severityLevel || '').toUpperCase() as SeverityLevel;
    if (tallies[sev] !== undefined) {
      tallies[sev] += 1;
    }
  }

  // 3. Majority wins; tie-breaking safety order: BAD > POOR > FAIR
  const order: SeverityLevel[] = ['BAD', 'POOR', 'FAIR'];
  let winningSeverity: SeverityLevel = reporterSev;
  let maxCount = -1;

  for (const sev of order) {
    if (tallies[sev] > maxCount) {
      maxCount = tallies[sev];
      winningSeverity = sev;
    }
  }

  return winningSeverity;
}

/**
 * Get all validation votes cast on a report with distance and severity metadata.
 */
export async function getVotesForReport(reportId: string): Promise<Array<{
  id: string;
  citizenId: string;
  voteType: VoteType;
  severityLevel: SeverityLevel | null;
  distanceMeters: number | null;
  votedAt: string;
}>> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, citizenId, voteType, severityLevel, distanceMeters, votedAt
     FROM community_votes
     WHERE reportId = ?
     ORDER BY votedAt ASC`,
    [reportId],
  );
  return rows.map((r) => ({
    id: r.id,
    citizenId: r.citizenId,
    voteType: r.voteType as VoteType,
    severityLevel: (r.severityLevel as SeverityLevel) || null,
    distanceMeters: r.distanceMeters !== null && r.distanceMeters !== undefined ? Number(r.distanceMeters) : null,
    votedAt: r.votedAt instanceof Date ? r.votedAt.toISOString() : String(r.votedAt),
  }));
}
