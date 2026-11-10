// Shared by the browser and the daily workflow. No secrets or Node imports.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sort = items => [...items.values()].sort((a, b) => Number(a.cve.split('-').pop()) - Number(b.cve.split('-').pop()));

export async function collectBulletin(baseUrl, date, {
  fetcher = fetch, municipality = '', onProgress = () => {}, wait = sleep
} = {}) {
  async function request(params) {
    const url = new URL('/api/search', baseUrl);
    url.search = new URLSearchParams({ date, cacheVersion: '3', ...params });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetcher(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(58000) });
        const raw = await response.text();
        let data;
        try { data = JSON.parse(raw); } catch {
          throw Object.assign(new Error(`La función de consulta devolvió HTTP ${response.status} sin una respuesta válida.`), { status: response.status });
        }
        if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status, quota: data.quota });
        return data;
      } catch (error) {
        if (attempt || error.status === 429 || (error.status && error.status < 500)) throw error;
        await wait(params.mode === 'analyze' ? 15000 : 1500);
      }
    }
  }
  const manifest = await request({ mode: 'manifest' });
  const report = { date, found: manifest.found, bulletinNumber: manifest.bulletinNumber,
    bulletinUrl: manifest.bulletinUrl || '', scanned: 0, downloaded: 0, total: 0,
    principal: [], complementary: [], doubtful: [], failedCves: [], cacheHits: 0, aiCacheHits: 0 };
  if (!manifest.found) return report;
  if (!Array.isArray(manifest.cves) || !manifest.cves.length) throw new Error('El sumario no contiene anuncios comprobables.');
  const all = [...new Set(manifest.cves)];
  const downloaded = new Set();
  const processed = new Set();
  const maps = { principal: new Map(), complementary: new Map(), doubtful: new Map() };
  report.total = all.length;
  const update = phase => {
    report.scanned = processed.size;
    report.downloaded = downloaded.size;
    report.failedCves = all.filter(cve => !processed.has(cve));
    for (const key of Object.keys(maps)) report[key] = sort(maps[key]);
    onProgress({ ...report, phase });
  };
  async function download(cves) {
    for (let offset = 0; offset < cves.length; offset += 4) {
      const batch = cves.slice(offset, offset + 4);
      const data = await request({ mode: 'download', cves: batch.join(',') });
      for (const cve of data.downloadedCves || []) if (batch.includes(cve)) downloaded.add(cve);
      report.cacheHits += data.cacheHits || 0;
      update('download');
    }
  }
  try {
    update('download');
    // Retry only missing sources, never re-read successful downloads in this run.
    for (let round = 0; round < 3; round++) {
      const pending = all.filter(cve => !downloaded.has(cve));
      if (!pending.length) break;
      if (round) await wait(round * 2000);
      await download(pending);
    }
    let pending = all.filter(cve => downloaded.has(cve));
    const restores = new Map();
    const analysisFailures = new Map();
    let targetTokens = 8000;
    while (pending.length) {
      update('analyze');
      const batch = pending.slice(0, 24);
      const data = await request({ mode: 'analyze', municipality, cves: batch.join(','), targetTokens });
      for (const [key, field] of [['principal', 'results'], ['complementary', 'complementary'], ['doubtful', 'doubtful']]) {
        for (const item of data[field] || []) if (batch.includes(item.cve)) maps[key].set(item.cve, item);
      }
      const done = new Set(data.processedCves || []);
      for (const cve of done) if (batch.includes(cve)) processed.add(cve);
      report.aiCacheHits += data.metrics?.cached || 0;
      update('analyze');
      if (data.analysisError) {
        const error = Object.assign(new Error(data.analysisError.message), data.analysisError);
        const failed = batch.filter(cve => !processed.has(cve));
        for (const cve of failed) analysisFailures.set(cve, (analysisFailures.get(cve) || 0) + 1);
        if (error.status === 504 && targetTokens > 2000) {
          targetTokens = Math.max(2000, Math.floor(targetTokens / 2));
          console.warn(`Gemini agotó el tiempo: próximo lote objetivo ${targetTokens} tokens estimados, ${failed.length} anuncios pendientes.`);
        }
        if (![500, 502, 503, 504].includes(error.status) || !failed.length
          || failed.some(cve => analysisFailures.get(cve) >= 3)) throw error;
        await wait(15000);
        pending = pending.filter(cve => !processed.has(cve));
        continue;
      }
      // Runtime cache may evict a source between requests. Restore at most once.
      const missing = (data.failedCves || []).filter(cve => batch.includes(cve));
      for (const cve of missing) {
        if (restores.has(cve)) throw new Error(`No se pudo conservar el texto de ${cve} para analizarlo.`);
        restores.set(cve, true);
        downloaded.delete(cve);
      }
      if (missing.length) await download(missing);
      if (!done.size && !missing.length) throw new Error('La revisión no avanzó; se conservan los anuncios pendientes.');
      pending = pending.filter(cve => !processed.has(cve));
      // Pace fresh AI work outside Vercel's invocation time budget. Cache-only batches need no pause.
      if (pending.length && data.metrics?.requested !== 0) await wait(15000);
    }
    update('complete');
    return report;
  } catch (error) {
    update('partial');
    error.partialReport = report;
    throw error;
  }
}
