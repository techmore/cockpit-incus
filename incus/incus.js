(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const instanceBody = $('#instances');
  const connection = $('#connection');
  const notice = $('#notice');
  const filter = $('#filter');
  const inspectDialog = $('#inspect-dialog');
  const deployDialog = $('#deploy-dialog');
  const historyKey = 'cockpit-incus-traffic-v1';
  const pollEvery = 30_000;
  const retention = 24 * 60 * 60 * 1000;
  let instances = [];
  let busy = false;
  let samples = loadSamples();
  let pendingProxies = {};
  let inspectedRepo = null;

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
  function runIncus(args) {
    return cockpit.spawn(['incus', '--force-local', ...args], { err: 'message' }).catch((error, stderr) => {
      const wrapped = new Error(stderr || error.message || 'Incus command failed.');
      Object.assign(wrapped, error);
      if (stderr) wrapped.message = stderr;
      throw wrapped;
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
    const current = Object.fromEntries(instances.filter(item => item.status.toLowerCase() === 'running').map(item => [item.name, networkCounters(item.raw)]));
    const previous = samples.at(-1);
    const delta = { received: 0, sent: 0 };
    if (previous) Object.entries(current).forEach(([name, counts]) => {
      const before = previous.instances?.[name];
      if (!before) return;
      delta.received += Math.max(0, counts.received - before.received);
      delta.sent += Math.max(0, counts.sent - before.sent);
    });
    samples.push({ t, instances: current, ...delta });
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
    const visible = samples.filter(sample => sample.t >= Date.now() - duration);
    const totals = visible.reduce((sum, sample) => ({ received: sum.received + sample.received, sent: sum.sent + sample.sent }), { received: 0, sent: 0 });
    $('#traffic-down').textContent = formatBytes(totals.received);
    $('#traffic-up').textContent = formatBytes(totals.sent);
    const first = visible[0]?.t;
    $('#traffic-sampled').textContent = samples.length > 1 ? `Samples cover ${Math.max(0, Math.round((Date.now() - first) / 60_000))} min · page must stay open` : 'Waiting for first sample…';
    const chart = $('#traffic-chart');
    chart.replaceChildren();
    const buckets = Array.from({ length: 36 }, () => ({ received: 0, sent: 0 }));
    visible.forEach(sample => {
      const index = Math.max(0, Math.min(35, Math.floor(((sample.t - (Date.now() - duration)) / duration) * 36)));
      buckets[index].received += sample.received;
      buckets[index].sent += sample.sent;
    });
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
      pair.title = `Bucket ${index + 1}: received ${formatBytes(bucket.received)}, sent ${formatBytes(bucket.sent)}`;
      pair.append(received, sent);
      chart.append(pair);
    });
  }
  function normalizeInstance(item) {
    return {
      raw: item, name: String(item.name || ''), status: String(item.status || 'Unknown'),
      type: String(item.type || 'container'),
      ipv4: findIPv4(item.state?.network) || item.expanded_devices?.eth0?.['ipv4.address'] || '',
      description: String(item.description || ''), group: itemConfig(item, 'user.cockpit-incus.deployment'),
      ports: getPortMappings(item),
    };
  }
  function visibleInstances() {
    const needle = filter.value.trim().toLowerCase();
    return instances.filter(item => `${item.name} ${item.group} ${item.ipv4}`.toLowerCase().includes(needle));
  }
  function updateStats() {
    $('#stat-total').textContent = instances.length;
    $('#stat-running').textContent = instances.filter(item => item.status.toLowerCase() === 'running').length;
    $('#stat-stopped').textContent = instances.filter(item => item.status.toLowerCase() === 'stopped').length;
    $('#stat-vms').textContent = instances.filter(item => item.type.toLowerCase().includes('virtual')).length;
  }
  function makeAction(label, action, item, extraClass = '') {
    const button = document.createElement('button');
    button.type = 'button'; button.className = `action ${extraClass}`.trim(); button.textContent = label;
    button.addEventListener('click', () => action(item));
    return button;
  }
  function render() {
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
      const typeCell = document.createElement('td'); const type = document.createElement('span');
      type.className = 'type-pill'; type.textContent = item.type.toLowerCase().includes('virtual') ? 'Virtual machine' : 'Container'; typeCell.append(type);
      const ipCell = document.createElement('td'); ipCell.className = 'ip'; ipCell.textContent = item.ipv4 || '—';
      const portsCell = document.createElement('td'); portsCell.className = 'ports-cell';
      if (item.ports.length) item.ports.forEach(port => {
        const link = document.createElement('a'); link.className = 'port-link'; link.textContent = `${port.hostPort} → ${port.guestPort}`;
        if (port.publicUrl) { link.href = port.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = `Caddy route needed: ${port.url}`; } else { link.classList.add('port-local'); link.title = 'Host-loopback only; configure Caddy to create a browser-accessible URL.'; }
        const url = document.createElement('small'); url.className = 'port-url'; url.textContent = port.publicUrl ? `${port.url} · Caddy route needed` : `${port.url} · host only`; portsCell.append(link, url);
      }); else { portsCell.textContent = '—'; portsCell.classList.add('no-ports'); }
      const actionCell = document.createElement('td'); const actions = document.createElement('div'); actions.className = 'row-actions';
      actions.append(makeAction('Inspect', inspectInstance, item));
      if (status === 'running') { actions.append(makeAction('Snapshot', snapshotInstance, item)); actions.append(makeAction('Stop', changeState, item, 'action-danger')); }
      else if (status === 'stopped') actions.append(makeAction('Start', changeState, item));
      actionCell.append(actions); row.append(nameCell, stateCell, typeCell, ipCell, portsCell, actionCell); instanceBody.append(row);
    });
  }
  async function refresh({ sample = true } = {}) {
    clearNotice(); $('#refresh').disabled = true;
    try {
      const parsed = parseJson(await runIncus(['list', '--format=json']), null);
      if (!Array.isArray(parsed)) throw new Error('Incus returned an unexpected instance list.');
      instances = parsed.map(normalizeInstance).filter(item => item.name);
      updateStats(); render(); setConnection('online', 'Connected to Incus');
      if (sample) recordTraffic();
      await installPendingProxies();
    } catch (error) {
      setConnection('error', 'Incus unavailable');
      const detail = error.problem === 'not-found' ? 'The incus command is unavailable to this Cockpit session.'
        : /permission|denied|socket/i.test(error.message || '') ? 'Incus denied access. Check this Cockpit account’s permission to use Incus.'
          : error.message || 'Could not read the Incus instance list.';
      showNotice(detail, true);
    } finally { $('#refresh').disabled = false; }
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
  async function changeState(item) {
    if (busy) return;
    const running = item.status.toLowerCase() === 'running';
    if (!window.confirm(`${running ? 'Stop' : 'Start'} “${item.name}”?`)) return;
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
    if (!window.confirm(`Create snapshot “${snapshot}” for “${item.name}”?`)) return;
    try { busy = true; showNotice(`Creating snapshot for ${item.name}…`); await runIncus(['snapshot', 'create', item.name, snapshot]); showNotice(`Snapshot created: ${item.name}/${snapshot}`); }
    catch (error) { showNotice(error.message || `Could not snapshot ${item.name}.`, true); }
    finally { busy = false; }
  }
  async function inspectInstance(item) {
    $('#inspect-title').textContent = item.name; $('#inspect-output').textContent = 'Loading instance details…'; inspectDialog.showModal();
    try { $('#inspect-output').textContent = await runIncus(['info', item.name, '--show-log']) || 'No details returned.'; }
    catch (error) { $('#inspect-output').textContent = error.message || 'Could not inspect this instance.'; }
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
        : ['bash', '-lc', `cd /opt/app && docker build -t incus-app . && docker run -d --restart unless-stopped -p 0.0.0.0:${input.ports[0].guest}:${input.ports[0].guest} --name incus-app incus-app`],
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
        'Base: Ubuntu 24.04 VM · 2 CPU · 4 GiB RAM · default profile',
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
      'launch', 'images:ubuntu/24.04', input.name, '--vm',
      '--config', 'limits.cpu=2', '--config', 'limits.memory=4GiB', '--config', `user.user-data=${cloudConfig(input)}`,
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
  $('#traffic-window').addEventListener('change', renderTraffic);
  $('.dialog-close:not(.deploy-close)').addEventListener('click', () => inspectDialog.close());
  inspectDialog.addEventListener('click', event => { if (event.target === inspectDialog) inspectDialog.close(); });
  deployDialog.addEventListener('click', event => { if (event.target === deployDialog) closeDeploy(); });
  renderTraffic(); refresh(); window.setInterval(() => refresh({ sample: true }), pollEvery);
})();
