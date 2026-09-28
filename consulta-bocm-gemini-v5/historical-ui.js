const $ = selector => document.querySelector(selector);
const DAY_MS = 86400000;
const MIN_DATE = '2010-02-12';
const madridParts = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit'
}).formatToParts(new Date());
const madridPart = name => madridParts.find(part => part.type === name).value;
const today = `${madridPart('year')}-${madridPart('month')}-${madridPart('day')}`;
const formatDate = date => date ? date.split('-').reverse().join('/') : 'Seleccionar';
const utcDay = value => Date.parse(`${value}T12:00:00Z`);
const isoDay = value => new Date(value).toISOString().slice(0, 10);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

async function requestJson(params, signal) {
  const response = await fetch(`/api/historical?${params}`, { signal });
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`Respuesta no válida del servidor (${response.status}).`); }
  if (!response.ok) {
    const error = new Error(data.error || `Error de consulta (${response.status}).`);
    error.code = data.code;
    throw error;
  }
  return data;
}

async function retryRequest(params, signal) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await requestJson(params, signal); }
    catch (error) {
      if (signal.aborted) throw error;
      if (error.code === 'AI_UNAVAILABLE') throw error;
      lastError = error;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 900));
    }
  }
  throw lastError;
}

function officialUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['bocm.es', 'www.bocm.es'].includes(url.hostname)
      ? url.href : '';
  } catch { return ''; }
}

function historicalCard(item) {
  const excerpt = item.excerpt || {};
  const value = String(excerpt.text || '');
  const start = Math.max(0, Math.min(value.length, Number(excerpt.highlightStart) || 0));
  const end = Math.max(start, Math.min(value.length, Number(excerpt.highlightEnd) || 0));
  const highlighted = `${escapeHtml(value.slice(0, start))}<mark>${escapeHtml(value.slice(start, end))}</mark>${escapeHtml(value.slice(end))}`;
  const organization = [item.organization, item.department].filter(Boolean).join(' · ');
  const url = officialUrl(item.url);
  return `<article class="card historical-card">
    <div class="badges"><span class="badge date-badge">${escapeHtml(formatDate(item.date))}</span><span class="badge">${escapeHtml(item.cve)}</span>${item.decision ? `<span class="badge high">${item.decision === 'principal' ? 'Interés principal' : 'Interés complementario'}</span>` : ''}</div>
    <h2>${escapeHtml(item.title)}</h2>
    ${organization ? `<p class="historical-meta">${escapeHtml(organization)}</p>` : ''}
    ${item.municipality ? `<p class="municipality">${escapeHtml(item.municipality)}</p>` : ''}
    <p class="match-excerpt"><small>${escapeHtml(item.source || 'Coincidencia')}:</small> «${highlighted}»</p>
    ${item.summary ? `<p class="ai-summary">${escapeHtml(item.summary)}</p>` : ''}
    ${url ? `<div class="actions"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Abrir anuncio oficial</a></div>` : ''}
  </article>`;
}

export function initHistoricalSearch() {
  const dailyTab = $('#tab-daily');
  const historicalTab = $('#tab-historical');
  const dailyPanel = $('#panel-daily');
  const historicalPanel = $('#panel-historical');
  const queryInput = $('#historical-query');
  const municipalityInput = $('#historical-municipality');
  const relevanceToggle = $('#historical-relevance');
  const rangeToggle = $('#range-toggle');
  const calendar = $('#calendar-popover');
  const monthSelect = $('#calendar-month');
  const yearSelect = $('#calendar-year');
  const grid = $('#calendar-grid');
  const instruction = $('#calendar-instruction');
  const searchButton = $('#historical-search');
  const cancelButton = $('#historical-cancel');
  const moreButton = $('#historical-more');
  const status = $('#historical-status');
  const issues = $('#historical-issues');
  const issuesList = $('#historical-issues-list');
  const results = $('#historical-results');

  let startDate = '';
  let endDate = '';
  let edit = 'start';
  let viewYear = Number(today.slice(0, 4));
  let viewMonth = Number(today.slice(5, 7)) - 1;
  let controller = null;
  let shown = 50;
  const matches = new Map();

  function switchTab(historical) {
    dailyTab.classList.toggle('active', !historical);
    historicalTab.classList.toggle('active', historical);
    dailyTab.setAttribute('aria-selected', String(!historical));
    historicalTab.setAttribute('aria-selected', String(historical));
    dailyPanel.classList.toggle('active', !historical);
    historicalPanel.classList.toggle('active', historical);
    dailyPanel.hidden = historical;
    historicalPanel.hidden = !historical;
    if (!historical) closeCalendar();
  }

  const monthNames = Array.from({ length: 12 }, (_, month) =>
    new Intl.DateTimeFormat('es-ES', { month: 'long' }).format(new Date(Date.UTC(2026, month, 1))));
  monthSelect.innerHTML = monthNames.map((name, index) =>
    `<option value="${index}">${name[0].toUpperCase()}${name.slice(1)}</option>`).join('');
  yearSelect.innerHTML = Array.from({ length: viewYear - 2009 }, (_, index) => 2010 + index)
    .map(year => `<option value="${year}">${year}</option>`).join('');

  function updateLabels() {
    $('#range-start-label').textContent = formatDate(startDate);
    $('#range-end-label').textContent = formatDate(endDate);
    instruction.textContent = edit === 'start'
      ? 'Selecciona la fecha de inicio.' : 'Selecciona la fecha final.';
    $('#calendar-edit-start').classList.toggle('active', edit === 'start');
    $('#calendar-edit-end').classList.toggle('active', edit === 'end');
  }

  function renderCalendar() {
    if (viewYear < 2010 || (viewYear === 2010 && viewMonth < 1)) { viewYear = 2010; viewMonth = 1; }
    const maxYear = Number(today.slice(0, 4));
    const maxMonth = Number(today.slice(5, 7)) - 1;
    if (viewYear > maxYear || (viewYear === maxYear && viewMonth > maxMonth)) {
      viewYear = maxYear; viewMonth = maxMonth;
    }
    monthSelect.value = String(viewMonth);
    yearSelect.value = String(viewYear);
    $('#calendar-prev').disabled = viewYear === 2010 && viewMonth === 1;
    $('#calendar-next').disabled = viewYear === maxYear && viewMonth === maxMonth;
    const firstWeekday = (new Date(Date.UTC(viewYear, viewMonth, 1)).getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(viewYear, viewMonth + 1, 0)).getUTCDate();
    const cells = Array.from({ length: firstWeekday }, () => '<span class="calendar-empty"></span>');
    for (let day = 1; day <= days; day += 1) {
      const date = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const endpoint = date === startDate || date === endDate;
      const inRange = startDate && endDate && date > startDate && date < endDate;
      cells.push(`<button type="button" class="calendar-day${endpoint ? ' endpoint' : ''}${inRange ? ' in-range' : ''}" data-date="${date}" aria-label="${formatDate(date)}${date === startDate ? ', inicio' : date === endDate ? ', fin' : ''}" aria-pressed="${Boolean(endpoint)}" ${date < MIN_DATE || date > today ? 'disabled' : ''}>${day}</button>`);
    }
    grid.innerHTML = cells.join('');
    updateLabels();
  }

  function closeCalendar() {
    calendar.hidden = true;
    rangeToggle.setAttribute('aria-expanded', 'false');
  }

  function selectDate(date) {
    if (edit === 'start' || !startDate) {
      startDate = date;
      if (endDate && endDate < startDate) endDate = '';
      edit = 'end';
    } else if (date < startDate) {
      startDate = date;
      endDate = '';
    } else {
      endDate = date;
      closeCalendar();
    }
    renderCalendar();
  }

  function renderMatches() {
    const sorted = [...matches.values()].sort((a, b) =>
      b.date.localeCompare(a.date) || a.cve.localeCompare(b.cve, 'es', { numeric: true }));
    results.innerHTML = sorted.length ? sorted.slice(0, shown).map(historicalCard).join('')
      : '<div class="empty">Todavía no hay coincidencias.</div>';
    moreButton.hidden = sorted.length <= shown;
  }

  function updateProgress(dayNumber, totalDays, bulletins, scanned, failedDays, failedAds) {
    status.textContent = `Analizando día ${dayNumber} de ${totalDays} · ${bulletins} boletines localizados · ${scanned} anuncios revisados · ${matches.size} coincidencias${failedDays || failedAds ? ` · ${failedDays} días y ${failedAds} anuncios pendientes` : ''}.`;
  }

  async function run() {
    const query = queryInput.value.trim();
    const municipality = municipalityInput.value.trim();
    const relevanceFilter = relevanceToggle.checked;
    if (query.length < 2) { status.textContent = 'Introduce al menos dos caracteres.'; queryInput.focus(); return; }
    if (!startDate || !endDate) { status.textContent = 'Selecciona la fecha de inicio y la fecha final.'; rangeToggle.focus(); return; }
    const totalDays = Math.round((utcDay(endDate) - utcDay(startDate)) / DAY_MS) + 1;
    if (totalDays < 1) { status.textContent = 'La fecha final debe ser igual o posterior a la inicial.'; return; }
    if (totalDays > 366) { status.textContent = 'El intervalo máximo por consulta es de 366 días.'; return; }

    controller = new AbortController();
    const signal = controller.signal;
    matches.clear();
    issues.hidden = true;
    issues.open = false;
    issuesList.replaceChildren();
    shown = 50;
    renderMatches();
    searchButton.disabled = true;
    relevanceToggle.disabled = true;
    cancelButton.hidden = false;
    closeCalendar();
    let bulletins = 0;
    let scanned = 0;
    const failedDays = new Map();
    const failedAds = new Map();
    const completed = new Set();
    let processedDays = 0;

    try {
      for (let offset = 0; offset < totalDays; offset += 1) {
        if (signal.aborted) break;
        const date = isoDay(utcDay(startDate) + offset * DAY_MS);
        updateProgress(offset + 1, totalDays, bulletins, scanned, failedDays.size, failedAds.size);
        let manifest;
        try {
          manifest = await retryRequest(new URLSearchParams({ mode: 'manifest', date }), signal);
        } catch (error) {
          if (signal.aborted) break;
          failedDays.set(date, error.message || 'No se pudo comprobar el boletín.');
          processedDays += 1;
          continue;
        }
        if (manifest.found) {
          bulletins += 1;
          if (!Array.isArray(manifest.cves) || !manifest.cves.length) failedDays.set(date, 'El sumario no contiene anuncios.');
          const all = [...new Set(manifest.cves || [])];
          for (let index = 0; index < all.length; index += 12) {
            if (signal.aborted) break;
            const batch = all.slice(index, index + 12);
            const runBatch = async cves => retryRequest(new URLSearchParams({
              mode: 'batch', date, q: query, municipality, filter: relevanceFilter ? '1' : '0', cves: cves.join(',')
            }), signal);
            let data;
            try { data = await runBatch(batch); }
            catch (error) {
              if (signal.aborted) break;
              if (error.code === 'AI_UNAVAILABLE') throw error;
              batch.forEach(cve => failedAds.set(cve, { date, reason: 'error' }));
              continue;
            }
            let pending = (data.failedCves || []).filter(cve => batch.includes(cve));
            let pendingDetails = data.failedDetails || [];
            for (const cve of batch.filter(cve => !pending.includes(cve))) completed.add(cve);
            for (const item of data.results || []) matches.set(`${date}|${item.cve}`, item);
            if (pending.length && !signal.aborted) {
              try {
                data = await runBatch(pending);
                const retryPending = (data.failedCves || []).filter(cve => pending.includes(cve));
                pendingDetails = data.failedDetails || [];
                for (const cve of pending.filter(cve => !retryPending.includes(cve))) completed.add(cve);
                pending = retryPending;
                for (const item of data.results || []) matches.set(`${date}|${item.cve}`, item);
              } catch (error) {
                if (signal.aborted) break;
                if (error.code === 'AI_UNAVAILABLE') throw error;
              }
              pending.forEach(cve => failedAds.set(cve, {
                date, reason: pendingDetails.find(detail => detail.cve === cve)?.reason || 'error'
              }));
            }
            scanned = completed.size;
            updateProgress(offset + 1, totalDays, bulletins, scanned, failedDays.size, failedAds.size);
            renderMatches();
          }
        }
        processedDays += 1;
      }
      if (signal.aborted) {
        status.textContent = `Búsqueda detenida tras ${processedDays} de ${totalDays} días. ${matches.size} coincidencias conservadas.`;
      } else {
        const missing = [...failedAds.values()].filter(item => item.reason === 'not_found').length;
        const other = failedAds.size - missing;
        status.textContent = `${processedDays} días · ${bulletins} boletines · ${scanned} anuncios revisados · ${matches.size} coincidencias${failedDays.size || failedAds.size ? `. Consulta parcial: ${failedDays.size} días no comprobados y ${failedAds.size} anuncios pendientes (${missing} XML no encontrados, ${other} errores de acceso).` : '.'}`;
      }
      if (failedDays.size || failedAds.size) {
        issues.hidden = false;
        issues.querySelector('summary').textContent = `Ver incidencias: ${failedDays.size} días y ${failedAds.size} anuncios`;
        issuesList.innerHTML = [
          ...[...failedDays].map(([date, reason]) => `<li>Día ${escapeHtml(formatDate(date))}: ${escapeHtml(reason)}</li>`),
          ...[...failedAds].map(([cve, item]) => `<li>${escapeHtml(formatDate(item.date))} · ${escapeHtml(cve)}: ${item.reason === 'not_found' ? 'XML no encontrado (404/410)' : 'Error de acceso o respuesta no válida'}</li>`)
        ].join('');
      }
      if (!matches.size) results.innerHTML = relevanceFilter
        ? '<div class="empty">No se han encontrado publicaciones de interés entre las coincidencias comprobadas.</div>'
        : '<div class="empty">No se han encontrado coincidencias en los anuncios comprobados.</div>';
    } finally {
      controller = null;
      cancelButton.hidden = true;
      searchButton.disabled = false;
      relevanceToggle.disabled = false;
    }
  }

  dailyTab.addEventListener('click', () => switchTab(false));
  historicalTab.addEventListener('click', () => switchTab(true));
  rangeToggle.addEventListener('click', () => {
    if (!calendar.hidden) { closeCalendar(); return; }
    edit = !startDate ? 'start' : !endDate ? 'end' : 'start';
    viewYear = Number((edit === 'end' ? startDate : startDate || today).slice(0, 4));
    viewMonth = Number((edit === 'end' ? startDate : startDate || today).slice(5, 7)) - 1;
    calendar.hidden = false;
    rangeToggle.setAttribute('aria-expanded', 'true');
    renderCalendar();
    monthSelect.focus();
  });
  grid.addEventListener('click', event => {
    const button = event.target.closest('button[data-date]');
    if (button && !button.disabled) selectDate(button.dataset.date);
  });
  $('#calendar-prev').addEventListener('click', () => {
    viewMonth -= 1;
    if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
    renderCalendar();
  });
  $('#calendar-next').addEventListener('click', () => {
    viewMonth += 1;
    if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
    renderCalendar();
  });
  monthSelect.addEventListener('change', () => { viewMonth = Number(monthSelect.value); renderCalendar(); });
  yearSelect.addEventListener('change', () => { viewYear = Number(yearSelect.value); renderCalendar(); });
  $('#calendar-edit-start').addEventListener('click', () => { edit = 'start'; renderCalendar(); });
  $('#calendar-edit-end').addEventListener('click', () => { edit = 'end'; renderCalendar(); });
  $('#calendar-close').addEventListener('click', closeCalendar);
  document.addEventListener('click', event => {
    if (!calendar.hidden && !calendar.contains(event.target) && !rangeToggle.contains(event.target)) closeCalendar();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeCalendar(); });
  searchButton.addEventListener('click', () => run().catch(error => {
    status.textContent = `La búsqueda se interrumpió: ${error.message}. Se conservan ${matches.size} coincidencias.`;
  }));
  cancelButton.addEventListener('click', () => controller?.abort());
  moreButton.addEventListener('click', () => { shown += 50; renderMatches(); });
  queryInput.addEventListener('keydown', event => { if (event.key === 'Enter') searchButton.click(); });
  municipalityInput.addEventListener('keydown', event => { if (event.key === 'Enter') searchButton.click(); });
}
