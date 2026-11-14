// Gera dist/SyncReact-vX.Y.Z.zip com os arquivos versionados da extensão.
// Se existir src/config.js (fora do git), ele entra no zip: a release já sai apontando para o servidor.
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const out = path.join(ROOT, 'dist', `SyncReact-v${version}.zip`);
mkdirSync(path.dirname(out), { recursive: true });

const run = (...args) => execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });
run('archive', '--format=zip', '--prefix=SyncReact/', '-o', out, 'HEAD', 'manifest.json', 'src', 'popup', 'icons');

const config = path.join(ROOT, 'src', 'config.js');
if (existsSync(config) && statSync(config).size > 0) {
  // git archive não aceita caminho de destino para arquivo fora do git; o zip é refeito com ele dentro de src/
  const tmp = path.join(ROOT, 'dist', '.pack');
  execFileSync('powershell', ['-NoProfile', '-Command', `
    $ErrorActionPreference = 'Stop'
    Remove-Item -Recurse -Force '${tmp}' -ErrorAction SilentlyContinue
    Expand-Archive -LiteralPath '${out}' -DestinationPath '${tmp}'
    Copy-Item -LiteralPath '${config}' -Destination '${path.join(tmp, 'SyncReact', 'src')}'
    Remove-Item -LiteralPath '${out}'
    Compress-Archive -Path '${path.join(tmp, 'SyncReact')}' -DestinationPath '${out}'
    Remove-Item -Recurse -Force '${tmp}'
  `], { stdio: 'inherit' });
  console.log('com servidor (src/config.js)');
} else {
  console.log('sem servidor: falta src/config.js, a extensão abre no modo local');
}
console.log(path.relative(ROOT, out));
