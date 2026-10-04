// Exercise production static-file handlers against a temporary public/private tree.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Script, createContext } from 'node:vm';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(tmpdir(), 'doge-proxy-test-'));
const root = path.join(temp, 'project');
let failed = 0;
function check(name, condition) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name);
  if (!condition) failed++;
}
try {
  fs.mkdirSync(path.join(root, 'web'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'doge-ide.html'), 'INDEX');
  fs.writeFileSync(path.join(root, 'web', 'asset.txt'), 'ASSET');
  fs.writeFileSync(path.join(root, '.git', 'config'), 'PRIVATE');
  fs.writeFileSync(path.join(temp, 'outside.txt'), 'OUTSIDE');
  let handler, listenArgs;
  const source = fs.readFileSync(path.join(repo, 'proxy.mjs'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace("const __dirname = fileURLToPath(new URL('.', import.meta.url));", 'const __dirname = ' + JSON.stringify(root) + ';');
  const context = createContext({
    ...fs, ...path, URL, Buffer, process,
    createServer: callback => { handler = callback; return { listen: (...args) => { listenArgs = args; } }; },
    console: { log() {} }
  });
  new Script(source).runInContext(context);
  check('Node proxy listens only on loopback', listenArgs[1] === '127.0.0.1');
  async function get(url) {
    let status = 200, body = '';
    const res = { setHeader() {}, writeHead: code => { status = code; }, end: data => { body = String(data || ''); } };
    await handler({ method: 'GET', url, headers: {} }, res);
    return { status, body };
  }
  for (const url of ['/', '/web/asset.txt']) {
    check('Node serves public asset ' + url, (await get(url)).status === 200);
  }
  for (const url of ['/../outside.txt', '/web/../../outside.txt', '/.git/config', '/web/%2e%2e/.git/config']) {
    const response = await get(url);
    check('Node rejects private/traversal path ' + url, response.status >= 400 && !/PRIVATE|OUTSIDE/.test(response.body));
  }

  const pythonTest = `
import importlib.util, http.server, http.client, json, sys, threading
spec = importlib.util.spec_from_file_location('doge_proxy', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.DIR = sys.argv[2]
server = http.server.HTTPServer(('127.0.0.1', 0), module.ProxyHandler)
threading.Thread(target=server.serve_forever, daemon=True).start()
out = []
try:
    for url in ['/', '/web/asset.txt', '/../outside.txt', '/web/../../outside.txt', '/.git/config', '/web/%2e%2e/.git/config']:
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
        connection.request('GET', url)
        response = connection.getresponse()
        out.append({'url': url, 'status': response.status, 'body': response.read().decode('utf-8')})
        connection.close()
finally:
    server.shutdown()
    server.server_close()
print(json.dumps(out))
`;
  const python = spawnSync('python', ['-B', '-c', pythonTest, path.join(repo, 'proxy.py'), root], { encoding: 'utf8' });
  if (python.status !== 0) throw new Error(python.stderr || 'Python handler test failed');
  for (const response of JSON.parse(python.stdout)) {
    const publicAsset = response.url === '/' || response.url === '/web/asset.txt';
    check('Python ' + (publicAsset ? 'serves ' : 'rejects ') + response.url,
      publicAsset ? response.status === 200 : response.status >= 400 && !/PRIVATE|OUTSIDE/.test(response.body));
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
if (failed) { console.error('Proxy regression: ' + failed + ' failed'); process.exitCode = 1; }
else console.log('Proxy regression: all passed');
