// Vigia do OmniRoute: se a porta 20128 não responder, sobe o servidor de novo (modo daemon).
// Roda no login (pasta Inicializar) e a cada 2 minutos (tarefa agendada "OmniRoute Vigia").
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const PORTA = 20128;
const NODE = process.execPath;
const OMNI = 'I:\\OMNIROUTE\\runtime\\node_modules\\omniroute\\bin\\omniroute.mjs';
const LOG = 'I:\\OMNIROUTE\\vigia.log';

const noAr = () => new Promise((ok) => {
  const s = net.connect({ host: '127.0.0.1', port: PORTA });
  s.setTimeout(3000);
  s.on('connect', () => { s.destroy(); ok(true); });
  s.on('error', () => ok(false));
  s.on('timeout', () => { s.destroy(); ok(false); });
});

if (!(await noAr())) {
  fs.appendFileSync(LOG, `${new Date().toISOString()} fora do ar: subindo\n`);
  const p = spawn(NODE, [OMNI, 'serve', '--daemon', '--no-open', '--no-tray'], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: 'I:\\OMNIROUTE',
  });
  p.unref();
}
