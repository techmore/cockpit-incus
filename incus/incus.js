(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const instanceBody = $('#instances');
  const connection = $('#connection');
  const notice = $('#notice');
  const filter = $('#filter');
  const dialog = $('#inspect-dialog');
  let instances = [];
  let busy = false;

  function setConnection(state, message) {
    connection.className = `connection ${state ? `is-${state}` : ''}`;
    connection.lastElementChild.textContent = message;
  }

  function showNotice(message, isError = false) {
    notice.textContent = message;
    notice.className = `notice${isError ? ' is-error' : ''}`;
    notice.hidden = false;
  }

  function clearNotice() {
    notice.hidden = true;
    notice.textContent = '';
  }

  function runIncus(args) {
    return cockpit.spawn(['incus', '--force-local', ...args], { err: 'message' }).catch((error, stderr) => {
      const wrapped = new Error(stderr || error.message || 'Incus command failed.');
      Object.assign(wrapped, error);
      if (stderr) wrapped.message = stderr;
      throw wrapped;
    });
  }

  function normalizeInstance(item) {
    return {
      name: String(item.name || item.Name || ''),
      status: String(item.status || item.Status || 'Unknown'),
      type: String(item.type || item.Type || 'container'),
      ipv4: String(item.ipv4 || item.IPv4 || findIPv4(item.state?.network) || ''),
      description: String(item.description || item.Description || ''),
    };
  }

  function findIPv4(networks) {
    if (!networks || typeof networks !== 'object') return '';
    for (const network of Object.values(networks)) {
      const address = (network.addresses || []).find(item => item.family === 'inet' && item.scope === 'global');
      if (address) return address.address;
    }
    return '';
  }

  function visibleInstances() {
    const needle = filter.value.trim().toLowerCase();
    return instances.filter(instance => instance.name.toLowerCase().includes(needle));
  }

  function updateStats() {
    $('#stat-total').textContent = instances.length;
    $('#stat-running').textContent = instances.filter(x => x.status.toLowerCase() === 'running').length;
    $('#stat-stopped').textContent = instances.filter(x => x.status.toLowerCase() === 'stopped').length;
    $('#stat-vms').textContent = instances.filter(x => x.type.toLowerCase().includes('virtual')).length;
  }

  function makeAction(label, action, instance, extraClass = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `action ${extraClass}`.trim();
    button.textContent = label;
    button.addEventListener('click', () => action(instance));
    return button;
  }

  function render() {
    instanceBody.replaceChildren();
    const rows = visibleInstances();
    $('#empty').hidden = instances.length !== 0;
    $('#no-match').hidden = instances.length === 0 || rows.length !== 0;

    rows.forEach(instance => {
      const row = document.createElement('tr');
      const nameCell = document.createElement('td');
      const name = document.createElement('span');
      name.className = 'instance-name';
      name.textContent = instance.name;
      nameCell.append(name);
      if (instance.description) {
        const description = document.createElement('small');
        description.className = 'instance-sub';
        description.textContent = instance.description;
        nameCell.append(description);
      }

      const stateCell = document.createElement('td');
      const state = document.createElement('span');
      const normalizedState = instance.status.toLowerCase();
      state.className = `state ${normalizedState === 'running' ? 'state-running' : normalizedState === 'stopped' ? 'state-stopped' : 'state-error'}`;
      state.textContent = instance.status;
      stateCell.append(state);

      const typeCell = document.createElement('td');
      const type = document.createElement('span');
      type.className = 'type-pill';
      type.textContent = instance.type.toLowerCase().includes('virtual') ? 'Virtual machine' : 'Container';
      typeCell.append(type);

      const ipCell = document.createElement('td');
      ipCell.className = 'ip';
      ipCell.textContent = instance.ipv4 || '—';

      const actionCell = document.createElement('td');
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.append(makeAction('Inspect', inspectInstance, instance));
      if (normalizedState === 'running') {
        actions.append(makeAction('Snapshot', snapshotInstance, instance));
        actions.append(makeAction('Stop', changeState, instance, 'action-danger'));
      } else if (normalizedState === 'stopped') {
        actions.append(makeAction('Start', changeState, instance));
      }
      actionCell.append(actions);
      row.append(nameCell, stateCell, typeCell, ipCell, actionCell);
      instanceBody.append(row);
    });
  }

  async function refresh() {
    clearNotice();
    $('#refresh').disabled = true;
    try {
      const output = await runIncus(['list', '--format=json']);
      const parsed = JSON.parse(output || '[]');
      if (!Array.isArray(parsed)) throw new Error('Incus returned an unexpected instance list.');
      instances = parsed.map(normalizeInstance).filter(item => item.name);
      updateStats();
      render();
      setConnection('online', 'Connected to Incus');
    } catch (error) {
      instances = [];
      updateStats();
      render();
      setConnection('error', 'Incus unavailable');
      const detail = error.problem === 'not-found'
        ? 'The incus command is not installed or is not available to the Cockpit session.'
        : error.exit_status === 1 && /permission|denied|socket/i.test(error.message || '')
          ? 'Incus denied access. Check that this signed-in Cockpit account has permission to use Incus.'
          : error.message || 'Could not read the Incus instance list.';
      showNotice(detail, true);
    } finally {
      $('#refresh').disabled = false;
    }
  }

  async function changeState(instance) {
    if (busy) return;
    const running = instance.status.toLowerCase() === 'running';
    const action = running ? 'stop' : 'start';
    if (!window.confirm(`${running ? 'Stop' : 'Start'} “${instance.name}”?`)) return;
    try {
      busy = true;
      showNotice(`${running ? 'Stopping' : 'Starting'} ${instance.name}…`);
      const args = running ? ['stop', instance.name, '--timeout=60'] : ['start', instance.name];
      await runIncus(args);
      await refresh();
      showNotice(`${instance.name} ${running ? 'stopped' : 'started'}.`);
    } catch (error) {
      showNotice(error.message || `Could not ${action} ${instance.name}.`, true);
    } finally {
      busy = false;
    }
  }

  async function snapshotInstance(instance) {
    if (busy) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const snapshotName = `before-change-${timestamp}`;
    if (!window.confirm(`Create snapshot “${snapshotName}” for “${instance.name}”?`)) return;
    try {
      busy = true;
      showNotice(`Creating snapshot for ${instance.name}…`);
      await runIncus(['snapshot', 'create', instance.name, snapshotName]);
      showNotice(`Snapshot created: ${instance.name}/${snapshotName}`);
    } catch (error) {
      showNotice(error.message || `Could not snapshot ${instance.name}.`, true);
    } finally {
      busy = false;
    }
  }

  async function inspectInstance(instance) {
    $('#inspect-title').textContent = instance.name;
    $('#inspect-output').textContent = 'Loading instance details…';
    dialog.showModal();
    try {
      const output = await runIncus(['info', instance.name, '--show-log']);
      $('#inspect-output').textContent = output || 'No details returned.';
    } catch (error) {
      $('#inspect-output').textContent = error.message || 'Could not inspect this instance.';
    }
  }

  $('#launch-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !event.currentTarget.reportValidity()) return;
    const name = $('#instance-name').value.trim();
    const image = $('#image').value;
    const type = $('#instance-type').value;
    const args = ['launch', image, name, '--config', 'limits.cpu=2', '--config', 'limits.memory=2GiB'];
    if (type === 'virtual-machine') args.push('--vm');
    const button = $('#launch');
    try {
      busy = true;
      button.disabled = true;
      clearNotice();
      showNotice(`Launching ${name}…`);
      await runIncus(args);
      $('#instance-name').value = '';
      await refresh();
      showNotice(`${name} launched.`);
    } catch (error) {
      showNotice(error.message || `Could not launch ${name}.`, true);
    } finally {
      busy = false;
      button.disabled = false;
    }
  });

  $('#refresh').addEventListener('click', refresh);
  filter.addEventListener('input', render);
  $('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
  refresh();
})();
