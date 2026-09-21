/**
 * Backend Entry Point
 * Crowdsourcing-Based Road Condition Monitoring and Advisory DSS
 * Municipality of Jimenez, Misamis Occidental
 */

import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';

import { testConnection, ensureSchemaUpToDate } from './database/connection';
import authRoutes from './routes/auth';
import reportsRoutes from './routes/reports';
import advisoriesRoutes from './routes/advisories';
import usersRoutes from './routes/users';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ── Ensure the uploads directory exists ─────────────────────────────
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ── Global middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded photos as static files with aggressive client caching
app.use(
  '/uploads',
  express.static(uploadsDir, {
    maxAge: '30d',
    immutable: true,
    etag: true,
    lastModified: true,
  })
);

// ── Health check ────────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  try {
    await testConnection();
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', db: 'disconnected', timestamp: new Date().toISOString() });
  }
});

// ── API routes ──────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/advisories', advisoriesRoutes);
app.use('/api/users', usersRoutes);

// ── Start server ────────────────────────────────────────────────────
async function start() {
  // Test DB connectivity before accepting requests
  try {
    await testConnection();
    console.log('✅ MySQL connection verified (SELECT 1 succeeded)');
    await ensureSchemaUpToDate();
  } catch (error) {
    console.error('❌ MySQL connection FAILED:', error);
    console.error('   Check your .env DB_HOST / DB_USER / DB_PASSWORD / DB_NAME values.');
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`\n🚀 Road Condition DSS Backend running on http://localhost:${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/api/health\n`);
  });
}

start();

export default app;
