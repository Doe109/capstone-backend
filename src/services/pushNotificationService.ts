import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import * as usersRepository from '../repositories/usersRepository';

const expo = new Expo();

export interface PushNotificationParams {
  reportId: string;
  conditionType: string;
  selectedBarangay: string;
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
 */
export async function sendNewReportNotification(params: PushNotificationParams): Promise<void> {
  const { reportId, conditionType, selectedBarangay } = params;

  try {
    const rawTokens = await usersRepository.getAllPushTokens();
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

/**
 * Send automatic push notifications to all registered devices when a report becomes Verified / crosses RRS threshold.
 */
export async function sendRoadAdvisoryNotification(params: PushNotificationParams): Promise<void> {
  const { reportId, conditionType, selectedBarangay } = params;

  try {
    const rawTokens = await usersRepository.getAllPushTokens();
    if (!rawTokens || rawTokens.length === 0) {
      console.log('[pushNotificationService] No push tokens registered in database to notify.');
      return;
    }

    const uniqueTokens = Array.from(new Set(rawTokens.filter((token) => Expo.isExpoPushToken(token))));
    const messages: ExpoPushMessage[] = uniqueTokens.map((token) => ({
      to: token,
      sound: 'default',
      title: `⚠️ Travel with Caution • ${conditionType} Advisory`,
      body: `Verified ${conditionType.toLowerCase()} in Brgy. ${selectedBarangay}. Motorists are advised to reduce speed and travel with caution.`,
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

