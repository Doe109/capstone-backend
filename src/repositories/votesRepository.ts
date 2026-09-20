/**
 * Votes Repository
 * createVote (catches duplicate-key), getVoteCounts
 */

import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { getPool } from '../database/connection';
import { CommunityVote, VoteType } from '../types/report';

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
  votedAt: string;
}): Promise<{ success: true; vote: CommunityVote } | { success: false; error: string }> {
  const pool = getPool();
  try {
    await pool.query<ResultSetHeader>(
      `INSERT INTO community_votes (id, reportId, citizenId, voteType, votedAt)
       VALUES (?, ?, ?, ?, ?)`,
      [vote.id, vote.reportId, vote.citizenId, vote.voteType, vote.votedAt],
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
 * Get the current agree/disagree tallies for a report.
 */
export async function getVoteCounts(
  reportId: string,
): Promise<{ agreeCount: number; disagreeCount: number }> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
       SUM(CASE WHEN voteType = 'agree'    THEN 1 ELSE 0 END) AS agreeCount,
       SUM(CASE WHEN voteType = 'disagree' THEN 1 ELSE 0 END) AS disagreeCount
     FROM community_votes
     WHERE reportId = ?`,
    [reportId],
  );
  const row = rows[0];
  return {
    agreeCount: Number(row?.agreeCount ?? 0),
    disagreeCount: Number(row?.disagreeCount ?? 0),
  };
}
