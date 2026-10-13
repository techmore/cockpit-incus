# Local UI testing

`mock/base1/cockpit.js` is a stand-in for Cockpit's JavaScript API with fake instances and telemetry, so the Incus
page can be viewed and clicked through without a host:

```bash
mkdir -p /tmp/ci-ui && cp -r incus /tmp/ci-ui/work && cp -r dev/mock/base1 /tmp/ci-ui/base1
cd /tmp/ci-ui && python3 -m http.server 8731 --bind 127.0.0.1   # open http://127.0.0.1:8731/work/index.html
```

It answers `incus project get-current`, `incus list --format=json`, `incus storage list` and the telemetry file.
Force a theme with `document.documentElement.dataset.theme = 'light' | 'dark'` in the browser console.
