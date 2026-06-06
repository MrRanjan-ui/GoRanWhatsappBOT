import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { getLeads, getWhitelistFromDb, saveWhitelistToDb, isDbConnected } from './db';
import { handleIncomingMessage } from '../bot';

/**
 * Helper function to extract text content from Meta WhatsApp message object
 */
function getMetaMessageText(message: any): string {
  if (!message) return '';
  
  if (message.type === 'text' && message.text) {
    return message.text.body || '';
  }
  
  if (message.type === 'interactive' && message.interactive) {
    const interactive = message.interactive;
    if (interactive.type === 'button_reply' && interactive.button_reply) {
      return interactive.button_reply.id || interactive.button_reply.title || '';
    }
    if (interactive.type === 'list_reply' && interactive.list_reply) {
      return interactive.list_reply.id || interactive.list_reply.title || '';
    }
  }
  
  if (message.type === 'button' && message.button) {
    return message.button.payload || message.button.text || '';
  }

  return '';
}

/**
 * Starts a lightweight HTTP server using Node's built-in 'http' module
 * to serve a premium live lead dashboard and the WhatsApp webhook endpoints.
 */
export function startDashboardServer(port: number) {
  const server = http.createServer(async (req, res) => {
    const url = req.url || '';
    const parsedUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    
    // 1. GET /api/leads - Serve JSON leads list
    if (req.method === 'GET' && pathname === '/api/leads') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      
      try {
        if (isDbConnected()) {
          const leads = await getLeads();
          res.end(JSON.stringify(leads));
        } else {
          // File fallback
          const leadsPath = path.join(__dirname, '../../leads.json');
          if (fs.existsSync(leadsPath)) {
            const rawData = fs.readFileSync(leadsPath, 'utf8');
            res.end(rawData);
          } else {
            res.end(JSON.stringify([]));
          }
        }
      } catch (err) {
        console.error('[API-LEADS] Fetch error:', err);
        try {
          const leadsPath = path.join(__dirname, '../../leads.json');
          if (fs.existsSync(leadsPath)) {
            const rawData = fs.readFileSync(leadsPath, 'utf8');
            res.end(rawData);
          } else {
            res.end(JSON.stringify([]));
          }
        } catch (fileErr) {
          res.end(JSON.stringify({ error: 'Failed to read leads source' }));
        }
      }
      return;
    }
    
    // 2. GET /api/whitelist - Serve current whitelist array
    if (req.method === 'GET' && pathname === '/api/whitelist') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      
      try {
        if (isDbConnected()) {
          const numbers = await getWhitelistFromDb();
          if (numbers && numbers.length > 0) {
            res.end(JSON.stringify(numbers));
            return;
          }
        }
      } catch (err) {
        console.error('[API-WHITELIST] DB Fetch error:', err);
      }
      
      // Fallback to reading from .env file
      res.end(JSON.stringify(getWhitelist()));
      return;
    }
    
    // 3. POST /api/whitelist - Save updated whitelist
    if (req.method === 'POST' && pathname === '/api/whitelist') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          if (Array.isArray(data.numbers)) {
            const numbers = data.numbers
              .map((n: any) => String(n).trim())
              .filter((n: string) => /^\d+$/.test(n));
              
            // Save to DB as primary
            if (isDbConnected()) {
              await saveWhitelistToDb(numbers);
            }
            
            // Save to .env file as backup
            saveWhitelist(numbers);
            
            // Instantly apply in memory so the running bot updates live!
            process.env.ALLOWED_NUMBERS = numbers.join(',');
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, numbers }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid data format' }));
          }
        } catch (err) {
          console.error('[API-WHITELIST] Save error:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to process request' }));
        }
      });
      return;
    }
    
    // 4. GET /webhook - Verify webhook verification challenge from Meta
    if (req.method === 'GET' && pathname === '/webhook') {
      const mode = parsedUrl.searchParams.get('hub.mode');
      const token = parsedUrl.searchParams.get('hub.verify_token');
      const challenge = parsedUrl.searchParams.get('hub.challenge');
      
      const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'goran_bot_verify_token';
      
      if (mode === 'subscribe' && token === verifyToken) {
        console.log('✅ [WEBHOOK] Webhook verified successfully.');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(challenge);
      } else {
        console.warn('❌ [WEBHOOK] Webhook verification failed. Token mismatch.');
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
      }
      return;
    }

    // 5. POST /webhook - Process incoming WhatsApp messages
    if (req.method === 'POST' && pathname === '/webhook') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          console.log('📥 [WEBHOOK] Received POST payload:', JSON.stringify(payload, null, 2));
          
          if (payload.object === 'whatsapp_business_account') {
            const entry = payload.entry?.[0];
            const change = entry?.changes?.[0];
            const value = change?.value;
            const message = value?.messages?.[0];
            
            if (message) {
              const from = message.from; // Sender phone number
              const messageText = getMetaMessageText(message);
              
              if (from && messageText) {
                // Run bot incoming message logic asynchronously, returning 200 OK immediately to Meta
                handleIncomingMessage(from, messageText).catch(err => {
                  console.error('❌ [WEBHOOK] Error handling message:', err);
                });
              }
            }
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'success' }));
        } catch (error: any) {
          console.error('❌ [WEBHOOK] Payload handling error:', error.message || error);
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request');
        }
      });
      return;
    }

    // 6. GET /dashboard || / - Serve HTML page
    if (req.method === 'GET' && (pathname === '/dashboard' || pathname === '/')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getDashboardHTML());
      return;
    }
    
    // 7. Fallback 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(port, () => {
    console.log(`📡 Live Lead Dashboard and Webhook is running at http://localhost:${port}/dashboard`);
    console.log(`📡 Meta Webhook Callback URL: http://localhost:${port}/webhook`);
  });
}

/**
 * Reads whitelisted numbers from active .env file
 */
function getWhitelist(): string[] {
  const envPath = path.join(__dirname, '../../.env');
  if (!fs.existsSync(envPath)) return [];
  try {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const match = envContent.match(/^ALLOWED_NUMBERS=(.*)$/m);
    if (match) {
      return match[1].split(',').map(n => n.trim()).filter(n => n.length > 0);
    }
  } catch (error) {
    console.error('[DASHBOARD-SERVER] Error reading .env whitelist:', error);
  }
  return [];
}

/**
 * Writes whitelisted numbers back to active .env file
 */
function saveWhitelist(numbers: string[]) {
  const envPath = path.join(__dirname, '../../.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const numbersStr = numbers.join(',');
    let newContent = '';
    
    if (envContent.match(/^ALLOWED_NUMBERS=(.*)$/m)) {
      newContent = envContent.replace(/^ALLOWED_NUMBERS=.*$/m, `ALLOWED_NUMBERS=${numbersStr}`);
    } else {
      newContent = envContent + `\nALLOWED_NUMBERS=${numbersStr}\n`;
    }
    
    fs.writeFileSync(envPath, newContent, 'utf8');
    console.log(`[WHITELIST-SAVED] Whitelist successfully saved to .env: ${numbersStr}`);
  } catch (error) {
    console.error('[DASHBOARD-SERVER] Error writing .env whitelist:', error);
  }
}

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GoRan AI — Premium Leads Hub</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=Outfit:wght@500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #070a13;
      --card-bg: rgba(13, 20, 38, 0.45);
      --card-hover: rgba(17, 27, 51, 0.6);
      --border: rgba(255, 255, 255, 0.04);
      --border-hover: rgba(234, 179, 8, 0.25);
      --accent: #F6C744;
      --accent-gradient: linear-gradient(135deg, #F6C744 0%, #facc15 100%);
      --text: #f1f5f9;
      --text-muted: #64748b;
      --success: #10b981;
      --success-glow: rgba(16, 185, 129, 0.12);
      --warning: #f59e0b;
      --warning-glow: rgba(245, 158, 11, 0.12);
      --cyan: #06b6d4;
      --cyan-glow: rgba(6, 182, 212, 0.12);
      --danger: #ef4444;
      --danger-glow: rgba(239, 68, 68, 0.15);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    /* Custom Scrollbar */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    ::-webkit-scrollbar-track {
      background: var(--bg);
    }
    ::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 100px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.2);
    }

    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background-color: var(--bg);
      background-image: 
        radial-gradient(circle at 15% 15%, rgba(246, 199, 68, 0.08) 0%, transparent 45%),
        radial-gradient(circle at 85% 85%, rgba(6, 182, 212, 0.06) 0%, transparent 45%);
      background-attachment: fixed;
      color: var(--text);
      min-height: 100vh;
      padding: 40px 20px;
      overflow-x: hidden;
    }

    .container {
      max-width: 1240px;
      margin: 0 auto;
    }

    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 40px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 24px;
    }

    .logo-section h1 {
      font-family: 'Outfit', sans-serif;
      font-size: 30px;
      font-weight: 800;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, #ffffff 30%, var(--accent) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .logo-section p {
      font-size: 14px;
      color: var(--text-muted);
      margin-top: 4px;
      font-weight: 500;
    }

    .status-badge {
      display: flex;
      align-items: center;
      gap: 10px;
      background: rgba(16, 185, 129, 0.06);
      border: 1px solid rgba(16, 185, 129, 0.15);
      padding: 8px 16px;
      border-radius: 100px;
      font-size: 13px;
      font-weight: 600;
      color: var(--success);
      box-shadow: 0 4px 15px rgba(16, 185, 129, 0.05);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      background-color: var(--success);
      border-radius: 50%;
      box-shadow: 0 0 10px var(--success);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
      70% { transform: scale(1); box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 24px;
      margin-bottom: 40px;
    }

    .stat-card {
      background: var(--card-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 24px;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
    }

    .stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 100%);
      pointer-events: none;
    }

    .stat-card:hover {
      transform: translateY(-2px);
      border-color: rgba(246, 199, 68, 0.15);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
    }

    .stat-label {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .stat-value {
      font-family: 'Outfit', sans-serif;
      font-size: 42px;
      font-weight: 700;
      color: #fff;
      margin-top: 10px;
      display: flex;
      align-items: baseline;
      gap: 8px;
    }

    /* Filters Bar */
    .controls-bar {
      background: var(--card-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 16px 24px;
      margin-bottom: 30px;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
    }

    .search-input-wrapper {
      position: relative;
      flex: 1;
      min-width: 280px;
      max-width: 400px;
    }

    .search-input-wrapper input {
      width: 100%;
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px 16px 12px 42px;
      color: #fff;
      font-size: 14px;
      font-family: inherit;
      transition: all 0.2s;
    }

    .search-input-wrapper input:focus {
      outline: none;
      border-color: rgba(246, 199, 68, 0.4);
      background: rgba(0, 0, 0, 0.3);
      box-shadow: 0 0 0 3px rgba(246, 199, 68, 0.05);
    }

    .search-icon {
      position: absolute;
      left: 14px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-muted);
      font-size: 16px;
      pointer-events: none;
    }

    .filter-tabs {
      display: flex;
      gap: 8px;
      background: rgba(0, 0, 0, 0.2);
      padding: 4px;
      border-radius: 12px;
      border: 1px solid var(--border);
    }

    .tab-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 600;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .tab-btn:hover {
      color: #fff;
    }

    .tab-btn.active {
      background: var(--accent);
      color: #000;
    }

    .tab-count {
      background: rgba(255, 255, 255, 0.1);
      padding: 2px 6px;
      border-radius: 6px;
      font-size: 11px;
    }
    
    .tab-btn.active .tab-count {
      background: rgba(0, 0, 0, 0.15);
    }

    .sort-wrapper {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .sort-wrapper span {
      font-size: 13px;
      color: var(--text-muted);
      font-weight: 500;
    }

    .sort-select {
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--border);
      color: #fff;
      padding: 8px 12px;
      border-radius: 10px;
      font-size: 13px;
      font-family: inherit;
      cursor: pointer;
      outline: none;
      transition: border-color 0.2s;
    }

    .sort-select:focus {
      border-color: rgba(246, 199, 68, 0.4);
    }

    /* Leads Grid */
    .section-title {
      font-family: 'Outfit', sans-serif;
      font-size: 22px;
      font-weight: 700;
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      gap: 12px;
      letter-spacing: -0.5px;
    }

    .leads-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 24px;
    }

    .lead-card {
      background: var(--card-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 24px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      cursor: pointer;
      position: relative;
    }

    .lead-card:hover {
      transform: translateY(-4px);
      border-color: var(--border-hover);
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
      background: var(--card-hover);
    }

    .lead-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 16px;
    }

    .lead-phone {
      font-family: 'Outfit', sans-serif;
      font-weight: 700;
      font-size: 17px;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .lead-time {
      font-size: 11px;
      color: var(--text-muted);
      font-weight: 500;
    }

    .lead-email {
      font-size: 13px;
      color: var(--accent);
      text-decoration: none;
      margin-bottom: 16px;
      display: block;
      font-weight: 600;
      word-break: break-all;
    }

    .lead-body {
      background: rgba(0, 0, 0, 0.15);
      border-radius: 12px;
      padding: 14px;
      border: 1px solid rgba(255, 255, 255, 0.02);
      margin-bottom: 18px;
      flex-grow: 1;
    }

    .lead-body-item {
      font-size: 13px;
      margin-bottom: 8px;
      line-height: 1.5;
    }

    .lead-body-item:last-child {
      margin-bottom: 0;
    }

    .lead-body-item strong {
      color: var(--text-muted);
      font-weight: 600;
      margin-right: 4px;
    }

    .lead-body-item span {
      color: var(--text);
    }

    .lead-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      padding-top: 16px;
    }

    .lead-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .badge {
      padding: 6px 12px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      letter-spacing: 0.2px;
    }

    .badge-score-high {
      background: var(--success-glow);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.15);
    }

    .badge-score-med {
      background: var(--warning-glow);
      color: var(--warning);
      border: 1px solid rgba(245, 158, 11, 0.15);
    }

    .badge-score-low {
      background: rgba(255, 255, 255, 0.03);
      color: var(--text-muted);
      border: 1px solid var(--border);
    }

    .badge-meeting {
      background: var(--cyan-glow);
      color: var(--cyan);
      border: 1px solid rgba(6, 182, 212, 0.15);
    }

    .view-details-arrow {
      color: var(--accent);
      font-size: 16px;
      transition: transform 0.2s;
    }

    .lead-card:hover .view-details-arrow {
      transform: translateX(4px);
    }

    /* Whitelist Section */
    .whitelist-section {
      margin-top: 60px;
    }

    .whitelist-container {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .whitelist-list {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .whitelist-tag {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      padding: 8px 14px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 14px;
      font-weight: 600;
      color: #fff;
      transition: border-color 0.2s;
    }
    
    .whitelist-tag:hover {
      border-color: rgba(239, 68, 68, 0.3);
    }

    .whitelist-tag .remove-btn {
      color: var(--danger);
      cursor: pointer;
      font-weight: 800;
      font-size: 15px;
      line-height: 1;
      padding: 2px;
      border-radius: 4px;
      transition: background 0.2s;
    }

    .whitelist-tag .remove-btn:hover {
      background: var(--danger-glow);
    }

    .whitelist-add-form {
      display: flex;
      gap: 12px;
      margin-top: 10px;
      max-width: 480px;
    }

    .whitelist-add-form input {
      flex: 1;
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px 16px;
      color: #fff;
      font-size: 14px;
      font-family: inherit;
      transition: border-color 0.2s;
    }

    .whitelist-add-form input:focus {
      outline: none;
      border-color: rgba(246, 199, 68, 0.4);
    }

    .whitelist-add-form button {
      background: var(--accent-gradient);
      color: #000;
      border: none;
      border-radius: 12px;
      padding: 12px 24px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      transition: opacity 0.2s;
      box-shadow: 0 4px 15px rgba(246, 199, 68, 0.2);
    }

    .whitelist-add-form button:hover {
      opacity: 0.9;
    }

    /* Modal / Drawer */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(3, 7, 18, 0.85);
      backdrop-filter: blur(12px);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 1000;
      padding: 20px;
    }

    .modal {
      background: #0d1222;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 24px;
      max-width: 680px;
      width: 100%;
      max-height: 90vh;
      overflow-y: auto;
      padding: 36px;
      position: relative;
      box-shadow: 0 20px 50px rgba(0,0,0,0.5);
    }

    .modal-close {
      position: absolute;
      top: 24px;
      right: 24px;
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--border);
      border-radius: 50%;
      width: 36px;
      height: 36px;
      color: var(--text);
      font-size: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s;
    }

    .modal-close:hover {
      background: rgba(255,255,255,0.1);
      transform: rotate(90deg);
    }

    .modal-title-section {
      margin-bottom: 24px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 20px;
    }

    .modal-title {
      font-family: 'Outfit', sans-serif;
      font-size: 24px;
      font-weight: 700;
      color: #fff;
    }
    
    .modal-subtitle {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    /* Score Meter */
    .score-meter-wrapper {
      display: flex;
      align-items: center;
      gap: 20px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 24px;
    }

    .score-circle {
      width: 70px;
      height: 70px;
      border-radius: 50%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-family: 'Outfit', sans-serif;
      font-weight: 800;
      border: 4px solid var(--border);
      position: relative;
    }
    
    .score-circle.score-high {
      border-color: var(--success);
      color: var(--success);
      background: var(--success-glow);
    }
    
    .score-circle.score-med {
      border-color: var(--warning);
      color: var(--warning);
      background: var(--warning-glow);
    }
    
    .score-circle.score-low {
      border-color: var(--text-muted);
      color: var(--text-muted);
      background: rgba(255,255,255,0.02);
    }
    
    .score-circle-value {
      font-size: 20px;
      line-height: 1;
    }
    
    .score-circle-label {
      font-size: 9px;
      text-transform: uppercase;
      margin-top: 2px;
      font-weight: 600;
    }
    
    .score-reason-text {
      flex: 1;
      font-size: 14px;
      line-height: 1.5;
      color: var(--text);
    }
    
    .score-reason-text em {
      display: block;
      font-style: normal;
      font-size: 12px;
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }

    .summary-title {
      font-family: 'Outfit', sans-serif;
      font-size: 16px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .copy-btn {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;
    }

    .copy-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }

    .summary-block {
      background: #030712;
      color: var(--cyan);
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      padding: 24px;
      border-radius: 16px;
      white-space: pre-wrap;
      font-size: 13px;
      line-height: 1.6;
      border: 1px solid rgba(6, 182, 212, 0.08);
      overflow-x: auto;
    }

    .empty-state {
      grid-column: 1 / -1;
      text-align: center;
      padding: 80px 20px;
      color: var(--text-muted);
      border: 2px dashed rgba(255,255,255,0.03);
      border-radius: 20px;
      background: rgba(255, 255, 255, 0.005);
    }

    .empty-state-icon {
      font-size: 40px;
      margin-bottom: 16px;
      display: block;
    }

    .empty-state-title {
      font-family: 'Outfit', sans-serif;
      font-size: 18px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 6px;
    }

    /* Modal Animation */
    @keyframes slideIn {
      from { transform: scale(0.95); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }

    .modal-overlay.active {
      display: flex;
    }

    .modal-overlay.active .modal {
      animation: slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-section">
        <h1>GoRan AI</h1>
        <p>Agency Operations & Lead Scoping Panel</p>
      </div>
      <div class="status-badge">
        <span class="status-dot"></span>
        <span>Meta WhatsApp Bot Active</span>
      </div>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Leads</div>
        <div class="stat-value" id="stat-total">0</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Highly Qualified</div>
        <div class="stat-value" id="stat-qualified" style="color: var(--success);">0</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Meetings Booked</div>
        <div class="stat-value" id="stat-meetings" style="color: var(--accent);">0</div>
      </div>
    </div>

    <!-- Filter & Controls bar -->
    <div class="controls-bar">
      <div class="search-input-wrapper">
        <span class="search-icon">🔍</span>
        <input type="text" id="search-input" placeholder="Search by phone, email, challenge, or biz..." oninput="handleSearch()" />
      </div>

      <div class="filter-tabs">
        <button class="tab-btn active" id="tab-all" onclick="setFilter('all')">
          All Leads <span class="tab-count" id="count-all">0</span>
        </button>
        <button class="tab-btn" id="tab-high" onclick="setFilter('high')">
          Qualified (8+) <span class="tab-count" id="count-high">0</span>
        </button>
        <button class="tab-btn" id="tab-meetings" onclick="setFilter('meetings')">
          Meetings <span class="tab-count" id="count-meetings">0</span>
        </button>
      </div>

      <div class="sort-wrapper">
        <span>Sort By</span>
        <select class="sort-select" id="sort-select" onchange="handleSort()">
          <option value="newest">Newest First</option>
          <option value="score_desc">Score: High to Low</option>
          <option value="teamsize_desc">Team: Large to Small</option>
        </select>
      </div>
    </div>

    <div class="section-title">
      <span>⚡</span> Real-time Lead Streams
    </div>

    <div class="leads-grid" id="leads-grid">
      <div class="empty-state">
        <span class="empty-state-icon">📡</span>
        <div class="empty-state-title">Awaiting Qualified Leads</div>
        <p>All conversations triggered on WhatsApp will populate here in real-time.</p>
      </div>
    </div>

    <!-- Whitelisted Numbers Manager -->
    <div class="whitelist-section">
      <div class="section-title">
        <span>🔒</span> Whitelist Sandbox Numbers
      </div>
      <div class="stat-card">
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 24px; line-height: 1.6;">
          If Whitelisting is active in environment settings, only the numbers listed below will trigger bot exchanges. Add numbers with country code (e.g., 91 for India) without '+' or spaces.
        </p>
        
        <div class="whitelist-container">
          <div class="whitelist-list" id="whitelist-list">
            <span style="color: var(--text-muted); font-size: 13px;">Loading sandbox numbers...</span>
          </div>
          
          <div class="whitelist-add-form">
            <input type="text" id="new-number-input" placeholder="e.g. 919934225353" maxlength="20" />
            <button onclick="addNumber()">Add to Whitelist</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="modal-overlay" onclick="closeModalOnOverlay(event)">
    <div class="modal">
      <button class="modal-close" onclick="closeModal()">&times;</button>
      
      <div class="modal-title-section">
        <div class="modal-title" id="modal-title">+91 99999 99999</div>
        <div class="modal-subtitle" id="modal-subtitle">Lead Scoping Breakdown</div>
      </div>

      <!-- Score widget -->
      <div class="score-meter-wrapper">
        <div class="score-circle" id="modal-score-circle">
          <span class="score-circle-value" id="modal-score-val">0/10</span>
          <span class="score-circle-label">Score</span>
        </div>
        <div class="score-reason-text" id="modal-score-reason">
          <em>Lead Qualification Rating</em>
          Awaiting details...
        </div>
      </div>

      <!-- Raw text summary -->
      <div class="summary-title">
        <span>AI Scoping Summary</span>
        <button class="copy-btn" onclick="copySummaryText()">Copy Text</button>
      </div>
      <pre class="summary-block" id="modal-summary-block"></pre>
    </div>
  </div>

  <script>
    let activeLeads = [];
    let whitelist = [];
    let currentFilter = 'all'; // 'all' | 'high' | 'meetings'
    let currentSearch = '';
    let currentSort = 'newest'; // 'newest' | 'score_desc' | 'teamsize_desc'

    async function fetchLeads() {
      try {
        const response = await fetch('/api/leads');
        const leads = await response.json();
        
        // Refresh only if data changed
        if (JSON.stringify(leads) !== JSON.stringify(activeLeads)) {
          activeLeads = leads;
          processAndRender();
        }
      } catch (err) {
        console.error('Error fetching leads:', err);
      }
    }

    async function fetchWhitelist() {
      try {
        const response = await fetch('/api/whitelist');
        whitelist = await response.json();
        renderWhitelist();
      } catch (err) {
        console.error('Error fetching whitelist:', err);
      }
    }

    function renderWhitelist() {
      const container = document.getElementById('whitelist-list');
      if (whitelist.length === 0) {
        container.innerHTML = '<span style="color: var(--text-muted); font-size: 13px;">No numbers whitelisted. Bot will ignore sandbox messages.</span>';
        return;
      }
      
      whitelist.forEach(num => {
        const tag = document.createElement('div');
        tag.className = 'whitelist-tag';
        tag.innerHTML = \`
          <span>+\${num}</span>
          <span class="remove-btn" onclick="deleteNumber('\${num}')">&times;</span>
        \`;
        container.appendChild(tag);
      });
    }

    async function saveWhitelistToServer() {
      try {
        const response = await fetch('/api/whitelist', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ numbers: whitelist })
        });
        const result = await response.json();
        if (result.success) {
          fetchWhitelist();
        } else {
          alert('Failed to save whitelist.');
        }
      } catch (err) {
        console.error('Error saving whitelist:', err);
        alert('Server connection error.');
      }
    }

    function addNumber() {
      const input = document.getElementById('new-number-input');
      const val = input.value.trim();
      if (!val) return;
      if (!/^\\d+$/.test(val)) {
        alert('Please enter digits only (e.g. 919934225353)');
        return;
      }
      if (whitelist.includes(val)) {
        alert('Number is already whitelisted.');
        return;
      }
      whitelist.push(val);
      input.value = '';
      saveWhitelistToServer();
    }

    function deleteNumber(num) {
      if (confirm(\`Remove +\${num} from the whitelist?\`)) {
        whitelist = whitelist.filter(n => n !== num);
        saveWhitelistToServer();
      }
    }

    function handleSearch() {
      currentSearch = document.getElementById('search-input').value.toLowerCase().trim();
      processAndRender();
    }

    function setFilter(filterType) {
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      
      if (filterType === 'all') document.getElementById('tab-all').classList.add('active');
      if (filterType === 'high') document.getElementById('tab-high').classList.add('active');
      if (filterType === 'meetings') document.getElementById('tab-meetings').classList.add('active');
      
      currentFilter = filterType;
      processAndRender();
    }

    function handleSort() {
      currentSort = document.getElementById('sort-select').value;
      processAndRender();
    }

    function processAndRender() {
      let filtered = [...activeLeads];

      // Update total badges before any filtering
      const countAll = filtered.length;
      const countHigh = filtered.filter(l => parseInt(l.score || '0') >= 8).length;
      const countMeetings = filtered.filter(l => l.meetingTime).length;

      document.getElementById('count-all').textContent = countAll;
      document.getElementById('count-high').textContent = countHigh;
      document.getElementById('count-meetings').textContent = countMeetings;

      // 1. Apply Search
      if (currentSearch) {
        filtered = filtered.filter(lead => {
          return (
            (lead.phone && lead.phone.toLowerCase().includes(currentSearch)) ||
            (lead.email && lead.email.toLowerCase().includes(currentSearch)) ||
            (lead.bizType && lead.bizType.toLowerCase().includes(currentSearch)) ||
            (lead.challenge && lead.challenge.toLowerCase().includes(currentSearch)) ||
            (lead.process && lead.process.toLowerCase().includes(currentSearch))
          );
        });
      }

      // 2. Apply Tabs
      if (currentFilter === 'high') {
        filtered = filtered.filter(lead => parseInt(lead.score || '0') >= 8);
      } else if (currentFilter === 'meetings') {
        filtered = filtered.filter(lead => lead.meetingTime);
      }

      // 3. Apply Sorting
      if (currentSort === 'newest') {
        filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      } else if (currentSort === 'score_desc') {
        filtered.sort((a, b) => {
          const scoreA = parseInt(a.score || '0');
          const scoreB = parseInt(b.score || '0');
          return scoreB - scoreA;
        });
      } else if (currentSort === 'teamsize_desc') {
        filtered.sort((a, b) => {
          // Extract first digit group or set to 0
          const getNum = str => {
            const m = (str || '').match(/\\d+/);
            return m ? parseInt(m[0]) : 0;
          };
          return getNum(b.teamSize) - getNum(a.teamSize);
        });
      }

      renderLeadsGrid(filtered);
      
      // Update Stat Cards with global values
      document.getElementById('stat-total').textContent = countAll;
      document.getElementById('stat-qualified').textContent = countHigh;
      document.getElementById('stat-meetings').textContent = countMeetings;
    }

    function renderLeadsGrid(leads) {
      const gridContainer = document.getElementById('leads-grid');
      
      if (leads.length === 0) {
        gridContainer.innerHTML = \`
          <div class="empty-state">
            <span class="empty-state-icon">📡</span>
            <div class="empty-state-title">No leads match the filters</div>
            <p>Try resetting the search terms or choosing another tab status.</p>
          </div>
        \`;
        return;
      }

      gridContainer.innerHTML = '';

      leads.forEach(lead => {
        const scoreNum = parseInt(lead.score || '0');
        let scoreClass = 'badge-score-low';
        if (scoreNum >= 8) scoreClass = 'badge-score-high';
        else if (scoreNum >= 5) scoreClass = 'badge-score-med';

        const card = document.createElement('div');
        card.className = 'lead-card';
        card.onclick = () => showModal(lead);

        const topDiv = document.createElement('div');
        topDiv.className = 'lead-top';
        topDiv.innerHTML = \`
          <span class="lead-phone">📞 +\${lead.phone}</span>
          <span class="lead-time">\${new Date(lead.timestamp).toLocaleDateString()} \${new Date(lead.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
        \`;

        const emailSpan = document.createElement('span');
        emailSpan.className = 'lead-email';
        emailSpan.textContent = lead.email || 'No email provided';

        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'lead-body';
        bodyDiv.innerHTML = \`
          <div class="lead-body-item"><strong>Biz:</strong> <span>\${lead.bizType || 'TBD'}</span></div>
          <div class="lead-body-item"><strong>Challenge:</strong> <span>\${lead.challenge || 'TBD'}</span></div>
          <div class="lead-body-item"><strong>Workflow:</strong> <span>\${lead.process || 'TBD'}</span></div>
        \`;

        const footerDiv = document.createElement('div');
        footerDiv.className = 'lead-footer';
        
        const badgesDiv = document.createElement('div');
        badgesDiv.className = 'lead-badges';

        const scoreBadge = document.createElement('span');
        scoreBadge.className = 'badge ' + scoreClass;
        scoreBadge.textContent = '★ ' + (lead.score || 'N/A');
        badgesDiv.appendChild(scoreBadge);

        if (lead.meetingTime) {
          const meetBadge = document.createElement('span');
          meetBadge.className = 'badge badge-meeting';
          meetBadge.innerHTML = '📅 Booked';
          badgesDiv.appendChild(meetBadge);
        }

        const arrowDiv = document.createElement('span');
        arrowDiv.className = 'view-details-arrow';
        arrowDiv.innerHTML = '➔';

        footerDiv.appendChild(badgesDiv);
        footerDiv.appendChild(arrowDiv);

        card.appendChild(topDiv);
        card.appendChild(emailSpan);
        card.appendChild(bodyDiv);
        card.appendChild(footerDiv);
        gridContainer.appendChild(card);
      });
    }

    function showModal(lead) {
      document.getElementById('modal-title').textContent = '+' + lead.phone;
      document.getElementById('modal-subtitle').textContent = 'Conversation scoping record on ' + new Date(lead.timestamp).toLocaleString();
      
      const scoreNum = parseInt(lead.score || '0');
      const scoreCircle = document.getElementById('modal-score-circle');
      scoreCircle.className = 'score-circle';
      if (scoreNum >= 8) scoreCircle.classList.add('score-high');
      else if (scoreNum >= 5) scoreCircle.classList.add('score-med');
      else scoreCircle.classList.add('score-low');

      document.getElementById('modal-score-val').textContent = lead.score || 'N/A';
      document.getElementById('modal-score-reason').innerHTML = \`
        <em>AI Rating Justification</em>
        \${lead.scoreReason || 'Rating explanation not provided.'}
        \${lead.meetingTime ? \\\`<div style="margin-top: 10px; color: var(--cyan); font-weight: 700; display: flex; align-items: center; gap: 6px;">📅 Call Scheduled: \${lead.meetingTime}</div>\\\` : ''}
      \`;

      document.getElementById('modal-summary-block').textContent = lead.summaryBlock || 'Summary block not generated.';
      document.getElementById('modal-overlay').classList.add('active');
    }

    function closeModal() {
      document.getElementById('modal-overlay').classList.remove('active');
    }

    function closeModalOnOverlay(event) {
      if (event.target === document.getElementById('modal-overlay')) {
        closeModal();
      }
    }

    function copySummaryText() {
      const summaryText = document.getElementById('modal-summary-block').textContent;
      navigator.clipboard.writeText(summaryText)
        .then(() => {
          const copyBtn = document.querySelector('.copy-btn');
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy Text'; }, 2000);
        })
        .catch(err => {
          console.error('Could not copy summary:', err);
        });
    }

    // Initial load
    fetchLeads();
    fetchWhitelist();
    
    // Poll leads every 4 seconds
    setInterval(fetchLeads, 4000);
  </script>
</body>
</html>`;
}
