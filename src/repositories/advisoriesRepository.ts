/**
 * Advisories Repository
 * Data-access layer for the `advisories` table.
 */

import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { getPool } from '../database/connection';
import { RoadAdvisory } from '../types/report';

// ── Row → Domain helper ─────────────────────────────────────────────

function rowToAdvisory(row: RowDataPacket): RoadAdvisory {
  return {
    id: row.id,
    title: row.title,
    location: row.location,
    selectedBarangay: row.selectedBarangay ?? undefined,
    message: row.message,
    issuedAt: row.issuedAt,
    active: row.active === 1 || row.active === true,
  };
}

// ── Repository functions ────────────────────────────────────────────

export async function getActive(): Promise<RoadAdvisory[]> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM advisories WHERE active = 1 ORDER BY issuedAt DESC',
  );
  return rows.map(rowToAdvisory);
}

export async function create(advisory: {
  id: string;
  title: string;
  location: string;
  selectedBarangay?: string;
  message: string;
  issuedAt: string;
}): Promise<RoadAdvisory> {
  const pool = getPool();
  await pool.query<ResultSetHeader>(
    `INSERT INTO advisories
       (id, title, location, selectedBarangay, message, issuedAt, active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [
      advisory.id,
      advisory.title,
      advisory.location,
      advisory.selectedBarangay ?? null,
      advisory.message,
      advisory.issuedAt,
    ],
  );

  return {
    ...advisory,
    active: true,
  };
}

export async function deactivateByBarangay(selectedBarangay: string): Promise<void> {
  const pool = getPool();
  await pool.query<ResultSetHeader>(
    'UPDATE advisories SET active = 0 WHERE selectedBarangay = ?',
    [selectedBarangay],
  );
}

export async function deactivateById(id: string): Promise<void> {
  const pool = getPool();
  await pool.query<ResultSetHeader>(
    'UPDATE advisories SET active = 0 WHERE id = ?',
    [id],
  );
}
