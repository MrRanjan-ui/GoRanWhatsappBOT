import { google } from 'googleapis';
import * as dotenv from 'dotenv';

// Ensure env variables are configured
dotenv.config();

const calendar = google.calendar('v3');

// Load configurations
const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
// Replace escaped newlines in keys if they are stored in .env as single strings
const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

// Authenticate Google APIs client with JWT (Service Account)
const auth = new google.auth.JWT({
  email: serviceAccountEmail,
  key: privateKey,
  scopes: ['https://www.googleapis.com/auth/calendar']
});

export interface CreateEventParams {
  summary: string;
  description: string;
  startIso: string;
  endIso: string;
  attendeeEmail: string;
}

/**
 * Creates an event on the configured Google Calendar via Google Calendar API.
 * Returns the calendar event HTML link on success, or null if disabled.
 */
export async function createCalendarEvent(params: CreateEventParams): Promise<string | null> {
  // If credentials are placeholder defaults, treat as disabled/empty
  if (!serviceAccountEmail || !privateKey || privateKey.includes('YOUR_') || serviceAccountEmail.includes('your-')) {
    console.warn('[CALENDAR-SERVICE] Google Service Account credentials are not configured. Skipping event creation.');
    return null;
  }

  try {
    const event = {
      summary: params.summary,
      description: params.description,
      start: {
        dateTime: params.startIso,
        timeZone: 'Asia/Kolkata', // Set to Indian Standard Time (IST) by default
      },
      end: {
        dateTime: params.endIso,
        timeZone: 'Asia/Kolkata',
      },
      reminders: {
        useDefault: true,
      },
    };

    const response = await calendar.events.insert({
      auth: auth,
      calendarId: calendarId,
      requestBody: event,
      sendUpdates: 'none',
    });

    const eventLink = response.data.htmlLink || 'success';
    console.log(`[CALENDAR-SERVICE] Created calendar event on organizer calendar. Link: ${eventLink}`);
    return eventLink;
  } catch (error: any) {
    console.error('[CALENDAR-SERVICE] Failed to create Google Calendar event:', error.message || error);
    throw error;
  }
}
