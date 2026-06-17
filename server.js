import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '25mb' }));

// Static assets (JS, CSS, images) can be cached
app.use(express.static(join(__dirname, 'public'), { index: false }));

// GET /api/config
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

// POST /api/analyze
app.post('/api/analyze', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify the request carries a valid Supabase session, returns the user id or null
async function verifyUser(authHeader) {
  if (!authHeader) return null;
  const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': authHeader, 'apikey': process.env.SUPABASE_ANON_KEY },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  return user.id || null;
}

// Admin: verify requester is admin, returns requester's user id or null
async function verifyAdmin(authHeader) {
  if (!authHeader) return null;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return null;
  const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': authHeader, 'apikey': process.env.SUPABASE_ANON_KEY },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  const profileRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=role`,
    { headers: { 'Authorization': `Bearer ${serviceKey}`, 'apikey': serviceKey } }
  );
  const profiles = await profileRes.json();
  if (!profiles[0] || profiles[0].role !== 'admin') return null;
  return user.id;
}

const STATEMENT_INSTRUCTIONS = `You are a credit card statement parser. Extract ALL transaction lines from this bank statement page.

Return ONLY a raw JSON array — no markdown, no explanation, no code fences. Start with [ and end with ].

Each transaction object must have:
{"date":"DD.MM.YYYY","merchant":"string","amount_chf":number,"currency_original":"string","amount_original":number_or_null,"is_fee":false}

Rules:
- date: the transaction date (first date column), convert YY to full year (e.g. 26 → 2026)
- merchant: the merchant/vendor name (first line of the detail text)
- amount_chf: the CHF amount (rightmost column). This is the key matching field.
- currency_original: original transaction currency (EUR, USD, CHF, etc.)
- amount_original: amount in original currency if different from CHF, null if same
- is_fee: true ONLY for "Bearbeitungsgebühr" fee lines, false for all real transactions
- Skip header rows, subtotals, and summary lines (like "Übertrag Karte", "Total Karte")
- Each real purchase/payment is one entry. Do NOT merge multiple transactions.
- If a transaction has a currency conversion line below it, that's part of the same transaction — do not create a separate entry for the conversion line.`;

// Parse a credit card statement into transactions. Each page is either
// { type: 'text', text } (extracted from the PDF text layer — fast, tiny
// payload) or { type: 'image', base64, media_type } (a rasterized page, used
// only when a page has no usable text layer). Pages run in parallel so the
// total time stays near the slowest single page.
async function parseStatementPages(pages, apiKey) {
  const textPages = pages.filter(p => p.type === 'text').length;
  const imagePages = pages.length - textPages;
  console.log(`[parse-statement] start: ${pages.length} page(s) (${textPages} text, ${imagePages} image)`);
  const t0 = Date.now();

  async function parsePage(page, pi) {
    const pageStart = Date.now();
    const content = page.type === 'image'
      ? [{ type: "image", source: { type: "base64", media_type: page.media_type || "image/png", data: page.base64 } },
         { type: "text", text: STATEMENT_INSTRUCTIONS }]
      : [{ type: "text", text: `${STATEMENT_INSTRUCTIONS}\n\nStatement page text:\n\n${page.text}` }];
    const payload = { model: "claude-sonnet-4-6", max_tokens: 4000, messages: [{ role: "user", content }] };
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || JSON.stringify(data));
    const text = (data.content || []).map(b => b.text || '').join('').trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    console.log(`[parse-statement] page ${pi + 1}/${pages.length} (${page.type}) done in ${Date.now() - pageStart}ms (status ${response.status})`);
    return parsed;
  }

  const results = await Promise.all(pages.map((page, pi) => parsePage(page, pi)));
  // Filter out fee lines
  const transactions = results.flat().filter(t => !t.is_fee);
  console.log(`[parse-statement] success: ${transactions.length} tx in ${Date.now() - t0}ms`);
  return transactions;
}

// Shared parse-statement response handler (auth is enforced by the caller).
// One buffered JSON response — no early flushHeaders/heartbeat. Extracting the
// PDF text layer keeps this well under a minute, so we don't need to fight the
// ~60s connection limit; and an early flushHeaders() made Railway's HTTP/2 proxy
// forward the 200 but drop the trailing body chunk, leaving the browser with an
// empty body it couldn't parse ("Server-Fehler 200").
async function handleParseStatement(req, res) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  // Pages are { type: 'text', text } or { type: 'image', base64, media_type }.
  // Older clients sent { images: [...] }; accept that as image-only pages.
  let { pages } = req.body;
  if (!pages && Array.isArray(req.body.images)) pages = req.body.images.map(im => ({ type: 'image', ...im }));
  if (!pages || !pages.length) return res.status(400).json({ error: 'No pages' });
  const t0 = Date.now();
  try {
    const transactions = await parseStatementPages(pages, apiKey);
    res.json({ transactions });
  } catch (err) {
    console.error(`[parse-statement] error after ${Date.now() - t0}ms:`, err.message);
    res.status(500).json({ error: err.message });
  }
}

// GET /api/all-folders — returns all folders (all users) for authenticated users
app.get('/api/all-folders', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  // Verify the caller is a valid user
  const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': authHeader, 'apikey': process.env.SUPABASE_ANON_KEY },
  });
  if (!userRes.ok) return res.status(401).json({ error: 'Unauthorized' });
  // Fetch all folders using service role (bypasses RLS)
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/folders?select=id,name&order=created_at.asc`,
    { headers: { 'Authorization': `Bearer ${serviceKey}`, 'apikey': serviceKey } }
  );
  const data = await r.json();
  res.status(r.status).json(data);
});

// GET /api/admin/users
app.get('/api/admin/users', async (req, res) => {
  const adminId = await verifyAdmin(req.headers.authorization);
  if (!adminId) return res.status(403).json({ error: 'Forbidden' });
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/profiles?select=id,full_name,email,role,created_at&order=created_at.asc`,
    { headers: { 'Authorization': `Bearer ${serviceKey}`, 'apikey': serviceKey } }
  );
  const data = await r.json();
  res.status(r.status).json(data);
});

// GET /api/admin/belege?userId=xxx
app.get('/api/admin/belege', async (req, res) => {
  const adminId = await verifyAdmin(req.headers.authorization);
  if (!adminId) return res.status(403).json({ error: 'Forbidden' });
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/belege?user_id=eq.${userId}&select=id,merchant,date,amount,currency,tip,payment_method,category,beschreibung,image_url,folder_id,created_at&order=created_at.desc`,
    { headers: { 'Authorization': `Bearer ${serviceKey}`, 'apikey': serviceKey } }
  );
  const data = await r.json();
  res.status(r.status).json(data);
});

// GET /api/admin/folders?userId=xxx
app.get('/api/admin/folders', async (req, res) => {
  const adminId = await verifyAdmin(req.headers.authorization);
  if (!adminId) return res.status(403).json({ error: 'Forbidden' });
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/folders?user_id=eq.${userId}&select=id,name&order=created_at.asc`,
    { headers: { 'Authorization': `Bearer ${serviceKey}`, 'apikey': serviceKey } }
  );
  const data = await r.json();
  res.status(r.status).json(data);
});

// POST /api/admin/create-user
app.post('/api/admin/create-user', async (req, res) => {
  const adminId = await verifyAdmin(req.headers.authorization);
  if (!adminId) return res.status(403).json({ error: 'Forbidden' });
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const { email, password, name, role } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Missing fields' });
  try {
    const createRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'apikey': serviceKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { name } }),
    });
    const createData = await createRes.json();
    console.log('create-user response:', createRes.status, JSON.stringify(createData));
    if (!createRes.ok) return res.status(createRes.status).json({ error: createData.msg || createData.message || JSON.stringify(createData) });
    const newUserId = createData.id;
    // Upsert profile (a DB trigger may have already created a row)
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?on_conflict=id`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'apikey': serviceKey,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ id: newUserId, full_name: name, email, role: role || 'user' }),
    });
    res.json({ success: true, userId: newUserId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/parse-statement — any authenticated user reconciles their own statement
app.post('/api/parse-statement', async (req, res) => {
  const userId = await verifyUser(req.headers.authorization);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  return handleParseStatement(req, res);
});

// POST /api/admin/parse-statement — admins parse on behalf of another user
app.post('/api/admin/parse-statement', async (req, res) => {
  const adminId = await verifyAdmin(req.headers.authorization);
  if (!adminId) return res.status(403).json({ error: 'Forbidden' });
  return handleParseStatement(req, res);
});

// DELETE /api/admin/delete-user
app.delete('/api/admin/delete-user', async (req, res) => {
  const adminId = await verifyAdmin(req.headers.authorization);
  if (!adminId) return res.status(403).json({ error: 'Forbidden' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  if (userId === adminId) return res.status(400).json({ error: 'Eigenen Account kann man nicht löschen' });
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    // Delete profile first (FK constraint)
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${serviceKey}`, 'apikey': serviceKey },
    });
    // Delete auth user
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${serviceKey}`, 'apikey': serviceKey },
    });
    if (!r.ok) { const d = await r.json(); return res.status(r.status).json({ error: d.msg || d.message || JSON.stringify(d) }); }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/change-password
app.post('/api/admin/change-password', async (req, res) => {
  const adminId = await verifyAdmin(req.headers.authorization);
  if (!adminId) return res.status(403).json({ error: 'Forbidden' });
  const { userId, password } = req.body;
  if (!userId || !password) return res.status(400).json({ error: 'Missing fields' });
  if (password.length < 8) return res.status(400).json({ error: 'Mindestens 8 Zeichen' });
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'apikey': serviceKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password }),
    });
    if (!r.ok) { const d = await r.json(); return res.status(r.status).json({ error: d.msg || d.message || JSON.stringify(d) }); }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upload-image
app.post('/api/upload-image', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  const { imageBase64, fileName } = req.body;
  if (!imageBase64 || !fileName) return res.status(400).json({ error: 'Missing fields' });

  const buffer = Buffer.from(imageBase64, 'base64');

  const uploadRes = await fetch(
    `${process.env.SUPABASE_URL}/storage/v1/object/belege-images/${fileName}`,
    {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Content-Type': 'image/jpeg',
      },
      body: buffer,
    }
  );

  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    return res.status(uploadRes.status).json({ error: text });
  }

  const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/belege-images/${fileName}`;
  res.json({ publicUrl });
});

// Serve index.html with no-cache so deploys are always picked up immediately
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
