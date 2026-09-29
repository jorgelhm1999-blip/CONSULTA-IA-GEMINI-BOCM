import { getBocmManifest, searchHistoricalCveBatch } from '../lib/bocm.js';

function madridToday() {
  const parts = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const part = name => parts.find(value => value.type === name).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
    && value >= '2010-02-12' && value <= madridToday();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido.' });
  const mode = String(req.query.mode || '');
  const date = String(req.query.date || '');
  if (!validDate(date)) return res.status(400).json({ error: 'Fecha no válida o fuera del archivo del BOCM.' });
  if (!['manifest', 'batch'].includes(mode)) return res.status(400).json({ error: 'Modo no válido.' });

  try {
    let data;
    if (mode === 'manifest') {
      data = await getBocmManifest(date, { historical: true });
    } else {
      const query = String(req.query.q || '').trim();
      const municipality = String(req.query.municipality || '').trim();
      const filter = String(req.query.filter || '0');
      const cves = String(req.query.cves || '').split(',').filter(Boolean);
      const compact = date.replaceAll('-', '');
      if ((!query && municipality.length < 2) || (query && query.length < 2)
        || query.length > 120 || municipality.length > 100 || !['0', '1'].includes(filter)) {
        return res.status(400).json({ error: 'Texto de búsqueda o municipio no válido.' });
      }
      if (filter === '1' && !process.env.GEMINI_API_KEY) {
        return res.status(503).json({ code: 'AI_UNAVAILABLE', error: 'Falta configurar GEMINI_API_KEY para aplicar los criterios de interés.' });
      }
      if (!cves.length || cves.length > 12 || cves.some(cve =>
        !new RegExp(`^BOCM-${compact}-\\d+$`, 'i').test(cve))) {
        return res.status(400).json({ error: 'Lote de CVE no válido.' });
      }
      data = await searchHistoricalCveBatch(date, query, municipality, cves, filter === '1');
    }
    res.setHeader('Cache-Control', date === madridToday()
      ? 'public, s-maxage=300'
      : 'public, s-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json(data);
  } catch (error) {
    console.error(error);
    if (error?.isHistoricalRelevanceError) {
      return res.status(503).json({ code: 'AI_UNAVAILABLE', error: error.message || 'Gemini no pudo revisar las coincidencias.' });
    }
    return res.status(502).json({ error: error?.message || 'No se pudo consultar el BOCM.' });
  }
}
