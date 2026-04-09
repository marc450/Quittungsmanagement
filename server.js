import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

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

// POST /api/admin/parse-statement
app.post('/api/admin/parse-statement', async (req, res) => {
  const adminId = await verifyAdmin(req.headers.authorization);
  if (!adminId) return res.status(403).json({ error: 'Forbidden' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const { images } = req.body; // array of { base64, media_type }
  if (!images || !images.length) return res.status(400).json({ error: 'No images' });
  try {
    const allTransactions = [];
    for (const img of images) {
      const payload = {
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: img.media_type || "image/png", data: img.base64 } },
          { type: "text", text: `You are a credit card statement parser. Extract ALL transaction lines from this bank statement image.

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
- If a transaction has a currency conversion line below it, that's part of the same transaction — do not create a separate entry for the conversion line.` }
        ]}]
      };
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
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        allTransactions.push(...parsed);
      }
    }
    // Filter out fee lines
    const transactions = allTransactions.filter(t => !t.is_fee);
    res.json({ transactions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
