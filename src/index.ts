/**
 * Backend Entry Point
 * Crowdsourcing-Based Road Condition Monitoring and Advisory DSS
 * Municipality of Jimenez, Misamis Occidental
 */

import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import fs from 'fs';

import { testConnection, ensureSchemaUpToDate } from './database/connection';
import authRoutes from './routes/auth';
import reportsRoutes from './routes/reports';
import advisoriesRoutes from './routes/advisories';
import usersRoutes from './routes/users';
import { optimizeUploadedImage } from './utils/imageOptimizer';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ── Ensure the uploads directory exists ─────────────────────────────
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ── Global middleware ───────────────────────────────────────────────
app.use(compression()); // Gzip compression for all JSON / API payloads
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve uploaded photos as static files with aggressive client caching and fallback
app.use(
  '/uploads',
  (req, res, next) => {
    const requestedFile = path.join(uploadsDir, req.path);
    if (!fs.existsSync(requestedFile)) {
      const fallbackFile = path.join(uploadsDir, 'pothole.jpg');
      if (fs.existsSync(fallbackFile)) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.sendFile(fallbackFile);
      }
    }
    next();
  },
  express.static(uploadsDir, {
    maxAge: '30d',
    immutable: true,
    etag: true,
    lastModified: true,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    },
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

// Background auto-optimization sweep for any legacy uncompressed uploads
function sweepUploadsInBackground() {
  setTimeout(async () => {
    try {
      if (!fs.existsSync(uploadsDir)) return;
      const files = fs.readdirSync(uploadsDir);
      for (const file of files) {
        const filePath = path.join(uploadsDir, file);
        const stat = fs.statSync(filePath);
        // If file is larger than 300KB, optimize it
        if (stat.isFile() && stat.size > 300 * 1024) {
          await optimizeUploadedImage(filePath);
        }
      }
      console.log('✅ Background upload image optimization sweep completed.');
    } catch (err: any) {
      console.warn('Notice during background image sweep:', err?.message || err);
    }
  }, 3000);
}

// ── Start server ────────────────────────────────────────────────────
async function start() {
  // Test DB connectivity before accepting requests
  try {
    await testConnection();
    console.log('✅ MySQL connection verified (SELECT 1 succeeded)');
    await ensureSchemaUpToDate();
    sweepUploadsInBackground();
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

