import { getBocmManifest, searchBocmCveBatch } from '../lib/bocm.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  const mode = String(req.query.mode || 'manifest');
  const date = String(req.query.date || '');
  const municipality = String(req.query.municipality || '');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Fecha no válida.' });
  }

  try {
    let data;
    if (mode === 'manifest') {
      data = await getBocmManifest(date);
    } else if (mode === 'batch') {
      const cves = String(req.query.cves || '').split(',').filter(Boolean);
      if (!cves.length || cves.length > 15) {
        return res.status(400).json({ error: 'Lote de CVE no válido.' });
      }
      data = await searchBocmCveBatch(date, municipality, cves);
    } else {
      return res.status(400).json({ error: 'Modo de consulta no válido.' });
    }

    // El boletin del dia puede publicarse o completarse despues de una primera consulta.
    // Usamos la fecha de Madrid porque las funciones de Vercel se ejecutan en UTC.
    const madridToday = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Madrid',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());

    const cacheControl = date === madridToday
      ? 's-maxage=300, stale-while-revalidate=60'
      : 's-maxage=86400, stale-while-revalidate=604800';

    res.setHeader('Cache-Control', cacheControl);
    return res.status(200).json(data);
  } catch (error) {
    console.error(error);
    return res.status(502).json({ error: error?.message || 'No se ha podido consultar el BOCM.' });
  }
}
