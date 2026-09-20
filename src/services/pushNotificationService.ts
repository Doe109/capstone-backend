import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import * as usersRepository from '../repositories/usersRepository';

const expo = new Expo();

export interface PushNotificationParams {
  reportId: string;
  conditionType: string;
  selectedBarangay: string;
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

    // Strictly deduplicate valid Expo push tokens
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

    console.log(`[pushNotificationService] Sending ${messages.length} unique new report push notification(s)...`);

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        await expo.sendPushNotificationsAsync(chunk);
      } catch (error) {
        console.error('[pushNotificationService] Error sending new report push chunk:', error);
      }
    }
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

    // Strictly deduplicate valid Expo push tokens
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

    const chunks = expo.chunkPushNotifications(messages);
    const tickets: ExpoPushTicket[] = [];

    for (const chunk of chunks) {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);
      } catch (error) {
        console.error('[pushNotificationService] Error sending push chunk:', error);
      }
    }

    // Inspect tickets for invalid/expired token errors
    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      if (ticket.status === 'error') {
        console.warn(
          `[pushNotificationService] Push delivery error for token: ${ticket.message} (${ticket.details?.error})`
        );
      }
    }
  } catch (err) {
    console.error('[pushNotificationService] Failed to process push notifications:', err);
  }
}
