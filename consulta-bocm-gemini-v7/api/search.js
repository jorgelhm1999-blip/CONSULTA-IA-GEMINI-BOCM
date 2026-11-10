import { getBocmManifest, searchBocmCveBatch, downloadBocmBatch } from '../lib/bocm.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido.' });
  const mode = String(req.query.mode || 'manifest');
  const date = String(req.query.date || '');
  const municipality = String(req.query.municipality || '');
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T12:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    return res.status(400).json({ error: 'Fecha no válida.' });
  }
  try {
    if (mode === 'manifest') return res.status(200).json(await getBocmManifest(date));
    if (!['download', 'analyze', 'batch'].includes(mode)) return res.status(400).json({ error: 'Modo no válido.' });
    const cves = [...new Set(String(req.query.cves || '').split(',').filter(Boolean))];
    const pattern = new RegExp(`^BOCM-${date.replaceAll('-', '')}-[1-9]\\d*$`);
    const limit = mode === 'analyze' ? 24 : 4;
    if (!cves.length || cves.length > limit || cves.some(cve => !pattern.test(cve))) {
      return res.status(400).json({ error: `Lote no válido (máximo ${limit} anuncios de la fecha indicada).` });
    }
    const targetTokens = Number(req.query.targetTokens || 0);
    if (mode === 'analyze' && targetTokens && ![2000, 4000, 8000].includes(targetTokens)) {
      return res.status(400).json({ error: 'Tamaño de lote no válido.' });
    }
    const data = mode === 'download' ? await downloadBocmBatch(cves)
      : await searchBocmCveBatch(date, municipality, cves, { cachedOnly: mode === 'analyze', targetTokens });
    return res.status(200).json(data);
  } catch (error) {
    console.error('bocmi_search_error', { message: error.message, status: error.status });
    return res.status(error.status === 429 ? 429 : 502).json({ error: error.message || 'No se ha podido consultar el BOCM.', quota: error.quota || null });
  }
}
