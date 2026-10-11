fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' }).then(response => {
  if (!response.ok) { location.assign('/login.html?next=%2Fdashboard.html'); return null; }
  return response.json();
}).then(data => {
  if (!data) return;
  const user = data.user;
  const initials = user.full_name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'JG';
  document.querySelector('#dashboard-org-name').textContent = user.organization_name;
  document.querySelector('#sidebar-org-name').textContent = user.organization_name;
  document.querySelector('#dashboard-user-name').textContent = user.full_name;
  document.querySelector('#sidebar-avatar').textContent = initials;
  document.querySelector('#dashboard-avatar').textContent = initials;
  document.querySelector('.user-profile small').textContent = user.email;
}).catch(() => location.assign('/login.html?next=%2Fdashboard.html'));

document.querySelector('#dashboard-logout').addEventListener('click', async () => {
  try { await postApi('/api/auth/logout', {}); location.assign('/'); }
  catch (error) { notify(error.message); }
});

const toast = document.querySelector('#toast');
let toastTimer;
function notify(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

const search = document.querySelector('#worker-search');
const filter = document.querySelector('#risk-filter');
const siteFilter = document.querySelector('#site-filter');
const tableBody = document.querySelector('#worker-table');
const dialog = document.querySelector('#worker-dialog');
const workerForm = document.querySelector('#worker-form');
const csvPreview = document.querySelector('#csv-preview');
let workers = [];
let sites = [];
let editingWorkerId = null;
let importRows = [];
const breakDialog = document.querySelector('#break-dialog');
const breakForm = document.querySelector('#break-form');
const breakList = document.querySelector('#break-list');

async function workerRequest(url, method = 'GET', values) {
  const options = { method, credentials: 'same-origin', cache: 'no-store', headers: {} };
  if (method !== 'GET') {
    options.headers['Content-Type'] = 'application/json';
    try { options.headers['X-CSRF-Token'] = await getCsrfToken(); }
    catch { throw new Error('Could not start a secure request. Reload the dashboard; if the error continues, restart python server.py.'); }
    if (values) options.body = JSON.stringify(values);
  }
  let response;
  try { response = await fetch(url, options); }
  catch { throw new Error('Cannot reach the JibonGuard server. Start it with `python server.py` and open the dashboard at http://127.0.0.1:8000.'); }
  let data = {};
  try { data = await response.json(); } catch { data = { error: `The server returned an unreadable response (${response.status}). Restart it with ` + '`python server.py`' + ' and reload the page.' }; }
  if (response.status === 401) { location.assign('/login.html?next=%2Fdashboard.html'); throw new Error('Please sign in again.'); }
  if (!response.ok) throw new Error(data.error || 'Worker request failed.');
  return data;
}
function textCell(text, className = '') {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}
function initials(name) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'JG'; }
function safeSiteValue(site) { return site.trim().toLowerCase(); }
function renderWorkers() {
  tableBody.replaceChildren();
  workers.forEach(worker => {
    const row = document.createElement('tr');
    row.dataset.risk = worker.risk_level || 'Unassessed';
    row.dataset.site = safeSiteValue(worker.site);
    row.dataset.siteId = worker.site_id || '';
    const personCell = document.createElement('td');
    const person = document.createElement('span'); person.className = 'table-person';
    const avatar = document.createElement('i'); avatar.className = 'person-avatar avatar-green'; avatar.textContent = initials(worker.name);
    const identity = document.createElement('strong'); identity.textContent = worker.name;
    const id = document.createElement('small'); id.textContent = `JG-${worker.id.slice(0, 7).toUpperCase()}`; identity.append(id);
    person.append(avatar, identity); personCell.append(person); row.append(personCell);
    const siteRole = document.createElement('td'); siteRole.append(document.createTextNode(worker.site));
    const role = document.createElement('small'); role.textContent = `${worker.job_type} \u00b7 ${worker.workload}`; siteRole.append(role); row.append(siteRole);
    const riskCell = document.createElement('td'); const risk = document.createElement('span'); risk.className = 'status-pill moderate-pill';
    const riskDot = document.createElement('i'); risk.append(riskDot, document.createTextNode('Not assessed')); riskCell.append(risk); row.append(riskCell);
    row.append(textCell('\u2014'), textCell('\u2014'));
    const consentCell = document.createElement('td'); const consent = document.createElement('span'); consent.className = worker.consent_at ? 'consent-yes' : 'consent-pending'; consent.textContent = worker.consent_at ? '\u25cf Consented' : worker.consent_status === 'withdrawn' ? '\u25cf Withdrawn' : '\u25cf Pending'; consentCell.append(consent); row.append(consentCell);
    const actions = document.createElement('td'); actions.className = 'row-actions';
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'row-action'; edit.textContent = 'Edit'; edit.setAttribute('aria-label', `Edit ${worker.name}`); edit.addEventListener('click', () => openWorkerDialog(worker));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'row-action row-delete'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove ${worker.name}`);
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Remove ${worker.name} from your worker list? This cannot be undone.`)) return;
      try { await workerRequest(`/api/workers?id=${encodeURIComponent(worker.id)}`, 'DELETE'); workers = workers.filter(item => item.id !== worker.id); renderWorkers(); notify('Worker removed.'); }
      catch (error) { notify(error.message); }
    });
    const consentAction = document.createElement('button'); consentAction.type = 'button'; consentAction.className = 'row-action'; consentAction.textContent = worker.consent_at ? 'Withdraw' : worker.consent_status === 'withdrawn' ? 'Re-record' : 'Consent'; consentAction.addEventListener('click', () => worker.consent_at ? withdrawConsent(worker) : openConsentDialog(worker));
    actions.append(consentAction, edit, remove); row.append(actions); tableBody.append(row);
  });
  filterWorkers();
  document.querySelector('#worker-nav-count').textContent = workers.length;
  document.querySelector('#worker-total').textContent = `${workers.length} total`;
  updateWorkerSummary();
}
function updateWorkerSummary() {
  const count = workers.length;
  const consented = workers.filter(worker => Boolean(worker.consent_at)).length;
  const withdrawn = workers.filter(worker => !worker.consent_at && worker.consent_status === 'withdrawn').length;
  const pendingConsent = count - consented - withdrawn;
  document.querySelector('#metric-present').textContent = count;
  document.querySelector('#metric-consented').textContent = consented;
  document.querySelector('#metric-consent-pending').textContent = pendingConsent;
  document.querySelector('#overview-consented-count').textContent = consented;
  document.querySelector('#overview-pending-count').textContent = pendingConsent;
  const list = document.querySelector('#overview-worker-status-list');
  list.replaceChildren();
  if (!count) {
    const empty = document.createElement('p');
    empty.className = 'dashboard-empty-state';
    empty.textContent = 'No workers yet. Add a worker to see their consent status here.';
    list.append(empty);
    return;
  }
  workers.slice(0, 6).forEach(worker => {
    const item = document.createElement('div'); item.className = 'overview-worker-row';
    const name = document.createElement('strong'); name.textContent = worker.name;
    const status = document.createElement('span');
    status.className = worker.consent_at ? 'consent-yes' : worker.consent_status === 'withdrawn' ? 'consent-withdrawn' : 'consent-pending';
    status.textContent = worker.consent_at ? 'Consented' : worker.consent_status === 'withdrawn' ? 'Withdrawn' : 'Pending consent';
    item.append(name, status); list.append(item);
  });
}
function refreshSiteOptions() {
  const current = siteFilter.value;
  siteFilter.replaceChildren(new Option(`All sites · ${sites.length}`, 'all'));
  sites.forEach(site => siteFilter.add(new Option(site.name, site.id)));
  siteFilter.value = sites.some(site => site.id === current) ? current : 'all';
  [workerForm.elements.site_id, breakForm.elements.site_id].forEach(select => {
    const selected = select.value;
    select.replaceChildren(new Option(sites.length ? 'Choose a saved site' : 'Create a site first', ''));
    sites.forEach(site => select.add(new Option(site.name, site.id)));
    select.value = sites.some(site => site.id === selected) ? selected : '';
    select.disabled = !sites.length;
  });
}
function filterWorkers() {
  let visible = 0;
  const term = search.value.trim().toLowerCase();
  [...tableBody.rows].forEach(row => {
    const matchesTerm = row.textContent.toLowerCase().includes(term);
    const matchesRisk = filter.value === 'all' || row.dataset.risk === filter.value;
    const matchesSite = siteFilter.value === 'all' || row.dataset.siteId === siteFilter.value;
    row.hidden = !(matchesTerm && matchesRisk && matchesSite);
    if (!row.hidden) visible++;
  });
  document.querySelector('#rows-count').textContent = visible;
}
search.addEventListener('input', filterWorkers);
filter.addEventListener('change', filterWorkers);
siteFilter.addEventListener('change', filterWorkers);
siteFilter.addEventListener('change', renderSelectedWeather);

function openWorkerDialog(worker = null) {
  editingWorkerId = worker?.id || null;
  workerForm.reset();
  csvPreview.hidden = true; csvPreview.replaceChildren();
  document.querySelector('#worker-dialog-title').textContent = worker ? 'Edit worker' : 'Add a worker';
  document.querySelector('#worker-dialog-copy').textContent = worker ? 'Update this worker\u2019s contact and work details.' : 'Create a worker record. Alerts stay off until the worker gives consent.';
  document.querySelector('#save-worker').textContent = worker ? 'Save changes' : 'Add worker';
  if (worker) Object.entries(worker).forEach(([key, value]) => { if (workerForm.elements[key]) workerForm.elements[key].value = value; });
  const message = document.querySelector('#worker-form-message');
  message.hidden = true;
  message.textContent = '';
  dialog.hidden = false;
  workerForm.elements.name.focus();
}
function closeWorkerDialog() { dialog.hidden = true; editingWorkerId = null; importRows = []; }
document.querySelector('#add-worker-button-secondary').addEventListener('click', () => openWorkerDialog());
dialog.querySelector('.dialog-close').addEventListener('click', closeWorkerDialog);
document.querySelector('#cancel-worker').addEventListener('click', closeWorkerDialog);
dialog.addEventListener('click', event => { if (event.target === dialog) closeWorkerDialog(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !dialog.hidden) closeWorkerDialog(); });
workerForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.querySelector('#save-worker'); button.disabled = true;
  const message = document.querySelector('#worker-form-message');
  message.hidden = true; message.textContent = '';
  const values = Object.fromEntries(new FormData(workerForm));
  try {
    const data = editingWorkerId
      ? await workerRequest(`/api/workers?id=${encodeURIComponent(editingWorkerId)}`, 'PUT', values)
      : await workerRequest('/api/workers', 'POST', values);
    if (editingWorkerId) workers = workers.map(worker => worker.id === editingWorkerId ? data.worker : worker);
    else workers.push(data.worker);
    const wasEditing = Boolean(editingWorkerId);
    renderWorkers(); closeWorkerDialog(); notify(wasEditing ? 'Worker details updated.' : 'Worker added. Consent is still pending.');
  } catch (error) { message.textContent = error.message; message.hidden = false; }
  finally { button.disabled = false; }
});

document.querySelector('#template-button').addEventListener('click', () => {
  const csv = 'name,phone,site,job_type,workload\nRahim Uddin,+8801712345678,Gulshan Heights,Construction,Heavy';
  const link = document.createElement('a'); const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.href = url; link.download = 'jibonguard-worker-template.csv'; link.click(); URL.revokeObjectURL(url);
});
function parseCsv(source) {
  const records = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) { if (char === '"' && source[i + 1] === '"') { field += '"'; i++; } else if (char === '"') quoted = false; else field += char; }
    else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field.trim()); field = ''; }
    else if (char === '\n' || char === '\r') { if (char === '\r' && source[i + 1] === '\n') i++; row.push(field.trim()); if (row.some(value => value)) records.push(row); row = []; field = ''; }
    else field += char;
  }
  if (quoted) throw new Error('The CSV has an unclosed quote.');
  if (field || row.length) { row.push(field.trim()); if (row.some(value => value)) records.push(row); }
  if (records.length < 2) throw new Error('The CSV needs a header and at least one worker row.');
  const headers = records.shift().map(value => value.replace(/^\uFEFF/, '').toLowerCase());
  const required = ['name', 'phone', 'site', 'job_type'];
  if (required.some(key => !headers.includes(key))) throw new Error('CSV header must include name, phone, site, job_type.');
  return records.map(record => Object.fromEntries(headers.map((header, index) => [header, record[index] || ''])))
    .map(worker => ({ ...worker, workload: worker.workload || 'Standard' }));
}
document.querySelector('#csv-upload').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file) return;
  try {
    importRows = parseCsv(await file.text());
    if (importRows.length > 500) throw new Error('Import up to 500 workers at a time.');
    csvPreview.replaceChildren();
    const text = document.createElement('p'); text.textContent = `Ready to import ${importRows.length} worker${importRows.length === 1 ? '' : 's'}.`; csvPreview.append(text);
    const confirm = document.createElement('button'); confirm.className = 'solid-button'; confirm.type = 'button'; confirm.textContent = 'Confirm import';
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      try { const result = await workerRequest('/api/workers/import', 'POST', { workers: importRows }); await loadWorkers(); csvPreview.hidden = true; notify(`${result.imported} worker${result.imported === 1 ? '' : 's'} imported. Consent is pending.`); }
      catch (error) { notify(error.message); confirm.disabled = false; }
    });
    csvPreview.append(confirm); csvPreview.hidden = false;
  } catch (error) { notify(error.message); }
});
const siteForm = document.querySelector('#site-form');
const weatherList = document.querySelector('#site-weather-list');
const weatherBySite = new Map();
let siteMap = null;
let selectedMapCoords = null;
let geocodeTimer = null;
function createOsmMap(container, onSelect) {
  let latitude = 23.8103, longitude = 90.4125, zoom = 12, marker = null;
  const mapContent = document.createElement('div'); mapContent.className = 'osm-map-content';
  const tiles = document.createElement('div'); tiles.className = 'osm-tiles';
  const pin = document.createElement('div'); pin.className = 'osm-map-pin'; pin.hidden = true; pin.setAttribute('aria-hidden', 'true');
  mapContent.append(tiles, pin);
  const controls = document.createElement('div'); controls.className = 'osm-map-controls';
  const zoomIn = document.createElement('button'); zoomIn.type = 'button'; zoomIn.className = 'site-map-control'; zoomIn.textContent = '+'; zoomIn.setAttribute('aria-label', 'Zoom in');
  const zoomOut = document.createElement('button'); zoomOut.type = 'button'; zoomOut.className = 'site-map-control'; zoomOut.textContent = '−'; zoomOut.setAttribute('aria-label', 'Zoom out');
  controls.append(zoomIn, zoomOut);
  const credit = document.createElement('div'); credit.className = 'osm-map-credit'; credit.innerHTML = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>';
  const tileStatus = document.createElement('span'); tileStatus.className = 'osm-map-status'; tileStatus.textContent = 'Loading OpenStreetMap…';
  container.replaceChildren(mapContent, controls, credit, tileStatus);
  function project(lat, lon, scale) {
    const safeLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const sin = Math.sin(safeLat * Math.PI / 180);
    return { x: (lon + 180) / 360 * scale, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale };
  }
  function unproject(x, y, scale) {
    const lon = x / scale * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / scale))) * 180 / Math.PI;
    return { latitude: lat, longitude: ((lon + 540) % 360) - 180 };
  }
  function draw() {
    const width = container.clientWidth, height = container.clientHeight;
    if (!width || !height) { requestAnimationFrame(draw); return; }
    const scale = 256 * 2 ** zoom, center = project(latitude, longitude, scale);
    const left = center.x - width / 2, top = center.y - height / 2;
    const minX = Math.floor(left / 256), maxX = Math.floor((left + width) / 256);
    const minY = Math.max(0, Math.floor(top / 256)), maxY = Math.min(2 ** zoom - 1, Math.floor((top + height) / 256));
    tiles.replaceChildren();
    let pending = 0, loaded = 0;
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      const image = document.createElement('img'); image.alt = ''; image.draggable = false;
      const tileX = ((x % 2 ** zoom) + 2 ** zoom) % 2 ** zoom;
      image.src = `https://tile.openstreetmap.org/${zoom}/${tileX}/${y}.png`;
      image.style.left = `${x * 256 - left}px`; image.style.top = `${y * 256 - top}px`;
      pending++; image.addEventListener('load', () => { loaded++; tileStatus.textContent = 'Click or tap the map to select a location.'; });
      image.addEventListener('error', () => { pending--; if (!loaded && pending === 0) tileStatus.textContent = 'Map tiles unavailable. You can still enter coordinates manually.'; });
      tiles.append(image);
    }
    if (marker) {
      const point = project(marker.latitude, marker.longitude, scale);
      pin.style.left = `${point.x - left}px`; pin.style.top = `${point.y - top}px`; pin.hidden = false;
    }
  }
  const mapPoint = event => {
    const rect = container.getBoundingClientRect(), scale = 256 * 2 ** zoom;
    const center = project(latitude, longitude, scale);
    return unproject(center.x - rect.width / 2 + event.clientX - rect.left, center.y - rect.height / 2 + event.clientY - rect.top, scale);
  };
  let pointerStart = null;
  container.addEventListener('pointerdown', event => {
    if (event.target.closest('button,a')) return;
    pointerStart = { x: event.clientX, y: event.clientY, latitude, longitude, moved: false };
    container.setPointerCapture(event.pointerId);
  });
  container.addEventListener('pointermove', event => {
    if (!pointerStart) return;
    const dx = event.clientX - pointerStart.x, dy = event.clientY - pointerStart.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) pointerStart.moved = true;
    if (pointerStart.moved) {
      mapContent.style.transform = `translate(${dx}px,${dy}px)`;
    }
  });
  container.addEventListener('pointerup', event => {
    if (!pointerStart) return;
    if (!pointerStart.moved) { const point = mapPoint(event); onSelect(point.latitude, point.longitude); }
    else {
      const scale = 256 * 2 ** zoom, start = project(pointerStart.latitude, pointerStart.longitude, scale);
      const next = unproject(start.x - (event.clientX - pointerStart.x), start.y - (event.clientY - pointerStart.y), scale);
      latitude = next.latitude; longitude = next.longitude; mapContent.style.transform = ''; draw();
    }
    pointerStart = null;
  });
  container.addEventListener('pointercancel', () => { pointerStart = null; });
  zoomIn.addEventListener('click', () => { zoom = Math.min(19, zoom + 1); draw(); });
  zoomOut.addEventListener('click', () => { zoom = Math.max(3, zoom - 1); draw(); });
  container.addEventListener('wheel', event => { event.preventDefault(); zoom = Math.max(3, Math.min(19, zoom + (event.deltaY < 0 ? 1 : -1))); draw(); }, { passive: false });
  window.addEventListener('resize', draw);
  draw();
  return {
    setView(point, level = zoom) { latitude = Number(point[0]); longitude = Number(point[1]); zoom = Math.max(3, Math.min(19, Number(level))); draw(); },
    setMarker(lat, lon) { marker = lat == null || lon == null ? null : { latitude: Number(lat), longitude: Number(lon) }; draw(); },
    invalidateSize: draw
  };
}
siteMap = createOsmMap(document.querySelector('#site-map'), (lat, lon) => setSiteMapPoint(lat, lon, true));
document.querySelector('#map-location-status').textContent = 'Click or tap the map to choose a point.';
const siteLocationQuery = document.querySelector('#site-location-query');
const siteLocationSearchButton = document.querySelector('#site-location-search-button');
const siteLocationResults = document.querySelector('#site-location-results');
let siteLocationSearchTimer = null;
let siteLocationSearchSequence = 0;
async function searchSiteLocations(query = siteLocationQuery.value.trim()) {
  const requestSequence = ++siteLocationSearchSequence;
  if (query.length < 3) {
    siteLocationResults.hidden = false;
    siteLocationResults.textContent = 'Enter at least 3 characters to search.';
    siteLocationQuery.focus();
    return;
  }
  siteLocationSearchButton.disabled = true;
  siteLocationResults.hidden = false;
  siteLocationResults.textContent = 'Searching OpenStreetMap…';
  try {
    const data = await workerRequest(`/api/geocode/search?q=${encodeURIComponent(query)}`);
    if (requestSequence !== siteLocationSearchSequence || query !== siteLocationQuery.value.trim()) return;
    siteLocationResults.replaceChildren();
    if (!data.results?.length) {
      siteLocationResults.textContent = 'No matching places found. Try a nearby area or a more specific address.';
      return;
    }
    data.results.forEach(place => {
      const result = document.createElement('button');
      result.type = 'button';
      result.className = 'site-location-result';
      result.textContent = place.display_name;
      result.addEventListener('click', () => {
        const latitude = Number(place.latitude), longitude = Number(place.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
        siteMap.setView([latitude, longitude], 16);
        setSiteMapPoint(latitude, longitude, false);
        siteForm.elements.address.value = String(place.display_name || '').slice(0, 240);
        setSiteNameFromPlace(place);
        document.querySelector('#map-location-status').textContent = `Selected place: ${place.display_name}`;
        siteLocationResults.hidden = true;
      });
      siteLocationResults.append(result);
    });
  } catch (error) {
    if (requestSequence === siteLocationSearchSequence && query === siteLocationQuery.value.trim()) siteLocationResults.textContent = error.message;
  } finally {
    if (requestSequence === siteLocationSearchSequence) siteLocationSearchButton.disabled = false;
  }
}
siteLocationSearchButton.addEventListener('click', () => { clearTimeout(siteLocationSearchTimer); searchSiteLocations(); });
siteLocationQuery.addEventListener('input', () => {
  clearTimeout(siteLocationSearchTimer);
  siteLocationSearchSequence++;
  const query = siteLocationQuery.value.trim();
  if (query.length < 3) {
    siteLocationResults.hidden = true;
    siteLocationResults.replaceChildren();
    siteLocationSearchButton.disabled = false;
    return;
  }
  siteLocationResults.hidden = false;
  siteLocationResults.textContent = 'Searching suggested locations…';
  siteLocationSearchTimer = setTimeout(() => searchSiteLocations(query), 650);
});
siteLocationQuery.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); clearTimeout(siteLocationSearchTimer); searchSiteLocations(); }
});
function setSiteMapPoint(latitude, longitude, lookup) {
  if (!siteMap) return;
  selectedMapCoords = { latitude: Number(latitude), longitude: Number(longitude) };
  siteForm.elements.latitude.value = selectedMapCoords.latitude.toFixed(6);
  siteForm.elements.longitude.value = selectedMapCoords.longitude.toFixed(6);
  const point = [selectedMapCoords.latitude, selectedMapCoords.longitude];
  siteMap.setMarker(point[0], point[1]);
  document.querySelector('#map-location-status').textContent = lookup ? `Selected ${point[0].toFixed(6)}, ${point[1].toFixed(6)}. Looking up nearby place…` : `Selected ${point[0].toFixed(6)}, ${point[1].toFixed(6)}.`;
  clearTimeout(geocodeTimer);
  if (lookup) geocodeTimer = setTimeout(() => lookupSitePlace(), 1200);
}
function setSiteNameFromPlace(place) {
  // Browser profile autofill can populate this field with the account owner's name.
  // For a new site, the selected place should supply its title; keep saved names during edits.
  if (siteForm.elements.id.value) return;
  const title = String(place?.name || place?.display_name || '').split(',')[0].trim();
  if (title) siteForm.elements.name.value = title.slice(0, 120);
}
async function lookupSitePlace() {
  if (!selectedMapCoords) { document.querySelector('#map-location-status').textContent = 'Click the map to choose a point first.'; return; }
  clearTimeout(geocodeTimer);
  const status = document.querySelector('#map-location-status');
  status.textContent = 'Looking up nearby place…';
  const { latitude, longitude } = selectedMapCoords;
  try {
    const place = await workerRequest(`/api/geocode/reverse?lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}`);
    if (!selectedMapCoords || selectedMapCoords.latitude !== latitude || selectedMapCoords.longitude !== longitude) return;
    siteForm.elements.address.value = place.display_name.slice(0, 240);
    setSiteNameFromPlace(place);
    status.textContent = `Place found: ${place.display_name}`;
  } catch (error) { if (selectedMapCoords?.latitude === latitude && selectedMapCoords?.longitude === longitude) status.textContent = error.message; }
}
function syncTypedCoordinates() {
  const latitude = Number(siteForm.elements.latitude.value);
  const longitude = Number(siteForm.elements.longitude.value);
  if (siteForm.elements.latitude.value && siteForm.elements.longitude.value && Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
    setSiteMapPoint(latitude, longitude, false);
    siteMap?.setView([latitude, longitude], 16);
  }
}
siteForm.elements.latitude.addEventListener('change', syncTypedCoordinates);
siteForm.elements.longitude.addEventListener('change', syncTypedCoordinates);
function focusSiteOnMap(site) {
  if (!siteMap || site.latitude == null || site.longitude == null) return;
  setSiteMapPoint(site.latitude, site.longitude, false);
  siteMap.setView([Number(site.latitude), Number(site.longitude)], 16);
  requestAnimationFrame(() => siteMap.invalidateSize());
}
function weatherText(value, fallback = '—') { return value === undefined || value === null || value === '' ? fallback : String(value); }
function weatherCard(site, state) {
  const card = document.createElement('article'); card.className = 'site-weather-card';
  const header = document.createElement('div'); header.className = 'site-weather-heading';
  const title = document.createElement('div'); const name = document.createElement('h3'); name.textContent = site.name; title.append(name);
  const address = document.createElement('small'); address.textContent = site.address || `${site.latitude ?? 'Coordinates not set'}, ${site.longitude ?? ''}`; title.append(address);
  const actions = document.createElement('div'); actions.className = 'site-actions';
  const edit = document.createElement('button'); edit.type='button'; edit.className='row-action'; edit.textContent='Edit'; edit.addEventListener('click',()=>{siteForm.elements.id.value=site.id; siteForm.elements.name.value=site.name; siteForm.elements.address.value=site.address||''; siteForm.elements.latitude.value=site.latitude??''; siteForm.elements.longitude.value=site.longitude??''; document.querySelector('#save-site').textContent='Save site'; document.querySelector('#cancel-site-edit').hidden=false; focusSiteOnMap(site); siteForm.scrollIntoView({behavior:'smooth',block:'center'});});
  const remove = document.createElement('button'); remove.type='button'; remove.className='row-action row-delete'; remove.textContent='Delete'; remove.addEventListener('click',async()=>{if(!confirm(`Delete ${site.name}? Sites with assigned workers cannot be deleted.`))return;try{await workerRequest(`/api/sites?id=${encodeURIComponent(site.id)}`,'DELETE');sites=sites.filter(item=>item.id!==site.id);weatherBySite.delete(site.id);refreshSiteOptions();renderSites();updateWorkerSummary();}catch(error){notify(error.message);}});
  actions.append(edit,remove); header.append(title,actions); card.append(header);
  if(state?.error){const error=document.createElement('p');error.className='weather-error';error.textContent=state.error;card.append(error);return card;}
  if(!state?.weather){const loading=document.createElement('p');loading.className='weather-error';loading.textContent="Loading current conditions and today's two-hour weather...";card.append(loading);return card;}
  const weather=state.weather; const current=weather.current||{}; const nowRow=document.createElement('div');nowRow.className='site-current-weather';
  const temp=document.createElement('strong');temp.textContent=`${weatherText(current.temperature)}\u00b0C`;const summary=document.createElement('span');summary.textContent=weatherText(current.summary,current.icon||'Current conditions');nowRow.append(temp,summary);card.append(nowRow);
  const details=document.createElement('p');details.className='weather-detail-line';details.textContent=`Feels like ${weatherText(current.feels_like)}\u00b0C \u00b7 Humidity ${weatherText(current.humidity)}% \u00b7 Wind ${weatherText(current.wind?.speed)} m/s`;card.append(details);
  const hours=Array.isArray(weather.hourly?.data)?weather.hourly.data:[];
  const timeline=document.createElement('div');timeline.className='forecast-list weather-timeline';
  const heading=document.createElement('strong');heading.className='weather-timeline-heading';heading.textContent='Today \u00b7 every 2 hours';timeline.append(heading);
  hours.forEach(entry=>{const item=document.createElement('div');item.className='forecast-day';const time=document.createElement('strong');time.textContent=weatherText(entry.label);const status=document.createElement('span');status.textContent=weatherText(entry.summary);const detail=document.createElement('small');const rain=entry.precipitation_probability==null?'':` \u00b7 ${entry.precipitation_probability}% rain`;detail.textContent=`${weatherText(entry.temperature)}\u00b0C \u00b7 feels ${weatherText(entry.feels_like)}\u00b0C${rain}`;item.append(time,status,detail);timeline.append(item);});
  if(!hours.length){const empty=document.createElement('p');empty.className='weather-error';empty.textContent='No two-hour weather updates are available for today.';timeline.append(empty);}card.append(timeline);return card;
}
function renderSites(){weatherList.replaceChildren();if(!sites.length){const empty=document.createElement('p');empty.className='dashboard-empty-state';empty.textContent='No worksites yet. Add a site above before enrolling workers.';weatherList.append(empty);}sites.forEach(site=>weatherList.append(weatherCard(site,weatherBySite.get(site.id))));refreshSiteOptions();renderSelectedWeather();}
function renderSelectedWeather(){const banner=document.querySelector('#weather-banner');const selected=sites.find(site=>site.id===siteFilter.value);const site=selected||sites[0];banner.replaceChildren();const symbol=document.createElement('div');symbol.className='weather-symbol';symbol.textContent='☀';const details=document.createElement('div');const kicker=document.createElement('span');kicker.textContent=site?(selected?'CURRENT SITE WEATHER':`CURRENT WEATHER · ${site.name.toUpperCase()}`):'SITE WEATHER';const strong=document.createElement('strong');const paragraph=document.createElement('p');details.append(kicker,strong,paragraph);banner.append(symbol,details);if(!site){strong.textContent='Add a site to begin';paragraph.textContent='Create a site in the Sites panel and add its coordinates.';return;}const state=weatherBySite.get(site.id);if(state?.error){strong.textContent='Weather unavailable';paragraph.textContent=state.error;return;}if(!state?.weather){strong.textContent='Loading…';paragraph.textContent="Fetching current conditions and today's two-hour weather.";return;}const current=state.weather.current||{};strong.textContent=`${weatherText(current.temperature)}°C · ${weatherText(current.summary,current.icon||'Current conditions')}`;paragraph.textContent=`Feels like ${weatherText(current.feels_like)}°C · Humidity ${weatherText(current.humidity)}% · ${site.address||site.name}`;}
async function loadSites(){try{const data=await workerRequest('/api/sites');sites=data.sites;renderSites();for(let i=0;i<sites.length;i+=4){await Promise.all(sites.slice(i,i+4).map(async site=>{try{const data=await workerRequest(`/api/sites/${encodeURIComponent(site.id)}/weather`);weatherBySite.set(site.id,{weather:data.weather});}catch(error){weatherBySite.set(site.id,{error:error.message});}renderSites();}));}document.querySelector('#weather-sync-note').textContent=`Weather checked ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;}catch(error){notify(error.message);}}
function resetSiteForm(){siteForm.reset();siteForm.elements.id.value='';document.querySelector('#save-site').textContent='Add site';document.querySelector('#cancel-site-edit').hidden=true;document.querySelector('#site-form-message').textContent='';siteLocationResults.hidden=true;siteLocationResults.replaceChildren();clearTimeout(geocodeTimer);selectedMapCoords=null;siteMap.setMarker(null,null);document.querySelector('#map-location-status').textContent='Click or tap the map to choose a point.';}
document.querySelector('#cancel-site-edit').addEventListener('click',resetSiteForm);
siteForm.addEventListener('submit',async event=>{event.preventDefault();const button=document.querySelector('#save-site');button.disabled=true;const values=Object.fromEntries(new FormData(siteForm));const id=values.id;delete values.id;try{const data=await workerRequest(id?`/api/sites?id=${encodeURIComponent(id)}`:'/api/sites',id?'PUT':'POST',values);if(id)sites=sites.map(site=>site.id===id?data.site:site);else sites.push(data.site);resetSiteForm();renderSites();updateWorkerSummary();const site=data.site;try{const weather=await workerRequest(`/api/sites/${encodeURIComponent(site.id)}/weather`);weatherBySite.set(site.id,{weather:weather.weather});}catch(error){weatherBySite.set(site.id,{error:error.message});}renderSites();}catch(error){document.querySelector('#site-form-message').textContent=error.message;}finally{button.disabled=false;}});

async function loadWorkers() {
  try { const data = await workerRequest('/api/workers'); workers = data.workers; renderWorkers(); }
  catch (error) { notify(error.message); }
}
loadSites();
loadWorkers();

const consentDialog=document.querySelector('#consent-dialog');const consentForm=document.querySelector('#consent-form');
function openConsentDialog(worker){consentForm.reset();consentForm.elements.worker_id.value=worker.id;document.querySelector('#consent-form-message').textContent='';consentDialog.hidden=false;consentForm.elements.method.focus();}
function closeConsentDialog(){consentDialog.hidden=true;}
consentDialog.querySelector('.dialog-close').addEventListener('click',closeConsentDialog);document.querySelector('#cancel-consent').addEventListener('click',closeConsentDialog);consentDialog.addEventListener('click',event=>{if(event.target===consentDialog)closeConsentDialog();});
consentForm.addEventListener('submit',async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(consentForm));values.action='consented';values.worker_agreed=consentForm.elements.worker_agreed.checked;try{const data=await workerRequest('/api/workers/consent','POST',values);workers=workers.map(worker=>worker.id===data.worker.id?{...worker,...data.worker}:worker);renderWorkers();closeConsentDialog();notify('Worker consent recorded with an audit entry.');}catch(error){document.querySelector('#consent-form-message').textContent=error.message;}});
async function withdrawConsent(worker){if(!confirm(`Withdraw consent for ${worker.name}? Alerts and consent-based processing should stop.`))return;try{const data=await workerRequest('/api/workers/consent','POST',{worker_id:worker.id,action:'withdrawn',note:'Withdrawal recorded by organization admin.'});workers=workers.map(item=>item.id===data.worker.id?{...item,...data.worker}:item);renderWorkers();notify('Consent withdrawn and logged.');}catch(error){notify(error.message);}}

document.querySelectorAll('.call-worker').forEach(button => button.addEventListener('click', () => {
  notify(`Call action queued for ${button.dataset.worker}. Connect a voice gateway to place the call.`);
}));
function localDateTimeParts(date = new Date()) {
  const two = value => String(value).padStart(2, '0');
  return {
    date: `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`,
    time: `${two(date.getHours())}:${two(date.getMinutes())}`
  };
}
function openBreakDialog() {
  breakForm.reset();
  const current = localDateTimeParts();
  breakForm.elements.break_date.value = current.date;
  breakForm.elements.break_time.value = current.time;
  breakForm.elements.site_id.value = sites.some(site => site.id === workers[0]?.site_id) ? workers[0].site_id : sites[0]?.id || '';
  breakForm.elements.duration_minutes.value = '15';
  breakForm.elements.alert_type.value = 'break';
  breakForm.elements.title.readOnly = false;
  updateBreakSmsPreview();
  const message = document.querySelector('#break-form-message');
  message.hidden = true; message.textContent = '';
  breakDialog.hidden = false;
  breakForm.elements.title.focus();
}
function closeBreakDialog() { breakDialog.hidden = true; }
const breakAlertTitles = { break: 'Water and shade break', rain: 'Rain alert', storm: 'Storm alert', earthquake: 'Earthquake alert' };
function updateBreakSmsPreview() {
  const type = breakForm.elements.alert_type.value;
  const site = sites.find(item => item.id === breakForm.elements.site_id.value)?.name || '[site]';
  const title = breakForm.elements.title.value || 'break';
  const alertCopy = {
    rain: "Rain Alert: Rain is expected or has been detected in your area. Pause exposed outdoor work, move to a covered and safe location, and follow your site's safety instructions. Avoid slippery surfaces and waterlogged areas. Reassess the weather conditions after 30 minutes before resuming outdoor activities.",
    storm: 'Storm Alert: Severe weather may pose a risk to people working outdoors. Stop outdoor work immediately and move to your designated safe shelter, away from trees, electric poles, metal structures, and exposed areas. Follow official local weather warnings and emergency instructions. Check conditions again after 30 minutes, and resume work only when it is safe to do so.',
    earthquake: 'Earthquake Alert: If shaking starts, DROP to the ground, COVER your head and neck, and HOLD ON to sturdy shelter. Once shaking stops, check for injuries and hazards, stay away from damaged buildings, and follow official emergency instructions. Reassess your surroundings after 30 minutes, but do not resume work until it is safe.'
  };
  const body = type === 'break'
    ? `break reminder: ${title} at ${site} on ${breakForm.elements.break_date.value || '[date]'} ${breakForm.elements.break_time.value || '[time]'} (${breakForm.elements.duration_minutes.value || '15'} min).`
    : `${alertCopy[type] || alertCopy.rain} Worksite: ${site}.`;
  document.querySelector('#break-sms-preview').textContent = `SMS preview: Hi [worker name], ${body} - JibonGuard`;
}
breakForm.elements.alert_type.addEventListener('change', () => {
  const alertType = breakForm.elements.alert_type.value;
  breakForm.elements.title.value = breakAlertTitles[alertType] || breakAlertTitles.break;
  breakForm.elements.title.readOnly = alertType !== 'break';
  updateBreakSmsPreview();
});
for (const field of ['title', 'site_id', 'break_date', 'break_time', 'duration_minutes']) {
  breakForm.elements[field].addEventListener('input', updateBreakSmsPreview);
  breakForm.elements[field].addEventListener('change', updateBreakSmsPreview);
}
document.querySelector('#mark-break-button').addEventListener('click', openBreakDialog);
document.querySelector('#refresh-breaks-button').addEventListener('click', () => loadBreaks());
breakDialog.querySelector('.dialog-close').addEventListener('click', closeBreakDialog);
document.querySelector('#cancel-break').addEventListener('click', closeBreakDialog);
breakDialog.addEventListener('click', event => { if (event.target === breakDialog) closeBreakDialog(); });
breakForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.querySelector('#save-break');
  const message = document.querySelector('#break-form-message');
  button.disabled = true; message.hidden = true; message.textContent = '';
  const values = Object.fromEntries(new FormData(breakForm));
  const current = localDateTimeParts();
  values.status = `${values.break_date}T${values.break_time}` > `${current.date}T${current.time}` ? 'scheduled' : 'logged';
  try {
    const result = await workerRequest('/api/breaks', 'POST', values);
    closeBreakDialog();
    const action = values.status === 'scheduled' ? 'Break scheduled.' : 'Break logged.';
    const refreshed = await loadBreaks({ quiet: true });
    const listMessage = refreshed ? '' : ' The break was saved, but the list could not refresh; reload this page.';
    notify(`${action} ${result.sms?.message || ''}${listMessage}`.trim());
  } catch (error) { message.textContent = error.message; message.hidden = false; }
  finally { button.disabled = false; }
});
function renderBreaks(data) {
  if (!data || !Array.isArray(data.breaks)) throw new Error('The server returned an unreadable break history. Refresh to try again.');
  breakList.replaceChildren();
  const currentDate = localDateTimeParts().date;
  const total = Number.isFinite(Number(data.total)) ? Number(data.total) : data.breaks.length;
  const todayTotal = Number.isFinite(Number(data.date_total)) ? Number(data.date_total) : 0;
  document.querySelector('#break-date-label').textContent = `Break history \u00b7 ${total} total`;
  const breakCountMetric = document.querySelector('#metric-break-count');
  const breakNoteMetric = document.querySelector('#metric-break-note');
  if (breakCountMetric) breakCountMetric.textContent = todayTotal;
  if (breakNoteMetric) breakNoteMetric.textContent = todayTotal ? `${todayTotal} break log${todayTotal === 1 ? '' : 's'} today` : 'No breaks logged today';
  if (!data.breaks.length) {
    const empty = document.createElement('p'); empty.className = 'dashboard-empty-state'; empty.textContent = 'No break logs yet. Use "Log a break" to record or schedule one.'; breakList.append(empty); return;
  }
  const fragment = document.createDocumentFragment();
  data.breaks.forEach(record => {
    if (!record || typeof record !== 'object') return;
    const date = String(record.break_date || '');
    const row = document.createElement('div');
    const isScheduled = record.status === 'scheduled';
    row.className = `break-row ${isScheduled ? 'upcoming' : 'complete'}`;
    const time = document.createElement('span'); time.className = 'break-time'; time.textContent = date === currentDate ? String(record.break_time || '') : (date.length >= 10 ? date.slice(5) : date);
    const line = document.createElement('span'); line.className = 'break-line';
    const dot = document.createElement('span'); dot.className = 'break-dot'; dot.textContent = isScheduled ? '\u2022' : '\u2713';
    const description = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = String(record.title || 'Break');
    const origin = document.createElement('span'); origin.className = `break-origin-tag ${record.source === 'ai' ? 'ai-origin' : 'manual-origin'}`; origin.textContent = record.source === 'ai' ? 'AI scheduled' : 'Manual';
    if (record.ai_rationale) origin.title = String(record.ai_rationale);
    const details = document.createElement('small'); details.textContent = `${String(record.site || 'Worksite')} \u00b7 ${Number(record.worker_count) || 0} on roster \u00b7 ${Number(record.duration_minutes) || 0} min${record.ai_rationale ? ` \u00b7 ${String(record.ai_rationale)}` : ''}`;
    description.append(title, origin, details);
    const state = document.createElement('span'); state.className = isScheduled ? 'upcoming-state' : 'break-state'; state.textContent = isScheduled ? 'SCHEDULED' : 'LOGGED';
    row.append(time, line, dot, description, state); fragment.append(row);
  });
  if (!fragment.childNodes.length) {
    const empty = document.createElement('p'); empty.className = 'dashboard-empty-state'; empty.textContent = 'No readable break records were returned.'; fragment.append(empty);
  }
  breakList.append(fragment);
}
function showBreakLoadError(message) {
  breakList.replaceChildren();
  const panel = document.createElement('div'); panel.className = 'break-list-failure';
  const text = document.createElement('p'); text.textContent = `Break records could not be loaded: ${message}`;
  const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Try again'; retry.addEventListener('click', () => loadBreaks());
  panel.append(text, retry); breakList.append(panel);
}
async function loadBreaks({ quiet = false } = {}) {
  try {
    const date = localDateTimeParts().date;
    const data = await workerRequest(`/api/breaks?date=${encodeURIComponent(date)}`);
    renderBreaks(data);
    return true;
  } catch (error) {
    showBreakLoadError(error.message || 'Unexpected error.');
    if (!quiet) notify(`Could not load break logs: ${error.message}`);
    return false;
  }
}
loadBreaks();
document.querySelector('#export-button').addEventListener('click', () => {
  const header = ['Worker', 'Worker ID', 'Site', 'Role', 'Risk level', 'Time outdoors', 'Last break', 'Consent'];
  const content = [...tableBody.rows].filter(row => !row.hidden).map(row => {
    const cells = [...row.querySelectorAll('td')];
    const workerName = cells[0].innerText.split('\n')[0];
    const workerId = cells[0].innerText.split('\n')[1] || '';
    const [site, role] = cells[1].innerText.split('\n');
    return [workerName, workerId, site, role, cells[2].innerText, cells[3].innerText, cells[4].innerText, cells[5].innerText];
  });
  const csv = [header, ...content].map(line => line.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = 'jibonguard-worker-status.csv';
  link.click();
  URL.revokeObjectURL(link.href);
  notify('Filtered worker status exported as CSV.');
});

const bannerDismiss = document.querySelector('.banner-dismiss');
if (bannerDismiss) bannerDismiss.addEventListener('click', () => document.querySelector('.weather-banner').remove());
function setDashboardView(view, updateHash = true) {
  const allowed = ['overview', 'workers', 'breaks', 'sites'];
  if (!allowed.includes(view)) return false;
  document.body.dataset.dashboardView = view;
  if (view === 'breaks') loadBreaks({ quiet: true });
  document.querySelectorAll('.side-nav a').forEach(link => link.classList.toggle('active', link.getAttribute('href') === `#${view}`));
  const labels = { overview: 'Overview', workers: 'Workers', breaks: 'Break schedule', sites: 'Sites' };
  const breadcrumb = document.querySelector('.breadcrumb strong');
  if (breadcrumb) breadcrumb.textContent = labels[view];
  if (updateHash && location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  return true;
}
document.querySelectorAll('.side-nav a').forEach(link => link.addEventListener('click', event => {
  const view = link.getAttribute('href')?.slice(1);
  if (setDashboardView(view)) event.preventDefault();
  else { event.preventDefault(); notify(`${link.textContent.trim()} settings preview is part of the platform roadmap.`); }
  if (window.innerWidth < 760) document.querySelector('#sidebar').classList.remove('open');
}));
document.querySelectorAll('[data-open-view]').forEach(button => button.addEventListener('click', () => setDashboardView(button.dataset.openView)));
setDashboardView(location.hash.slice(1), false) || setDashboardView('overview', false);
document.addEventListener('click', event => {
  const button = event.target.closest('button:not(:disabled)');
  if (!button) return;
  button.classList.remove('is-clicked');
  void button.offsetWidth;
  button.classList.add('is-clicked');
  setTimeout(() => button.classList.remove('is-clicked'), 550);
});
document.querySelector('#sidebar-toggle').addEventListener('click', () => document.querySelector('#sidebar').classList.toggle('open'));
document.querySelectorAll('.table-footer button:not(:disabled)').forEach(button => button.addEventListener('click', () => notify('Worker pagination is a sample preview.')));
