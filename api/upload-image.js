export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  const { imageBase64, fileName } = req.body;
  if (!imageBase64 || !fileName) return res.status(400).json({ error: 'Missing fields' });

  console.log('upload-image: fileName=', fileName, 'base64 length=', imageBase64.length);

  const buffer = Buffer.from(imageBase64, 'base64');
  console.log('upload-image: buffer size=', buffer.length);

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

  console.log('upload-image: supabase status=', uploadRes.status);

  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    console.log('upload-image: supabase error=', text);
    return res.status(uploadRes.status).json({ error: text });
  }

  const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/belege-images/${fileName}`;
  res.json({ publicUrl });
}
