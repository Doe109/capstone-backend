/**
 * MySQL Database Connection
 * Uses mysql2/promise with a connection pool.
 * Reads credentials from .env — never hardcoded.
 */

import mysql, { Pool } from 'mysql2/promise';
import { computeCV, computeLVS, computeRRS } from '../config/validationRules';

let pool: Pool | null = null;

/**
 * Returns the shared connection pool, creating it on first call.
 */
export function getPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306', 10),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'road_condition_dss',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      // Return dates as strings to match the RN app's SQLite text storage
      dateStrings: true,
    });
  }
  return pool;
}

/**
 * Quick connectivity check — runs `SELECT 1` against the pool.
 * Call on startup to confirm the DB is reachable.
 */
export async function testConnection(): Promise<void> {
  const db = getPool();
  await db.query('SELECT 1');
}

/**
 * Ensures any new columns (e.g. resolutionPhotoUri, pushToken) are present in the MySQL schema.
 */
export async function ensureSchemaUpToDate(): Promise<void> {
  const db = getPool();
  const dbName = process.env.DB_NAME || 'road_condition_dss';
  try {
    // 1. Modify reportStatus to VARCHAR(50) so it cleanly supports 'Under Review' alongside standard statuses
    try {
      await db.query(`ALTER TABLE reports MODIFY COLUMN reportStatus VARCHAR(50) NOT NULL DEFAULT 'Pending Validation'`);
    } catch (statusErr) {
      console.warn('Notice modifying reportStatus column:', statusErr);
    }

    // 2. Add resolutionPhotoUri if missing
    const [resCols] = (await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'reports' AND COLUMN_NAME = 'resolutionPhotoUri'`,
      [dbName]
    )) as any;
    if (resCols.length === 0) {
      await db.query(`ALTER TABLE reports ADD COLUMN resolutionPhotoUri VARCHAR(500) NULL`);
      console.log('✅ Added missing resolutionPhotoUri column to reports table');
    }

    // 3. Add resolvedByCitizenId if missing
    const [citCols] = (await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'reports' AND COLUMN_NAME = 'resolvedByCitizenId'`,
      [dbName]
    )) as any;
    if (citCols.length === 0) {
      await db.query(`ALTER TABLE reports ADD COLUMN resolvedByCitizenId VARCHAR(36) NULL`);
      console.log('✅ Added missing resolvedByCitizenId column to reports table');
    }

    // 4. Add repairAgreeCount and repairDisagreeCount if missing
    const [repairCols] = (await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'reports' AND COLUMN_NAME = 'repairAgreeCount'`,
      [dbName]
    )) as any;
    if (repairCols.length === 0) {
      await db.query(`ALTER TABLE reports ADD COLUMN repairAgreeCount INT DEFAULT 0, ADD COLUMN repairDisagreeCount INT DEFAULT 0`);
      console.log('✅ Added missing repairAgreeCount & repairDisagreeCount columns to reports table');
    }

    // 4b. Add previousRepairAgreeCount, previousRepairDisagreeCount, previousResolutionAttemptAt if missing
    const [prevRepairCols] = (await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'reports' AND COLUMN_NAME = 'previousRepairAgreeCount'`,
      [dbName]
    )) as any;
    if (prevRepairCols.length === 0) {
      await db.query(`ALTER TABLE reports ADD COLUMN previousRepairAgreeCount INT DEFAULT 0, ADD COLUMN previousRepairDisagreeCount INT DEFAULT 0, ADD COLUMN previousResolutionAttemptAt DATETIME NULL`);
      console.log('✅ Added missing previousRepairAgreeCount, previousRepairDisagreeCount, & previousResolutionAttemptAt columns to reports table');
    }

    // 4c. Add resolutionHistory JSON/TEXT column if missing
    const [resHistoryCols] = (await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'reports' AND COLUMN_NAME = 'resolutionHistory'`,
      [dbName]
    )) as any;
    if (resHistoryCols.length === 0) {
      await db.query(`ALTER TABLE reports ADD COLUMN resolutionHistory JSON NULL`);
      console.log('✅ Added missing resolutionHistory column to reports table');
    }

    // 5. Create repair_votes table if missing
    await db.query(`
      CREATE TABLE IF NOT EXISTS repair_votes (
        id VARCHAR(100) PRIMARY KEY,
        reportId VARCHAR(100) NOT NULL,
        citizenId VARCHAR(100) NOT NULL,
        voteType ENUM('agree', 'disagree') NOT NULL,
        votedAt DATETIME NOT NULL,
        INDEX idx_rep_report (reportId),
        INDEX idx_rep_citizen (citizenId),
        UNIQUE KEY unique_repair_vote (reportId, citizenId)
      ) ENGINE=InnoDB
    `);

    // 6. Add pushToken if missing in users
    const [tokenCols] = (await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'pushToken'`,
      [dbName]
    )) as any;
    if (tokenCols.length === 0) {
      await db.query(`ALTER TABLE users ADD COLUMN pushToken VARCHAR(255) NULL`);
      console.log('✅ Added missing pushToken column to users table');
    }

    // 7. Add distanceMeters column to community_votes if missing
    const [voteDistCols] = (await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'community_votes' AND COLUMN_NAME = 'distanceMeters'`,
      [dbName]
    )) as any;
    if (voteDistCols.length === 0) {
      await db.query(`ALTER TABLE community_votes ADD COLUMN distanceMeters DECIMAL(8, 2) NULL`);
      console.log('✅ Added missing distanceMeters column to community_votes table');
    }

    // 8. Add severityLevel column to reports if missing
    const [reportSevCols] = (await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'reports' AND COLUMN_NAME = 'severityLevel'`,
      [dbName]
    )) as any;
    if (reportSevCols.length === 0) {
      await db.query(`ALTER TABLE reports ADD COLUMN severityLevel VARCHAR(20) NOT NULL DEFAULT 'POOR'`);
      console.log('✅ Added missing severityLevel column to reports table');
    }

    // 9. Add severityLevel column to community_votes if missing
    const [voteSevCols] = (await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'community_votes' AND COLUMN_NAME = 'severityLevel'`,
      [dbName]
    )) as any;
    if (voteSevCols.length === 0) {
      await db.query(`ALTER TABLE community_votes ADD COLUMN severityLevel VARCHAR(20) NULL`);
      console.log('✅ Added missing severityLevel column to community_votes table');
    }

    // 10. Add severityLevel column to advisories if missing
    const [advSevCols] = (await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'advisories' AND COLUMN_NAME = 'severityLevel'`,
      [dbName]
    )) as any;
    if (advSevCols.length === 0) {
      await db.query(`ALTER TABLE advisories ADD COLUMN severityLevel VARCHAR(20) NULL`);
      console.log('✅ Added missing severityLevel column to advisories table');
    }

    // 11. Migrate any existing 'Disputed' reports to 'Closed'
    try {
      const [disputedUpdates] = (await db.query(
        `UPDATE reports SET reportStatus = 'Closed' WHERE reportStatus = 'Disputed'`
      )) as any;
      if (disputedUpdates?.affectedRows > 0) {
        console.log(`✅ Migrated ${disputedUpdates.affectedRows} Disputed report(s) to Closed status`);
      }
    } catch (dispErr) {
      console.warn('Notice migrating Disputed reports:', dispErr);
    }

    // 12. Add reportNumber INT UNIQUE NULL column if missing, and initialize sequentially from 1001
    const [reportNumCols] = (await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'reports' AND COLUMN_NAME = 'reportNumber'`,
      [dbName]
    )) as any;
    if (reportNumCols.length === 0) {
      await db.query(`ALTER TABLE reports ADD COLUMN reportNumber INT UNIQUE NULL`);
      // Chronologically number existing reports starting at 1001
      const [existingReports] = (await db.query(`SELECT id FROM reports ORDER BY createdAt ASC`)) as any;
      if (Array.isArray(existingReports) && existingReports.length > 0) {
        for (let i = 0; i < existingReports.length; i++) {
          await db.query(`UPDATE reports SET reportNumber = ? WHERE id = ?`, [1001 + i, existingReports[i].id]);
        }
      }
      console.log('✅ Added missing reportNumber column to reports table and backfilled sequential IDs');
    }

    // 12b. Ensure any existing reports with NULL reportNumber are assigned permanent numbers
    try {
      const [nullReports] = (await db.query(
        `SELECT id FROM reports WHERE reportNumber IS NULL ORDER BY createdAt ASC`
      )) as any;
      if (Array.isArray(nullReports) && nullReports.length > 0) {
        const [maxRows] = (await db.query(`SELECT MAX(reportNumber) as maxNum FROM reports`)) as any;
        let nextNum = Math.max(1001, (Number(maxRows?.[0]?.maxNum) || 1000) + 1);
        for (const r of nullReports) {
          await db.query(`UPDATE reports SET reportNumber = ? WHERE id = ?`, [nextNum, r.id]);
          console.log(`[Schema] Backfilled report ${r.id} with permanent reportNumber ${nextNum}`);
          nextNum++;
        }
      }
    } catch (backfillErr) {
      console.warn('Notice backfilling reportNumber:', backfillErr);
    }

    // 13. Add verifiedAt column to reports if missing
    try {
      const [verifiedCols] = (await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'reports' AND COLUMN_NAME = 'verifiedAt'`,
        [dbName]
      )) as any;
      if (verifiedCols.length === 0) {
        await db.query(`ALTER TABLE reports ADD COLUMN verifiedAt DATETIME NULL`);
        await db.query(`UPDATE reports SET verifiedAt = updatedAt WHERE reportStatus IN ('Verified', 'Under Review', 'Resolved') AND verifiedAt IS NULL`);
        console.log('✅ Added missing verifiedAt column to reports table');
      }
    } catch (verColErr) {
      console.warn('Notice adding verifiedAt column:', verColErr);
    }

    // 14. Add closedAt column to reports if missing
    try {
      const [closedCols] = (await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'reports' AND COLUMN_NAME = 'closedAt'`,
        [dbName]
      )) as any;
      if (closedCols.length === 0) {
        await db.query(`ALTER TABLE reports ADD COLUMN closedAt DATETIME NULL`);
        await db.query(`UPDATE reports SET closedAt = COALESCE(DATE_ADD(createdAt, INTERVAL 7 DAY), updatedAt) WHERE reportStatus = 'Closed' AND closedAt IS NULL`);
        console.log('✅ Added missing closedAt column to reports table');
      }
    } catch (closedColErr) {
      console.warn('Notice adding closedAt column:', closedColErr);
    }

    // 15. Add repairPhotoDistanceMeters column to reports if missing
    try {
      const [distCols] = (await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'reports' AND COLUMN_NAME = 'repairPhotoDistanceMeters'`,
        [dbName]
      )) as any;
      if (distCols.length === 0) {
        await db.query(`ALTER TABLE reports ADD COLUMN repairPhotoDistanceMeters DOUBLE NULL DEFAULT NULL`);
        console.log('✅ Added missing repairPhotoDistanceMeters column to reports table');
      }
    } catch (distColErr) {
      console.warn('Notice adding repairPhotoDistanceMeters column:', distColErr);
    }

    // 9. Ensure research and demo test accounts exist
    try {
      const bcrypt = require('bcrypt');
      const hash = await bcrypt.hash('password123', 10);

      const testAccounts = [
        { id: 'usr_tester_roadwatch', email: 'tester@roadwatch.ph', name: 'Master Tester', first: 'Master', last: 'Tester' },
        { id: 'usr_reporter_roadwatch', email: 'reporter@roadwatch.ph', name: 'Citizen Reporter', first: 'Citizen', last: 'Reporter' },
        { id: 'usr_voter1_roadwatch', email: 'voter1@roadwatch.ph', name: 'Peer Voter 1', first: 'Voter', last: 'One' },
        { id: 'usr_voter2_roadwatch', email: 'voter2@roadwatch.ph', name: 'Peer Voter 2', first: 'Voter', last: 'Two' },
        { id: 'usr_voter3_roadwatch', email: 'voter3@roadwatch.ph', name: 'Peer Voter 3', first: 'Voter', last: 'Three' },
        { id: 'usr_voter4_roadwatch', email: 'voter4@roadwatch.ph', name: 'Peer Voter 4', first: 'Voter', last: 'Four' },
        { id: 'usr_voter5_roadwatch', email: 'voter5@roadwatch.ph', name: 'Peer Voter 5', first: 'Voter', last: 'Five' },
      ];

      for (const acc of testAccounts) {
        const [existing] = (await db.query('SELECT id FROM users WHERE email = ?', [acc.email])) as any;
        if (existing.length === 0) {
          await db.query(
            `INSERT INTO users (id, email, passwordHash, fullName, firstName, lastName, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [acc.id, acc.email, hash, acc.name, acc.first, acc.last]
          );
          console.log(`✅ Seeded account: ${acc.email} / password123`);
        }
      }
    } catch (testerSeedErr) {
      console.warn('Notice seeding test users:', testerSeedErr);
    }

    // 12. One-time recomputation of LVS, CV, RRS for existing reports based on community_votes
    try {
      const [reports] = (await db.query(`SELECT id, confirmCount, disputeCount FROM reports`)) as any;
      for (const rep of reports) {
        const reportId = rep.id;
        const [counts] = (await db.query(
          `SELECT
             SUM(CASE WHEN voteType = 'agree' THEN 1 ELSE 0 END) AS agreeCount,
             SUM(CASE WHEN voteType = 'disagree' THEN 1 ELSE 0 END) AS disagreeCount,
             SUM(CASE WHEN voteType = 'agree' AND distanceMeters IS NOT NULL AND distanceMeters <= 30 THEN 1 ELSE 0 END) AS onsiteAgreeCount,
             SUM(CASE WHEN voteType = 'disagree' AND distanceMeters IS NOT NULL AND distanceMeters <= 30 THEN 1 ELSE 0 END) AS onsiteDisagreeCount
           FROM community_votes
           WHERE reportId = ?`,
          [reportId]
        )) as any;
        const row = counts[0] || {};
        let agree = Number(row.agreeCount || 0);
        let disagree = Number(row.disagreeCount || 0);
        const onsiteAgree = Number(row.onsiteAgreeCount || 0);
        const onsiteDisagree = Number(row.onsiteDisagreeCount || 0);

        // Check if rows actually exist in community_votes
        const [voteRows] = (await db.query(
          `SELECT id FROM community_votes WHERE reportId = ? LIMIT 1`,
          [reportId]
        )) as any;

        // If no rows exist in community_votes, fallback to report table counts (with 0 on-site votes)
        if (voteRows.length === 0 && (rep.confirmCount > 0 || rep.disputeCount > 0)) {
          agree = Number(rep.confirmCount || 0);
          disagree = Number(rep.disputeCount || 0);
        }

        const total = agree + disagree;
        // Strict rule: LVS is based only on votes within 30m. 0 on-site votes -> LVS = 0.000!
        const lvs = computeLVS(onsiteAgree, onsiteDisagree);
        const cv = computeCV(agree, total);
        const rrs = computeRRS(lvs, cv);

        await db.query(
          `UPDATE reports
           SET locationValidationScore = ?,
               communityValidationScore = ?,
               reportReliabilityScore = ?,
               communityAgreeCount = ?,
               communityDisagreeCount = ?
           WHERE id = ?`,
          [lvs, cv, rrs, agree, disagree, reportId]
        );
      }
      console.log(`✅ One-time recompute of LVS, CV, and RRS scores completed for existing reports`);
    } catch (recomputeErr) {
      console.warn('Notice during one-time recomputation of report scores:', recomputeErr);
    }
  } catch (migErr) {
    console.warn('Notice during schema migration check:', migErr);
  }
}
