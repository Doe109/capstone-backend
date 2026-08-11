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
