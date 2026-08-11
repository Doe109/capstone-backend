import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import * as usersRepository from '../repositories/usersRepository';

const expo = new Expo();

export interface RoadAdvisoryPushParams {
  reportId: string;
  conditionType: string;
  selectedBarangay: string;
}

/**
 * Send automatic push notifications to all registered devices when a report becomes Verified / crosses RRS threshold.
 */
export async function sendRoadAdvisoryNotification(params: RoadAdvisoryPushParams): Promise<void> {
  const { reportId, conditionType, selectedBarangay } = params;

  try {
    const rawTokens = await usersRepository.getAllPushTokens();
    if (!rawTokens || rawTokens.length === 0) {
      console.log('[pushNotificationService] No push tokens registered in database to notify.');
      return;
    }

    const messages: ExpoPushMessage[] = [];
    for (const token of rawTokens) {
      if (!Expo.isExpoPushToken(token)) {
        console.warn(`[pushNotificationService] Skipping invalid Expo push token: ${token}`);
        continue;
      }

      messages.push({
        to: token,
        sound: 'default',
        title: 'Road Condition Advisory',
        body: `${conditionType} hazard reported in Brgy. ${selectedBarangay} — drive carefully or avoid area.`,
        data: { reportId },
        priority: 'high',
      });
    }

    if (messages.length === 0) {
      console.log('[pushNotificationService] No valid push tokens found for broadcast.');
      return;
    }

    console.log(`[pushNotificationService] Sending ${messages.length} push notification(s)...`);

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
