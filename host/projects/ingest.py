#!/usr/bin/env python3
"""Bounded same-origin relay to GoatCounter's count-only API."""
import json
import re
import threading
import time
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

CONFIG = Path('/etc/project-analytics/ingest.json')
TRACKER = Path('/usr/local/libexec/cockpit-incus/projects/tracker.js')
EXCLUDED = re.compile(r'^/(?:admin|login|logout|oauth2?|auth|api|project-analytics)(?:/|$)')
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')


class Server(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    def __init__(self, address, handler, config):
        self.config = config
        self.slots = threading.BoundedSemaphore(12)
        self.rates = OrderedDict()
        self.rate_lock = threading.Lock()
        super().__init__(address, handler)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def permit(self, host, session):
        now = int(time.monotonic() // 60)
        key = (host, session)
        with self.rate_lock:
            minute, count = self.rates.get(key, (now, 0))
            count = count + 1 if minute == now else 1
            self.rates[key] = (now, count)
            self.rates.move_to_end(key)
            while len(self.rates) > 4096:
                self.rates.popitem(last=False)
            return count <= 120


class Handler(BaseHTTPRequestHandler):
    server_version = 'ProjectAnalytics'
    sys_version = ''
    protocol_version = 'HTTP/1.0'
    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, *_args):
        pass  # No raw URLs, request headers, visitor identifiers or IPs in logs.

    def reply(self, status, body=b'', content_type='application/json'):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        if self.path.split('?', 1)[0] == '/project-analytics.js':
            self.reply(200, TRACKER.read_bytes(), 'text/javascript; charset=utf-8')
        elif self.path == '/health':
            self.reply(200, b'{"status":"ok"}')
        else:
            self.reply(404)

    def do_POST(self):
        if self.path != '/project-analytics/collect':
            return self.reply(404)
        host = self.headers.get('Host', '').lower()
        site = self.server.config.get('sites', {}).get(host)
        origin = self.headers.get('Origin', '')
        if not site or origin != 'https://' + host:
            return self.reply(403)
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size < 2 or size > 8192 or self.headers.get('Content-Type', '').split(';', 1)[0] != 'application/json':
                return self.reply(413)
            data = json.loads(self.rfile.read(size))
            path, session = data.get('path'), data.get('session')
            event = data.get('event') is True
            if not isinstance(path, str) or len(path) > 512 or not isinstance(session, str) or not UUID.fullmatch(session):
                return self.reply(400)
            if event:
                if not re.fullmatch(r'[a-z][a-z0-9_:-]{0,79}', path):
                    return self.reply(400)
            elif not path.startswith('/') or EXCLUDED.match(path) or any(c in path for c in ('?', '#', '\\', '\x00')):
                return self.reply(400)
            if not self.server.permit(host, session):
                return self.reply(429)
            ref = str(data.get('referrer') or '')[:255]
            if not re.fullmatch(r'[A-Za-z0-9.-]*', ref):
                ref = ''
            width = data.get('width')
            width = width if type(width) is int and 0 < width <= 10000 else 0
            hit = {'path': path, 'title': path if event else host, 'event': event,
                   'session': host + ':' + session, 'user_agent': self.headers.get('User-Agent', '')[:512],
                   'ref': ref, 'size': [width]}
            request = Request('http://127.0.0.1:14380/api/v0/count', method='POST',
                data=json.dumps({'hits': [hit]}).encode(),
                headers={'Content-Type': 'application/json', 'Host': site['vhost'],
                         'Authorization': 'Bearer ' + site['token']})
            with urlopen(request, timeout=4) as response:
                response.read(1024)
            self.reply(202)
        except (ValueError, TypeError, AttributeError):
            self.reply(400)
        except (URLError, OSError, TimeoutError):
            self.reply(503)


if __name__ == '__main__':
    config = json.loads(CONFIG.read_text())
    Server(('127.0.0.1', 14381), Handler, config).serve_forever()
