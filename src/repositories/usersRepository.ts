/**
 * Users Repository
 * createUser, findUserByEmail, findUserById, updateUser
 * No role field — citizen-only app.
 */

import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { getPool } from '../database/connection';
import { User, UserRow } from '../types/auth';

// ── Row → Domain ────────────────────────────────────────────────────

function rowToUser(row: RowDataPacket): User {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    firstName: row.firstName ?? undefined,
    lastName: row.lastName ?? undefined,
    pushToken: row.pushToken ?? undefined,
    createdAt: row.createdAt,
  };
}

function rowToUserRow(row: RowDataPacket): UserRow {
  return { ...rowToUser(row), passwordHash: row.passwordHash };
}

// ── Repository functions ────────────────────────────────────────────

export async function createUser(user: {
  id: string;
  email: string;
  passwordHash: string;
  fullName: string;
  firstName: string;
  lastName: string;
  createdAt: string;
}): Promise<User> {
  const pool = getPool();
  await pool.query<ResultSetHeader>(
    `INSERT INTO users (id, email, passwordHash, fullName, firstName, lastName, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [user.id, user.email, user.passwordHash, user.fullName, user.firstName, user.lastName, user.createdAt],
  );
  const created = await findUserById(user.id);
  if (!created) throw new Error('User creation failed — row not found after insert.');
  return created;
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM users WHERE email = ?',
    [email],
  );
  return rows.length > 0 ? rowToUserRow(rows[0]) : null;
}

export async function findUserById(id: string): Promise<User | null> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM users WHERE id = ?',
    [id],
  );
  return rows.length > 0 ? rowToUser(rows[0]) : null;
}

export async function findUserRowById(id: string): Promise<UserRow | null> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM users WHERE id = ?',
    [id],
  );
  return rows.length > 0 ? rowToUserRow(rows[0]) : null;
}

export async function updateUser(
  id: string,
  updates: Partial<Pick<User, 'fullName' | 'firstName' | 'lastName' | 'email' | 'pushToken'>>,
): Promise<User | null> {
  const entries = Object.entries(updates).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return findUserById(id);

  const pool = getPool();
  const setClauses = entries.map(([key]) => `${key} = ?`).join(', ');
  const values = entries.map(([, v]) => v);

  await pool.query<ResultSetHeader>(
    `UPDATE users SET ${setClauses} WHERE id = ?`,
    [...values, id],
  );

  return findUserById(id);
}

export async function updatePushToken(userId: string, pushToken: string): Promise<void> {
  const pool = getPool();
  // Clear this push token from other user accounts on this device to prevent duplicate broadcasts
  await pool.query<ResultSetHeader>(
    'UPDATE users SET pushToken = NULL WHERE pushToken = ? AND id != ?',
    [pushToken, userId],
  );
  await pool.query<ResultSetHeader>(
    'UPDATE users SET pushToken = ? WHERE id = ?',
    [pushToken, userId],
  );
}

export async function updatePassword(userId: string, passwordHash: string): Promise<boolean> {
  const pool = getPool();
  const [res] = await pool.query<ResultSetHeader>(
    'UPDATE users SET passwordHash = ? WHERE id = ?',
    [passwordHash, userId],
  );
  return res.affectedRows > 0;
}

export async function getAllPushTokens(): Promise<string[]> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT DISTINCT pushToken FROM users WHERE pushToken IS NOT NULL AND pushToken != ""',
  );
  const tokenSet = new Set<string>();
  for (const r of rows) {
    if (r.pushToken && typeof r.pushToken === 'string' && r.pushToken.trim()) {
      tokenSet.add(r.pushToken.trim());
    }
  }
  return Array.from(tokenSet);
}
