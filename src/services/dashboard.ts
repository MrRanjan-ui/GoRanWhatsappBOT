import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { getLeads, getWhitelistFromDb, saveWhitelistToDb, isDbConnected } from './db';

/**
 * Starts a lightweight HTTP server using Node's built-in 'http' module
 * to serve a premium live lead dashboard.
 */
export function startDashboardServer(port: number) {
  const server = http.createServer(async (req, res) => {
    const url = req.url || '';
    
    // 1. GET /api/leads - Serve JSON leads list
    if (req.method === 'GET' && url === '/api/leads') {
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
    if (req.method === 'GET' && url === '/api/whitelist') {
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
    if (req.method === 'POST' && url === '/api/whitelist') {
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
    
    // 4. GET /dashboard || / - Serve HTML page
    if (req.method === 'GET' && (url === '/dashboard' || url === '/')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getDashboardHTML());
      return;
    }
    
    // 5. Fallback 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(port, () => {
    console.log(`📡 Live Lead Dashboard is running at http://localhost:${port}/dashboard`);
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
  <title>GoRan AI — Live Lead Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(17, 24, 39, 0.7);
      --border: rgba(255, 255, 255, 0.08);
      --accent: #F6C744;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --success: #10b981;
      --success-glow: rgba(16, 185, 129, 0.15);
      --warning: #f59e0b;
      --warning-glow: rgba(245, 158, 11, 0.15);
      --danger: #ef4444;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Inter', sans-serif;
      background-color: var(--bg);
      background-image: 
        radial-gradient(circle at 10% 20%, rgba(246, 199, 68, 0.05) 0%, transparent 40%),
        radial-gradient(circle at 90% 80%, rgba(16, 185, 129, 0.03) 0%, transparent 40%);
      background-attachment: fixed;
      color: var(--text);
      min-height: 100vh;
      padding: 40px 20px;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
    }

    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 40px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 20px;
    }

    .logo-section h1 {
      font-family: 'Outfit', sans-serif;
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, #fff 0%, var(--accent) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .logo-section p {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    .status-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.2);
      padding: 6px 14px;
      border-radius: 100px;
      font-size: 13px;
      font-weight: 500;
      color: var(--success);
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
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 20px;
      margin-bottom: 40px;
    }

    .stat-card {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .stat-card:hover {
      transform: translateY(-2px);
      border-color: rgba(246, 199, 68, 0.2);
      box-shadow: 0 10px 20px rgba(0,0,0,0.2);
    }

    .stat-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .stat-value {
      font-family: 'Outfit', sans-serif;
      font-size: 36px;
      font-weight: 700;
      color: #fff;
      margin-top: 10px;
    }

    /* Leads Table Section */
    .section-title {
      font-family: 'Outfit', sans-serif;
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .leads-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .lead-card {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: all 0.3s ease;
      cursor: pointer;
    }

    .lead-card:hover {
      border-color: rgba(255, 255, 255, 0.15);
      background: rgba(17, 24, 39, 0.85);
    }

    .lead-main {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-width: 70%;
    }

    .lead-header {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .lead-phone {
      font-weight: 600;
      font-size: 16px;
      color: #fff;
    }

    .lead-time {
      font-size: 12px;
      color: var(--text-muted);
    }

    .lead-email {
      font-size: 14px;
      color: var(--accent);
      text-decoration: none;
    }

    .lead-details {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.4;
      margin-top: 4px;
    }

    .lead-badges {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .badge {
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .badge-score-high {
      background: var(--success-glow);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.2);
    }

    .badge-score-med {
      background: var(--warning-glow);
      color: var(--warning);
      border: 1px solid rgba(245, 158, 11, 0.2);
    }

    .badge-score-low {
      background: rgba(255,255,255,0.03);
      color: var(--text-muted);
      border: 1px solid var(--border);
    }

    .badge-meeting {
      background: rgba(246, 199, 68, 0.08);
      color: var(--accent);
      border: 1px solid rgba(246, 199, 68, 0.2);
    }

    /* Whitelist Section */
    .whitelist-section {
      margin-top: 50px;
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
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      padding: 8px 14px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 14px;
      font-weight: 500;
      color: #fff;
    }

    .whitelist-tag .remove-btn {
      color: var(--danger);
      cursor: pointer;
      font-weight: 700;
      font-size: 16px;
      line-height: 1;
      transition: opacity 0.2s;
    }

    .whitelist-tag .remove-btn:hover {
      opacity: 0.8;
    }

    .whitelist-add-form {
      display: flex;
      gap: 10px;
      margin-top: 10px;
      max-width: 450px;
    }

    .whitelist-add-form input {
      flex: 1;
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 14px;
      color: #fff;
      font-size: 14px;
      font-family: inherit;
    }

    .whitelist-add-form input:focus {
      outline: none;
      border-color: rgba(246, 199, 68, 0.4);
    }

    .whitelist-add-form button {
      background: var(--accent);
      color: #000;
      border: none;
      border-radius: 10px;
      padding: 10px 20px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s;
    }

    .whitelist-add-form button:hover {
      opacity: 0.9;
    }

    /* Modal */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.8);
      backdrop-filter: blur(8px);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 1000;
      padding: 20px;
    }

    .modal {
      background: #0f172a;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 20px;
      max-width: 600px;
      width: 100%;
      max-height: 85vh;
      overflow-y: auto;
      padding: 30px;
      position: relative;
    }

    .modal-close {
      position: absolute;
      top: 20px;
      right: 20px;
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 24px;
      cursor: pointer;
    }

    .modal-title {
      font-family: 'Outfit', sans-serif;
      font-size: 22px;
      font-weight: 600;
      margin-bottom: 20px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 15px;
      color: #fff;
    }

    .summary-block {
      background: #020617;
      color: #38bdf8;
      font-family: monospace;
      padding: 20px;
      border-radius: 12px;
      white-space: pre-wrap;
      font-size: 13px;
      line-height: 1.5;
      border: 1px solid rgba(56, 189, 248, 0.1);
    }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-muted);
      border: 1px dashed var(--border);
      border-radius: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-section">
        <h1>GoRan AI</h1>
        <p>Live Agency Lead & Booking Dashboard</p>
      </div>
      <div class="status-badge">
        <span class="status-dot"></span>
        <span>WhatsApp Bot Active</span>
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

    <div class="section-title">
      <span>🔥</span> Recent Scoped Leads
    </div>

    <div class="leads-list" id="leads-list">
      <div class="empty-state">No leads recorded yet. Scan QR and start qualification conversations!</div>
    </div>

    <!-- Whitelisted Numbers Manager -->
    <div class="whitelist-section">
      <div class="section-title">
        <span>🔒</span> Whitelisted Test Numbers
      </div>
      <div class="stat-card">
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 20px;">
          Only the phone numbers listed below are allowed to chat with and trigger the bot. Make sure to enter the country code (e.g., 91 for India) without '+' or spaces.
        </p>
        
        <div class="whitelist-container">
          <div class="whitelist-list" id="whitelist-list">
            <span style="color: var(--text-muted); font-size: 13px;">Loading whitelist...</span>
          </div>
          
          <div class="whitelist-add-form">
            <input type="text" id="new-number-input" placeholder="e.g. 919934225353" maxlength="20" />
            <button onclick="addNumber()">Add Number</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="modal-overlay">
    <div class="modal">
      <button class="modal-close" onclick="closeModal()">&times;</button>
      <div class="modal-title">Lead Scoping Details</div>
      <pre class="summary-block" id="modal-summary-block"></pre>
    </div>
  </div>

  <script>
    let activeLeads = [];
    let whitelist = [];

    async function fetchLeads() {
      try {
        const response = await fetch('/api/leads');
        const leads = await response.json();
        
        // Only re-render if count or timestamp changed
        if (JSON.stringify(leads) !== JSON.stringify(activeLeads)) {
          activeLeads = leads;
          renderLeads(leads);
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
        container.innerHTML = '<span style="color: var(--text-muted); font-size: 13px;">No numbers whitelisted. Bot will ignore all incoming messages!</span>';
        return;
      }
      
      container.innerHTML = '';
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
        alert('Server connection error while saving.');
      }
    }

    function addNumber() {
      const input = document.getElementById('new-number-input');
      const val = input.value.trim();
      if (!val) return;
      if (!/^\\d+$/.test(val)) {
        alert('Please enter numbers only (digits only, e.g., 919934225353)');
        return;
      }
      if (whitelist.includes(val)) {
        alert('This number is already whitelisted.');
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

    function renderLeads(leads) {
      // Sort: newest first
      leads.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      // Calculate stats
      const total = leads.length;
      let qualified = 0;
      let meetings = 0;

      const listContainer = document.getElementById('leads-list');
      if (total === 0) {
        listContainer.innerHTML = '<div class="empty-state">No leads recorded yet. Scan QR and start qualification conversations!</div>';
        return;
      }

      listContainer.innerHTML = '';

      leads.forEach(lead => {
        const scoreNum = parseInt(lead.score || '0');
        if (scoreNum >= 8) qualified++;
        if (lead.meetingTime) meetings++;

        let scoreClass = 'badge-score-low';
        if (scoreNum >= 8) scoreClass = 'badge-score-high';
        else if (scoreNum >= 5) scoreClass = 'badge-score-med';

        const card = document.createElement('div');
        card.className = 'lead-card';
        card.onclick = () => showModal(lead.summaryBlock || 'No summary block generated.');

        const mainDiv = document.createElement('div');
        mainDiv.className = 'lead-main';

        const headerDiv = document.createElement('div');
        headerDiv.className = 'lead-header';
        
        const phoneSpan = document.createElement('span');
        phoneSpan.className = 'lead-phone';
        phoneSpan.textContent = '+' + lead.phone;

        const timeSpan = document.createElement('span');
        timeSpan.className = 'lead-time';
        timeSpan.textContent = new Date(lead.timestamp).toLocaleString();

        headerDiv.appendChild(phoneSpan);
        headerDiv.appendChild(timeSpan);

        const emailLink = document.createElement('div');
        emailLink.className = 'lead-email';
        emailLink.textContent = lead.email || 'No email provided';

        const detailsDiv = document.createElement('div');
        detailsDiv.className = 'lead-details';
        detailsDiv.innerHTML = \`
          <strong>Biz Type:</strong> \&nbsp;\${lead.bizType || 'N/A'}<br/>
          <strong>Challenge:</strong> \&nbsp;\${lead.challenge || 'N/A'}<br/>
          <strong>Workflow:</strong> \&nbsp;\${lead.process || 'N/A'}
        \`;

        mainDiv.appendChild(headerDiv);
        mainDiv.appendChild(emailLink);
        mainDiv.appendChild(detailsDiv);

        const badgesDiv = document.createElement('div');
        badgesDiv.className = 'lead-badges';

        const scoreBadge = document.createElement('span');
        scoreBadge.className = 'badge ' + scoreClass;
        scoreBadge.textContent = '★ ' + (lead.score || 'N/A');
        badgesDiv.appendChild(scoreBadge);

        if (lead.meetingTime) {
          const meetBadge = document.createElement('span');
          meetBadge.className = 'badge badge-meeting';
          meetBadge.innerHTML = '📅 ' + lead.meetingTime;
          badgesDiv.appendChild(meetBadge);
        }

        card.appendChild(mainDiv);
        card.appendChild(badgesDiv);
        listContainer.appendChild(card);
      });

      document.getElementById('stat-total').textContent = total;
      document.getElementById('stat-qualified').textContent = qualified;
      document.getElementById('stat-meetings').textContent = meetings;
    }

    function showModal(summary) {
      document.getElementById('modal-summary-block').textContent = summary;
      document.getElementById('modal-overlay').style.display = 'flex';
    }

    function closeModal() {
      document.getElementById('modal-overlay').style.display = 'none';
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
