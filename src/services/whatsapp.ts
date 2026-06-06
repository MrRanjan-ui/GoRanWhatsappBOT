import * as dotenv from 'dotenv';
dotenv.config();

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';

/**
 * Sends a text message to a WhatsApp number using the Meta Graph API.
 */
export async function sendWhatsAppMessage(to: string, text: string): Promise<any> {
  if (!WHATSAPP_TOKEN || WHATSAPP_TOKEN.includes('your-meta-') || !WHATSAPP_PHONE_NUMBER_ID || WHATSAPP_PHONE_NUMBER_ID.includes('your-')) {
    console.warn(`⚠️ [WHATSAPP-SERVICE] Meta API credentials not configured. Cannot send message to +${to}: "${text}"`);
    return null;
  }

  const formattedTo = to.replace(/\D/g, '');
  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: formattedTo,
    type: 'text',
    text: {
      preview_url: false,
      body: text
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json() as any;
    if (!response.ok) {
      console.error('[WHATSAPP-SERVICE] Meta API error details:', JSON.stringify(data));
      throw new Error(`Meta API error: ${response.statusText} (${response.status})`);
    }

    console.log(`[WHATSAPP-SERVICE] Message sent successfully to +${formattedTo}. Message ID: ${data.messages?.[0]?.id}`);
    return data;
  } catch (error: any) {
    console.error(`[WHATSAPP-SERVICE] Failed to send message to +${formattedTo}:`, error.message || error);
    throw error;
  }
}

/**
 * Sends a button message (up to 3 buttons) to a WhatsApp number.
 */
export async function sendWhatsAppButtons(to: string, text: string, buttons: string[]): Promise<any> {
  if (!WHATSAPP_TOKEN || WHATSAPP_TOKEN.includes('your-meta-') || !WHATSAPP_PHONE_NUMBER_ID || WHATSAPP_PHONE_NUMBER_ID.includes('your-')) {
    console.warn(`⚠️ [WHATSAPP-SERVICE] Meta API credentials not configured. Cannot send buttons to +${to}: "${text}"`);
    return null;
  }

  const formattedTo = to.replace(/\D/g, '');
  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  // Format buttons to the Meta API structure (maximum 3 buttons allowed by WhatsApp)
  const formattedButtons = buttons.slice(0, 3).map((btnText, index) => {
    // Trim button text and cap it at 20 characters (Meta API limit)
    const cleanBtnText = btnText.trim().substring(0, 20);
    return {
      type: 'reply',
      reply: {
        id: `btn_${index + 1}_${cleanBtnText.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
        title: cleanBtnText
      }
    };
  });

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: formattedTo,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: text
      },
      action: {
        buttons: formattedButtons
      }
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json() as any;
    if (!response.ok) {
      console.error('[WHATSAPP-SERVICE] Meta API Button error details:', JSON.stringify(data));
      throw new Error(`Meta API Button error: ${response.statusText} (${response.status})`);
    }

    console.log(`[WHATSAPP-SERVICE] Button message sent successfully to +${formattedTo}.`);
    return data;
  } catch (error: any) {
    console.error(`[WHATSAPP-SERVICE] Failed to send button message to +${formattedTo}:`, error.message || error);
    // Fallback to sending standard text message if buttons fail
    return sendWhatsAppMessage(formattedTo, text + '\n\nOptions:\n' + buttons.map(b => `• ${b}`).join('\n'));
  }
}

/**
 * Sends a WhatsApp reply. Parses the text for [BUTTONS: A | B | C] block.
 * If found, sends it as an interactive button message. Otherwise sends standard text.
 */
export async function sendWhatsAppReply(to: string, text: string): Promise<any> {
  const buttonRegex = /\[BUTTONS:\s*(.+?)\s*\]/i;
  const match = text.match(buttonRegex);

  if (match) {
    const buttonsBlock = match[0];
    const buttonList = match[1].split('|').map(b => b.trim()).filter(b => b.length > 0);
    const cleanText = text.replace(buttonsBlock, '').trim();
    
    console.log(`[WHATSAPP-SERVICE] Parsed buttons:`, buttonList);
    return sendWhatsAppButtons(to, cleanText, buttonList);
  }

  return sendWhatsAppMessage(to, text);
}
