/* Shared, same-origin tracking. No account IDs, cookies, query strings or IPs. */
(() => {
  'use strict';
  if (window.ProjectAnalytics) return;
  const idle = 30 * 60 * 1000;
  let memoryVisit, lastPage = '', lastPageAt = 0;
  const excluded = path => /^\/(?:admin|login|logout|oauth2?|auth|api|project-analytics)(?:\/|$)/.test(path);
  function visit() {
    const now = Date.now();
    let record;
    try { record = JSON.parse(sessionStorage.getItem('project-analytics-visit') || 'null'); } catch {}
    record ||= memoryVisit;
    if (!record || now - record.at > idle || now < record.at) record = { id: crypto.randomUUID(), at: now };
    record.at = now;
    memoryVisit = record;
    try { sessionStorage.setItem('project-analytics-visit', JSON.stringify(record)); } catch {}
    return record.id;
  }
  function send(path, event) {
    if (navigator.doNotTrack === '1' || navigator.globalPrivacyControl || navigator.webdriver || excluded(location.pathname)) return;
    let referrer = '';
    try { const ref = new URL(document.referrer); if (ref.hostname !== location.hostname) referrer = ref.hostname; } catch {}
    const data = { path, event: !!event, session: visit(), referrer, width: Math.min(10000, screen.width || innerWidth), title: event ? path : location.hostname };
    fetch('/project-analytics/collect', {method: 'POST', headers: {'Content-Type': 'application/json'}, credentials: 'omit', keepalive: true, body: JSON.stringify(data)}).catch(() => {});
  }
  function page(path = location.pathname) {
    if (typeof path !== 'string' || !path.startsWith('/') || excluded(path)) return;
    path = path.split(/[?#]/)[0];
    const now = Date.now();
    if (path === lastPage && now - lastPageAt < 1500) return;
    lastPage = path; lastPageAt = now;
    send(path, false);
  }
  window.ProjectAnalytics = Object.freeze({page, event: name => { if (/^[a-z][a-z0-9_:-]{0,79}$/.test(name)) send(name, true); }});
  window.addEventListener('project:page', event => page(event.detail));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => page(), {once: true});
  else page();
})();
