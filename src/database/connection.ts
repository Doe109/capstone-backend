/**
 * MySQL Database Connection
 * Uses mysql2/promise with a connection pool.
 * Reads credentials from .env — never hardcoded.
 */

import mysql, { Pool } from 'mysql2/promise';

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

    // 8. Migrate any existing 'Disputed' reports to 'Closed'
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

    // 9. Ensure research testing accounts exist (reporter + 5 voters)
    try {
      const bcrypt = require('bcrypt');
      const hash = await bcrypt.hash('password123', 10);

      const testAccounts = [
        { id: 'usr_tester_roadwatch', email: 'tester@roadwatch.ph', name: 'Research Tester', first: 'Research', last: 'Tester' },
        { id: 'usr_reporter_roadwatch', email: 'reporter@roadwatch.ph', name: 'Research Reporter', first: 'Research', last: 'Reporter' },
        { id: 'usr_voter1_roadwatch', email: 'voter1@roadwatch.ph', name: 'Research Voter 1', first: 'Voter', last: 'One' },
        { id: 'usr_voter2_roadwatch', email: 'voter2@roadwatch.ph', name: 'Research Voter 2', first: 'Voter', last: 'Two' },
        { id: 'usr_voter3_roadwatch', email: 'voter3@roadwatch.ph', name: 'Research Voter 3', first: 'Voter', last: 'Three' },
        { id: 'usr_voter4_roadwatch', email: 'voter4@roadwatch.ph', name: 'Research Voter 4', first: 'Voter', last: 'Four' },
        { id: 'usr_voter5_roadwatch', email: 'voter5@roadwatch.ph', name: 'Research Voter 5', first: 'Voter', last: 'Five' },
      ];

      for (const acc of testAccounts) {
        const [existing] = (await db.query('SELECT id FROM users WHERE email = ?', [acc.email])) as any;
        if (existing.length === 0) {
          await db.query(
            `INSERT INTO users (id, email, passwordHash, fullName, firstName, lastName, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [acc.id, acc.email, hash, acc.name, acc.first, acc.last]
          );
          console.log(`✅ Seeded research test account: ${acc.email} / password123`);
        }
      }
    } catch (testerSeedErr) {
      console.warn('Notice seeding tester users:', testerSeedErr);
    }
  } catch (migErr) {
    console.warn('Notice during schema migration check:', migErr);
  }
}
