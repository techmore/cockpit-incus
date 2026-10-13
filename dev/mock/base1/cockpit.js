// Minimal stand-in for Cockpit's API, with fake data, for local visual checks only.
(function () {
  const now = Date.now(), day = 86400000;
  const inst = (name, status, ip, extra = {}) => ({
    name, status, type: extra.vm ? 'virtual-machine' : 'container', description: extra.description || '',
    profiles: ['default'], architecture: 'x86_64', snapshots: extra.snapshots || [],
    config: Object.assign({'image.os': 'Ubuntu', 'image.release': '24.04', 'limits.cpu': extra.cpu || ''}, extra.config || {}),
    expanded_config: {}, devices: {}, expanded_devices: {root: {type: 'disk', path: '/', pool: 'default', size: extra.disk || ''}},
    state: status === 'Running' ? {memory: {usage: 900e6, total: 4e9}, network: {eth0: {addresses: [{family: 'inet', scope: 'global', address: ip}]}}} : null,
  });
  const list = [
    inst('daedalus-prod', 'Running', '10.96.131.185', {config: {'user.cockpit-incus.backup': new Date(now - 2 * day).toISOString()}}),
    inst('daedalus-scanner-linux', 'Running', '10.96.131.85'),
    inst('energy-monitor', 'Running', '10.96.131.89'),
    inst('homeboard', 'Running', '10.96.131.50', {snapshots: [{name: 'before-change', created_at: new Date(now - 3 * day).toISOString()}]}),
    inst('pin-telemetry', 'Running', '10.96.131.97'),
    inst('rupert', 'Running', '10.96.131.8'),
    inst('rupert-db', 'Running', '10.96.131.127', {vm: true, snapshots: [{name: 'old', created_at: new Date(now - 40 * day).toISOString()}]}),
    inst('sonder', 'Running', '10.96.131.52'),
    inst('swartzit', 'Running', '10.96.131.51', {config: {'user.cockpit-incus.backup': new Date(now - 1 * day).toISOString()}}),
    inst('swartzit-db', 'Stopped', ''),
    inst('tmrootgw', 'Running', '10.96.131.2'),
  ];
  const win = (req) => ({http: {external_requests: req, received: req * 3000, sent: req * 52000}, network_seconds: 86400, received: req * 90000, sent: req * 300000, memory_percent: 31, cpu_cores: 0.12, cpu_percent: 6.1});
  const mk = (n, host, req, listeners) => ({name: host, url: 'https://' + host, listeners: listeners || [':443'], instances: ['default/' + n], targets: [{listeners: [':443'], upstream: '10.96.131.50:3000', guest_ports: [3000]}], dns: {status: 'Resolved', addresses: ['203.0.113.7']}, windows: {86400: {external_requests: req, public_requests: req, gateway_requests: 0, local_requests: 0, unknown_requests: 0, received: req * 900, sent: req * 40000, errors5: 0, average_ms: 41}}});
  const telemetry = () => JSON.stringify({version: 1, generated_at: Date.now(), routes_updated_at: Date.now(), access: {available: true, configured: true}, windows: {86400: {coverage_seconds: 86400, chart: Array.from({length: 36}, (_, i) => [3e6 + i * 1e5, 9e6 + i * 2e5, 20 + (i * 7) % 40, 4e4 * (1 + i % 5), 9e5 * (1 + i % 7)]), http: {external_requests: 5659, received: 6e6, sent: 2.1e8, errors5: 0, average_ms: 43, public_requests: 5659, gateway_requests: 0, local_requests: 12, unknown_requests: 0}, network: {received: 3.4e9, sent: 1.2e10}}},
    domains: [mk('homeboard', 'tasks.example.org', 1240), mk('rupert', 'rupert.example.org', 310), mk('swartzit', 'swartzit.example.org', 88), mk('daedalus-prod', 'daedalus.example.net', 4021)],
    instances: Object.fromEntries(list.map((i, k) => ['default/' + i.name, {windows: {86400: win(100 + k * 37)}}]))});
  function thenable(promise) { promise.close = () => {}; return promise; }
  window.cockpit = {
    spawn(args) {
      const a = args.filter(x => x !== '--force-local').join(' ');
      let out = '';
      if (a.includes('project get-current')) out = 'default\n';
      else if (a.includes('storage list')) out = JSON.stringify([{name: 'default', driver: 'dir'}]);
      else if (a.includes('list --format=json')) out = JSON.stringify(list);
      else if (a.includes(' info ')) out = 'Name: sample\nStatus: RUNNING\n';
      else out = '';
      window.__spawned = (window.__spawned || []).concat([a]);
      return thenable(new Promise(r => setTimeout(() => r(out), 30)));
    },
    file(path) { return {read: () => path.includes('telemetry') ? Promise.resolve(telemetry()) : Promise.reject(new Error('nofile'))}; },
  };
})();
