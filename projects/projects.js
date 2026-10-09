/* Cockpit supplies authentication and read access to host aggregates. */
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const files = {projects: cockpit.file('/var/cache/cockpit-incus/projects.json'), telemetry: cockpit.file('/var/cache/cockpit-incus/telemetry.json')};
  let report = null, telemetry = null, section = 'overview', loading = false;
  const numeric = value => typeof value === 'number' && Number.isFinite(value);
  const number = value => numeric(value) ? new Intl.NumberFormat().format(Math.round(value)) : '—';
  const bytes = value => {
    if (!numeric(value)) return '—';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const index = value > 0 ? Math.min(4, Math.floor(Math.log(value) / Math.log(1024))) : 0;
    return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
  };
  const percent = value => numeric(value) ? value.toFixed(1) + '%' : '—';
  const fresh = data => data && Date.now() - data.generated_at < 120000 && data.generated_at <= Date.now() + 60000;
  const seconds = () => $('#window').value;
  const period = () => $('#window').selectedOptions[0].textContent;
  const date = value => value ? new Date(value).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) : 'Unknown';
  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text !== undefined && text !== null) item.textContent = text;
    if (className) item.className = className;
    return item;
  }
  function link(label, url) {
    try {
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol)) return null;
      const a = node('a', label); a.href = parsed.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
      return a;
    } catch { return null; }
  }
  function activeProjects() {
    const needle = $('#search').value.trim().toLowerCase(), chosen = $('#project').value;
    return (report?.projects || []).filter(p => (chosen === 'all' || p.id === chosen) && `${p.name} ${(p.domains || []).join(' ')}`.toLowerCase().includes(needle));
  }
  function instance(p) { return telemetry?.instances?.[`${p.incus_project || 'default'}/${p.instance}`]; }
  function metrics(p) { return fresh(telemetry) ? instance(p)?.windows?.[seconds()] : null; }
  function analytics(p, window = seconds()) { return fresh(report) && p.analytics?.available ? p.analytics.windows?.[window] : null; }
  function health(p) { return fresh(report) ? p.health?.status || 'unavailable' : 'stale'; }
  function badge(p) {
    const state = health(p);
    return node('span', {healthy:'Healthy',unhealthy:'Needs attention',unavailable:'Unknown',stale:'Stale'}[state] || 'Unknown', 'health-badge ' + state);
  }
  function sum(projects, get) {
    const values = projects.map(get).filter(numeric);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  }
  function metric(label, value, note) {
    const box = node('article', null, 'metric');
    box.append(node('span', label, 'metric-label'), node('strong', value), node('small', note));
    return box;
  }
  function renderSummary(projects) {
    const covered = projects.filter(p => analytics(p)).length;
    const healthy = projects.filter(p => health(p) === 'healthy').length;
    $('#summary').replaceChildren(
      metric('Visits', number(sum(projects, p => analytics(p)?.visits)), `${covered}/${projects.length} projects instrumented · ${period()}`),
      metric('Active visits', number(sum(projects, p => analytics(p, '300')?.visits)), 'Pageview in the last 5 minutes'),
      metric('Pageviews', number(sum(projects, p => analytics(p)?.pageviews)), `${period()} · repeats included`),
      metric('External requests', number(sum(projects, p => metrics(p)?.http?.external_requests)), `${period()} · includes gateway traffic`),
      metric('HTTP downloads', bytes(sum(projects, p => metrics(p)?.http?.sent)), `Server → visitor · ${period()}`),
      metric('Healthy services', fresh(report) ? `${healthy} / ${projects.length}` : '—', 'Current application health probes')
    );
  }
  function renderTable(projects) {
    const rows = projects.map(p => {
      const a = analytics(p), m = metrics(p), http = m?.http;
      const row = node('tr');
      const title = node('td'), line = node('div', null, 'project-title'), dot = node('span', null, 'project-dot');
      if (/^#[a-f0-9]{6}$/i.test(p.color || '')) dot.style.background = p.color;
      const name = node('button', p.name, 'project-name');
      name.addEventListener('click', () => { $('#project').value = p.id; render(); });
      line.append(dot, name); title.append(line, node('span', (p.domains || []).join(' · '), 'secondary'));
      const state = node('td'); state.append(badge(p));
      if (numeric(p.health?.latency_ms) && fresh(report)) state.append(node('span', p.health.latency_ms + ' ms probe', 'secondary'));
      const visitors = node('td', a ? `${number(a.visits)} / ${number(a.pageviews)}` : '—');
      if (!a) visitors.append(node('span', p.analytics?.available ? 'Waiting for fresh data' : 'Tracking not installed', 'secondary'));
      const req = node('td', number(http?.external_requests));
      req.append(node('span', http ? `${number(http.errors5)} server errors` : 'No traffic sample', 'secondary'));
      const transfer = node('td', `${bytes(http?.received)} / ${bytes(http?.sent)}`);
      const load = node('td', `${percent(m?.cpu_percent)} / ${percent(m?.memory_percent)}`);
      load.append(node('span', `${p.instance || 'Unmapped'} · ${period()}`, 'secondary'));
      const release = node('td', p.deployment?.version || '—');
      release.append(node('span', p.deployment?.commit?.slice(0, 8) || 'Not reported', 'secondary'));
      const shortcuts = node('td'), links = node('div', null, 'links');
      for (const [label, url] of [['Site',p.site_url],['Admin',p.admin_url],['GitHub',p.github_url]]) {
        const a = link(label, url); if (a) links.append(a);
      }
      const incus = node('a', 'Incus'); incus.href = '../incus/index.html'; links.append(incus);
      shortcuts.append(links); row.append(title,state,visitors,req,transfer,load,release,shortcuts);
      return row;
    });
    $('#project-rows').replaceChildren(...rows);
    $('#project-count').textContent = projects.length;
    $('#projects-empty').hidden = projects.length > 0;
  }
  function renderChart(projects) {
    const kind = $('#chart-metric').value, trafficIndex = {requests:2,sent:4,received:3,network_sent:1,network_received:0};
    const values = Array(36).fill(0);
    let available = false;
    for (const p of projects) {
      const chart = kind === 'pageviews' ? analytics(p)?.chart : metrics(p)?.chart;
      if (!chart) continue;
      available = true;
      chart.forEach((value, index) => { values[index] += kind === 'pageviews' ? value : value[trafficIndex[kind]]; });
    }
    const format = kind === 'pageviews' || kind === 'requests' ? number : bytes;
    $('#chart-title').textContent = $('#chart-metric').selectedOptions[0].textContent;
    $('#chart-note').textContent = `${period()} · ${format(values.reduce((sum, n) => sum + n, 0))} total`;
    const end = kind === 'pageviews' ? report?.generated_at : telemetry?.generated_at;
    const start = (end || Date.now()) - Number(seconds()) * 1000;
    $('#chart-start').textContent = date(start); $('#chart-end').textContent = date(end || Date.now());
    const max = Math.max(1, ...values);
    $('#chart').setAttribute('aria-label', `${$('#chart-title').textContent} over ${period()}; ${format(values.reduce((sum,n) => sum+n,0))} total`);
    if (!available || values.every(value => value === 0)) {
      $('#chart').replaceChildren(node('p', !available ? 'Collection unavailable for this metric' : 'No activity recorded in this window', 'chart-empty'));
      return;
    }
    $('#chart').replaceChildren(...values.map((value, index) => {
      const bar = node('div', null, 'bar'); bar.style.height = `${value > 0 ? Math.max(2, value / max * 100) : 0}%`;
      bar.title = `${date(start + index / 36 * Number(seconds()) * 1000)} · ${format(value)}`;
      return bar;
    }));
  }
  function ranking(selector, projects, key) {
    const totals = new Map();
    for (const p of projects) for (const row of analytics(p)?.[key] || []) {
      const label = key === 'pages' && projects.length > 1 ? `${p.name} · ${row.label}` : row.label;
      const old = totals.get(label) || {label, count:0, url:null}; old.count += row.count;
      if (key === 'pages' && row.label.startsWith('/')) try { old.url = new URL(row.label, p.site_url).href; } catch {}
      totals.set(label, old);
    }
    const rows = [...totals.values()].sort((a,b) => b.count - a.count).slice(0,8), max = Math.max(1,...rows.map(r => r.count));
    $(selector).replaceChildren(...(rows.length ? rows.map(row => {
      const el = node('div', null, 'rank-row'); el.style.setProperty('--fill', `${row.count/max*100}%`);
      const label = row.url ? link(row.label,row.url) : node('span',row.label); label.className = 'rank-label'; label.title = row.label;
      el.append(label,node('span',number(row.count),'rank-count')); return el;
    }) : [node('p','No activity recorded yet.','empty')]));
  }
  function sizeLimit(value) {
    const match = String(value || '').match(/^(\d+(?:\.\d+)?)\s*(Ki?B|Mi?B|Gi?B|Ti?B|B)?$/i);
    if (!match) return null;
    const power = {b:0,kb:1,kib:1,mb:2,mib:2,gb:3,gib:3,tb:4,tib:4}[(match[2] || 'B').toLowerCase()];
    return Number(match[1]) * (/i/i.test(match[2] || '') ? 1024 : 1000) ** power;
  }
  function gauge(label, value, detail) {
    const row = node('div', null, 'load-row'), heading = node('div', null, 'load-heading');
    heading.append(node('span',label), node('span',numeric(value) ? percent(value) : '—','load-value'));
    const track = node('div',null,'load-track'), fill = node('div',null,'load-fill' + (value > 85 ? ' high' : ''));
    fill.style.width = `${numeric(value) ? Math.min(100, Math.max(0,value)) : 0}%`; track.append(fill);
    row.append(heading,track,node('div',detail,'spec-line')); return row;
  }
  function renderResources(projects) {
    $('#resources').replaceChildren(...projects.map(p => {
      const card = node('article',null,'panel resource-card'), head = node('div',null,'resource-heading'), info = instance(p), m = metrics(p), specs = info?.specs || {};
      head.append(node('h3',p.name),badge(p)); card.append(head);
      const disk = fresh(telemetry) && info?.disk && Date.now()/1000-info.disk.t<900 ? info.disk : null;
      const capacity = sizeLimit(specs.disk), diskPercent = capacity && numeric(disk?.bytes) ? disk.bytes/capacity*100 : null;
      card.append(gauge('CPU average',m?.cpu_percent,`${specs.cpu || 'Host available'} assigned CPUs · ${numeric(m?.cpu_cores) ? m.cpu_cores.toFixed(2) : '—'} cores used`),
        gauge('RAM average',m?.memory_percent,`${bytes(m?.memory_bytes)} used · ${specs.memory || 'No explicit limit'} assigned · includes cache`),
        gauge('Root disk estimate',diskPercent,`${bytes(disk?.bytes)} root files · ${specs.disk || 'No configured capacity'} assigned`),
        node('p',`Network: ${bytes(m?.received)} received / ${bytes(m?.sent)} sent · ${period()}`,'spec-line'));
      return card;
    }));
  }
  function renderDomains(projects) {
    const keys = new Set(projects.map(p => `${p.incus_project || 'default'}/${p.instance}`));
    const rows = (telemetry?.domains || []).filter(d => d.instances?.some(key => keys.has(key)));
    $('#domain-rows').replaceChildren(...rows.map(d => {
      const h = fresh(telemetry) ? d.windows?.[seconds()] : null, row = node('tr'), name = node('td');
      name.append(link(d.name,d.url) || node('span',d.name));
      row.append(name,node('td',projects.filter(p => d.instances?.includes(`${p.incus_project || 'default'}/${p.instance}`)).map(p => p.name).join(', ')),
        node('td',number(h?.external_requests)),node('td',`${bytes(h?.received)} / ${bytes(h?.sent)}`),node('td',`${number(h?.errors4)} / ${number(h?.errors5)}`),node('td',numeric(h?.average_ms) ? h.average_ms.toFixed(1)+' ms' : '—'));
      return row;
    }));
  }
  function renderActivity(projects) {
    const backup = report?.analytics_backup;
    const backupRow = node('div',null,'release-item');
    backupRow.append(node('strong',backup?.status === 'success' ? 'Latest backup completed' : 'No successful backup recorded'),
      node('p',backup ? `${date(backup.at)} · ${number(backup.retained)} snapshots retained` : 'Check the project-analytics-backup timer.'));
    $('#backups').replaceChildren(backupRow);
    $('#deployments').replaceChildren(...projects.map(p => {
      const row = node('div',null,'release-item'), top = node('div',null,'release-top'); top.append(node('strong',p.name),node('span',p.deployment?.version || 'Not reported','muted'));
      row.append(top,node('p',`Installed / started: ${date(p.deployment?.installed_at)}`));
      if (p.deployment?.commit) row.append(node('code',p.deployment.commit.slice(0,12)));
      const github = link(' · GitHub',p.github_url); if (github) row.append(github); return row;
    }));
    $('#activity').replaceChildren(...projects.map(p => {
      const row = node('div',null,'release-item'), a = fresh(report) ? p.activity : null; row.append(node('strong',p.name));
      if (a) row.append(node('p',`${number(a.runners_enabled)} enabled · ${number(a.runners_paused)} paused`),node('p',`${number(a.runner_failures_24h)} failed runner attempts · ${number(a.crawler_failures_24h)} failed crawler attempts`));
      else row.append(node('p','Activity adapter not available.'));
      const admin = link('Open project admin →',p.admin_url); if (admin) row.append(admin); return row;
    }));
  }
  function render() {
    const projects = activeProjects();
    const stale = !fresh(report) || !fresh(telemetry);
    $('#freshness').textContent = stale ? 'Collection stale / unavailable' : 'Updated ' + new Date(report.generated_at).toLocaleTimeString();
    $('#freshness').classList.toggle('stale',stale);
    const ingestionDown = Object.values(report?.analytics_services || {}).some(active => !active);
    $('#notice').hidden = !stale && !ingestionDown;
    $('#notice').textContent = stale ? 'Fresh measurements are unavailable. Check the project and Incus collector timers on this host. Older deployment details may still be shown.' : 'The visitor collector or ingestion relay is stopped. Recorded history remains available; new visits may be missing.';
    for (const element of document.querySelectorAll('[data-sections]')) element.hidden = !element.dataset.sections.split(' ').includes(section);
    renderSummary(projects); renderTable(projects); renderChart(projects); renderResources(projects); renderDomains(projects); renderActivity(projects);
    for (const [selector,key] of [['#pages','pages'],['#referrers','referrers'],['#browsers','browsers'],['#systems','systems'],['#events','events_top']]) ranking(selector,projects,key);
    const coverage = telemetry?.windows?.[seconds()]?.coverage_seconds;
    $('#coverage').textContent = `${numeric(coverage) ? Math.round(coverage/60)+' min' : 'No'} resource history available · visitor history starts when tracking is installed · refresh every 30 seconds`;
  }
  async function refresh() {
    if (loading) return;
    loading = true; $('#refresh').disabled = true;
    try {
      const results = await Promise.allSettled([files.projects.read(),files.telemetry.read()]);
      if (results[0].status === 'fulfilled' && results[0].value) report = JSON.parse(results[0].value);
      if (results[1].status === 'fulfilled' && results[1].value) telemetry = JSON.parse(results[1].value);
      const selected = $('#project').value;
      $('#project').replaceChildren(node('option','All projects'));
      $('#project').firstElementChild.value = 'all';
      for (const p of report?.projects || []) { const option=node('option',p.name); option.value=p.id; $('#project').append(option); }
      $('#project').value = (report?.projects || []).some(p => p.id === selected) ? selected : 'all';
    } catch { $('#notice').hidden = false; }
    finally { loading=false; $('#refresh').disabled=false; render(); }
  }
  $('#refresh').addEventListener('click',refresh);
  for (const id of ['#project','#window','#chart-metric']) $(id).addEventListener('change',render);
  $('#search').addEventListener('input',render);
  for (const button of document.querySelectorAll('[data-section]')) button.addEventListener('click',() => {
    section=button.dataset.section;
    for (const tab of document.querySelectorAll('[data-section]')) { tab.classList.toggle('selected',tab===button); if(tab===button)tab.setAttribute('aria-current','page'); else tab.removeAttribute('aria-current'); }
    if(section==='traffic' && $('#chart-metric').value==='pageviews')$('#chart-metric').value='requests';
    if(section==='visitors')$('#chart-metric').value='pageviews';
    render();
  });
  window.addEventListener('unload',() => Object.values(files).forEach(file => file.close()));
  refresh(); window.setInterval(refresh,30000);
})();
