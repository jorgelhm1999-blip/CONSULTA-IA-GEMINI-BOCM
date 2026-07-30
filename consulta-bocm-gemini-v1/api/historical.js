import { searchHistoricalBocm } from '../lib/bocm.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido.' });
  const query = String(req.query.q || '').trim();
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  const municipality = String(req.query.municipality || '');
  if (query.length < 2) return res.status(400).json({ error: 'Introduce al menos dos caracteres.' });
  try {
    const data = await searchHistoricalBocm(query, from, to, municipality);
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
    return res.status(200).json(data);
  } catch (error) {
    console.error(error);
    return res.status(502).json({ error: error.message || 'No se ha podido consultar el histórico del BOCM.' });
  }
}
