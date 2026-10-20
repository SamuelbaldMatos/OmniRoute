#!/usr/bin/env node
// Prova de falha simulada: cria combos temporários com a mesma cadeia de um combo real, mas com o 1º alvo
// quebrado, chama cada um e mostra que a tarefa termina pelo alvo seguinte. Apaga os temporários no fim.
//
//   node prova-falha.mjs [combo-base]     (padrão: codigo)
//
// Cenários:
//   1-desabilitado  1º alvo = cc/claude-sonnet-5, cuja conexão está desativada no OmniRoute (is_active=0, token expirado)
//   2-fora-catalogo 1º alvo = agy/gemini-pro-agent, que saiu do catálogo da Antigravity (erro permanente 400)
//   3-pendurado     1º alvo = ollama-local/orq-qwen:latest sem tempo de responder; targetTimeoutMs de 15 s corta e cai
//   4-lento-hedging config e cadeia do revisor-seguranca com orq-qwen lento na frente: hedging dispara o próximo aos 60 s
// Os temporários usam a mesma config do combo-base (validação de vazio e repetição da cadeia), só o timeout do 3 muda.
import { CADEIAS, configDe } from './aplicar-combos.mjs';

const OMNI_CLI_TOKEN = 'file:///I:/OMNIROUTE/runtime/node_modules/omniroute/bin/cli/utils/cliToken.mjs';
const BASE = 'http://127.0.0.1:20128';
const base = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : 'codigo';
const cadeia = CADEIAS[base];
if (!cadeia) { console.error(`combo-base desconhecido: ${base}`); process.exit(2); }

const { getCliToken, CLI_TOKEN_HEADER } = await import(OMNI_CLI_TOKEN);
const cli = await getCliToken();
async function gestao(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { [CLI_TOKEN_HEADER]: cli, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → HTTP ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}
const { configuracao } = await import('file:///I:/Cerebro/omniroute.mjs');
const { token } = configuracao();

const passo = (model, extra = {}) => ({ kind: 'model', model, providerId: model.split('/')[0], weight: 0, ...extra });
const cfg = configDe(base);
const cenarios = [
  { nome: 'prova-falha-1-desabilitado', alvo1: passo('cc/claude-sonnet-5'), cfg },
  { nome: 'prova-falha-2-fora-catalogo', alvo1: passo('agy/gemini-pro-agent'), cfg },
  { nome: 'prova-falha-3-pendurado', alvo1: passo('ollama-local/orq-qwen:latest'), cfg: { ...cfg, targetTimeoutMs: 15000 } },
  // Combo pesado (hedging): o 1º alvo lento NÃO segura a tarefa até o timeout de 180 s; aos 60 s o próximo é disparado em paralelo.
  { nome: 'prova-falha-4-lento-hedging', alvo1: passo('ollama-local/orq-qwen:latest'), cfg: configDe('revisor-seguranca'), cadeia: CADEIAS['revisor-seguranca'] },
];

async function chamar(modelo, comFerramenta) {
  const corpo = comFerramenta
    ? { model: modelo, max_tokens: 600, tools: [{ name: 'somar', description: 'Soma dois inteiros.', input_schema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] } }],
        messages: [{ role: 'user', content: 'Use a ferramenta somar para calcular 17 + 25.' }] }
    : { model: modelo, max_tokens: 600, messages: [{ role: 'user', content: 'Responda em uma frase: o que é failover?' }] };
  const t0 = Date.now();
  const r = await fetch(BASE + '/v1/messages', { method: 'POST', signal: AbortSignal.timeout(600000),
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(corpo) });
  const d = await r.json().catch(() => ({}));
  const blocos = d.content || [];
  const texto = blocos.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const tool = blocos.find(b => b.type === 'tool_use');
  const ok = r.ok && (comFerramenta ? !!tool : texto.length > 0);
  return { ok, status: r.status, ms: Date.now() - t0, respondeu: d.model || '-', saida: comFerramenta ? (tool ? `tool_use ${JSON.stringify(tool.input)}` : '-') : texto.slice(0, 70), erro: d.error?.message };
}

const existentes = (await gestao('GET', '/api/combos')).combos;
let falhou = 0;
console.log(`${new Date().toISOString()}  combo-base: ${base} = ${cadeia.join(' > ')}\n`);
for (const c of cenarios) {
  const velho = existentes.find(x => x.name === c.nome);
  if (velho) await gestao('DELETE', `/api/combos/${velho.id}`);
  const criado = await gestao('POST', '/api/combos', {
    name: c.nome, description: 'temporário: prova de failover (apagado pelo script)', strategy: 'priority', isHidden: true,
    models: [c.alvo1, ...(c.cadeia || cadeia).map(m => passo(m))], config: c.cfg,
  });
  const id = criado.id || criado.combo?.id;
  try {
    for (const ferramenta of [false, true]) {
      const r = await chamar(c.nome, ferramenta);
      if (!r.ok) falhou++;
      console.log(`${r.ok ? 'OK   ' : 'FALHA'} ${c.nome.padEnd(26)} ${ferramenta ? 'tool' : 'txt '} 1º alvo: ${c.alvo1.model}`);
      console.log(`      HTTP ${r.status} em ${r.ms} ms; respondeu ${r.respondeu}: ${r.saida}${r.erro ? ' | erro: ' + r.erro : ''}`);
    }
  } finally {
    if (id) await gestao('DELETE', `/api/combos/${id}`);
  }
}
const sobra = (await gestao('GET', '/api/combos')).combos.filter(x => x.name.startsWith('prova-falha-'));
console.log(`\ncombos temporários restantes: ${sobra.length}`);
process.exit(falhou || sobra.length ? 1 : 0);
