(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const instanceBody = $('#instances');
  const connection = $('#connection');
  const notice = $('#notice');
  const filter = $('#filter');
  const inspectDialog = $('#inspect-dialog');
  const deployDialog = $('#deploy-dialog');
  const historyKey = 'cockpit-incus-traffic-v2';
  const pollEvery = 30_000;
  const diskPollEvery = 5 * 60_000;
  const retention = 24 * 60 * 60 * 1000;
  let instances = [];
  let busy = false;
  let samples = loadSamples();
  let pendingProxies = {};
  let inspectedRepo = null;
  const cpuBaselines = new Map();
  const memorySamples = new Map();
  let lastDiskPoll = 0;
  let diskSampling = false;
  let refreshing = false;
  let currentProject = null;
  let telemetry = null;
  const telemetryFile = cockpit.file('/var/cache/cockpit-incus/telemetry.json');

  function selectedSeconds() { return Number($('#traffic-window').value) / 1000; }
  function windowLabel() { return $('#traffic-window').selectedOptions[0].textContent; }
  function instanceKey(item) { return `${item.project || currentProject || 'default'}/${item.name}`; }
  function freshTelemetry() { return telemetry?.version === 1 && Math.abs(Date.now() - telemetry.generated_at) < 90_000; }
  function accessReady() { return freshTelemetry() && telemetry.access?.available && telemetry.access?.configured; }
  function instanceMetrics(item) { return freshTelemetry() ? telemetry.instances?.[instanceKey(item)]?.windows?.[selectedSeconds()] : null; }
  function assignedDomains(item) { return (telemetry?.domains || []).filter(domain => domain.instances?.includes(instanceKey(item))); }
  function instanceDomainUrl(domain, item) {
    const bindings = (domain.bindings || []).filter(binding => binding.instances.includes(instanceKey(item)));
    const binding = bindings.find(entry => entry.port === 443) || bindings.find(entry => entry.port === 80) || bindings[0];
    if (!binding) return domain.url;
    try {
      const url = new URL(domain.url);
      url.protocol = binding.port === 80 ? 'http:' : 'https:';
      url.port = [80, 443].includes(binding.port) ? '' : String(binding.port);
      return url.href;
    } catch { return domain.url; }
  }
  function textElement(tag, text, className = '') {
    const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
  }
  function serviceLink(url, label, className = 'domain-link') {
    const node = textElement('a', label, className);
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return textElement('span', label, className);
      node.href = parsed.href; node.target = '_blank'; node.rel = 'noopener noreferrer';
    } catch { return textElement('span', label, className); }
    return node;
  }
  async function readTelemetry() {
    try {
      const value = parseJson(await telemetryFile.read(), null);
      if (value?.version === 1 && Array.isArray(value.domains) && value.instances && value.windows) telemetry = value;
    } catch { /* Instance management remains usable when the host collector is absent. */ }
  }

  function setConnection(state, message) {
    connection.className = `connection ${state ? `is-${state}` : ''}`;
    connection.lastElementChild.textContent = message;
  }
  function showNotice(message, isError = false) {
    notice.textContent = message;
    notice.className = `notice${isError ? ' is-error' : ''}`;
    notice.hidden = false;
  }
  function clearNotice() { notice.hidden = true; notice.textContent = ''; }
  function runIncus(args, timeout = 0, project = currentProject) {
    const process = cockpit.spawn(['incus', '--force-local', ...(project ? ['--project', project] : []), ...args], { err: 'message' });
    const timer = timeout ? window.setTimeout(() => process.close('timeout'), timeout) : null;
    const result = process.catch((error, stderr) => {
      const wrapped = new Error(stderr || error.message || 'Incus command failed.');
      Object.assign(wrapped, error);
      if (stderr) wrapped.message = stderr;
      throw wrapped;
    });
    if (!timer) return result;
    return result.then(output => {
      window.clearTimeout(timer);
      return output;
    }, error => {
      window.clearTimeout(timer);
      throw error;
    });
  }
  function parseJson(text, fallback = []) {
    try { return JSON.parse(text || JSON.stringify(fallback)); } catch { return fallback; }
  }
  function itemConfig(item, key) { return item.config?.[key] || item.expanded_config?.[key] || ''; }
  function findIPv4(networks) {
    if (!networks || typeof networks !== 'object') return '';
    for (const network of Object.values(networks)) {
      const address = (network.addresses || []).find(entry => entry.family === 'inet' && entry.scope === 'global');
      if (address) return address.address;
    }
    return '';
  }
  function getPortMappings(item) {
    const devices = item.expanded_devices || item.devices || {};
    return Object.values(devices).filter(device => device.type === 'proxy' && /^tcp:127\.0\.0\.1:\d+$/.test(device.listen || '')).map(device => {
      const hostPort = device.listen.split(':').pop();
      const guestPort = device.connect?.split(':').pop();
      const baseUrl = itemConfig(item, 'user.cockpit-incus.url');
      return { hostPort, guestPort, url: baseUrl ? String(baseUrl) : `127.0.0.1:${hostPort}`, publicUrl: Boolean(baseUrl) };
    });
  }
  function assignedSpecs(item) {
    const config = item.expanded_config || item.config || {};
    const devices = item.expanded_devices || item.devices || {};
    const root = Object.values(devices).find(device => device.type === 'disk' && device.path === '/');
    const image = [config['image.os'], config['image.release'], config['image.variant']].filter(Boolean).join(' ');
    return {
      cpu: config['limits.cpu'] || 'No explicit limit',
      memory: config['limits.memory'] || 'No explicit limit',
      disk: root?.size || 'Pool default',
      pool: root?.pool || '',
      profiles: Array.isArray(item.profiles) && item.profiles.length ? item.profiles.join(', ') : 'None',
      image: image || config['image.description'] || config['image.architecture'] || 'Not reported',
      architecture: config['image.architecture'] || item.architecture || '',
      memoryUsage: item.state?.memory?.usage,
      memoryTotal: item.state?.memory?.total,
      devices: Object.entries(devices).map(([name, device]) => ({ name, ...device })),
    };
  }
  function capacityBytes(value) {
    const match = String(value || '').trim().match(/^([\d.]+)\s*([KMGTPE]?i?B)?$/i);
    if (!match) return 0;
    const units = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
    return Number(match[1]) * (units[(match[2] || 'b').toLowerCase()] || 1);
  }
  function cpuLimitCount(item) {
    const value = String(item.specs.cpu || '');
    if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
    if (/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value)) return value.split(',').reduce((count, part) => {
      const [start, end = start] = part.split('-').map(Number);
      return count + end - start + 1;
    }, 0);
    return 0;
  }
  function updateCpuMetrics() {
    const now = Date.now();
    instances.forEach(item => {
      item.live ||= {};
      const usage = Number(item.raw.state?.cpu?.usage);
      const previous = cpuBaselines.get(item.name);
      item.live.cpuPercent = null;
      item.live.cpuCores = null;
      const memoryUsage = Number(item.raw.state?.memory?.usage);
      const memoryTotal = Number(item.raw.state?.memory?.total);
      if (item.status.toLowerCase() === 'running' && memoryTotal > 0 && Number.isFinite(memoryUsage)) {
        const history = memorySamples.get(item.name) || [];
        history.push({ t: now, percent: memoryUsage / memoryTotal * 100 });
        const recent = history.filter(sample => sample.t >= now - 5 * 60_000);
        memorySamples.set(item.name, recent);
        item.live.memoryPercentAverage = recent.reduce((sum, sample) => sum + sample.percent, 0) / recent.length;
      } else {
        memorySamples.delete(item.name);
        item.live.memoryPercentAverage = null;
      }
      if (item.status.toLowerCase() === 'running' && Number.isFinite(usage)) {
        if (previous && now > previous.t && usage >= previous.usage) {
          const cores = (usage - previous.usage) / ((now - previous.t) * 1e6);
          const cpuCount = cpuLimitCount(item);
          item.live.cpuCores = cores;
          item.live.cpuPercent = cpuCount ? Math.min(100, (cores / cpuCount) * 100) : cores * 100;
        }
        cpuBaselines.set(item.name, { usage, t: now });
      } else cpuBaselines.delete(item.name);
    });
  }
  async function sampleDiskUsage() {
    if (freshTelemetry()) return; // The host timer samples even with Cockpit closed.
    const now = Date.now();
    if (diskSampling || now - lastDiskPoll < diskPollEvery) return;
    diskSampling = true;
    const running = instances.filter(item => item.status.toLowerCase() === 'running');
    try {
      for (const item of running) {
        try {
          // Bound the work inside the guest and the Cockpit process separately.
          const output = await runIncus(['exec', item.name, '--', 'timeout', '-k', '5', '30', 'du', '-sx', '-B1', '/'], 45_000, item.project);
          const bytes = Number(String(output).trim().split(/\s+/)[0]);
          const current = instances.find(entry => entry.name === item.name);
          if (current && Number.isFinite(bytes)) { current.live.diskBytes = bytes; current.live.diskError = false; }
        } catch {
          const current = instances.find(entry => entry.name === item.name);
          if (current) { current.live.diskBytes = null; current.live.diskError = true; }
        }
      }
    } finally {
      lastDiskPoll = Date.now();
      diskSampling = false;
      render();
    }
  }
  function liveLoadCell(item) {
    const cell = document.createElement('td'); cell.className = 'live-load-cell';
    const memoryUsage = Number(item.raw.state?.memory?.usage);
    const memoryTotal = Number(item.raw.state?.memory?.total);
    const metrics = instanceMetrics(item);
    const memoryPercent = Number.isFinite(metrics?.memory_percent) ? metrics.memory_percent : Number.isFinite(item.live?.memoryPercentAverage) ? item.live.memoryPercentAverage : null;
    const cpu = document.createElement('span'); cpu.className = 'load-value';
    if (item.status.toLowerCase() !== 'running') cpu.textContent = 'CPU · stopped';
    else if (Number.isFinite(metrics?.cpu_cores)) {
      cpu.textContent = Number.isFinite(metrics.cpu_percent) ? `CPU · ${metrics.cpu_percent.toFixed(1)}% avg` : `CPU · ${metrics.cpu_cores.toFixed(2)} cores avg`;
      cpu.title = `${windowLabel()} average of collected samples; percent is relative to the configured CPU limit.`;
    }
    else if (Number.isFinite(item.live?.cpuCores)) {
      cpu.textContent = cpuLimitCount(item) ? `CPU · ${item.live.cpuPercent.toFixed(1)}% avg` : `CPU · ${item.live.cpuCores.toFixed(2)} cores avg`;
      cpu.title = cpuLimitCount(item) ? 'Average use as a percentage of this instance’s configured CPU limit' : 'Average CPU cores used; this instance has no explicit CPU limit';
    }
    else cpu.textContent = 'CPU · sampling…';
    const ram = document.createElement('span'); ram.className = 'load-value';
    ram.textContent = item.status.toLowerCase() !== 'running' ? 'RAM · stopped' : Number.isFinite(memoryPercent) ? `RAM · ${memoryPercent.toFixed(0)}% avg` : 'RAM · sampling…';
    if (Number.isFinite(memoryPercent)) ram.title = `Current: ${formatBytes(memoryUsage)} of ${formatBytes(memoryTotal)} · ${metrics ? windowLabel() : '5-minute browser'} sample average. Incus usage can include filesystem cache.`;
    const disk = document.createElement('span'); disk.className = 'load-value';
    const centralDisk = freshTelemetry() ? telemetry.instances?.[instanceKey(item)]?.disk : null;
    const diskBytes = centralDisk ? centralDisk.bytes : item.live?.diskBytes;
    if (Number.isFinite(diskBytes)) {
      const capacity = capacityBytes(item.specs.disk);
      const percent = capacity > 0 ? ` · ${(diskBytes / capacity * 100).toFixed(0)}% estimated` : '';
      disk.textContent = `Disk · ${formatBytes(diskBytes)}${percent}`;
      disk.title = `${capacity > 0 ? 'Root files compared with configured disk size; quotas may not be enforced.' : 'Root file usage; no configured capacity.'}${centralDisk ? ` Sampled ${new Date(centralDisk.t * 1000).toLocaleTimeString()}.` : ''}`;
    } else disk.textContent = item.status.toLowerCase() !== 'running' ? 'Disk · stopped' : centralDisk?.error || item.live?.diskError ? 'Disk · unavailable' : 'Disk · sampling…';
    cell.append(cpu, ram, disk);
    return cell;
  }
  function networkCounters(item) {
    const totals = { received: 0, sent: 0 };
    Object.entries(item.state?.network || {}).forEach(([name, network]) => {
      if (name === 'lo') return;
      totals.received += Number(network.counters?.bytes_received || 0);
      totals.sent += Number(network.counters?.bytes_sent || 0);
    });
    return totals;
  }
  function loadSamples() {
    try {
      const parsed = JSON.parse(localStorage.getItem(historyKey) || '[]');
      return Array.isArray(parsed) ? parsed.filter(sample => Number.isFinite(sample.t)) : [];
    } catch { return []; }
  }
  function recordTraffic() {
    const t = Date.now();
    const current = Object.fromEntries(instances.filter(item => item.status.toLowerCase() === 'running').map(item => [instanceKey(item), networkCounters(item.raw)]));
    const previous = samples.filter(sample => sample.project === currentProject).at(-1);
    const delta = { received: 0, sent: 0 };
    if (previous) Object.entries(current).forEach(([name, counts]) => {
      const before = previous.instances?.[name];
      if (!before) return;
      delta.received += Math.max(0, counts.received - before.received);
      delta.sent += Math.max(0, counts.sent - before.sent);
    });
    samples.push({ t, project: currentProject, instances: current, ...delta });
    samples = samples.filter(sample => sample.t >= t - retention - pollEvery);
    try { localStorage.setItem(historyKey, JSON.stringify(samples)); } catch { /* Retain this session's chart if browser storage is unavailable. */ }
    renderTraffic();
  }
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / (1024 ** i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }
  function renderTraffic() {
    const duration = Number($('#traffic-window').value);
    const visible = samples.filter(sample => sample.project === currentProject && sample.t >= Date.now() - duration);
    const totals = visible.reduce((sum, sample) => ({ received: sum.received + sample.received, sent: sum.sent + sample.sent }), { received: 0, sent: 0 });
    const window = freshTelemetry() ? telemetry.windows?.[selectedSeconds()] : null;
    const http = accessReady() ? window?.http : null;
    const network = window?.network || totals;
    $('#traffic-down').textContent = formatBytes(network.received);
    $('#traffic-up').textContent = formatBytes(network.sent);
    $('#access-count').textContent = http ? http.external_requests.toLocaleString() : '—';
    $('#http-down').textContent = http ? formatBytes(http.received) : '—';
    $('#http-up').textContent = http ? formatBytes(http.sent) : '—';
    $('#http-errors').textContent = http ? `${http.errors5.toLocaleString()} / ${http.average_ms === null ? '—' : `${http.average_ms.toLocaleString()} ms`}` : '—';
    $('#access-source').textContent = http ? `${(http.public_requests || 0).toLocaleString()} public peers · ${(http.gateway_requests || 0).toLocaleString()} gateway · ${http.local_requests.toLocaleString()} local · ${http.unknown_requests.toLocaleString()} unknown` : 'HTTP logging not available';
    $('#instance-metric-window').textContent = window ? `CPU / RAM averages · ${windowLabel()}` : 'CPU since last poll · RAM over 5 minutes';
    if (window) {
      const coverage = Math.floor(window.coverage_seconds / 60);
      const httpSince = telemetry.access?.since ? new Date(telemetry.access.since).toLocaleTimeString() : 'not enabled';
      $('#traffic-sampled').textContent = `Host history covers ${coverage} min of ${windowLabel()} · HTTP logging since ${httpSince}`;
      $('#telemetry-status').textContent = `Collected on host · ${new Date(telemetry.generated_at).toLocaleTimeString()}${telemetry.access?.backlog ? ' · catching up with logs' : ''}${telemetry.errors?.length ? ` · ${telemetry.errors[0]}` : ''}`;
      $('#telemetry-status').className = `collector-state${telemetry.errors?.length ? ' collector-warning' : ''}`;
    } else {
      const first = visible[0]?.t;
      $('#traffic-sampled').textContent = visible.length > 1 ? `Browser samples cover ${Math.max(0, Math.round((Date.now() - first) / 60_000))} min · page must stay open` : 'Waiting for a second network sample…';
      $('#telemetry-status').textContent = telemetry ? 'Host collector stale · browser network fallback' : 'Host collector not installed · browser network fallback';
      $('#telemetry-status').className = 'collector-state collector-warning';
    }
    let view = $('#traffic-view').value;
    if (!http && view !== 'network') view = 'network';
    const buckets = Array.from({ length: 36 }, () => ({ received: 0, sent: 0 }));
    if (window) {
      window.chart.forEach((entry, index) => {
        buckets[index].received = entry[view === 'requests' ? 2 : view === 'http' ? 3 : 0];
        buckets[index].sent = view === 'requests' ? 0 : entry[view === 'http' ? 4 : 1];
      });
    } else visible.forEach(sample => {
      const index = Math.max(0, Math.min(35, Math.floor(((sample.t - (Date.now() - duration)) / duration) * 36)));
      buckets[index].received += sample.received; buckets[index].sent += sample.sent;
    });
    $('#legend-down').textContent = view === 'requests' ? 'External requests' : 'Received';
    $('#legend-up').textContent = 'Sent';
    $('#legend-up-wrapper').hidden = view === 'requests';
    const chart = $('#traffic-chart'); chart.replaceChildren();
    chart.setAttribute('aria-label', `${view === 'requests' ? 'External HTTP requests' : view === 'http' ? 'External HTTP body bytes' : 'Instance network bytes'} across ${windowLabel()}`);
    const max = Math.max(1, ...buckets.map(bucket => bucket.received + bucket.sent));
    buckets.forEach((bucket, index) => {
      const pair = document.createElement('div');
      pair.className = 'traffic-bar-pair';
      const received = document.createElement('i');
      received.className = 'traffic-bar traffic-bar-down';
      received.classList.add(`traffic-level-${Math.max(0, Math.ceil(bucket.received / max * 10))}`);
      const sent = document.createElement('i');
      sent.className = 'traffic-bar traffic-bar-up';
      sent.classList.add(`traffic-level-${Math.max(0, Math.ceil(bucket.sent / max * 10))}`);
      const bucketStart = Date.now() - duration + duration / 36 * index;
      pair.title = `${new Date(bucketStart).toLocaleString()}: ${view === 'requests' ? `${bucket.received.toLocaleString()} external requests` : `received ${formatBytes(bucket.received)}, sent ${formatBytes(bucket.sent)}`}`;
      pair.append(received, sent);
      chart.append(pair);
    });
  }
  function renderDomains() {
    const body = $('#domains'); body.replaceChildren();
    const domains = telemetry?.domains || [];
    $('#domain-count').textContent = `${domains.length} configured`;
    $('#domains-source').textContent = telemetry ? `Caddy config · updated ${new Date(telemetry.routes_updated_at).toLocaleString()}${freshTelemetry() ? '' : ' · collector stale'}` : 'Install the host collector to discover routes and DNS.';
    const needle = filter.value.trim().toLowerCase();
    const visible = domains.filter(domain => `${domain.name} ${domain.instances.join(' ')} ${domain.dns?.addresses?.join(' ') || ''}`.toLowerCase().includes(needle));
    $('#domains-empty').hidden = visible.length > 0;
    $('#domains-empty').textContent = domains.length ? 'No domains match this filter.' : 'Domain inventory is not available yet.';
    visible.forEach(domain => {
      const row = document.createElement('tr');
      const domainCell = document.createElement('td');
      domainCell.append(serviceLink(domain.url, domain.name));
      domainCell.append(textElement('small', `Listeners · ${(domain.listeners || []).join(', ')}`, 'domain-detail'));
      if (domain.redirects?.length) domainCell.append(textElement('small', `Redirect → ${(domain.redirect_routes || []).map(route => `${route.host} · listener ${(route.listeners || []).join(', ')}`).join('; ') || domain.redirects.join(', ')}`, 'domain-detail'));
      const targetCell = document.createElement('td');
      const owners = domain.instances || [];
      targetCell.append(textElement('b', owners.length ? owners.map(key => key.startsWith('default/') ? key.slice(8) : key).join(', ') : domain.targets?.length ? 'Host / unmapped' : 'Redirect / host route', 'domain-owner'));
      (domain.targets || []).forEach(target => {
        const detail = `${(target.listeners || []).map(value => value.split(':').pop()).join(', ')} → ${target.upstream}${target.guest_ports?.length ? ` → guest :${target.guest_ports.join(', :')}` : ''}${target.paths?.length ? ` · ${target.paths.join(', ')}` : ''}`;
        targetCell.append(textElement('small', detail, 'domain-detail'));
      });
      if (owners.length > 1) targetCell.append(textElement('small', 'Multiple owners · attribution follows listener port; shared listeners remain unassigned', 'domain-detail'));
      const dnsCell = document.createElement('td');
      dnsCell.append(textElement('span', domain.dns?.status || 'Unknown', domain.dns?.status === 'Resolved' ? 'dns-resolved' : 'dns-warning'));
      dnsCell.append(textElement('small', (domain.dns?.addresses || []).join(' · '), 'domain-detail'));
      const metric = accessReady() ? domain.windows?.[selectedSeconds()] : null;
      const hitsCell = textElement('td', metric ? metric.external_requests.toLocaleString() : '—', 'metric-number');
      if (metric) hitsCell.title = `${metric.public_requests || 0} public peers · ${metric.gateway_requests || 0} external gateway · ${metric.local_requests} local requests · ${metric.unknown_requests} unknown source`;
      const bytesCell = textElement('td', metric ? `↓ ${formatBytes(metric.received)} · ↑ ${formatBytes(metric.sent)}` : '—', 'metric-number');
      bytesCell.title = 'HTTP body bytes for public peers and configured external gateway ingress; excludes TLS and network headers.';
      const responseCell = textElement('td', metric ? `${metric.errors5} / ${metric.average_ms === null ? '—' : `${metric.average_ms.toLocaleString()} ms`}` : '—', 'metric-number');
      responseCell.title = '5xx responses / average completed-request duration; long streams are included.';
      row.append(domainCell, targetCell, dnsCell, hitsCell, bytesCell, responseCell); body.append(row);
    });
  }
  function trafficCell(item) {
    const cell = document.createElement('td'); cell.className = 'instance-traffic';
    const metrics = instanceMetrics(item);
    if (accessReady() && metrics) {
      cell.append(textElement('b', `${metrics.http.external_requests.toLocaleString()} external requests`));
      cell.append(textElement('small', `HTTP ↓ ${formatBytes(metrics.http.received)} · ↑ ${formatBytes(metrics.http.sent)}`));
    } else cell.append(textElement('small', 'HTTP · unavailable'));
    if (metrics?.network_seconds) cell.append(textElement('small', `NIC ↓ ${formatBytes(metrics.received)} · ↑ ${formatBytes(metrics.sent)}`));
    else cell.append(textElement('small', 'NIC · sampling…'));
    cell.title = `${windowLabel()} · HTTP totals for domain listeners assigned to this guest when collected; shared listeners remain unassigned. NIC bytes include internal traffic.`;
    return cell;
  }
  function normalizeInstance(item) {
    return {
      raw: item, name: String(item.name || ''), project: currentProject, status: String(item.status || 'Unknown'),
      type: String(item.type || 'container'),
      ipv4: findIPv4(item.state?.network) || item.expanded_devices?.eth0?.['ipv4.address'] || '',
      description: String(item.description || ''), group: itemConfig(item, 'user.cockpit-incus.deployment'),
      snapshots: Array.isArray(item.snapshots) ? item.snapshots : [], offsite: String(itemConfig(item, 'user.cockpit-incus.backup') || ''),
      ports: getPortMappings(item), specs: assignedSpecs(item),
    };
  }
  function visibleInstances() {
    const needle = filter.value.trim().toLowerCase();
    return instances.filter(item => `${item.name} ${item.group} ${item.ipv4} ${assignedDomains(item).map(domain => domain.name).join(' ')}`.toLowerCase().includes(needle));
  }
  const DAY = 86_400_000;
  function ageLabel(stamp) {
    const days = Math.floor((Date.now() - stamp) / DAY);
    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  }
  // Recovery state of one instance: an off-host backup (recorded in user.cockpit-incus.backup by the backup job)
  // beats a snapshot, because snapshots live on the same disk as the instance.
  function recoveryStatus(item) {
    const offsite = Date.parse(item.offsite);
    if (Number.isFinite(offsite)) {
      const fresh = Date.now() - offsite <= 8 * DAY;
      return { level: fresh ? 'ok' : 'local', label: `Backup ${ageLabel(offsite)}`, detail: fresh ? 'Off-host backup' : 'Backup is more than 8 days old',
               title: 'Last off-host backup recorded in user.cockpit-incus.backup.' };
    }
    const stamps = item.snapshots.map(snapshot => Date.parse(snapshot.created_at)).filter(Number.isFinite);
    if (stamps.length) {
      const newest = Math.max(...stamps);
      return { level: 'local', label: `Snapshot ${ageLabel(newest)}`, detail: 'Same disk only',
               title: 'Snapshots live on the same drive as the instance, so they do not protect against a drive failure.' };
    }
    return { level: 'none', label: 'No backup', detail: 'No snapshot or backup recorded',
             title: 'No snapshot exists and no off-host backup is recorded in user.cockpit-incus.backup.' };
  }
  function updateStats() {
    $('#stat-total').textContent = instances.length;
    $('#stat-running').textContent = instances.filter(item => item.status.toLowerCase() === 'running').length;
    $('#stat-stopped').textContent = instances.filter(item => item.status.toLowerCase() === 'stopped').length;
    $('#stat-vms').textContent = instances.filter(item => item.type.toLowerCase().includes('virtual')).length;
    const unprotected = instances.filter(item => recoveryStatus(item).level === 'none').length;
    $('#stat-unprotected').textContent = unprotected;
    $('#stat-unprotected-card').classList.toggle('stat-alert', unprotected > 0);
  }
  function makeAction(label, action, item, extraClass = '') {
    const button = document.createElement('button');
    button.type = 'button'; button.className = `action ${extraClass}`.trim(); button.textContent = label;
    button.addEventListener('click', () => action(item));
    return button;
  }
  function render() {
    renderDomains();
    instanceBody.replaceChildren();
    const rows = visibleInstances();
    $('#empty').hidden = instances.length !== 0;
    $('#no-match').hidden = instances.length === 0 || rows.length !== 0;
    rows.forEach(item => {
      const row = document.createElement('tr');
      const nameCell = document.createElement('td');
      const name = document.createElement('span'); name.className = 'instance-name'; name.textContent = item.name; nameCell.append(name);
      if (item.group || item.description) {
        const meta = document.createElement('small'); meta.className = item.group ? 'instance-group' : 'instance-sub';
        meta.textContent = item.group ? `Deployment · ${item.group}` : item.description; nameCell.append(meta);
      }
      const stateCell = document.createElement('td');
      const state = document.createElement('span'); const status = item.status.toLowerCase();
      state.className = `state ${status === 'running' ? 'state-running' : status === 'stopped' ? 'state-stopped' : 'state-error'}`;
      state.textContent = item.status; stateCell.append(state);
      const meta = document.createElement('div'); meta.className = 'instance-meta';
      const type = document.createElement('span'); type.className = 'type-pill';
      type.textContent = item.type.toLowerCase().includes('virtual') ? 'Virtual machine' : 'Container';
      const ip = document.createElement('span'); ip.className = 'ip'; ip.textContent = item.ipv4 || 'no address';
      meta.append(type, ip); nameCell.append(meta);
      const recoveryCell = document.createElement('td'); const recovery = recoveryStatus(item);
      const recoveryBox = document.createElement('div'); recoveryBox.className = `recovery recovery-${recovery.level}`; recoveryBox.title = recovery.title;
      recoveryBox.append(textElement('b', recovery.label), textElement('small', recovery.detail)); recoveryCell.append(recoveryBox);
      const loadCell = liveLoadCell(item);
      const portsCell = document.createElement('td'); portsCell.className = 'ports-cell';
      const domains = assignedDomains(item);
      domains.forEach(domain => {
        const url = instanceDomainUrl(domain, item);
        let label = domain.name;
        try { const port = new URL(url).port; if (port) label += `:${port}`; } catch { /* Wildcards have no direct URL. */ }
        portsCell.append(serviceLink(url, label, 'instance-domain-link'));
      });
      if (item.ports.length) item.ports.forEach(port => {
        const link = port.publicUrl ? serviceLink(port.url, `${port.hostPort} → ${port.guestPort}`, 'port-link') : textElement('span', `${port.hostPort} → ${port.guestPort}`, 'port-link port-local');
        const configured = domains.some(domain => domain.url === port.url || domain.url === `${port.url}/`);
        link.title = configured ? 'Configured domain route' : port.publicUrl ? 'Declared URL; a configured route was not found' : 'Host-loopback port';
        const url = textElement('small', port.publicUrl ? `${port.url}${configured ? '' : ' · declared only'}` : `${port.url} · host only`, 'port-url');
        portsCell.append(link, url);
      }); else if (!domains.length) { portsCell.textContent = 'No domain'; portsCell.classList.add('no-ports'); }
      const actionCell = document.createElement('td'); const actions = document.createElement('div'); actions.className = 'row-actions';
      actions.append(makeAction('Inspect', inspectInstance, item));
      if (status === 'running') { actions.append(makeAction('Snapshot', snapshotInstance, item)); actions.append(makeAction('Stop', changeState, item, 'action-danger')); }
      else if (status === 'stopped') actions.append(makeAction('Start', changeState, item));
      actionCell.append(actions); row.append(nameCell, stateCell, recoveryCell, loadCell, portsCell, trafficCell(item), actionCell);
      ['Instance', 'State', 'Recovery', 'Live load', 'Domains', 'Traffic', ''].forEach((label, index) => { row.children[index].dataset.label = label; });
      instanceBody.append(row);
    });
  }
  async function refresh({ sample = true } = {}) {
    if (refreshing) return;
    refreshing = true;
    clearNotice(); $('#refresh').disabled = true;
    try {
      const [project] = await Promise.all([runIncus(['project', 'get-current'], 10_000, null), readTelemetry()]);
      if (currentProject !== project.trim()) { cpuBaselines.clear(); memorySamples.clear(); }
      currentProject = project.trim();
      const parsed = parseJson(await runIncus(['list', '--format=json']), null);
      if (!Array.isArray(parsed)) throw new Error('Incus returned an unexpected instance list.');
      const diskUsage = new Map(instances.map(item => [instanceKey(item), { diskBytes: item.live?.diskBytes, diskError: item.live?.diskError }]));
      instances = parsed.map(item => ({ ...normalizeInstance(item), live: diskUsage.get(`${currentProject}/${item.name}`) || {} })).filter(item => item.name);
      updateCpuMetrics();
      updateStats(); render(); setConnection('online', 'Connected to Incus');
      if (sample) recordTraffic();
      void sampleDiskUsage();
      await installPendingProxies();
    } catch (error) {
      setConnection('error', 'Incus unavailable');
      const detail = error.problem === 'not-found' ? 'The incus command is unavailable to this Cockpit session.'
        : /permission|denied|socket/i.test(error.message || '') ? 'Incus denied access. Check this Cockpit account’s permission to use Incus.'
          : error.message || 'Could not read the Incus instance list.';
      showNotice(detail, true);
    } finally { $('#refresh').disabled = false; refreshing = false; }
  }
  async function installPendingProxies() {
    for (const [name, ports] of Object.entries(pendingProxies)) {
      const item = instances.find(entry => entry.name === name);
      if (!item?.ipv4) continue;
      for (const port of ports) {
        try {
          await runIncus(['config', 'device', 'add', name, `web-${port.host}`, 'proxy', `listen=tcp:127.0.0.1:${port.host}`, `connect=tcp:${item.ipv4}:${port.guest}`]);
        } catch (error) {
          if (!/already exists/i.test(error.message || '')) showNotice(`VM ${name} has address ${item.ipv4}, but port ${port.host} could not be mapped: ${error.message}`, true);
        }
      }
      delete pendingProxies[name];
    }
  }
  function confirmAction({ title, body, details = [], confirmLabel, danger = false, typeName = '' }) {
    return new Promise(resolve => {
      const dialog = $('#confirm-dialog'), ok = $('#confirm-ok'), cancel = $('#confirm-cancel'), input = $('#confirm-input'), form = $('#confirm-form');
      $('#confirm-title').textContent = title; $('#confirm-body').textContent = body;
      const list = $('#confirm-list'); list.replaceChildren(); list.hidden = details.length === 0;
      details.forEach(entry => list.append(textElement('li', entry.text || entry, entry.warn ? 'warn' : '')));
      $('#confirm-type').hidden = !typeName; $('#confirm-name').textContent = typeName; input.value = '';
      ok.textContent = confirmLabel; ok.className = `button ${danger ? 'button-danger' : 'button-primary'}`; ok.disabled = Boolean(typeName);
      const onInput = () => { ok.disabled = Boolean(typeName) && input.value.trim() !== typeName; };
      const finish = value => { cleanup(); if (dialog.open) dialog.close(); resolve(value); };
      const onSubmit = event => { event.preventDefault(); if (!ok.disabled) finish(true); };
      const onCancel = event => { event.preventDefault(); finish(false); };
      const cleanup = () => { input.removeEventListener('input', onInput); form.removeEventListener('submit', onSubmit); cancel.removeEventListener('click', onCancel); dialog.removeEventListener('cancel', onCancel); };
      input.addEventListener('input', onInput); form.addEventListener('submit', onSubmit); cancel.addEventListener('click', onCancel); dialog.addEventListener('cancel', onCancel);
      dialog.showModal(); (typeName ? input : cancel).focus();
    });
  }
  async function poolDriver(pool) {
    if (!pool) return '';
    try { return parseJson(await runIncus(['storage', 'list', '--format=json'], 10_000, null), []).find(entry => entry.name === pool)?.driver || ''; }
    catch { return ''; }
  }
  async function changeState(item) {
    if (busy) return;
    const running = item.status.toLowerCase() === 'running';
    const serving = assignedDomains(item).map(domain => domain.name).concat(item.ports.filter(port => port.publicUrl).map(port => port.url));
    const approved = await confirmAction(running ? {
      title: `Stop “${item.name}”?`,
      body: 'The instance is shut down gracefully (up to 60 seconds) and stays stopped until you start it again.',
      details: serving.length ? [{ text: `It is serving ${serving.join(', ')}. Those sites go offline until it is started.`, warn: true }] : [],
      confirmLabel: 'Stop instance', danger: true, typeName: serving.length ? item.name : '',
    } : { title: `Start “${item.name}”?`, body: 'The instance is started with its saved configuration.', confirmLabel: 'Start instance' });
    if (!approved) return;
    try {
      busy = true; showNotice(`${running ? 'Stopping' : 'Starting'} ${item.name}…`);
      await runIncus(running ? ['stop', item.name, '--timeout=60'] : ['start', item.name]);
      await refresh(); showNotice(`${item.name} ${running ? 'stopped' : 'started'}.`);
    } catch (error) { showNotice(error.message || `Could not change ${item.name}'s state.`, true); }
    finally { busy = false; }
  }
  async function snapshotInstance(item) {
    if (busy) return;
    const snapshot = `before-change-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)}`;
    const driver = await poolDriver(item.specs.pool);
    const details = [{ text: 'Snapshots stay on the same drive as the instance. They help with mistakes, not with a drive failure.', warn: false }];
    if (driver === 'dir') details.push({ text: 'This storage pool uses the “dir” driver, so a snapshot is a full copy of the instance’s files and takes as much space as the instance itself.', warn: true });
    if (!await confirmAction({ title: `Snapshot “${item.name}”?`, body: `Creates the snapshot “${snapshot}”.`, details, confirmLabel: 'Create snapshot' })) return;
    try { busy = true; showNotice(`Creating snapshot for ${item.name}…`); await runIncus(['snapshot', 'create', item.name, snapshot]); await refresh(); showNotice(`Snapshot created: ${item.name}/${snapshot}`); }
    catch (error) { showNotice(error.message || `Could not snapshot ${item.name}.`, true); }
    finally { busy = false; }
  }
  async function inspectInstance(item) {
    $('#inspect-title').textContent = item.name;
    renderInspectSpecs(item);
    $('#inspect-output').textContent = 'Loading instance details…'; inspectDialog.showModal();
    try { $('#inspect-output').textContent = await runIncus(['info', item.name, '--show-log']) || 'No details returned.'; }
    catch (error) { $('#inspect-output').textContent = error.message || 'Could not inspect this instance.'; }
  }
  function renderInspectSpecs(item) {
    const grid = $('#inspect-spec-grid');
    grid.replaceChildren();
    const entries = [
      ['CPU limit', item.specs.cpu], ['Memory limit', item.specs.memory],
      ['Root disk', item.specs.disk], ['Storage pool', item.specs.pool || 'Not reported'],
      ['Profiles', item.specs.profiles], ['Base image', item.specs.image],
      ['Domains', assignedDomains(item).map(domain => domain.name).join(', ') || 'None configured'],
    ];
    const metrics = instanceMetrics(item);
    if (accessReady() && metrics) entries.push([`External HTTP · ${windowLabel()}`, `${metrics.http.external_requests.toLocaleString()} requests · ↓ ${formatBytes(metrics.http.received)} · ↑ ${formatBytes(metrics.http.sent)}`]);
    if (item.specs.architecture) entries.push(['Architecture', item.specs.architecture]);
    if (Number.isFinite(item.specs.memoryUsage) && Number.isFinite(item.specs.memoryTotal)) {
      entries.push(['Current memory use', `${formatBytes(item.specs.memoryUsage)} of ${formatBytes(item.specs.memoryTotal)}`]);
    }
    item.specs.devices.filter(device => !(device.type === 'disk' && device.path === '/')).forEach(device => {
      const detail = [device.type, device.path, device.size, device.pool, device.source, device.listen, device.connect].filter(Boolean).join(' · ');
      entries.push([`Device · ${device.name}`, detail || 'Configured']);
    });
    entries.forEach(([label, value]) => {
      const term = document.createElement('dt'); term.textContent = label;
      const description = document.createElement('dd'); description.textContent = String(value);
      grid.append(term, description);
    });
  }
  function parseRepo(value) {
    let url; try { url = new URL(value.trim()); } catch { throw new Error('Paste a valid https://github.com/owner/repository URL.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password) throw new Error('Only public HTTPS GitHub repository URLs are supported.');
    const parts = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    if (parts.length !== 2 || !/^[\w.-]+$/.test(parts[0]) || !/^[\w.-]+$/.test(parts[1].replace(/\.git$/, ''))) throw new Error('Use github.com/owner/repository.');
    const repo = parts[1].replace(/\.git$/, '');
    return { owner: parts[0], repo, url: `https://github.com/${parts[0]}/${repo}.git` };
  }
  function slug(value) { return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50); }
  function parsePorts(value) {
    if (!value.trim()) return [];
    const ports = value.split(',').map(part => {
      const match = part.trim().match(/^(\d{1,5}):(\d{1,5})$/);
      if (!match) throw new Error('Enter ports as host:guest, separated by commas, for example 18080:8080.');
      const host = Number(match[1]), guest = Number(match[2]);
      if (host < 1024 || host > 65535 || guest < 1 || guest > 65535) throw new Error('Host ports must be 1024–65535 and guest ports 1–65535.');
      return { host, guest };
    });
    if (new Set(ports.map(port => port.host)).size !== ports.length) throw new Error('Each host port must be unique.');
    return ports;
  }
  function deploymentInputs() {
    const repo = parseRepo($('#github-url').value);
    const requestedBranch = $('#github-branch').value.trim();
    if (!inspectedRepo || inspectedRepo.url !== repo.url || inspectedRepo.branch !== requestedBranch) throw new Error('Inspect this repository and branch before previewing the deployment.');
    const branch = $('#github-branch').value.trim();
    if (!/^[A-Za-z0-9._/-]{1,63}$/.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) throw new Error('Enter a valid Git branch name.');
    const name = $('#deployment-name').value.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,49}$/.test(name)) throw new Error('Use a deployment name beginning with a letter, followed by letters, numbers, or hyphens.');
    const ports = parsePorts($('#deploy-ports').value);
    if (!ports.length) throw new Error('Add at least one published host:guest port mapping.');
    if (!$('#deploy-ack').checked) throw new Error('Confirm that you trust this repository before continuing.');
    const choice = $('#deploy-layout').value;
    const layout = choice === 'auto' ? inspectedRepo.layout : choice;
    if (layout === 'compose' && !inspectedRepo.files.some(file => ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'].includes(file))) throw new Error('No root-level Compose file was detected in this repository branch.');
    if (layout === 'dockerfile' && !inspectedRepo.files.includes('Dockerfile')) throw new Error('No root-level Dockerfile was detected in this repository branch.');
    const hostname = $('#deploy-hostname').value.trim().toLowerCase();
    if (hostname && (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname))) throw new Error('Enter a valid hostname such as app.example.com.');
    if (hostname && ports.length !== 1) throw new Error('Use one published port per service hostname. Add separate hostnames for additional services.');
    return { ...repo, branch, name, ports, hostname, layout, files: inspectedRepo.files };
  }
  function cloudConfig(input) {
    const steps = [
      ['systemctl', 'enable', '--now', 'docker'],
      ['bash', '-lc', `git clone --depth 1 --branch '${input.branch}' -- '${input.url}' /opt/app`],
      input.layout === 'compose'
        ? ['bash', '-lc', 'cd /opt/app && docker compose up -d --build']
        : ['bash', '-lc', `cd /opt/app && docker build -t incus-app . && docker run -d --restart unless-stopped ${[...new Set(input.ports.map(port => port.guest))].map(guest => `-p 0.0.0.0:${guest}:${guest}`).join(' ')} --name incus-app incus-app`],
    ];
    return `#cloud-config\npackage_update: true\npackages:\n  - git\n  - docker.io\n  - docker-compose-v2\nruncmd:\n${steps.map(step => `  - [${step.map(value => JSON.stringify(value)).join(', ')}]`).join('\n')}\n`;
  }
  async function inspectRepo() {
    const status = $('#repo-inspect-status');
    try {
      const repo = parseRepo($('#github-url').value);
      let branch = $('#github-branch').value.trim();
      if (!/^[A-Za-z0-9._/-]{1,63}$/.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) throw new Error('Enter a valid Git branch name first.');
      inspectedRepo = null;
      $('#deploy-run').disabled = true;
      status.className = 'repo-inspect-status';
      status.textContent = 'Checking public GitHub repository…';
      $('#repo-inspect').disabled = true;
      const api = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
      const headers = ['-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
      const metadata = JSON.parse(await cockpit.spawn(['curl', '-fsSL', '--max-time', '15', ...headers, api], { err: 'message' }));
      if (branch === 'main' && metadata.default_branch && metadata.default_branch !== 'main') {
        branch = metadata.default_branch;
        $('#github-branch').value = branch;
      }
      const contents = JSON.parse(await cockpit.spawn(['curl', '-fsSL', '--max-time', '15', ...headers, `${api}/contents?ref=${encodeURIComponent(branch)}`], { err: 'message' }));
      if (!Array.isArray(contents)) throw new Error('GitHub did not return the repository root file listing. Check the branch name.');
      const files = contents.filter(file => file.type === 'file').map(file => file.name);
      const composeFiles = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
      const layout = composeFiles.some(file => files.includes(file)) ? 'compose' : files.includes('Dockerfile') ? 'dockerfile' : '';
      if (!layout) throw new Error('No supported root deployment file found. Add a Dockerfile or Docker Compose file at the repository root.');
      inspectedRepo = { url: repo.url, branch, layout, files };
      $('#deploy-layout').value = 'auto';
      status.className = 'repo-inspect-status is-ready';
      status.textContent = `${layout === 'compose' ? 'Docker Compose stack' : 'Dockerfile application'} detected · ${layout === 'compose' ? 'Compose services will run together in one VM.' : 'App will run in one VM.'}`;
      $('#deploy-run').disabled = true;
      $('#deploy-plan').hidden = true;
    } catch (error) {
      inspectedRepo = null;
      status.className = 'repo-inspect-status is-error';
      status.textContent = error.message || 'Could not inspect the GitHub repository.';
    } finally { $('#repo-inspect').disabled = false; }
  }
  function invalidateInspection() {
    inspectedRepo = null;
    $('#repo-inspect-status').className = 'repo-inspect-status';
    $('#repo-inspect-status').textContent = 'Repository or branch changed · inspect again before deploying.';
    $('#deploy-run').disabled = true;
    $('#deploy-plan').hidden = true;
  }
  function showDeployPreview() {
    try {
      const input = deploymentInputs();
      $('#deploy-plan-text').textContent = [
        `GitHub: ${input.url}`, `Branch: ${input.branch}`, `Deployment tag: ${input.name}`,
        `Layout: ${input.layout === 'compose' ? 'Compose stack in a single VM' : 'Dockerfile app in a single VM'}`,
        'Base: Ubuntu 24.04 cloud VM · 2 CPU · 4 GiB RAM · default profile',
        `Loopback only: ${input.ports.map(port => `127.0.0.1:${port.host} → VM:${port.guest}`).join(' · ')}`,
        ...(input.hostname ? [`Reserved URL: https://${input.hostname} (Caddy/DNS route not installed)`, `${input.hostname} { reverse_proxy 127.0.0.1:${input.ports[0].host} }`] : []),
        'Cloud-init will install Docker, clone the repo, and build/run it on first boot.', '', cloudConfig(input),
      ].join('\n');
      $('#deploy-plan').hidden = false; $('#deploy-error').hidden = true; $('#deploy-run').disabled = false;
    } catch (error) { $('#deploy-error').textContent = error.message; $('#deploy-error').hidden = false; $('#deploy-run').disabled = true; }
  }
  async function deployProject(event) {
    event?.preventDefault();
    if (busy || $('#deploy-run').disabled) return;
    let input; try { input = deploymentInputs(); } catch (error) { $('#deploy-error').textContent = error.message; $('#deploy-error').hidden = false; return; }
    const args = [
      'launch', 'images:ubuntu/24.04/cloud', input.name, '--vm',
      '--config', 'limits.cpu=2', '--config', 'limits.memory=4GiB', '--config', `cloud-init.user-data=${cloudConfig(input)}`,
      '--config', `user.cockpit-incus.deployment=${input.name}`, '--config', `user.cockpit-incus.source=${input.url}`,
      '--config', `user.cockpit-incus.branch=${input.branch}`, '--config', `user.cockpit-incus.layout=${input.layout}`,
      ...(input.hostname ? ['--config', `user.cockpit-incus.url=https://${input.hostname}`] : []),
    ];
    try {
      busy = true; $('#deploy-run').disabled = true; $('#deploy-error').hidden = true;
      showNotice(`Creating ${input.name} VM and preparing the project…`);
      await runIncus(args);
      pendingProxies[input.name] = input.ports;
      deployDialog.close();
      showNotice(`VM ${input.name} launched. First-boot GitHub setup is running; loopback port mappings will attach when it receives an address.`);
      await refresh();
    } catch (error) {
      $('#deploy-error').textContent = error.message || `Could not create ${input.name}.`;
      $('#deploy-error').hidden = false; showNotice(`Could not create ${input.name}: ${error.message}`, true);
    } finally { busy = false; $('#deploy-run').disabled = false; }
  }
  function updateName() {
    try { $('#deployment-name').value = slug(parseRepo($('#github-url').value).repo); } catch { /* URL is incomplete. */ }
  }
  function closeDeploy() { deployDialog.close(); }

  $('#launch-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !event.currentTarget.reportValidity()) return;
    const name = $('#instance-name').value.trim();
    const args = ['launch', $('#image').value, name, '--config', 'limits.cpu=2', '--config', 'limits.memory=2GiB'];
    if ($('#instance-type').value === 'virtual-machine') args.push('--vm');
    try { busy = true; $('#launch').disabled = true; showNotice(`Launching ${name}…`); await runIncus(args); $('#instance-name').value = ''; await refresh(); showNotice(`${name} launched.`); }
    catch (error) { showNotice(error.message || `Could not launch ${name}.`, true); }
    finally { busy = false; $('#launch').disabled = false; }
  });
  $('#open-deploy').addEventListener('click', () => { $('#deploy-error').hidden = true; $('#deploy-plan').hidden = true; $('#deploy-run').disabled = true; deployDialog.showModal(); });
  $('.deploy-close').addEventListener('click', closeDeploy);
  $('#deploy-cancel').addEventListener('click', closeDeploy);
  $('#deploy-preview').addEventListener('click', showDeployPreview);
  $('#deploy-back').addEventListener('click', () => { $('#deploy-plan').hidden = true; $('#deploy-run').disabled = true; });
  $('#deploy-form').addEventListener('submit', deployProject);
  $('#repo-inspect').addEventListener('click', inspectRepo);
  $('#github-url').addEventListener('input', () => { updateName(); invalidateInspection(); });
  $('#github-branch').addEventListener('input', invalidateInspection);
  $('#refresh').addEventListener('click', () => refresh());
  filter.addEventListener('input', render);
  $('#traffic-window').addEventListener('change', () => { renderTraffic(); render(); });
  $('#traffic-view').addEventListener('change', renderTraffic);
  $('.dialog-close:not(.deploy-close)').addEventListener('click', () => inspectDialog.close());
  inspectDialog.addEventListener('click', event => { if (event.target === inspectDialog) inspectDialog.close(); });
  deployDialog.addEventListener('click', event => { if (event.target === deployDialog) closeDeploy(); });
  renderTraffic(); refresh(); window.setInterval(() => refresh({ sample: true }), pollEvery);
})();
