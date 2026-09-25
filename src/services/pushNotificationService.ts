import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import * as usersRepository from '../repositories/usersRepository';

const expo = new Expo();

export interface PushNotificationParams {
  reportId: string;
  conditionType: string;
  selectedBarangay: string;
  reporterUserId?: string;
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
      title: `📢 Bag-ong Road Report: ${conditionType}`,
      body: `Adunay bag-ong report nga ${conditionType} sa Brgy. ${selectedBarangay}. I-tap aron masusi ang dalan ug lokasyon sa mapa.`,
      data: { reportId, screen: 'report-detail' },
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
 * Excludes the reporter so they don't receive an alert for their own submission.
 */
export async function sendRoadAdvisoryNotification(params: PushNotificationParams): Promise<void> {
  const { reportId, conditionType, selectedBarangay, reporterUserId } = params;

  try {
    const rawTokens = await usersRepository.getAllPushTokens(reporterUserId);
    if (!rawTokens || rawTokens.length === 0) {
      console.log('[pushNotificationService] No push tokens registered in database to notify.');
      return;
    }

    const uniqueTokens = Array.from(new Set(rawTokens.filter((token) => Expo.isExpoPushToken(token))));
    const safetyAction = getRecommendedAction(conditionType);
    const messages: ExpoPushMessage[] = uniqueTokens.map((token) => ({
      to: token,
      sound: 'default',
      title: `⚠️ Travel with Caution • ${conditionType} Advisory`,
      body: `Verified ${conditionType.toLowerCase()} in Brgy. ${selectedBarangay}: ${safetyAction}`,
      data: { reportId, screen: 'report-detail' },
      priority: 'high',
      channelId: 'default',
    }));

    if (messages.length === 0) {
      console.log('[pushNotificationService] No valid push tokens found for broadcast.');
      return;
    }

    console.log(`[pushNotificationService] Sending ${messages.length} verified advisory push notification(s)...`);
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
      title: `🔧 Gisusi ang Pagka-ayo sa Dalan: ${conditionType}`,
      body: `Adunay bag-ong repair photo nga gi-submit sa Brgy. ${selectedBarangay}. Kung anaa ka sa duol, palihug tabangi pag-verify kung na-ayo na ba gyud kini.`,
      data: { reportId, screen: 'report-detail', type: 'under_review' },
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
      title: `🎉 Kumpirmado! Na-ayo Na ang Dalan`,
      body: `Ang gitaho nga ${conditionType} sa Brgy. ${selectedBarangay} kumpirmado na sa komunidad nga na-ayo na. Luwas na kining agian sa tanan!`,
      data: { reportId, screen: 'report-detail', type: 'resolved' },
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
        title: '🎉 Kumpirmado! Na-verify ang Imong Gi-submit nga Repair',
        body: `Kumpirmado sa komunidad nga opisyal nang na-ayo ang ${conditionType} sa Brgy. ${selectedBarangay} base sa imong gi-submit nga litrato. Daghang salamat sa imong kontribusyon!`,
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
    body: 'Kini usa ka test notification gikan sa RoadWatch system. 100% active ug naglihok ang push service!',
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

