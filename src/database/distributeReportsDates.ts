/**
 * Batch Date & Timestamp Distribution Script for 40 Road Condition Reports
 * 
 * Distributes report timestamps across 3 realistic defense testing groups:
 * 1. 'Ni Tung-Tung sa 7 Days' (October 18, 2026 - Day 7 of 7, Pending Validation)
 * 2. 'Ni Lapas sa 7 Days' (October 16-17, 2026 - 8+ Days Old, Auto-Closed)
 * 3. 'Active Ongoing' (October 21-24, 2026 - 1-4 Days Old, Pending Validation)
 * 
 * Run with: npm run distribute-dates (in backend directory)
 */

import dotenv from 'dotenv';
dotenv.config();

import { getPool } from './connection';
import { RowDataPacket } from 'mysql2';
import { evaluateExpiredPendingReports } from '../repositories/reportsRepository';

async function distributeDates(): Promise<void> {
  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    const [rows] = await connection.query<RowDataPacket[]>(
      'SELECT id, conditionType, selectedBarangay, reportStatus FROM reports ORDER BY id ASC'
    );

    console.log(`\nFound ${rows.length} total reports in database.`);
    if (rows.length === 0) {
      console.log('No reports found to update.');
      return;
    }

    const tungTungTimes = [
      '2026-10-18 07:45:00', '2026-10-18 08:20:00', '2026-10-18 09:15:00',
      '2026-10-18 10:05:00', '2026-10-18 10:40:00', '2026-10-18 11:25:00',
      '2026-10-18 13:10:00', '2026-10-18 13:50:00', '2026-10-18 14:30:00',
      '2026-10-18 15:15:00', '2026-10-18 15:55:00', '2026-10-18 16:20:00',
      '2026-10-18 16:45:00', '2026-10-18 17:10:00', '2026-10-18 17:30:00',
    ];

    const lapasTimes = [
      '2026-10-17 08:10:00', '2026-10-17 09:30:00', '2026-10-17 10:45:00',
      '2026-10-17 13:15:00', '2026-10-17 14:40:00', '2026-10-17 15:50:00',
      '2026-10-17 16:30:00', '2026-10-17 17:15:00', '2026-10-16 08:40:00',
      '2026-10-16 10:20:00', '2026-10-16 11:45:00', '2026-10-16 14:10:00',
      '2026-10-16 15:30:00', '2026-10-16 16:15:00', '2026-10-16 17:00:00',
    ];

    const ongoingTimes = [
      '2026-10-21 09:15:00', '2026-10-21 13:40:00', '2026-10-21 16:20:00',
      '2026-10-22 10:10:00', '2026-10-22 14:30:00', '2026-10-22 16:50:00',
      '2026-10-23 08:30:00', '2026-10-23 14:00:00', '2026-10-24 11:15:00',
      '2026-10-24 16:45:00',
    ];

    console.log('\nAssigning timestamps:');
    let tungCount = 0;
    let lapasCount = 0;
    let ongoingCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const rep = rows[i];
      let assignedDate = '';
      let targetStatus = rep.reportStatus;

      if (i < 15) {
        // Group 1: Ni Tung-Tung sa 7 Days (October 18)
        assignedDate = tungTungTimes[i % tungTungTimes.length];
        targetStatus = 'Pending Validation';
        tungCount++;
      } else if (i < 30) {
        // Group 2: Ni Lapas sa 7 Days (October 16-17)
        assignedDate = lapasTimes[(i - 15) % lapasTimes.length];
        targetStatus = 'Closed';
        lapasCount++;
      } else {
        // Group 3: Active Ongoing (October 21-24)
        assignedDate = ongoingTimes[(i - 30) % ongoingTimes.length];
        targetStatus = 'Pending Validation';
        ongoingCount++;
      }

      await connection.query(
        `UPDATE reports 
         SET createdAt = ?, photoCapturedAt = ?, submittedAt = ?, reportStatus = ?, updatedAt = NOW()
         WHERE id = ?`,
        [assignedDate, assignedDate, assignedDate, targetStatus, rep.id]
      );
      console.log(`✓ Report #${i + 1} (${rep.id.slice(0, 8)}) -> ${assignedDate} [${targetStatus}]`);
    }

    // Run expiration check for any remaining reports
    await evaluateExpiredPendingReports();

    console.log(`\n🎉 Distribution Finished!`);
    console.log(`• Ni Tung-Tung sa 7 Days (Oct 18, Day 7/7, Pending): ${tungCount}`);
    console.log(`• Ni Lapas sa 7 Days (Oct 16-17, >7 Days, Closed):   ${lapasCount}`);
    console.log(`• Active Ongoing (Oct 21-24, Days 1-4, Pending):     ${ongoingCount}`);
  } catch (error) {
    console.error('❌ Error distributing dates:', error);
  } finally {
    connection.release();
    await pool.end();
  }
}

distributeDates();
