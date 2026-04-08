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
    `${process.env.SUPABASE_URL}/rest/v1/belege?user_id=eq.${userId}&select=id,merchant,date,amount,currency,payment_method,category,beschreibung,image_url,folder_id,created_at&order=created_at.desc`,
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
