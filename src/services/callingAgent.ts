import * as dotenv from 'dotenv';
dotenv.config();

const CALLING_AGENT_URL = process.env.CALLING_AGENT_URL || '';
const FOLLOW_UP_DELAY_MS = Number(process.env.FOLLOW_UP_DELAY_MS) || 30 * 60 * 1000; // Default: 30 minutes

// In-memory tracker for scheduled reminder timers (to avoid duplicates)
const scheduledReminders: { [phone: string]: NodeJS.Timeout } = {};

/**
 * Triggers an outbound follow-up call to a lead who completed the WhatsApp
 * qualification flow but did NOT book a meeting.
 * 
 * The call is placed after a configurable delay (default 2 minutes) to give
 * the lead a moment before following up by phone.
 * 
 * Uses the "arjun-outbound" persona by default.
 */
export function triggerFollowUpCall(phone: string, personaId: string = 'arjun-outbound'): void {
  if (!CALLING_AGENT_URL) {
    console.log(`[CALLING-AGENT] Skipping follow-up call for ${phone} — CALLING_AGENT_URL not configured.`);
    return;
  }

  // Format number with + prefix for VoBiz
  const toNumber = phone.startsWith('+') ? phone : `+${phone}`;

  console.log(`[CALLING-AGENT] Scheduling follow-up call to ${toNumber} in ${FOLLOW_UP_DELAY_MS / 1000}s (persona: ${personaId})`);

  setTimeout(async () => {
    try {
      console.log(`[CALLING-AGENT] Triggering follow-up call to ${toNumber}...`);
      const response = await fetch(`${CALLING_AGENT_URL}/api/outbound/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toNumber, personaId })
      });

      const data = await response.json();

      if (data.success) {
        console.log(`[CALLING-AGENT] ✅ Follow-up call initiated: callId=${data.callId}, status=${data.status}`);
      } else {
        console.warn(`[CALLING-AGENT] ⚠️ Follow-up call failed: ${data.error || 'Unknown error'}`);
      }
    } catch (err: any) {
      console.error(`[CALLING-AGENT] ❌ Failed to reach Calling Agent at ${CALLING_AGENT_URL}:`, err.message || err);
    }
  }, FOLLOW_UP_DELAY_MS);
}

/**
 * Schedules a meeting reminder call 1 hour before the meeting start time.
 * 
 * If the meeting is less than 1 hour away, the call is scheduled to fire
 * in 5 minutes (minimum lead time). If the meeting is in the past, the
 * call is skipped entirely.
 * 
 * Uses the "reminder-outbound" persona by default.
 */
export function scheduleMeetingReminderCall(
  phone: string,
  meetingStartIso: string,
  personaId: string = 'reminder-outbound'
): void {
  if (!CALLING_AGENT_URL) {
    console.log(`[CALLING-AGENT] Skipping reminder call for ${phone} — CALLING_AGENT_URL not configured.`);
    return;
  }

  if (!meetingStartIso) {
    console.log(`[CALLING-AGENT] Skipping reminder call for ${phone} — no meeting start ISO time provided.`);
    return;
  }

  const meetingTime = new Date(meetingStartIso).getTime();
  const now = Date.now();

  if (isNaN(meetingTime)) {
    console.warn(`[CALLING-AGENT] Invalid meeting ISO time: ${meetingStartIso}`);
    return;
  }

  // Calculate when to call: 1 hour before the meeting
  const oneHourBefore = meetingTime - (60 * 60 * 1000);
  let delayMs = oneHourBefore - now;

  // If the meeting is less than 1 hour away, call in 5 minutes minimum
  if (delayMs < 0) {
    const timeUntilMeeting = meetingTime - now;
    if (timeUntilMeeting < 0) {
      console.log(`[CALLING-AGENT] Meeting time is in the past (${meetingStartIso}). Skipping reminder call.`);
      return;
    }
    // Meeting is less than 1 hour away — call in 5 minutes or immediately if <5 min to meeting
    delayMs = Math.max(0, Math.min(5 * 60 * 1000, timeUntilMeeting - 5 * 60 * 1000));
  }

  // Cancel any existing reminder for this phone number
  if (scheduledReminders[phone]) {
    clearTimeout(scheduledReminders[phone]);
    console.log(`[CALLING-AGENT] Cancelled previous reminder for ${phone}`);
  }

  const toNumber = phone.startsWith('+') ? phone : `+${phone}`;
  const delayMinutes = Math.round(delayMs / 60000);

  console.log(`[CALLING-AGENT] 📅 Scheduled reminder call to ${toNumber} in ${delayMinutes} minutes (persona: ${personaId})`);

  scheduledReminders[phone] = setTimeout(async () => {
    delete scheduledReminders[phone];

    try {
      console.log(`[CALLING-AGENT] Triggering meeting reminder call to ${toNumber}...`);
      const response = await fetch(`${CALLING_AGENT_URL}/api/outbound/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toNumber, personaId })
      });

      const data = await response.json();

      if (data.success) {
        console.log(`[CALLING-AGENT] ✅ Reminder call initiated: callId=${data.callId}, status=${data.status}`);
      } else {
        console.warn(`[CALLING-AGENT] ⚠️ Reminder call failed: ${data.error || 'Unknown error'}`);
      }
    } catch (err: any) {
      console.error(`[CALLING-AGENT] ❌ Failed to reach Calling Agent for reminder:`, err.message || err);
    }
  }, delayMs);
}
