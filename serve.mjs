import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {dirname, extname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8'};
const port = Number(process.env.PORT || 4173);
const [flag, modelPath] = process.argv.slice(2);
if (flag && (flag !== '--agent' || !modelPath)) throw new Error('사용법: node serve.mjs --agent 모델파일');
const localModel = modelPath && await readFile(resolve(modelPath));
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    if (localModel) {
      const js = {'Content-Type':mime['.js'], 'Cache-Control':'no-store'};
      if (path === '/agent-kit/local-model.js') return res.writeHead(200, js).end(localModel);
      if (path === '/agent-kit/registry.js' && !url.searchParams.has('installed')) {
        return res.writeHead(200, js).end("import installed from './registry.js?installed';\n" +
          "import local from './local-model.js';\nexport default [...installed, local];");
      }
      if (path === '/account-config.js') return res.writeHead(200, js).end("export const accountConfig = {url:'', publishableKey:''};");
    }
    const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(root + sep) || !mime[extname(file)] || path.split('/').some(part => part.startsWith('.'))) throw new Error();
    const data = await readFile(file);
    res.writeHead(200, {'Content-Type':mime[extname(file)], 'Cache-Control':'no-store'}).end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log('http://127.0.0.1:' + port));
