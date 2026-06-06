import { sendWhatsAppReply } from './services/whatsapp';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { askGemini, askGeminiRaw, GeminiMessage } from './gemini';
import { createCalendarEvent } from './services/calendar';
import { sendLeadEmails } from './services/mailer';
import { saveLead, updateLeadBooking } from './services/db';
import { triggerFollowUpCall, scheduleMeetingReminderCall } from './services/callingAgent';

// Initialize dotenv immediately
dotenv.config();

// Load static texts
const configPath = path.join(__dirname, '../config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Sessions state storage (In-memory)
interface LeadData {
  phone: string;
  bizType?: string;
  challenge?: string;
  process?: string;
  teamSize?: string;
  email?: string;
  meetingTime?: string;
  meetingStartIso?: string;
  meetingEndIso?: string;
  meetingLink?: string;
  score?: string;
  scoreReason?: string;
  summaryBlock?: string;
  questionsAsked: string[];
  timestamp: string;
}

interface Session {
  /** 'qualifying' = AI is naturally collecting lead info; 'booking' = waiting for date/time; 'chatting' = post-qualification free chat */
  phase: 'qualifying' | 'booking' | 'chatting';
  history: GeminiMessage[];
  timeoutTimer?: NodeJS.Timeout;
  leadData: LeadData;
  /** Tracks which qualification fields have been extracted so far */
  collectedFields: Set<string>;
  /** Whether the lead has already been saved */
  leadSaved: boolean;
  /** Per-JID processing lock to prevent duplicate responses from race conditions */
  processing: boolean;
  /** Stashed booking time from user message (when they provide time + booking request in one message) */
  pendingBookingTime?: string;
}

const sessions: { [jid: string]: Session } = {};

// The fields we want to collect during qualification
const REQUIRED_FIELDS = ['bizType', 'challenge', 'process', 'teamSize', 'email'] as const;

// ──────────────────────────────────────────────────
// Utility: extract email from raw text via regex
// ──────────────────────────────────────────────────
function extractEmailFromText(text: string): string | null {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const match = text.match(emailRegex);
  return match ? match[0] : null;
}

// ──────────────────────────────────────────────────
// Utility: strip any [TRIGGER_BOOKING] tokens from text
// ──────────────────────────────────────────────────
function stripTriggerTokens(text: string): string {
  return text.replace(/\[TRIGGER_BOOKING\]/g, '').trim();
}

// ──────────────────────────────────────────────────
// Utility: check if text contains booking intent keywords
// ──────────────────────────────────────────────────
function hasBookingIntent(text: string): boolean {
  const lower = text.toLowerCase();
  const keywords = ['book', 'schedule', 'meeting', 'appointment', 'call', 'slot'];
  return keywords.some(kw => lower.includes(kw));
}

/**
 * Build a dynamic system instruction that tells Gemini what info
 * is still missing so it can naturally work those questions into conversation.
 */
function buildQualificationSystemPrompt(collected: Set<string>): string {
  const missing: string[] = [];
  if (!collected.has('bizType'))   missing.push('What type of business they run');
  if (!collected.has('challenge')) missing.push('Their biggest challenge (e.g. lead gen, operations, support, recruitment, follow-ups)');
  if (!collected.has('process'))   missing.push('How they currently handle that process');
  if (!collected.has('teamSize'))  missing.push('Roughly how many employees they have');
  if (!collected.has('email'))     missing.push('Their email address (for sending a summary and calendar invite)');

  const collectedList = Array.from(collected);
  const collectedInfo = collectedList.length > 0
    ? `\nYou have already collected: ${collectedList.join(', ')}. Do NOT re-ask for these.`
    : '';

  const allCollected = missing.length === 0;

  return `${config.systemInstruction}

### YOUR CURRENT ROLE — AI Sales Consultant & Lead Qualifier
You are having a REAL, natural conversation on WhatsApp. You are NOT a form or a quiz.
${collectedInfo}

${allCollected
  ? `ALL qualification data has been collected! 🎉
Now do one of these:
- Provide a short, personalized value insight based on their business details.
- Naturally suggest booking a 15-minute strategy call. Ask for their preferred date/time.
- If they already gave a preferred time, output exactly: [TRIGGER_BOOKING]
- Otherwise, continue chatting helpfully about their business.`
  : `You still need to learn the following (weave them into conversation NATURALLY — do NOT ask all at once, do NOT list them as a numbered form):
${missing.map((m, i) => `${i + 1}. ${m}`).join('\n')}

GUIDELINES:
- Ask ONE missing piece of info at a time, max two if they're closely related.
- React to what the user says — acknowledge their answers, show empathy, give a brief insight, THEN ask the next question.
- If the user asks YOU a question mid-flow, answer it helpfully and then smoothly continue gathering info.
- Sound like a smart AI consultant, NOT a script reader.`
}

### BOOKING TRIGGER
If the user explicitly asks to book a call, schedule a meeting, or start a project, reply with EXACTLY and ONLY: [TRIGGER_BOOKING]
Do NOT add any other text before or after [TRIGGER_BOOKING]. Just the token alone.

### FORMAT
- Keep messages concise and punchy for WhatsApp (not too long).
- Use *bold* for emphasis. Use bullet points when helpful.
- Be warm, professional, and consultative.
- Send only ONE response per turn. Never send multiple messages.
- Always use the WhatsApp buttons protocol "[BUTTONS: Option 1 | Option 2 | Option 3]" when asking options or suggesting the next step (like business type B2B/B2C, team size 1-5/6-20/21+, or booking). Make sure button titles are strictly 20 characters or less.`;
}

/**
 * Main message handler — fully AI-driven
 */
export async function handleIncomingMessage(senderNumber: string, messageText: string) {
  const remoteJid = senderNumber;

  // 1. Strict Whitelist Filter (Bypassed if ALLOWED_NUMBERS is empty or '*')
  const allowedString = process.env.ALLOWED_NUMBERS || '';
  if (allowedString && allowedString.trim() !== '*') {
    const allowedNumbers = allowedString.split(',').map(n => n.trim());
    if (!allowedNumbers.includes(senderNumber)) {
      console.log(`[WHITELIST-BLOCKED] Ignored message from ${senderNumber}: "${messageText}" (Allowed: ${allowedString})`);
      return;
    }
  }

  console.log(`[MESSAGE-RECEIVED] From: ${senderNumber} | Message: "${messageText}"`);

  const text = messageText.trim();
  const lowerText = text.toLowerCase();

  // Reset command
  if (lowerText === 'menu' || lowerText === 'exit' || lowerText === 'reset' || lowerText === 'home') {
    delete sessions[remoteJid];
  }

  // Initialize session if needed
  const isNewSession = !sessions[remoteJid];
  if (isNewSession) {
    sessions[remoteJid] = {
      phase: 'qualifying',
      history: [],
      leadData: {
        phone: senderNumber,
        questionsAsked: [],
        timestamp: new Date().toISOString()
      },
      collectedFields: new Set(),
      leadSaved: false,
      processing: false
    };
  }

  const session = sessions[remoteJid];

  // ── Per-JID lock: prevent processing overlapping messages simultaneously ──
  if (session.processing) {
    console.log(`[LOCK] Skipping overlapping message for ${remoteJid} — already processing.`);
    return;
  }
  session.processing = true;

  try {
    // ── Pre-processing: extract email from raw text immediately ──
    const emailInMessage = extractEmailFromText(text);
    if (emailInMessage && !session.collectedFields.has('email')) {
      session.leadData.email = emailInMessage;
      session.collectedFields.add('email');
      console.log(`[FAST-EXTRACT] Email captured from message: ${emailInMessage}`);
    }

    // Refresh the 15-minute inactivity timer
    refreshSessionTimeout(remoteJid);

    // Handle based on phase
    switch (session.phase) {
      case 'qualifying':
      case 'chatting':
        await handleAIConversation(remoteJid, session, text, isNewSession);
        break;

      case 'booking':
        await handleBookingResponse(remoteJid, session, text);
        break;
    }
  } finally {
    session.processing = false;
  }
}

/**
 * Core AI conversation handler — used for both qualification and free chat
 */
async function handleAIConversation(remoteJid: string, session: Session, userText: string, isFirstMessage: boolean) {
  // Build the appropriate system prompt
  const systemPrompt = session.phase === 'qualifying'
    ? buildQualificationSystemPrompt(session.collectedFields)
    : config.systemInstruction + '\n\nYou are in open chat mode. The user has already been qualified. Be helpful, answer any questions about GoRan AI, and if they want to book a call, reply with exactly and only: [TRIGGER_BOOKING]';

  // For the very first message, prepend a greeting context
  const effectiveUserText = isFirstMessage
    ? `[The user just sent their first message to start a conversation. Greet them warmly and start qualifying naturally.]\n\nUser's message: "${userText}"`
    : userText;

  // Get AI response
  const aiResponse = await askGemini(effectiveUserText, session.history, systemPrompt);

  // ── Check for booking trigger BEFORE sending anything ──
  if (aiResponse.includes('[TRIGGER_BOOKING]')) {
    console.log(`[BOOKING-TRIGGER] Detected in AI response during ${session.phase} phase.`);
    
    // Save user message to history (but NOT the trigger response)
    session.history.push({ role: 'user', parts: [{ text: userText }] });

    // If user's message also contains time info, stash it for the booking flow
    if (hasBookingIntent(userText) || /\d/.test(userText)) {
      session.pendingBookingTime = userText;
    }

    await initiateBookingFlow(remoteJid, session);
    return;
  }

  // ── Safety: strip any leaked trigger tokens before sending ──
  const cleanResponse = stripTriggerTokens(aiResponse);
  if (!cleanResponse) {
    console.log(`[SAFETY] AI response was empty after stripping trigger tokens. Skipping send.`);
    return;
  }

  // Save to conversation history
  session.history.push({ role: 'user', parts: [{ text: userText }] });
  session.history.push({ role: 'model', parts: [{ text: cleanResponse }] });

  // Send the AI response
  await sendWhatsAppReply(remoteJid, cleanResponse);

  // Background: extract any new qualification data from conversation
  if (session.phase === 'qualifying') {
    await extractQualificationData(session);

    // Check if all fields are now collected
    const allCollected = REQUIRED_FIELDS.every(f => session.collectedFields.has(f));
    if (allCollected && !session.leadSaved) {
      console.log(`[QUALIFICATION-COMPLETE] All fields collected for ${session.leadData.phone}`);
      await processAndSaveCompletedLead(remoteJid, session);
    }
  }
}

/**
 * Extract structured qualification data from conversation history using Gemini
 */
async function extractQualificationData(session: Session) {
  // Only extract if there's enough conversation (at least 2 exchanges)
  if (session.history.length < 4) return;

  const conversationText = session.history
    .map(m => `${m.role === 'user' ? 'User' : 'Bot'}: ${m.parts[0].text}`)
    .join('\n');

  const extractionPrompt = `Analyze this WhatsApp conversation and extract any business qualification data the USER has shared.

CONVERSATION:
${conversationText}

Extract ONLY information the USER explicitly stated. Output a JSON object with these fields (use null for anything not yet mentioned):
{
  "bizType": "type of business they run (string or null)",
  "challenge": "their biggest challenge (string or null)",
  "process": "how they currently handle it (string or null)",
  "teamSize": "team/employee count (string or null)",
  "email": "their email address (string or null)"
}

RULES:
- Only extract data the USER actually provided. Do NOT infer or guess.
- For email, only extract if it looks like a valid email address.
- Return ONLY the JSON, no other text.`;

  try {
    const rawReply = await askGeminiRaw(extractionPrompt);
    const extracted = parseGeminiJson(rawReply);

    if (extracted) {
      if (extracted.bizType && !session.collectedFields.has('bizType')) {
        session.leadData.bizType = extracted.bizType;
        session.collectedFields.add('bizType');
        console.log(`[DATA-EXTRACTED] bizType: ${extracted.bizType}`);
      }
      if (extracted.challenge && !session.collectedFields.has('challenge')) {
        session.leadData.challenge = extracted.challenge;
        session.collectedFields.add('challenge');
        console.log(`[DATA-EXTRACTED] challenge: ${extracted.challenge}`);
      }
      if (extracted.process && !session.collectedFields.has('process')) {
        session.leadData.process = extracted.process;
        session.collectedFields.add('process');
        console.log(`[DATA-EXTRACTED] process: ${extracted.process}`);
      }
      if (extracted.teamSize && !session.collectedFields.has('teamSize')) {
        session.leadData.teamSize = extracted.teamSize;
        session.collectedFields.add('teamSize');
        console.log(`[DATA-EXTRACTED] teamSize: ${extracted.teamSize}`);
      }
      if (extracted.email && !session.collectedFields.has('email')) {
        session.leadData.email = extracted.email;
        session.collectedFields.add('email');
        console.log(`[DATA-EXTRACTED] email: ${extracted.email}`);
      }
    }
  } catch (err) {
    console.error('[DATA-EXTRACTION] Error extracting qualification data:', err);
  }
}

/**
 * Handle the booking date/time response
 */
async function handleBookingResponse(remoteJid: string, session: Session, userText: string) {
  const lowerText = userText.toLowerCase();

  if (lowerText === 'skip' || lowerText === 'later' || lowerText === 'no') {
    console.log(`[BOOKING] User skipped calendar booking.`);
    session.phase = 'chatting';
    
    const skipResponse = await askGemini(
      "The user decided to skip booking a call for now. Acknowledge this gracefully, let them know the team will follow up via email, and invite them to continue chatting or ask any questions.",
      session.history,
      config.systemInstruction
    );
    const cleanSkip = stripTriggerTokens(skipResponse);
    session.history.push({ role: 'user', parts: [{ text: userText }] });
    session.history.push({ role: 'model', parts: [{ text: cleanSkip }] });
    await sendWhatsAppReply(remoteJid, cleanSkip);
    return;
  }

  // Extract email from this message if present
  const emailInMessage = extractEmailFromText(userText);
  let justProvidedEmail = false;
  if (emailInMessage) {
    if (!session.leadData.email) {
      session.leadData.email = emailInMessage;
      session.collectedFields.add('email');
      console.log(`[BOOKING-EMAIL] Email captured: ${emailInMessage}`);
    }
    justProvidedEmail = true;
  }

  // Try to parse the meeting time
  const parsedTime = await parseMeetingTimeWithGemini(userText);

  if (parsedTime && parsedTime.start && parsedTime.end) {
    try {
      console.log(`[MEETING-SCHEDULER] Creating event for ${session.leadData.phone} at ${parsedTime.start} -> ${parsedTime.end}`);
      console.log(`[MEETING-SCHEDULER] Attendee email: ${session.leadData.email}`);

      const eventLink = await createCalendarEvent({
        summary: `GoRan AI Strategy Call: ${session.leadData.bizType || 'Prospect'} & Ashish Ranjan`,
        description: `Automated scoping session for GoRan AI.\n\nLead Details:\n- Industry/Biz: ${session.leadData.bizType || 'TBD'}\n- Challenge: ${session.leadData.challenge || 'TBD'}\n- Current Process: ${session.leadData.process || 'TBD'}\n- Team Size: ${session.leadData.teamSize || 'TBD'}\n- Phone: +${session.leadData.phone}\n- Email: ${session.leadData.email || 'TBD'}`,
        startIso: parsedTime.start,
        endIso: parsedTime.end,
        attendeeEmail: session.leadData.email || ''
      });

      session.leadData.meetingTime = parsedTime.readable;
      session.leadData.meetingStartIso = parsedTime.start;
      session.leadData.meetingEndIso = parsedTime.end;
      session.leadData.meetingLink = eventLink || undefined;

      const confirmMsg = `📅 *Meeting Confirmed!*\n\nYour strategy call has been scheduled for *${parsedTime.readable}* (IST).\n${session.leadData.email ? `A calendar invitation (.ics) has been sent to *${session.leadData.email}*.` : ''}\n${eventLink ? `\n🔗 Event Link: ${eventLink}` : ''}\n\nIs there anything else I can help you with? [BUTTONS: Explore Services | Ask Q&A | Finish]`;

      session.history.push({ role: 'user', parts: [{ text: userText }] });
      session.history.push({ role: 'model', parts: [{ text: confirmMsg }] });
      await sendWhatsAppReply(remoteJid, confirmMsg);
      session.phase = 'chatting';

      // Save lead if not already saved, otherwise update the booking details in the saved record
      if (!session.leadSaved) {
        await processAndSaveCompletedLead(remoteJid, session);
      } else {
        await updateLeadBookingDetails(session);
      }

      // Schedule a reminder call 1 hour before the meeting
      if (session.leadData.meetingStartIso) {
        scheduleMeetingReminderCall(session.leadData.phone, session.leadData.meetingStartIso);
      }
    } catch (err: any) {
      console.error('[MEETING-SCHEDULER] Google Calendar event creation failed, falling back to email calendar invite:', err.message || err);
      
      // Store time details even if calendar insert failed
      session.leadData.meetingTime = parsedTime.readable;
      session.leadData.meetingStartIso = parsedTime.start;
      session.leadData.meetingEndIso = parsedTime.end;

      const errorMsg = `📅 *Meeting Confirmed!*\n\nYour strategy call has been scheduled for *${parsedTime.readable}* (IST).\n${session.leadData.email ? `A calendar invitation (.ics) has been sent to *${session.leadData.email}*.` : ''}\n\nIs there anything else I can help you with? [BUTTONS: Explore Services | Ask Q&A | Finish]`;
      session.history.push({ role: 'user', parts: [{ text: userText }] });
      session.history.push({ role: 'model', parts: [{ text: errorMsg }] });
      await sendWhatsAppReply(remoteJid, errorMsg);
      session.phase = 'chatting';

      // Save lead if not already saved, otherwise update the booking details in the saved record
      if (!session.leadSaved) {
        await processAndSaveCompletedLead(remoteJid, session);
      } else {
        await updateLeadBookingDetails(session);
      }

      // Schedule a reminder call 1 hour before the meeting (even on calendar fallback)
      if (session.leadData.meetingStartIso) {
        scheduleMeetingReminderCall(session.leadData.phone, session.leadData.meetingStartIso);
      }
    }
  } else {
    // If they just provided the email and did not provide a parseable date/time in the same message, ask for the date/time now!
    if (justProvidedEmail) {
      const askTimeMsg = `Thank you! I've saved your email. 📅 *Please reply with your preferred date and time* for our strategy call.\n\nExamples:\n• *June 11 at 3 PM*\n• *Tomorrow at 11 AM*\n• *Friday at 2:30 PM*\n\nOr type *skip* to schedule later. [BUTTONS: Tomorrow 11 AM | Friday 2:30 PM | Skip for now]`;
      session.history.push({ role: 'user', parts: [{ text: userText }] });
      session.history.push({ role: 'model', parts: [{ text: askTimeMsg }] });
      await sendWhatsAppReply(remoteJid, askTimeMsg);
      return;
    }

    // Couldn't parse — ask again with a clear message
    const retryMsg = `I couldn't quite parse that date and time. Could you try a clearer format?\n\nExamples:\n• *June 11 at 3 PM*\n• *Tomorrow at 11 AM*\n• *Friday at 2:30 PM*\n\nOr type *skip* to schedule later. [BUTTONS: Tomorrow 11 AM | Friday 2:30 PM | Skip for now]`;
    session.history.push({ role: 'user', parts: [{ text: userText }] });
    session.history.push({ role: 'model', parts: [{ text: retryMsg }] });
    await sendWhatsAppReply(remoteJid, retryMsg);
  }
}

/**
 * Triggers the booking flow — handles the case where user already provided time + email in one message
 */
async function initiateBookingFlow(remoteJid: string, session: Session) {
  session.phase = 'booking';

  // If we already have email AND a pending booking time (user gave both in one message), fast-track!
  if (session.leadData.email && session.pendingBookingTime) {
    const pendingTime = session.pendingBookingTime;
    session.pendingBookingTime = undefined;
    console.log(`[FAST-TRACK-BOOKING] Email: ${session.leadData.email}, Time text: "${pendingTime}"`);
    await handleBookingResponse(remoteJid, session, pendingTime);
    return;
  }

  // If we don't have email yet, ask for it
  if (!session.leadData.email) {
    const emailMsg = `To send you the calendar invitation and a summary, I'll need your email address. What's the best email to reach you at? [BUTTONS: Skip for now | Explore Services | Ask Q&A]`;
    session.history.push({ role: 'model', parts: [{ text: emailMsg }] });
    await sendWhatsAppReply(remoteJid, emailMsg);
    // Stay in 'booking' phase — next message will be processed as booking response where we extract email + time
    return;
  }

  // We have email but need a time
  // If there's a pending time from the trigger message, use it
  if (session.pendingBookingTime) {
    const pendingTime = session.pendingBookingTime;
    session.pendingBookingTime = undefined;
    await handleBookingResponse(remoteJid, session, pendingTime);
    return;
  }

  const bookingMsg = `📅 *Let's book your strategy call!*\n\nPlease reply with your preferred date and time.\n\nExamples:\n• *June 11 at 3 PM*\n• *Tomorrow at 11 AM*\n• *Friday at 2:30 PM*\n\nOr type *skip* to schedule later. [BUTTONS: Tomorrow 11 AM | Friday 2:30 PM | Skip for now]`;
  session.history.push({ role: 'model', parts: [{ text: bookingMsg }] });
  await sendWhatsAppReply(remoteJid, bookingMsg);
}

/**
 * Handle lead scoring, saving, and email notifications
 */
async function processAndSaveCompletedLead(remoteJid: string, session: Session) {
  if (session.leadSaved) return;
  session.leadSaved = true;

  // Score the lead using Gemini
  const scoreResult = await scoreCompletedLead(session.leadData);
  session.leadData.score = scoreResult.score;
  session.leadData.scoreReason = scoreResult.reason;
  session.leadData.summaryBlock = scoreResult.summary;

  // Save lead locally to file
  saveLeadToFile(session.leadData);

  // Send email alerts
  await sendLeadEmails({
    phone: session.leadData.phone,
    bizType: session.leadData.bizType || '',
    challenge: session.leadData.challenge || '',
    process: session.leadData.process || '',
    teamSize: session.leadData.teamSize || '',
    email: session.leadData.email || '',
    score: scoreResult.score,
    scoreReason: scoreResult.reason,
    summaryBlock: scoreResult.summary,
    meetingTime: session.leadData.meetingTime,
    meetingStartIso: session.leadData.meetingStartIso,
    meetingEndIso: session.leadData.meetingEndIso,
    meetingLink: session.leadData.meetingLink
  });

  // Transition to chatting phase
  session.phase = 'chatting';
  console.log(`[LEAD-COMPLETE] Lead processed and saved for ${session.leadData.phone}. Score: ${scoreResult.score}`);

  // If no meeting was booked, trigger an outbound follow-up call
  if (!session.leadData.meetingTime) {
    console.log(`[CALLING-AGENT] No meeting booked for ${session.leadData.phone} — triggering follow-up call.`);
    triggerFollowUpCall(session.leadData.phone);
  }
}

/**
 * Updates an already saved lead with booking details, saves it, and sends confirmation emails.
 */
async function updateLeadBookingDetails(session: Session) {
  // Update in local file and MongoDB
  updateLeadInFile(session.leadData);

  // Send booking confirmation emails
  await sendLeadEmails({
    phone: session.leadData.phone,
    bizType: session.leadData.bizType || '',
    challenge: session.leadData.challenge || '',
    process: session.leadData.process || '',
    teamSize: session.leadData.teamSize || '',
    email: session.leadData.email || '',
    score: session.leadData.score || '5/10',
    scoreReason: session.leadData.scoreReason || 'N/A',
    summaryBlock: session.leadData.summaryBlock || 'N/A',
    meetingTime: session.leadData.meetingTime,
    meetingStartIso: session.leadData.meetingStartIso,
    meetingEndIso: session.leadData.meetingEndIso,
    meetingLink: session.leadData.meetingLink
  });

  console.log(`[BOOKING-UPDATED] Lead booking updated and confirmation emails sent for ${session.leadData.phone}`);
}

/**
 * Update the booking details of a lead in leads.json and MongoDB.
 */
function updateLeadInFile(leadData: LeadData) {
  const filePath = path.join(__dirname, '../leads.json');
  if (!fs.existsSync(filePath)) return;

  try {
    const fileData = fs.readFileSync(filePath, 'utf8');
    const leads = JSON.parse(fileData);
    
    // Find the last record with this phone number and update booking
    for (let i = leads.length - 1; i >= 0; i--) {
      if (leads[i].phone === leadData.phone) {
        leads[i].meetingTime = leadData.meetingTime;
        leads[i].meetingStartIso = leadData.meetingStartIso;
        leads[i].meetingEndIso = leadData.meetingEndIso;
        leads[i].meetingLink = leadData.meetingLink;
        break;
      }
    }
    
    fs.writeFileSync(filePath, JSON.stringify(leads, null, 2), 'utf8');
    console.log(`[LEAD-UPDATED] Lead file updated with booking for ${leadData.phone}`);
  } catch (error) {
    console.error('Error updating leads.json:', error);
  }

  // Update in MongoDB (even if meetingLink is missing due to calendar API fallback)
  if (leadData.meetingTime) {
    updateLeadBooking(
      leadData.phone,
      leadData.meetingTime,
      leadData.meetingLink || '',
      leadData.meetingStartIso,
      leadData.meetingEndIso
    ).catch(err => {
      console.error('[DB-LEADS] Failed to update lead booking in MongoDB:', err.message || err);
    });
  }
}

/**
 * Parses user preferred meeting time using Gemini API — IMPROVED with explicit date handling
 */
async function parseMeetingTimeWithGemini(userText: string): Promise<{ start: string, end: string, readable: string } | null> {
  const now = new Date();
  const istOffset = '+05:30';
  // Create a readable current time in IST
  const currentIST = new Date(now.getTime() + (5.5 * 60 * 60 * 1000 - now.getTimezoneOffset() * 60 * 1000));
  const currentDateStr = now.toISOString();

  const prompt = `You are a precise date/time parser. The current date and time is: ${currentDateStr} (UTC). The local timezone is IST (UTC+05:30).

The user wants to book a 15-minute meeting slot. They said: "${userText}"

CRITICAL RULES:
1. Parse the EXACT date the user specified. If they say "11th June", use June 11. If they say "tomorrow", calculate from today's date.
2. The year is 2026 unless specified otherwise.
3. Generate ISO 8601 timestamps WITH the IST offset (+05:30).
4. The end time is exactly 15 minutes after the start time.
5. DO NOT use today's date unless the user explicitly says "today".

Output ONLY a JSON object (no markdown, no explanation):
{
  "start": "2026-06-11T15:00:00+05:30",
  "end": "2026-06-11T15:15:00+05:30",
  "readable": "Wednesday, June 11 at 3:00 PM IST"
}

If the text cannot be parsed as a valid date and time, output exactly: {}`;

  try {
    const rawReply = await askGeminiRaw(prompt);
    console.log(`[DATE-PARSER] Raw Gemini response: ${rawReply}`);
    const result = parseGeminiJson(rawReply);
    if (!result || Object.keys(result).length === 0) return null;
    if (!result.start || !result.end) return null;
    console.log(`[DATE-PARSER] Parsed: start=${result.start}, end=${result.end}, readable=${result.readable}`);
    return result;
  } catch (error) {
    console.error('[MEETING-PARSER] Error parsing date with Gemini:', error);
    return null;
  }
}

/**
 * Lead scoring using Gemini
 */
async function scoreCompletedLead(leadData: LeadData): Promise<{ score: string, reason: string, summary: string }> {
  const prompt = `Score this qualified lead:
- Phone: ${leadData.phone}
- Business: ${leadData.bizType || 'N/A'}
- Challenge: ${leadData.challenge || 'N/A'}
- Current Process: ${leadData.process || 'N/A'}
- Team Size: ${leadData.teamSize || 'N/A'}
- Email: ${leadData.email || 'N/A'}
- Questions: ${leadData.questionsAsked.join(', ') || 'None'}

Output ONLY JSON:
{
  "score": "X/10",
  "reason": "One sentence reason",
  "summary": "Formatted lead summary block"
}`;

  try {
    const rawReply = await askGeminiRaw(prompt);
    const result = parseGeminiJson(rawReply);
    return {
      score: result.score || '5/10',
      reason: result.reason || 'N/A',
      summary: result.summary || 'Summary unavailable'
    };
  } catch (error) {
    console.error('Error scoring lead:', error);
    return {
      score: '5/10',
      reason: 'Auto-scoring failed',
      summary: `Phone: ${leadData.phone}\nBusiness: ${leadData.bizType || 'N/A'}\nChallenge: ${leadData.challenge || 'N/A'}`
    };
  }
}

/**
 * Score a timed-out partial lead
 */
async function scoreTimeoutLead(leadData: LeadData): Promise<{ score: string, reason: string, summary: string }> {
  const prompt = `Score this PARTIAL lead (user went inactive):
- Phone: ${leadData.phone}
- Business: ${leadData.bizType || 'Not provided'}
- Challenge: ${leadData.challenge || 'Not provided'}
- Process: ${leadData.process || 'Not provided'}
- Team Size: ${leadData.teamSize || 'Not provided'}
- Email: ${leadData.email || 'Not provided'}
- Questions: ${leadData.questionsAsked.join(', ') || 'None'}

Output ONLY JSON:
{
  "score": "X/10",
  "reason": "One sentence reason",
  "summary": "Formatted lead summary"
}`;

  try {
    const rawReply = await askGeminiRaw(prompt);
    const result = parseGeminiJson(rawReply);
    return {
      score: result.score || '4/10',
      reason: result.reason || 'N/A',
      summary: result.summary || 'Partial lead'
    };
  } catch (error) {
    console.error('Error scoring timeout lead:', error);
    return {
      score: '4/10',
      reason: 'Auto-scoring failed on timeout',
      summary: `Phone: ${leadData.phone}\nBusiness: ${leadData.bizType || 'N/A'}`
    };
  }
}

/**
 * Refresh the 15-minute inactivity timer
 */
function refreshSessionTimeout(remoteJid: string) {
  const session = sessions[remoteJid];
  if (!session) return;

  if (session.timeoutTimer) {
    clearTimeout(session.timeoutTimer);
  }

  session.timeoutTimer = setTimeout(async () => {
    await handleSessionTimeout(remoteJid);
  }, 15 * 60 * 1000); // 15 minutes
}

/**
 * Handle 15-minute session timeout
 */
async function handleSessionTimeout(remoteJid: string) {
  const session = sessions[remoteJid];
  if (!session) return;

  console.log(`[TIMEOUT-TRIGGERED] Inactivity timeout for JID: ${remoteJid}`);

  // Save partial lead if user provided at least some info
  if (!session.leadSaved && session.leadData.bizType) {
    console.log(`[TIMEOUT-LEAD] Compiling partial lead for: ${session.leadData.phone}`);

    try {
      await extractQualificationData(session);

      const result = await scoreTimeoutLead(session.leadData);
      session.leadData.score = result.score;
      session.leadData.scoreReason = result.reason;
      session.leadData.summaryBlock = result.summary;

      saveLeadToFile(session.leadData);

      await sendLeadEmails({
        phone: session.leadData.phone,
        bizType: session.leadData.bizType || 'Partial Info',
        challenge: session.leadData.challenge || 'N/A',
        process: session.leadData.process || 'N/A',
        teamSize: session.leadData.teamSize || 'N/A',
        email: session.leadData.email || 'N/A',
        score: result.score,
        scoreReason: result.reason,
        summaryBlock: result.summary,
        meetingTime: session.leadData.meetingTime,
        meetingStartIso: session.leadData.meetingStartIso,
        meetingEndIso: session.leadData.meetingEndIso,
        meetingLink: session.leadData.meetingLink
      });

      const timeoutMsg = "It's been a while, so I've saved the details you shared. Feel free to come back anytime to resume our conversation or book a call! 👋 [BUTTONS: Resume Chat | Book a Call | Main Menu]";
      await sendWhatsAppReply(remoteJid, timeoutMsg);

      // Trigger follow-up call if no meeting was booked before timeout
      if (!session.leadData.meetingTime) {
        console.log(`[CALLING-AGENT] Session timed out without booking for ${session.leadData.phone} — triggering follow-up call.`);
        triggerFollowUpCall(session.leadData.phone);
      }
    } catch (err) {
      console.error('Error compiling timeout lead:', err);
    }
  }

  delete sessions[remoteJid];
}

/**
 * Save lead record to local JSON file
 */
function saveLeadToFile(leadData: LeadData) {
  const filePath = path.join(__dirname, '../leads.json');
  let leads: any[] = [];

  try {
    if (fs.existsSync(filePath)) {
      const fileData = fs.readFileSync(filePath, 'utf8');
      leads = JSON.parse(fileData);
    }
  } catch (error) {
    console.error('Error reading leads.json:', error);
  }

  const record = {
    phone: leadData.phone,
    bizType: leadData.bizType,
    challenge: leadData.challenge,
    process: leadData.process,
    teamSize: leadData.teamSize,
    email: leadData.email,
    meetingTime: leadData.meetingTime,
    meetingStartIso: leadData.meetingStartIso,
    meetingEndIso: leadData.meetingEndIso,
    meetingLink: leadData.meetingLink,
    score: leadData.score,
    scoreReason: leadData.scoreReason,
    summaryBlock: leadData.summaryBlock,
    questionsAsked: leadData.questionsAsked,
    timestamp: leadData.timestamp
  };

  leads.push(record);

  try {
    fs.writeFileSync(filePath, JSON.stringify(leads, null, 2), 'utf8');
    console.log(`[LEAD-SAVED] Lead saved locally for ${leadData.phone}. Score: ${leadData.score}`);
  } catch (error) {
    console.error('Error writing leads.json:', error);
  }

  // Save to MongoDB asynchronously
  saveLead(record).catch(err => {
    console.error('[DB-LEADS] Failed to save lead to MongoDB:', err.message || err);
  });
}

/**
 * Safely extract JSON from a Gemini response
 */
function parseGeminiJson(rawReply: string): any {
  const firstBrace = rawReply.indexOf('{');
  const lastBrace = rawReply.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('No JSON object found in response');
  }
  const cleanJson = rawReply.substring(firstBrace, lastBrace + 1).trim();
  if (cleanJson === '{}') return {};
  return JSON.parse(cleanJson);
}
