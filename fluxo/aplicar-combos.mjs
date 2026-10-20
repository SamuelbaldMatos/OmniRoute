#!/usr/bin/env node
// Cadeias de fallback dos combos do OmniRoute (revisão 2026-10-20). Fonte única: edite CADEIAS e rode de novo.
//
//   node aplicar-combos.mjs                      mostra o que mudaria (não grava)
//   node aplicar-combos.mjs --aplicar            grava via API de gestão (PUT /api/combos/:id)
//   node aplicar-combos.mjs --restaurar <arq>    devolve models/config de um backup (ex.: backups/2026-10-20-revisao-combos/combos-antes.json)
//
// Ordem da política do usuário: GPT (cx) → Antigravity (agy: Claude/gpt-oss) → outros (moonshot/Kimi) → local por último.
// Combos cuja função é uma provedora (executor-claude, executor-antigravity, aprimorador) ou que precisam de família
// diferente do executor GPT (revisor, revisor-seguranca) começam pela Antigravity e trazem o GPT logo em seguida.
// gerente-jarvis (Jarvis é local por design) e processador-privado-local (dado sensível, só local) começam no local.
//
// Fora das cadeias, com o motivo medido em 2026-10-20 (ver REVISAO-COMBOS.md):
//   cc/*  conexão Claude com token expirado (invalid_grant) — reautenticar no painel e então recolocar
//   gh/*  GitHub Copilot sem cota até 2026-11-01 (preflight 100%)
//   cheaperinference/*  saldo da carteira zerado (HTTP 402)
//   cx/gpt-5.5-*  não suportado em conta ChatGPT (HTTP 400)
//   agy|antigravity/gemini-*  as duas contas em cooldown de ~119 h; gemini-pro-agent saiu do catálogo (HTTP 400)
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const OMNI_CLI_TOKEN = 'file:///I:/OMNIROUTE/runtime/node_modules/omniroute/bin/cli/utils/cliToken.mjs';
const BASE = 'http://127.0.0.1:20128';

// Reserva local dos combos de nuvem: gemma4:12b (mesmo peso do orq-gemma, contexto padrão, cabe na GPU), com raciocínio
// desligado pela payload rule do OmniRoute (PUT /api/settings/payload-rules: reasoning_effort=none só para ollama-local/gemma4:12b),
// para nunca gastar o orçamento só pensando e devolver texto vazio. Não afeta orq-qwen/orq-gemma (Jarvis, privado).
export const LOCAL = 'ollama-local/gemma4:12b';

export const CADEIAS = {
  orquestrador: ['cx/gpt-6-astra-high', 'cx/gpt-6-sol-high', 'cx/gpt-6-luna-high', 'agy/claude-sonnet-4-6', 'agy/claude-opus-4-6-thinking', 'moonshot/kimi-k3', LOCAL],
  complexo: ['cx/gpt-6-astra-xhigh', 'cx/gpt-6-astra-high', 'cx/gpt-6-sol-xhigh', 'agy/claude-opus-4-6-thinking', 'agy/claude-sonnet-4-6', 'moonshot/kimi-k3', LOCAL],
  maximo: ['cx/gpt-6-astra-max', 'cx/gpt-6-astra-xhigh', 'cx/gpt-6-sol-high', 'agy/claude-opus-4-6-thinking', 'moonshot/kimi-k3', LOCAL],
  codigo: ['cx/gpt-6-sol-medium', 'cx/gpt-6-luna-high', 'cx/gpt-6-luna-medium', 'agy/claude-sonnet-4-6', 'moonshot/kimi-k2.7-code', LOCAL],
  'codigo-pesado': ['cx/gpt-6-astra-high', 'cx/gpt-6-sol-high', 'cx/gpt-5.6-sol-high', 'agy/claude-opus-4-6-thinking', 'agy/claude-sonnet-4-6', 'moonshot/kimi-k2.7-code', LOCAL],
  'contexto-longo': ['cx/gpt-6-sol-high', 'cx/gpt-6-astra-high', 'agy/claude-sonnet-4-6', 'agy/claude-opus-4-6-thinking', 'moonshot/kimi-k3', LOCAL],
  texto: ['cx/gpt-6-sol-medium', 'cx/gpt-6-luna-high', 'agy/claude-sonnet-4-6', 'moonshot/kimi-k3', LOCAL],
  analise: ['cx/gpt-6-sol-medium', 'cx/gpt-6-sol-high', 'agy/claude-sonnet-4-6', 'agy/claude-opus-4-6-thinking', 'moonshot/kimi-k3', LOCAL],
  rapido: ['cx/gpt-6-sol-medium', 'cx/gpt-6-luna-high', 'cx/gpt-6-luna-medium', 'agy/claude-sonnet-4-6', 'moonshot/kimi-k2.7-code-highspeed', LOCAL],
  compactador: ['cx/gpt-6-sol-medium', 'cx/gpt-6-luna-high', 'agy/claude-sonnet-4-6', 'moonshot/kimi-k3', LOCAL],
  revisor: ['agy/claude-sonnet-4-6', 'agy/claude-opus-4-6-thinking', 'cx/gpt-6-sol-high', 'cx/gpt-6-astra-high', 'moonshot/kimi-k3', LOCAL],
  // Prompt grande (45 KB) estourou os dois xhigh em 120 s cada; o sol-high resolveu o mesmo em 97 s. Por isso há GPT "high" logo atrás.
  'revisor-seguranca': ['agy/claude-opus-4-6-thinking', 'cx/gpt-6-astra-xhigh', 'cx/gpt-6-sol-high', 'agy/claude-sonnet-4-6', 'cx/gpt-6-astra-high', 'moonshot/kimi-k3', LOCAL],
  aprimorador: ['agy/claude-opus-4-6-thinking', 'cx/gpt-6-astra-high', 'agy/claude-sonnet-4-6', 'cx/gpt-6-sol-high', 'moonshot/kimi-k3', LOCAL],
  'executor-claude': ['agy/claude-sonnet-4-6', 'agy/claude-opus-4-6-thinking', 'cx/gpt-6-astra-high', 'cx/gpt-6-sol-high', 'moonshot/kimi-k2.7-code', LOCAL],
  'executor-codex': ['cx/gpt-6-astra-high', 'cx/gpt-6-sol-high', 'cx/gpt-5.6-sol-high', 'agy/claude-sonnet-4-6', 'moonshot/kimi-k2.7-code', LOCAL],
  'executor-antigravity': ['agy/claude-sonnet-4-6', 'agy/claude-opus-4-6-thinking', 'agy/gpt-oss-120b-medium', 'cx/gpt-6-sol-high', 'moonshot/kimi-k3', LOCAL],
  // GitHub Copilot volta quando a cota resetar (2026-11-01): recolocar gh/claude-sonnet-5 e gh/gpt-5.6-sol no topo.
  'executor-copilot': ['cx/gpt-6-sol-high', 'cx/gpt-6-luna-high', 'agy/claude-sonnet-4-6', 'moonshot/kimi-k2.7-code', LOCAL],
  // Jarvis é local por design; se o qwen não responder a tempo (frio ou GPU disputada) cai para a nuvem e, por fim, para a reserva local.
  'gerente-jarvis': ['ollama-local/orq-qwen:latest', 'cx/gpt-6-astra-high', 'cx/gpt-6-sol-high', 'agy/claude-sonnet-4-6', 'moonshot/kimi-k3', LOCAL],
  // Dado sensível: SÓ local. A reserva gemma4:12b (sem raciocínio) é a que mais fica carregada, por isso fecha a cadeia.
  'processador-privado-local': ['ollama-local/orq-qwen:latest', 'ollama-local/orq-gemma:latest', LOCAL],
};

// Timeout por alvo: só limita o tempo até os cabeçalhos em streaming (a geração continua); em não-streaming, a resposta toda.
// Falha de nuvem chega em milissegundos (cota, auth, catálogo); o teto serve para alvo pendurado e para a reserva local.
// Restrição: o fetch do Node (undici) desiste após 300 s sem cabeçalhos, então o pior caso da cadeia inteira, somando as
// repetições, tem de ficar abaixo disso: padrão 3 × 60 s + 2 × 15 s = 210 s; pesados: alvos disparados a cada 60 s em paralelo,
// o 2º começa aos 60 s e tem até 120 s (termina até 180 s); sem resposta, local 120 s + 15 s + nova rodada 120 s = 255 s;
// gerente-jarvis 2 × (60 s qwen + 60 s reserva) + 15 s = 255 s; processador-privado-local 3 alvos locais × 90 s = 270 s.
const PESADOS = ['orquestrador', 'complexo', 'maximo', 'codigo-pesado', 'revisor', 'revisor-seguranca', 'contexto-longo', 'executor-claude', 'executor-codex', 'executor-antigravity'];
const TIMEOUT = { padrao: 60_000, ...Object.fromEntries(PESADOS.map(n => [n, 120_000])), 'gerente-jarvis': 60_000, 'processador-privado-local': 90_000 };
// Resposta 200 sem texto (só raciocínio) cai para o próximo alvo; chamada de ferramenta válida é isenta (responseValidation do OmniRoute).
const VALIDACAO = { minContentLength: 1 };
// Se a cadeia inteira falhar (ex.: conta Codex em cooldown de 30 s junto com Antigravity e Kimi sem cota e o local
// travado), o combo espera 15 s e tenta a cadeia de novo em vez de devolver erro (medido: cooldown de 21–31 s na conta Codex).
const REPETIR = { padrao: { maxSetRetries: 2, setRetryDelayMs: 15_000 }, ...Object.fromEntries([...PESADOS, 'gerente-jarvis'].map(n => [n, { maxSetRetries: 1, setRetryDelayMs: 15_000 }])), 'processador-privado-local': { maxSetRetries: 0 } };
// Pesados (raciocínio xhigh/max, prompts grandes): em vez de esperar um alvo lento até o timeout para só então tentar o próximo,
// o OmniRoute dispara o próximo alvo em paralelo após 60 s (hedging) e fica com a primeira resposta boa; o timeout por alvo
// é 120 s (180 s estourou os 300 s do cliente quando a reserva local estava lenta e a cadeia foi repetida). Compressão de contexto nos fallbacks fica desligada
// (zeroLatencyOptimizations a ligaria e cortaria o prompt de uma revisão).
const PARALELO_ESCALONADO = { zeroLatencyOptimizationsEnabled: true, hedging: true, hedgeDelayMs: 60_000, fallbackCompressionMode: 'off' };
export function configDe(nome, atual = {}) {
  return { ...atual, targetTimeoutMs: TIMEOUT[nome] ?? TIMEOUT.padrao, responseValidation: VALIDACAO, ...(REPETIR[nome] ?? REPETIR.padrao),
    ...(PESADOS.includes(nome) ? PARALELO_ESCALONADO : {}) };
}

function provedor(model) { return model.split('/')[0]; }
function passo(nome, model, i) {
  return { id: `${nome}-model-${i + 1}-${model.replace(/[^a-zA-Z0-9.]+/g, '-')}`, kind: 'model', model, providerId: provedor(model), weight: 0 };
}

async function api(method, path, body) {
  const { getCliToken, CLI_TOKEN_HEADER } = await import(OMNI_CLI_TOKEN);
  const r = await fetch(BASE + path, { method, headers: { [CLI_TOKEN_HEADER]: await getCliToken(), 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → HTTP ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}

async function principal() {
  const args = process.argv.slice(2);
  const APLICAR = args.includes('--aplicar');
  const iRest = args.indexOf('--restaurar');
  const atuais = (await api('GET', '/api/combos')).combos;

  if (iRest >= 0) {
    const backup = JSON.parse(fs.readFileSync(args[iRest + 1], 'utf8')).combos;
    for (const b of backup) {
      const c = atuais.find(x => x.id === b.id);
      if (!c) { console.log(`(sem combo ${b.name} no servidor)`); continue; }
      await api('PUT', `/api/combos/${c.id}`, { models: b.models, config: b.config || {} });
      console.log(`restaurado ${b.name}`);
    }
    return;
  }

  let mudou = 0;
  for (const [nome, cadeia] of Object.entries(CADEIAS)) {
    const c = atuais.find(x => x.name === nome);
    if (!c) { console.log(`FALTA combo ${nome} no servidor`); process.exitCode = 1; continue; }
    const antes = (c.models || []).map(m => m.model);
    const config = configDe(nome, c.config || {});
    const igual = JSON.stringify(antes) === JSON.stringify(cadeia) && JSON.stringify(c.config) === JSON.stringify(config);
    console.log(`${igual ? '=' : '*'} ${nome}  timeout ${config.targetTimeoutMs / 1000}s, repete a cadeia ${config.maxSetRetries}x`);
    if (!igual) {
      console.log(`    antes: ${antes.join(' > ')}  (timeout ${(c.config?.targetTimeoutMs ?? 0) / 1000}s)`);
      console.log(`    agora: ${cadeia.join(' > ')}`);
      mudou++;
      if (APLICAR) await api('PUT', `/api/combos/${c.id}`, { models: cadeia.map((m, i) => passo(nome, m, i)), config });
    }
  }
  console.log(`\n${mudou} combo(s) ${APLICAR ? 'atualizados' : 'mudariam (use --aplicar)'}.`);
}

// Só executa quando chamado direto (prova-falha.mjs importa CADEIAS sem aplicar nada).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await principal();
