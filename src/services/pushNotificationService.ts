import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import * as usersRepository from '../repositories/usersRepository';

const expo = new Expo();

import { SeverityLevel } from '../types/report';

export interface PushNotificationParams {
  reportId: string;
  conditionType: string;
  selectedBarangay: string;
  reporterUserId?: string;
  severityLevel?: SeverityLevel;
}

/**
 * Safely send push notifications with single-token isolation
 * so that a conflicting or stale token never blocks other valid devices from receiving alerts.
 */
async function sendPushMessagesSafely(
  messages: ExpoPushMessage[]
): Promise<{ tickets: ExpoPushTicket[]; errors: string[] }> {
  const tickets: ExpoPushTicket[] = [];
  const errors: string[] = [];

  for (const msg of messages) {
    try {
      const singleTicket = await expo.sendPushNotificationsAsync([msg]);
      tickets.push(...singleTicket);
    } catch (singleErr: any) {
      const errStr = singleErr?.message || String(singleErr);
      console.warn(`[pushNotificationService] Failed to send to token ${msg.to}:`, errStr);
      errors.push(`Token ${String(msg.to).substring(0, 20)}...: ${errStr}`);
    }
  }

  // Log individual ticket errors (e.g. DeviceNotRegistered)
  for (const ticket of tickets) {
    if (ticket.status === 'error') {
      console.warn(
        `[pushNotificationService] Push delivery ticket error: ${ticket.message} (${ticket.details?.error})`
      );
    }
  }

  return { tickets, errors };
}

/**
 * Send automatic push notifications to all registered devices when a report is newly submitted (Pending Validation).
 * Excludes the reporter so they don't receive an alert for their own submission.
 */
export async function sendNewReportNotification(params: PushNotificationParams): Promise<void> {
  const { reportId, conditionType, selectedBarangay, reporterUserId } = params;

  try {
    const rawTokens = await usersRepository.getAllPushTokens(reporterUserId);
    if (!rawTokens || rawTokens.length === 0) {
      console.log('[pushNotificationService] No push tokens registered in database to notify.');
      return;
    }

    const uniqueTokens = Array.from(new Set(rawTokens.filter((token) => Expo.isExpoPushToken(token))));
    const messages: ExpoPushMessage[] = uniqueTokens.map((token) => ({
      to: token,
      sound: 'default',
      title: `📢 New Road Hazard Report: ${conditionType}`,
      body: `A new ${conditionType} hazard has been reported in Brgy. ${selectedBarangay}. Tap to view details and inspect location on the map.`,
      data: { reportId, screen: 'report-detail', type: 'new_report', conditionType, barangay: selectedBarangay },
      priority: 'high',
      channelId: 'default',
    }));

    if (messages.length === 0) {
      console.log('[pushNotificationService] No valid push tokens found for broadcast.');
      return;
    }

    console.log(`[pushNotificationService] Sending ${messages.length} new report push notification(s)...`);
    await sendPushMessagesSafely(messages);
  } catch (err) {
    console.error('[pushNotificationService] Failed to process new report push notifications:', err);
  }
}

import { getRecommendedAction } from '../routes/reports';

/**
 * Send automatic push notifications to all registered devices when a report becomes Verified / crosses RRS threshold.
 * Enhanced with DSS Severity level (BAD / POOR / FAIR) and recommended speed advisory.
 * Excludes the reporter so they don't receive an alert for their own submission.
 */
export async function sendRoadAdvisoryNotification(params: PushNotificationParams): Promise<void> {
  const { reportId, conditionType, selectedBarangay, reporterUserId, severityLevel } = params;

  try {
    const rawTokens = await usersRepository.getAllPushTokens(reporterUserId);
    if (!rawTokens || rawTokens.length === 0) {
      console.log('[pushNotificationService] No push tokens registered in database to notify.');
      return;
    }

    const uniqueTokens = Array.from(new Set(rawTokens.filter((token) => Expo.isExpoPushToken(token))));
    const safetyAction = getRecommendedAction(conditionType);

    const normSev = (severityLevel || 'POOR').toUpperCase().trim();
    let speedLimit = '30-40 kph';
    let badgeEmoji = '⚠️';
    let levelLabel = 'POOR';

    if (normSev === 'BAD') {
      speedLimit = '20-30 kph';
      badgeEmoji = '🚨';
      levelLabel = 'BAD';
    } else if (normSev === 'FAIR') {
      speedLimit = '50-60 kph';
      badgeEmoji = 'ℹ️';
      levelLabel = 'FAIR';
    }

    const notifTitle = `${badgeEmoji} DSS Road Advisory • ${conditionType} (${speedLimit})`;
    const notifBody = `[DSS Safe Speed: ${speedLimit} zone • ${levelLabel}] Verified ${conditionType.toLowerCase()} in Brgy. ${selectedBarangay}. ${safetyAction}`;

    const messages: ExpoPushMessage[] = uniqueTokens.map((token) => ({
      to: token,
      sound: 'default',
      title: notifTitle,
      body: notifBody,
      data: {
        reportId,
        screen: 'report-detail',
        type: 'advisory',
        conditionType,
        barangay: selectedBarangay,
        severityLevel: severityLevel || 'POOR',
      },
      priority: 'high',
      channelId: 'default',
    }));

    if (messages.length === 0) {
      console.log('[pushNotificationService] No valid push tokens found for broadcast.');
      return;
    }

    console.log(`[pushNotificationService] Sending ${messages.length} verified advisory push notification(s) [Severity: ${severityLevel || 'N/A'}]...`);
    await sendPushMessagesSafely(messages);
  } catch (err) {
    console.error('[pushNotificationService] Failed to process push notifications:', err);
  }
}

/**
 * Send automatic push notifications to all registered devices when a repair photo is submitted (Under Review).
 * Excludes the submitter so they don't receive an alert for their own submission.
 */
export async function sendRepairUnderReviewNotification(params: {
  reportId: string;
  conditionType: string;
  selectedBarangay: string;
  submitterUserId?: string;
}): Promise<void> {
  const { reportId, conditionType, selectedBarangay, submitterUserId } = params;

  try {
    const rawTokens = await usersRepository.getAllPushTokens(submitterUserId);
    if (!rawTokens || rawTokens.length === 0) {
      console.log('[pushNotificationService] No push tokens registered in database to notify for repair review.');
      return;
    }

    const uniqueTokens = Array.from(new Set(rawTokens.filter((token) => Expo.isExpoPushToken(token))));
    const messages: ExpoPushMessage[] = uniqueTokens.map((token) => ({
      to: token,
      sound: 'default',
      title: `🔧 Road Repair Under Verification: ${conditionType}`,
      body: `A repair verification photo was submitted in Brgy. ${selectedBarangay}. If you are nearby, please help verify if the road hazard has been fixed.`,
      data: { reportId, screen: 'report-detail', type: 'repair_submitted', conditionType, barangay: selectedBarangay },
      priority: 'high',
      channelId: 'default',
    }));

    if (messages.length === 0) return;

    console.log(`[pushNotificationService] Sending ${messages.length} repair review push notification(s)...`);
    await sendPushMessagesSafely(messages);
  } catch (err) {
    console.error('[pushNotificationService] Failed to process repair review push notifications:', err);
  }
}

/**
 * Send automatic push notifications when community votes confirm that a road condition has been fixed (Resolved).
 * Excludes the voter / submitter so only other users receive the broadcast.
 */
export async function sendRepairResolvedNotification(params: {
  reportId: string;
  conditionType: string;
  selectedBarangay: string;
  excludeUserId?: string;
}): Promise<void> {
  const { reportId, conditionType, selectedBarangay, excludeUserId } = params;

  try {
    const rawTokens = await usersRepository.getAllPushTokens(excludeUserId);
    if (!rawTokens || rawTokens.length === 0) {
      console.log('[pushNotificationService] No push tokens registered in database to notify for resolved repair.');
      return;
    }

    const uniqueTokens = Array.from(new Set(rawTokens.filter((token) => Expo.isExpoPushToken(token))));
    const messages: ExpoPushMessage[] = uniqueTokens.map((token) => ({
      to: token,
      sound: 'default',
      title: `🎉 Resolved: Road Hazard Fixed!`,
      body: `The reported ${conditionType} in Brgy. ${selectedBarangay} has been verified as repaired by community consensus. Safe to pass!`,
      data: { reportId, screen: 'report-detail', type: 'repair_resolved', conditionType, barangay: selectedBarangay },
      priority: 'high',
      channelId: 'default',
    }));

    if (messages.length === 0) return;

    console.log(`[pushNotificationService] Sending ${messages.length} repair resolved push notification(s)...`);
    await sendPushMessagesSafely(messages);
  } catch (err) {
    console.error('[pushNotificationService] Failed to process repair resolved push notifications:', err);
  }
}

/**
 * Send a personal celebration push notification to the citizen who submitted the repair photo
 * when the community confirms by consensus that the road is now officially fixed (Resolved).
 */
export async function sendSubmitterRepairCelebrationNotification(params: {
  reportId: string;
  conditionType: string;
  selectedBarangay: string;
  submitterUserId: string;
}): Promise<void> {
  const { reportId, conditionType, selectedBarangay, submitterUserId } = params;

  try {
    const user = await usersRepository.findUserById(submitterUserId);
    if (!user || !user.pushToken || !Expo.isExpoPushToken(user.pushToken)) {
      console.log(`[pushNotificationService] Submitter ${submitterUserId} does not have a valid push token for celebration.`);
      return;
    }

    const messages: ExpoPushMessage[] = [
      {
        to: user.pushToken,
        sound: 'default',
        title: '🎉 Confirmed: Your Repair Submission Was Verified!',
        body: `Community consensus verified that the ${conditionType} in Brgy. ${selectedBarangay} has been successfully fixed based on your photo. Thank you for your contribution!`,
        data: { reportId, screen: 'report-detail', type: 'repair_resolved_celebration' },
        priority: 'high',
        channelId: 'default',
      },
    ];

    console.log(`[pushNotificationService] Sending celebration push notification to repair submitter (${submitterUserId})...`);
    await sendPushMessagesSafely(messages);
  } catch (err) {
    console.error('[pushNotificationService] Failed to send submitter celebration push notification:', err);
  }
}

/**
 * Send automatic 2-week follow-up reminder push notification to ALL registered users (Table 7 R15).
 */
export async function sendTwoWeekFollowUpReminderNotification(params: {
  reportId: string;
  conditionType: string;
  selectedBarangay: string;
}): Promise<void> {
  const { reportId, conditionType, selectedBarangay } = params;

  try {
    const rawTokens = await usersRepository.getAllPushTokens();
    if (!rawTokens || rawTokens.length === 0) {
      console.log('[pushNotificationService] No push tokens registered in database to notify for 2-week follow-up.');
      return;
    }

    const uniqueTokens = Array.from(new Set(rawTokens.filter((token) => Expo.isExpoPushToken(token))));
    const messages: ExpoPushMessage[] = uniqueTokens.map((token) => ({
      to: token,
      sound: 'default',
      title: '🔔 Status Check: Unrepaired Hazard Reminder',
      body: `The verified ${conditionType} in Brgy. ${selectedBarangay} has remained active for 2 weeks. Please check if it has been repaired. Tap to submit repair evidence.`,
      data: { reportId, screen: 'report-detail', type: 'followup', conditionType, barangay: selectedBarangay },
      priority: 'high',
      channelId: 'default',
    }));

    if (messages.length === 0) return;

    console.log(`[pushNotificationService] Broadcasting 2-week follow-up reminder to ${messages.length} device(s)...`);
    await sendPushMessagesSafely(messages);
  } catch (err) {
    console.error('[pushNotificationService] Failed to broadcast 2-week follow-up reminder:', err);
  }
}

/**
 * Send an immediate test push notification to all registered tokens for live verification.
 */
export async function sendTestPushNotification(): Promise<{
  totalTokens: number;
  validTokens: number;
  tickets: ExpoPushTicket[];
  errors: string[];
}> {
  const rawTokens = await usersRepository.getAllPushTokens();
  const validTokens = Array.from(new Set(rawTokens.filter((token) => Expo.isExpoPushToken(token))));

  if (validTokens.length === 0) {
    return {
      totalTokens: rawTokens.length,
      validTokens: 0,
      tickets: [],
      errors: ['No valid Expo push tokens found in database. Please make sure the app is opened and logged in on at least one device.'],
    };
  }

  const messages: ExpoPushMessage[] = validTokens.map((token) => ({
    to: token,
    sound: 'default',
    title: '🔔 RoadWatch Push Notification Test',
    body: 'This is a test notification from RoadWatch. Push notification service is active and operational!',
    data: { test: true, timestamp: new Date().toISOString() },
    priority: 'high',
    channelId: 'default',
  }));

  const { tickets, errors } = await sendPushMessagesSafely(messages);

  return {
    totalTokens: rawTokens.length,
    validTokens: validTokens.length,
    tickets,
    errors,
  };
}

