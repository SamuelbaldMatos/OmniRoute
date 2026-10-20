#!/usr/bin/env node
// Testa os combos do OmniRoute com chamadas reais (/v1/messages) e sai com código ≠ 0 se algum falhar ou vier vazio.
//
//   node testar-combos.mjs                 pinga todos os combos visíveis (texto; combos de código também com ferramenta)
//   node testar-combos.mjs --alvos         pinga cada provedor/modelo de cada combo, direto (sem o combo)
//   node testar-combos.mjs --so a,b        restringe aos combos (ou alvos) cujo nome contém a ou b
//   node testar-combos.mjs --json saida.json   grava a tabela também em JSON
//   node testar-combos.mjs --alvos --extra p/m,p/m   inclui candidatos fora dos combos
//   node testar-combos.mjs --grande        prompt de ~45 KB, max_tokens 6000, nos combos de revisão/raciocínio pesado
//                                          (caso real de 2026-10-20: revisor-seguranca deu 504 em 242 s, os dois xhigh estouraram)
//
// Credencial: lida de ~/.claude/profiles/omniroute/settings.json (nunca impressa).
// Lista de combos e alvos: API de gestão do OmniRoute, autenticada pelo token local da CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OMNI_BIN = 'I:/OMNIROUTE/runtime/node_modules/omniroute/bin/cli/utils/cliToken.mjs';
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const MODO_ALVOS = args.includes('--alvos');
const FILTRO = (opt('--so') || '').split(',').filter(Boolean);
const SAIDA_JSON = opt('--json');
const GRANDE = args.includes('--grande');
const MAX_TOKENS = Number(opt('--max-tokens') || (GRANDE ? 6000 : 600));
// Combos que recebem prompt grande no dia a dia (revisão de diff, leitura longa, decisão difícil).
const COMBOS_GRANDE = ['revisor-seguranca', 'revisor', 'complexo', 'maximo', 'contexto-longo', 'codigo-pesado'];
// Teto do cliente por chamada = o do fetch do Node (300 s sem cabeçalhos), igual aos clientes reais (Cerebro, scripts).
// O pior caso de cada combo foi dimensionado abaixo disso em aplicar-combos.mjs.
const TIMEOUT_MS = Number(opt('--timeout') || (MODO_ALVOS ? 150_000 : 300_000));
// A conta Codex é uma só: paralelismo alto no teste dispara o cooldown da conta inteira e falseia o resultado.
const PARALELO = Number(opt('--paralelo') || 2);

// Combos que fazem código (ou executam tarefa com ferramentas): testados também com tool_use.
const COM_FERRAMENTA = /^(codigo|codigo-pesado|executor-|orquestrador|gerente-jarvis|complexo|maximo|codex-auto-review)/;

function credencial() {
  const prof = path.join(os.homedir(), '.claude/profiles/omniroute/settings.json');
  const bruto = fs.readFileSync(prof, 'utf8');
  const env = JSON.parse(bruto.charCodeAt(0) === 0xfeff ? bruto.slice(1) : bruto).env || {};
  const url = new URL(env.ANTHROPIC_BASE_URL || 'http://127.0.0.1:20128');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('OmniRoute deve ser local.');
  const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
  if (!token) throw new Error('Credencial do OmniRoute ausente no perfil.');
  return { url: url.origin, token };
}

async function listarCombos(base) {
  const { getCliToken, CLI_TOKEN_HEADER } = await import('file:///' + OMNI_BIN);
  const r = await fetch(base + '/api/combos', { headers: { [CLI_TOKEN_HEADER]: await getCliToken() } });
  if (!r.ok) throw new Error(`API de gestão respondeu HTTP ${r.status}`);
  return (await r.json()).combos;
}

const FERRAMENTA = {
  name: 'somar',
  description: 'Soma dois inteiros e devolve o resultado.',
  input_schema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] },
};

// ~45 KB de código plausível (um módulo de login repetido com variações), para pedir uma revisão de segurança.
function promptGrande() {
  const partes = [];
  for (let i = 0; partes.join('\n').length < 45_000; i++) partes.push([
    `// arquivo src/auth/sessao-${i}.js`,
    `export async function entrar${i}(req, res, db) {`,
    `  const { usuario, senha } = req.body;`,
    `  const linha = await db.get("SELECT id, hash, papel FROM usuarios WHERE nome = '" + usuario + "'");`,
    `  if (!linha || !(await comparar(senha, linha.hash))) return res.status(401).json({ erro: 'credenciais' });`,
    `  const token = assinar({ id: linha.id, papel: linha.papel }, process.env.SEGREDO || 'dev-${i}', { expiresIn: '${7 + i}d' });`,
    `  res.cookie('sessao', token, { httpOnly: ${i % 2 === 0}, sameSite: 'lax' });`,
    `  return res.json({ ok: true, papel: linha.papel, redirecionar: req.query.volta });`,
    `}`,
  ].join('\n'));
  return 'Faça uma revisão de segurança do código abaixo. Responda com no máximo 5 achados, um por linha, cada um com o risco e a correção.\n\n' + partes.join('\n');
}

async function chamar({ url, token }, modelo, comFerramenta) {
  const corpo = GRANDE
    ? { model: modelo, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: promptGrande() }] }
    : comFerramenta
    ? { model: modelo, max_tokens: MAX_TOKENS, tools: [FERRAMENTA],
        messages: [{ role: 'user', content: 'Use a ferramenta somar para calcular 17 + 25. Não responda de cabeça.' }] }
    : { model: modelo, max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: 'Responda em uma frase curta, em português: para que serve um teste automatizado?' }] };
  const t0 = Date.now();
  const linha = { modelo, ferramenta: comFerramenta, status: 0, ms: 0, respondeu: '', texto: 0, tool: false, stop: '', ok: false, erro: '' };
  try {
    const r = await fetch(url + '/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(corpo),
    });
    linha.status = r.status;
    const bruto = await r.text();
    linha.ms = Date.now() - t0;
    let d = {};
    try { d = JSON.parse(bruto); } catch { linha.erro = 'resposta não-JSON: ' + bruto.slice(0, 120); }
    if (!r.ok) { linha.erro = (d.error?.message || d.error?.type || bruto).toString().replace(/\s+/g, ' ').slice(0, 160); return linha; }
    linha.respondeu = d.model || '';
    const blocos = Array.isArray(d.content) ? d.content : [];
    linha.texto = blocos.filter(b => b.type === 'text').map(b => b.text || '').join('').trim().length;
    const usoTool = blocos.find(b => b.type === 'tool_use');
    linha.tool = !!usoTool;
    linha.stop = d.stop_reason || '';
    if (comFerramenta) {
      linha.ok = !!usoTool && usoTool.name === 'somar' && Number(usoTool.input?.a) + Number(usoTool.input?.b) === 42;
      if (!linha.ok) linha.erro = usoTool ? `tool_use com argumentos errados: ${JSON.stringify(usoTool.input).slice(0, 80)}` : (linha.texto ? 'respondeu sem chamar a ferramenta' : 'VAZIO');
    } else {
      linha.ok = linha.texto > 0;
      if (!linha.ok) linha.erro = `VAZIO (stop_reason=${linha.stop})`;
    }
  } catch (e) {
    linha.ms = Date.now() - t0;
    linha.erro = e.name === 'TimeoutError' ? `timeout do cliente (${TIMEOUT_MS} ms)` : String(e.message || e).slice(0, 160);
  }
  return linha;
}

async function emParalelo(itens, n, fn) {
  const saida = new Array(itens.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, async () => {
    while (i < itens.length) { const k = i++; saida[k] = await fn(itens[k], k); }
  }));
  return saida;
}

const cred = credencial();
const combos = await listarCombos(cred.url);
const casa = (nome) => !FILTRO.length || FILTRO.some(f => nome.includes(f));

let tarefas = [];
if (MODO_ALVOS) {
  const vistos = new Map();
  for (const c of combos) for (const m of c.models || []) {
    if (m.kind !== 'model' || !m.model) continue;
    const e = vistos.get(m.model) || { modelo: m.model, combos: [], ferramenta: false };
    e.combos.push(c.name); if (COM_FERRAMENTA.test(c.name)) e.ferramenta = true;
    vistos.set(m.model, e);
  }
  // --extra p/m,p/m: candidatos que ainda não estão em combo nenhum (testados com e sem ferramenta).
  for (const m of (opt('--extra') || '').split(',').filter(Boolean))
    if (!vistos.has(m)) vistos.set(m, { modelo: m, combos: ['(candidato)'], ferramenta: true });
  for (const e of vistos.values()) if (casa(e.modelo)) {
    tarefas.push({ ...e, comFerramenta: false });
    if (e.ferramenta) tarefas.push({ ...e, comFerramenta: true });
  }
} else {
  for (const c of combos) if (!c.isHidden && casa(c.name)) {
    if (GRANDE) { if (COMBOS_GRANDE.includes(c.name)) tarefas.push({ modelo: c.name, combos: [c.name], comFerramenta: false }); continue; }
    tarefas.push({ modelo: c.name, combos: [c.name], comFerramenta: false });
    if (COM_FERRAMENTA.test(c.name)) tarefas.push({ modelo: c.name, combos: [c.name], comFerramenta: true });
  }
}
// O modelo local atende uma requisição por vez: alvos locais vão em série, no fim, para não falsear latência da nuvem.
const locais = tarefas.filter(t => t.modelo.startsWith('ollama'));
const nuvem = tarefas.filter(t => !t.modelo.startsWith('ollama'));

console.log(`${new Date().toISOString()}  ${MODO_ALVOS ? 'alvos' : GRANDE ? 'combos com prompt grande (~45 KB)' : 'combos'}: ${tarefas.length} chamadas, max_tokens=${MAX_TOKENS}`);
const imprimir = (l) => console.log(
  `${l.ok ? 'OK  ' : 'FALHA'} ${l.modelo.padEnd(44)} ${l.ferramenta ? 'tool' : 'txt '} HTTP ${String(l.status).padEnd(3)} ${String(l.ms).padStart(6)} ms  ${(l.respondeu || '-').padEnd(30)} ${l.ferramenta ? (l.tool ? 'tool_use' : '-') : `${l.texto} chars`}${l.erro ? '  ' + l.erro : ''}`);
const res = [
  ...await emParalelo(nuvem, PARALELO, async (t) => { const l = await chamar(cred, t.modelo, t.comFerramenta); l.combos = t.combos; imprimir(l); return l; }),
  ...await emParalelo(locais, 1, async (t) => { const l = await chamar(cred, t.modelo, t.comFerramenta); l.combos = t.combos; imprimir(l); return l; }),
];
const falhas = res.filter(l => !l.ok);
console.log(`\nResumo: ${res.length - falhas.length}/${res.length} OK${falhas.length ? '; falharam: ' + falhas.map(l => `${l.modelo}${l.ferramenta ? '[tool]' : ''}`).join(', ') : ''}`);
if (SAIDA_JSON) fs.writeFileSync(SAIDA_JSON, JSON.stringify({ quando: new Date().toISOString(), modo: MODO_ALVOS ? 'alvos' : 'combos', res }, null, 1));
process.exit(falhas.length ? 1 : 0);
