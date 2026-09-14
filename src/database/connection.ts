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
    // Add resolutionPhotoUri if missing
    const [resCols] = (await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'reports' AND COLUMN_NAME = 'resolutionPhotoUri'`,
      [dbName]
    )) as any;
    if (resCols.length === 0) {
      await db.query(`ALTER TABLE reports ADD COLUMN resolutionPhotoUri VARCHAR(500) NULL`);
      console.log('✅ Added missing resolutionPhotoUri column to reports table');
    }

    // Add resolvedByCitizenId if missing
    const [citCols] = (await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'reports' AND COLUMN_NAME = 'resolvedByCitizenId'`,
      [dbName]
    )) as any;
    if (citCols.length === 0) {
      await db.query(`ALTER TABLE reports ADD COLUMN resolvedByCitizenId VARCHAR(36) NULL`);
      console.log('✅ Added missing resolvedByCitizenId column to reports table');
    }

    // Add pushToken if missing in users
    const [tokenCols] = (await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'pushToken'`,
      [dbName]
    )) as any;
    if (tokenCols.length === 0) {
      await db.query(`ALTER TABLE users ADD COLUMN pushToken VARCHAR(255) NULL`);
      console.log('✅ Added missing pushToken column to users table');
    }
  } catch (migErr) {
    console.warn('Notice during schema migration check:', migErr);
  }
}
