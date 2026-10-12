import { MUNICIPALITIES } from './municipalities.js';
import { initHistoricalSearch } from './historical-ui.js';

const $ = selector => document.querySelector(selector);
const dateInput = $('#date');
const municipalityInput = $('#municipality');
const municipalityList = $('#municipality-list');
const searchButton = $('#search');
const status = $('#status');
const results = $('#results');

const BATCH_SIZE = 12;
const MAX_RETRY_ROUNDS = 3;

const todayParts = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit'
}).formatToParts(new Date());
const todayPart = name => todayParts.find(part => part.type === name).value;
dateInput.value = `${todayPart('year')}-${todayPart('month')}-${todayPart('day')}`;
municipalityList.innerHTML = MUNICIPALITIES.map(name => `<option value="${name}"></option>`).join('');

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function cveNumber(cve = '') {
  return Number(String(cve).split('-').pop()) || 0;
}

function officialUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['bocm.es', 'www.bocm.es'].includes(url.hostname)
      ? url.href : '';
  } catch { return ''; }
}

function renderCard(item) {
  const tags = (item.matches || []).map(tag => `<span class="badge">${escapeHtml(tag)}</span>`).join('');
  const level = item.decision === 'principal' ? 'Interés principal' : item.decision === 'complementario' ? 'Interés complementario' : 'Revisión recomendada';
  const heading = item.cve || 'Anuncio BOCM';
  const url = officialUrl(item.url);
  return `<article class="card">
    <div class="badges"><span class="badge high">${level}</span>${tags}</div>
    <h2>${escapeHtml(heading)}</h2>
    <p class="announcement-title">${escapeHtml(item.title || '')}</p>
    ${item.summary ? `<p class="ai-summary">${escapeHtml(item.summary)}</p>` : ''}
    ${item.reason ? `<p class="reason"><strong>Motivo de selección:</strong> ${escapeHtml(item.reason)}</p>` : ''}
    ${url ? `<div class="actions"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Abrir anuncio en HTML</a></div>` : ''}
  </article>`;
}

function setLoading(text) {
  results.innerHTML = '';
  status.innerHTML = `<span class="spinner"></span>${text}`;
}

async function requestJson(params) {
  const response = await fetch(`/api/search?${params}`);
  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    const preview = raw.replace(/\s+/g, ' ').trim().slice(0, 180);
    throw new Error(response.ok
      ? 'El servidor devolvió una respuesta no válida.'
      : `La función de consulta falló${response.status ? ` (${response.status})` : ''}${preview ? `: ${preview}` : '.'}`);
  }
  if (!response.ok) throw new Error(data.error || `Error de consulta (${response.status})`);
  return data;
}

async function runSearch() {
  if (!dateInput.value) return;
  searchButton.disabled = true;
  setLoading('Leyendo el sumario XML oficial del BOCM…');

  const resultMap = new Map();
  let scanned = 0;
  let incomplete = false;
  const doubtfulMap = new Map();
  const complementaryMap = new Map();

  try {
    const manifestParams = new URLSearchParams({ mode: 'manifest', date: dateInput.value });
    const manifest = await requestJson(manifestParams);

    if (!manifest.found || !Array.isArray(manifest.cves) || manifest.cves.length === 0) {
      status.textContent = 'No se ha localizado un boletín para esa fecha. Puede ser festivo o día sin publicación.';
      results.innerHTML = '<div class="empty">No hay BOCM localizado para la fecha seleccionada.</div>';
      return;
    }

    const allCves = manifest.cves;
    for (let offset = 0; offset < allCves.length; offset += BATCH_SIZE) {
      const batch = allCves.slice(offset, offset + BATCH_SIZE);
      status.innerHTML = `<span class="spinner"></span>Revisando anuncios ${offset + 1}-${Math.min(offset + batch.length, allCves.length)} de ${allCves.length}…`;

      const params = new URLSearchParams({
        mode: 'batch',
        date: dateInput.value,
        cves: batch.join(',')
      });
      if (municipalityInput.value.trim()) params.set('municipality', municipalityInput.value.trim());

      const data = await requestJson(params);
      scanned += data.existingCount || 0;
      for (const item of data.results || []) resultMap.set(item.cve, item);
      for (const item of data.complementary || []) complementaryMap.set(item.cve, item);
      for (const item of data.doubtful || []) doubtfulMap.set(item.cve, item);
      if (Array.isArray(data.failedCves) && data.failedCves.length) {
        manifest.failedCves = [...(manifest.failedCves || []), ...data.failedCves];
      }

      const partial = [...resultMap.values()].sort((a, b) => cveNumber(a.cve) - cveNumber(b.cve));
      results.innerHTML = partial.length ? partial.map(renderCard).join('') : '';
    }

    let pending = [...new Set(manifest.failedCves || [])];
    for (let round = 1; pending.length && round <= MAX_RETRY_ROUNDS; round += 1) {
      const nextPending = [];
      for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
        const batch = pending.slice(offset, offset + BATCH_SIZE);
        status.innerHTML = `<span class="spinner"></span>Reintentando ${batch.length} anuncio(s) pendientes · ronda ${round}/${MAX_RETRY_ROUNDS}…`;
        const params = new URLSearchParams({ mode: 'batch', date: dateInput.value, cves: batch.join(',') });
        if (municipalityInput.value.trim()) params.set('municipality', municipalityInput.value.trim());
        const data = await requestJson(params);
        scanned += data.existingCount || 0;
        for (const item of data.results || []) resultMap.set(item.cve, item);
        for (const item of data.complementary || []) complementaryMap.set(item.cve, item);
      for (const item of data.doubtful || []) doubtfulMap.set(item.cve, item);
        if (Array.isArray(data.failedCves)) nextPending.push(...data.failedCves);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      pending = [...new Set(nextPending)];
    }
    incomplete = pending.length > 0;
    scanned = allCves.length - pending.length;

    const finalResults = [...resultMap.values()].sort((a, b) => cveNumber(a.cve) - cveNumber(b.cve));
    const finalComplementary = [...complementaryMap.values()].sort((a, b) => cveNumber(a.cve) - cveNumber(b.cve));
    const finalDoubtful = [...doubtfulMap.values()].sort((a, b) => cveNumber(a.cve) - cveNumber(b.cve));
    const warning = incomplete ? ' · Consulta parcial: algún XML individual no respondió' : '';
    const complementaryText = finalComplementary.length ? ` · ${finalComplementary.length} aviso(s) complementario(s)` : '';
    const doubtfulText = finalDoubtful.length ? ` · ${finalDoubtful.length} pendiente(s) de revisión` : '';
    const bulletinUrl = officialUrl(manifest.bulletinUrl);
    status.innerHTML = `<strong>BOCM nº ${escapeHtml(manifest.bulletinNumber || '?')}</strong> · ${finalResults.length} resultado(s) seleccionados por IA entre ${scanned} anuncios revisados de ${allCves.length} publicados${complementaryText}${doubtfulText}${warning}. ${bulletinUrl ? `<a href="${escapeHtml(bulletinUrl)}" target="_blank" rel="noopener noreferrer">Ver sumario oficial</a>` : ''}`;
    const complementaryHtml = finalComplementary.length ? `<section class="result-group complementary-group"><h2 class="group-title">Avisos complementarios</h2>${finalComplementary.map(renderCard).join('')}</section>` : '';
    const doubtfulHtml = finalDoubtful.length ? `<details class="doubtful-block"><summary>Mostrar ${finalDoubtful.length} anuncio(s) pendientes de revisión</summary>${finalDoubtful.map(renderCard).join('')}</details>` : '';
    const principalHtml = finalResults.length ? `<section class="result-group"><h2 class="group-title">Publicaciones de interés principal</h2>${finalResults.map(renderCard).join('')}</section>` : '';
    results.innerHTML = finalResults.length || finalComplementary.length || finalDoubtful.length ? principalHtml + complementaryHtml + doubtfulHtml : '<div class="empty">La IA no ha detectado publicaciones de interés.</div>';
  } catch (error) {
    status.textContent = `${error.message} Consulta parcial: se conservan los resultados ya recibidos.`;
    const partial = [...resultMap.values()].sort((a, b) => cveNumber(a.cve) - cveNumber(b.cve));
    const complementary = [...complementaryMap.values()].sort((a, b) => cveNumber(a.cve) - cveNumber(b.cve));
    const doubtful = [...doubtfulMap.values()].sort((a, b) => cveNumber(a.cve) - cveNumber(b.cve));
    results.innerHTML = [...partial, ...complementary, ...doubtful].length
      ? `<section class="result-group">${[...partial, ...complementary, ...doubtful].map(renderCard).join('')}</section>`
      : '<div class="empty">La consulta no ha podido completarse.</div>';
  } finally {
    searchButton.disabled = false;
  }
}

searchButton.addEventListener('click', runSearch);
municipalityInput.addEventListener('keydown', event => { if (event.key === 'Enter') runSearch(); });

initHistoricalSearch();
