/**
 * Database Initialisation Script
 *
 * Reads schema.sql and executes each statement against the MySQL pool.
 * Run with:  npm run init-db
 */

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { getPool } from './connection';

async function initDb(): Promise<void> {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf-8');

  // Split on semicolons, filter empty statements
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    for (const statement of statements) {
      console.log(`Executing: ${statement.substring(0, 60)}...`);
      await connection.query(statement);
    }
    console.log('\n✅ Database schema initialised successfully.');
  } catch (error) {
    console.error('❌ Failed to initialise database:', error);
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

initDb();
