import { collectBulletin } from './lib/query-client.js';
import { MUNICIPALITIES } from './municipalities.js';
import { initHistoricalSearch } from './historical-ui.js';

const $ = selector => document.querySelector(selector);
const dateInput = $('#date');
const municipalityInput = $('#municipality');
const municipalityList = $('#municipality-list');
const searchButton = $('#search');
const status = $('#status');
const results = $('#results');


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

function renderReport(report) {
  const groups = [
    ['Publicaciones de interés principal', report.principal],
    ['Avisos complementarios', report.complementary],
    ['Revisión recomendada', report.doubtful]
  ];
  const html = groups.filter(([, items]) => items.length).map(([title, items]) =>
    `<section class="result-group"><h2 class="group-title">${title}</h2>${items.map(renderCard).join('')}</section>`).join('');
  results.innerHTML = html || '<div class="empty">Todavía no hay resultados seleccionados.</div>';
}

async function runSearch() {
  if (!dateInput.value || searchButton.disabled) return;
  const searchDate = dateInput.value;
  const dateLabel = searchDate.split('-').reverse().join('/');
  searchButton.disabled = true;
  dateInput.disabled = true;
  municipalityInput.disabled = true;
  setLoading(`Leyendo el sumario oficial del BOCM del ${dateLabel}…`);
  try {
    const report = await collectBulletin(location.origin, searchDate, {
      municipality: municipalityInput.value.trim(),
      onProgress(progress) {
        const phase = progress.phase === 'download' ? 'Descargando textos' : 'Revisando anuncios';
        status.textContent = `${dateLabel} · ${phase}: ${progress.downloaded}/${progress.total} descargados · ${progress.scanned} revisados · ${progress.aiCacheHits} análisis reutilizados.`;
        renderReport(progress);
      }
    });
    if (!report.found) {
      status.textContent = `No se ha localizado un boletín para el ${dateLabel}.`;
      results.innerHTML = '<div class="empty">No hay BOCM localizado para la fecha seleccionada.</div>';
      return;
    }
    renderReport(report);
    const incomplete = report.failedCves.length;
    status.textContent = `${dateLabel} · BOCM nº ${report.bulletinNumber || '?'} · ${report.scanned} anuncios revisados de ${report.total} publicados · ${report.aiCacheHits} análisis reutilizados.${incomplete ? ` Consulta parcial: ${incomplete} pendientes (${report.failedCves.join(', ')}).` : ' Consulta completa.'}`;
    if (!incomplete && !report.principal.length && !report.complementary.length && !report.doubtful.length) {
      results.innerHTML = '<div class="empty">No se han detectado publicaciones de interés en los anuncios revisados.</div>';
    }
  } catch (error) {
    if (error.partialReport) renderReport(error.partialReport);
    const counts = error.partialReport ? ` ${error.partialReport.scanned}/${error.partialReport.total} anuncios revisados.` : '';
    const hasResults = error.partialReport && ['principal', 'complementary', 'doubtful'].some(key => error.partialReport[key]?.length);
    status.textContent = `${dateLabel} · ${error.message}${counts}${hasResults ? ' Consulta parcial: se conservan los resultados ya recibidos.' : ' No se ha completado la consulta de esta fecha.'}`;
    if (!error.partialReport) results.innerHTML = '<div class="empty">No se ha podido obtener el sumario oficial. Puedes reintentar o consultar otra fecha.</div>';
  } finally {
    searchButton.disabled = false;
    dateInput.disabled = false;
    municipalityInput.disabled = false;
  }
}

dateInput.addEventListener('change', () => {
  if (searchButton.disabled) return;
  results.innerHTML = '';
  status.textContent = 'Fecha cambiada. Pulsa Consultar BOCM para iniciar una nueva búsqueda.';
});

searchButton.addEventListener('click', runSearch);
municipalityInput.addEventListener('keydown', event => { if (event.key === 'Enter') runSearch(); });

initHistoricalSearch();

