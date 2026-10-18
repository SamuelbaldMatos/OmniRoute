#!/usr/bin/env node
// anti-loop.mjs — gancho anti-loop / anti-travamento do fluxo OmniRoute (Claude Code).
//
// Um único script para vários eventos (escolhe pelo campo hook_event_name do JSON no stdin):
//   UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure,
//   PreCompact, PostCompact e SessionStart (source compact/clear/resume).
// Registre TODOS no perfil. Sem PostToolUse a época avança no PreToolUse (modo de compatibilidade,
// menos preciso); sem PreCompact/SessionStart o histórico sobrevive à compactação.
//
// Regras:
//   A) Repetição (PreToolUse): a mesma assinatura já executada FLUXO_REPETICOES vezes (2) nas
//      últimas FLUXO_JANELA chamadas (20) => nega a próxima. A assinatura usa a chamada canônica
//      (Bash e PowerShell viram "shell"; sem description/timeout/run_in_background; sem 2>&1 e
//      "| tail -N"; "npm run test" = "npm test"; "cat x" = Read x; com o cwd) e:
//        - leitura (Read/Grep/Glob/LS/Web e shell sabidamente só de leitura): + época, e para
//          Read/Grep/Glob/LS também mtime e tamanho do alvo;
//        - shell mutante ou desconhecido e ferramentas MCP: esquema "x" (época menos as próprias
//          mutações): a própria repetição continua detectável, mas outra mudança no meio libera;
//        - delegação (Agent/Task): esquema "x" sobre a época local;
//        - Edit/Write/MultiEdit/NotebookEdit: sem época.
//      Shell, MCP, Grep/Glob e Web só são negados se as repetições deram a MESMA saída (hash da
//      resposta, gravado no PostToolUse, sem tempos/datas/ids; contagens e porcentagens contam).
//      Ação mutante (rolar, clicar, sed -i) repetida só é loop se nada novo foi observado entre
//      as repetições. Consultas de status (curl /health, /api/ps, ollama ps, git status, sleep,
//      tail de log...) separadas por mais de FLUXO_POLL_SEG (20 s) não contam como repetição.
//   A2) Ciclo: A,B,A,B,A (período 2) ou A,B,C,A,B,C,A (período 3), com as mesmas saídas => nega.
//   B) Falhas (PostToolUse/PostToolUseFailure), em janela deslizante (leituras bem-sucedidas NÃO
//      zeram): >= FLUXO_FALHAS1 (5) falhas nas últimas FLUXO_JANELA_FALHAS (10) => nível 1;
//      >= FLUXO_FALHAS2 (8) => nível 2. O mesmo comando com o mesmo erro FLUXO_FALHAS_MESMA (2)x
//      => alerta; o dobro => nível 2. Edição falha no mesmo arquivo FLUXO_FALHAS_EDIT (2)x =>
//      reler o trecho exato; o dobro => delegar. Alertas só saem numa chamada que falhou, um por
//      vez (o mais grave); o mesmo alerta espera 10, 20, 40 chamadas (dobra até o intervalo do
//      checkpoint) e, depois de um alerta, os de gravidade igual ou menor esperam 10 chamadas.
//   C) Orçamento do turno: checkpoint a cada FLUXO_CHECKPOINT (40) chamadas. Depois de
//      FLUXO_CHECKPOINTS_MAX (3) checkpoints, continua a cada 40 com um aviso obrigatório: sem
//      progresso verificável, pare e pergunte ao usuário. 0 desliga. UserPromptSubmit zera o turno.
//
// Época: só avança no PostToolUse de SUCESSO de uma mutação (Edit/Write/MultiEdit/NotebookEdit,
// shell mutante ou desconhecido, ferramenta com verbo de escrita) e quando Agent/Task termina
// (o subagente pode ter mudado arquivos). Toda mutação também anexa 1 byte em <sessão>.mut, que
// o agente principal e os subagentes da mesma sessão leem: a edição feita por um subagente libera
// a verificação no principal.
//
// Garantias: nunca trava nem derruba a sessão. Qualquer erro vira exit 0 sem saída (uma linha no
// log local, sem dados da chamada). FLUXO_ANTILOOP=0 desliga tudo. Estado por sessão em
// FLUXO_ESTADO_DIR (padrão: os.tmpdir()/fluxo-anti-loop), sob trava por arquivo. A escrita é
// atômica (.tmp + rename); se o rename falhar, NÃO salva (nunca grava direto). Sem trava, decide
// sem salvar. Estado ilegível vai para .corrompido em vez de ser sobrescrito em silêncio. A limpeza
// (FLUXO_ESTADO_DIAS = 2 dias) só apaga arquivos com nome do próprio gancho e só em diretório com
// o marcador .fluxo-anti-loop, criado pelo gancho quando ele mesmo cria o diretório.
//
// Sem dependências externas: só módulos node:.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

const VERSAO_ESTADO = 2;
const MAX_IDS_CONTADOS = 64;
const MAX_MUT_POR_ASSIN = 200;
const MAX_CHAVES = 100;
const LOG_MAX_BYTES = 256 * 1024;
const MAX_COMANDO_ANALISE = 20000;
const WIN = process.platform === 'win32';

/** Marcador que autoriza a limpeza do diretório de estado. */
export const MARCADOR = '.fluxo-anti-loop';
/** Únicos nomes que a limpeza pode apagar (arquivos criados pelo próprio gancho). */
export const PADRAO_PROPRIO = /^(?:[A-Za-z0-9_-]+(?:\.json(?:\.\d+\.tmp|\.lock|\.corrompido)?|\.mut)|anti-loop\.log)$/;

/** Ferramentas que nunca são bloqueadas e não contam para falhas/sucessos. */
export const ISENTAS = new Set([
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'AskUserQuestion',
  // Leitura de saída de processo em segundo plano: consultar de novo é o uso normal.
  'BashOutput',
  'TaskOutput',
]);

/** Leituras: a assinatura inclui a época (nº de mutações), então reler após editar é permitido. */
export const LEITURA = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead']);

/** Leituras de arquivo: a "saída" é o próprio arquivo (mtime + tamanho). */
const LEITURA_ARQUIVO = new Set(['Read', 'NotebookRead']);

/** Ferramentas cujo alvo (arquivo ou pasta) entra na assinatura com mtime e tamanho. */
const COM_ALVO = new Set(['Read', 'NotebookRead', 'Grep', 'Glob', 'LS']);

/** Mutações: avançam a época no sucesso; a própria assinatura não inclui a época. */
export const MUTANTES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Delegação a outro agente. */
export const DELEGACAO = new Set(['Agent', 'Task']);

/** Ferramentas de shell: o comando pode ser leitura, mutação ou desconhecido (heurística). */
export const SHELL = new Set(['Bash', 'PowerShell']);

const CAMPOS_SHELL_IGNORADOS = ['description', 'timeout', 'run_in_background', 'dangerouslyDisableSandbox'];
const CAMPOS_CAMINHO = ['file_path', 'notebook_path', 'path'];
const COM_CAMINHO = new Set(['Read', 'NotebookRead', 'Grep', 'Glob', 'LS', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function inteiro(valor, padrao, minimo = 1) {
  const n = Number.parseInt(String(valor ?? ''), 10);
  return Number.isFinite(n) && n >= minimo ? n : padrao;
}

function lista(valor) {
  return String(valor || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function lerConfig(env = process.env) {
  const falhas1 = inteiro(env.FLUXO_FALHAS1, 5);
  let falhas2 = inteiro(env.FLUXO_FALHAS2, 8);
  if (falhas2 <= falhas1) falhas2 = falhas1 + 3;
  let janelaFalhas = inteiro(env.FLUXO_JANELA_FALHAS, 10, 2);
  if (janelaFalhas < falhas2) janelaFalhas = falhas2;
  return {
    ativo: String(env.FLUXO_ANTILOOP ?? '1').trim() !== '0',
    repeticoes: inteiro(env.FLUXO_REPETICOES, 2),
    janela: inteiro(env.FLUXO_JANELA, 20, 2),
    falhas1,
    falhas2,
    janelaFalhas,
    falhasMesma: inteiro(env.FLUXO_FALHAS_MESMA, 2),
    falhasEdit: inteiro(env.FLUXO_FALHAS_EDIT, 2),
    pollMs: inteiro(env.FLUXO_POLL_SEG, 20, 0) * 1000,
    checkpoint: inteiro(env.FLUXO_CHECKPOINT, 40),
    checkpointsMax: inteiro(env.FLUXO_CHECKPOINTS_MAX, 3, 0),
    diasEstado: inteiro(env.FLUXO_ESTADO_DIAS, 2),
    dir: env.FLUXO_ESTADO_DIR && String(env.FLUXO_ESTADO_DIR).trim()
      ? String(env.FLUXO_ESTADO_DIR).trim()
      : path.join(os.tmpdir(), 'fluxo-anti-loop'),
    isentasExtras: new Set(lista(env.FLUXO_ISENTAS)),
    mutantesExtras: new Set(lista(env.FLUXO_MCP_MUTANTES)),
    leituraExtras: new Set(lista(env.FLUXO_MCP_LEITURA)),
  };
}

// ---------------------------------------------------------------------------
// Textos (curtos e imperativos: o leitor é um modelo local de ~35B)
// ---------------------------------------------------------------------------

export const PROTOCOLO = [
  'PROTOCOLO DE TRAVAMENTO:',
  '1) Pare de repetir a mesma chamada.',
  '2) Leia o erro UMA vez e escreva a causa provável em 1 frase.',
  '3) Mude a abordagem: outra ferramenta, outro arquivo ou escopo menor. Mudar uma vírgula na mesma chamada NÃO é mudar de abordagem.',
  '4) Se 2 abordagens falharem, delegue a um executor mais forte (executor-codex para código, executor-claude para raciocínio) com: objetivo, erro exato e o que já tentou.',
  '5) Se ainda travar, pare e pergunte ao usuário, com opções.',
  '6) Nunca declare sucesso sem verificar.',
  '7) Erro 429/402/cota de provedora não se resolve repetindo: o combo já faz failover. Siga em frente.',
].join('\n');

export function textoNegacao({ nome, resumo, vezes, janela, categoria, sequencia }) {
  const alvo = resumo ? `${nome}: ${resumo}` : nome;
  if (categoria === 'ciclo') {
    return [
      `LOOP BLOQUEADO (anti-loop): ciclo detectado. A sequência ${sequencia || ''} se repetiu com o mesmo resultado e "${alvo}" começaria a volta seguinte. Esta chamada NÃO foi executada. Alternar entre as mesmas chamadas (aplicar e desfazer, ler e reler) não avança.`,
      PROTOCOLO,
    ].join('\n');
  }
  const dica =
    categoria === 'leitura'
      ? 'Nada mudou desde as chamadas anteriores (mesmo alvo, nenhuma alteração registrada). Use o resultado que você já obteve; se ele não estiver mais disponível, peça só o trecho necessário (offset/limit ou filtro) ou mude de abordagem.'
      : categoria === 'delegacao'
        ? 'Nada mudou desde a última delegação idêntica. Não reenvie igual: inclua o que mudou e o erro exato, ou escolha outro executor.'
        : 'As repetições anteriores deram o mesmo resultado; repetir não muda nada.';
  return [
    `LOOP BLOQUEADO (anti-loop): "${alvo}" já foi executado ${vezes}x nas últimas ${janela} chamadas, sem mudança no meio. Esta chamada NÃO foi executada. ${dica}`,
    PROTOCOLO,
  ].join('\n');
}

export function textoFalhas(nivel, falhas, janela = 10) {
  if (nivel === 1) {
    return [
      `ALERTA ANTI-TRAVAMENTO nível 1: ${falhas} falhas de ferramenta nas últimas ${janela} chamadas.`,
      PROTOCOLO,
    ].join('\n');
  }
  return [
    `ALERTA ANTI-TRAVAMENTO nível 2: ${falhas} falhas de ferramenta nas últimas ${janela} chamadas. PARE de tentar sozinho.`,
    'Faça AGORA uma destas:',
    'a) Delegue o diagnóstico a executor-codex (código) ou executor-claude (raciocínio) com contexto completo: objetivo, comando/arquivo exato, erro exato e as abordagens já tentadas.',
    'b) Pergunte ao usuário, com 2 ou 3 opções claras.',
    'Não faça mais tentativas diretas nesta linha. Nunca declare sucesso sem verificar. Erro 429/402/cota: o combo já faz failover, não repita.',
  ].join('\n');
}

export function textoMesmaFalha(nivel, resumo, vezes) {
  const alvo = resumo ? `"${resumo}"` : 'O mesmo comando';
  if (nivel === 1) {
    return [
      `ALERTA ANTI-TRAVAMENTO: ${alvo} falhou ${vezes}x com o mesmo erro nas últimas chamadas. O que você mudou entre as tentativas não resolveu.`,
      'Releia o erro UMA vez, escreva a causa provável em 1 frase e mude a abordagem. Mudar uma vírgula NÃO é mudar de abordagem.',
    ].join('\n');
  }
  return [
    `ALERTA ANTI-TRAVAMENTO nível 2: ${alvo} já falhou ${vezes}x com o mesmo erro. PARE de tentar sozinho.`,
    'a) Delegue o diagnóstico a executor-codex (código) ou executor-claude (raciocínio) com objetivo, comando exato, erro exato e o que já tentou.',
    'b) Ou pergunte ao usuário, com 2 ou 3 opções claras.',
  ].join('\n');
}

export function textoFalhaEdit(nivel, arquivo, vezes) {
  const alvo = arquivo ? `"${arquivo}"` : 'o mesmo arquivo';
  if (nivel === 1) {
    return [
      `ALERTA ANTI-TRAVAMENTO: a edição falhou ${vezes}x em ${alvo}.`,
      'Releia só o trecho alvo (Read com offset/limit) e copie old_string literalmente, com espaços, tabs e quebras de linha. Se o trecho se repete no arquivo, inclua mais linhas de contexto. Arquivo pequeno: reescreva inteiro com Write.',
    ].join('\n');
  }
  return [
    `ALERTA ANTI-TRAVAMENTO nível 2: a edição já falhou ${vezes}x em ${alvo}. Pare de tentar Edit neste arquivo.`,
    'Delegue a alteração a executor-codex com o trecho exato e a mensagem de erro, ou pergunte ao usuário.',
  ].join('\n');
}

export function textoCheckpoint(chamadas) {
  return [
    `CHECKPOINT (${chamadas} chamadas de ferramenta neste turno). Antes de continuar:`,
    '1) Resuma o progresso em até 3 linhas.',
    '2) Compare com os critérios de aceite do pedido: o que falta?',
    '3) Decida: continuar (diga o próximo passo), delegar (executor-codex / executor-claude / executor-antigravity / executor-copilot) ou perguntar ao usuário.',
  ].join('\n');
}

export function textoCheckpointExtra(chamadas, intervalo) {
  return [
    `CHECKPOINT OBRIGATÓRIO (${chamadas} chamadas de ferramenta neste turno, acima do orçamento normal).`,
    `1) Diga em 1 linha que progresso VERIFICÁVEL (teste passando, arquivo entregue, erro novo) as últimas ${intervalo} chamadas trouxeram.`,
    '2) Se não houve progresso verificável: PARE e pergunte ao usuário, com o resumo e 2 ou 3 opções.',
    '3) Se houve: diga o próximo passo e continue, ou delegue (executor-codex / executor-claude / executor-antigravity / executor-copilot).',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Funções puras: serialização, hash, caminhos
// ---------------------------------------------------------------------------

/** Serialização JSON com chaves ordenadas (estável). */
export function serializarEstavel(valor) {
  if (valor === undefined) return 'null';
  if (valor === null || typeof valor !== 'object') {
    if (typeof valor === 'number' && !Number.isFinite(valor)) return 'null';
    if (typeof valor === 'bigint') return JSON.stringify(String(valor));
    if (typeof valor === 'function' || typeof valor === 'symbol') return 'null';
    return JSON.stringify(valor);
  }
  if (Array.isArray(valor)) return `[${valor.map(serializarEstavel).join(',')}]`;
  const chaves = Object.keys(valor)
    .filter((k) => valor[k] !== undefined)
    .sort();
  return `{${chaves.map((k) => `${JSON.stringify(k)}:${serializarEstavel(valor[k])}`).join(',')}}`;
}

export function sha1(texto) {
  return createHash('sha1').update(texto).digest('hex');
}

/** Caminho comparável: barras normais, sem barra final, minúsculas no Windows. */
export function normalizarCaminho(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  let s = path.normalize(p.trim()).replace(/\\/g, '/');
  if (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1);
  return WIN ? s.toLowerCase() : s;
}

function resolverCaminho(p, cwd) {
  if (typeof p !== 'string' || !p) return p;
  if (path.isAbsolute(p)) return normalizarCaminho(p);
  if (typeof cwd === 'string' && cwd.trim()) return normalizarCaminho(path.resolve(cwd, p));
  return p;
}

const CAMPOS_VOLATEIS = new Set([
  'durationMs',
  'duration_ms',
  'duration',
  'elapsed',
  'elapsedMs',
  'totalDurationMs',
  'totalTokens',
  'totalToolUseCount',
  'usage',
  'timestamp',
  'startTime',
  'endTime',
  'tool_use_id',
  'toolUseId',
  'agentId',
  'agent_id',
  'backgroundTaskId',
  'shellId',
  'bash_id',
]);

function reduzirTexto(s) {
  return s.length > 65536 ? `${s.slice(0, 32768)}\u2026${s.slice(-32768)}` : s;
}

function reduzir(valor, profundidade) {
  if (typeof valor === 'string') return reduzirTexto(valor);
  if (!valor || typeof valor !== 'object') return valor;
  if (profundidade > 6) return '\u2026';
  if (Array.isArray(valor)) {
    const v = valor.length > 200 ? [...valor.slice(0, 100), ...valor.slice(-100)] : valor;
    return v.map((x) => reduzir(x, profundidade + 1));
  }
  const out = {};
  for (const k of Object.keys(valor)) {
    if (!CAMPOS_VOLATEIS.has(k)) out[k] = reduzir(valor[k], profundidade + 1);
  }
  return out;
}

/**
 * Troca o que varia sem significar mudança (datas, horas, durações, ids hexadecimais, números
 * longos como PIDs e timestamps) por marcadores. Contagens e porcentagens curtas continuam,
 * porque "3 falhas" -> "2 falhas" ou "carregando 40%" -> "60%" é progresso real.
 */
export function normalizarVolatil(texto) {
  return String(texto)
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<data>')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\b/g, '<hora>')
    .replace(/\d+(?:\.\d+)?\s?(?:ms|µs|us|ns|s|secs?|seconds?|segundos?|min|mins|minutes?|minutos?|h)\b/gi, '<tempo>')
    .replace(/\b(duration|elapsed|took|time|tempo|dura[cç][aã]o)([\w-]*)(["']?[\s:=]+)\d+(?:\.\d+)?/gi, '$1$2$3<tempo>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d{5,}/g, '<n>');
}

/** Hash curto da resposta, sem o que é volátil (tempos, datas, ids). */
export function hashResposta(resposta) {
  if (resposta === undefined) return undefined;
  const texto = typeof resposta === 'string' ? reduzirTexto(resposta) : serializarEstavel(reduzir(resposta, 0));
  return sha1(normalizarVolatil(texto)).slice(0, 12);
}

// ---------------------------------------------------------------------------
// Análise de comandos de shell (heurística; nada é executado)
// ---------------------------------------------------------------------------

/** APIs de escrita dentro de código (node -e, python -c) ou chamadas .NET. */
const RE_API_ESCRITA = new RegExp(
  [
    '\\b(?:writeFile|writeFileSync|appendFile|appendFileSync|rmSync|rmdirSync|unlinkSync|renameSync|mkdirSync|copyFileSync|cpSync|createWriteStream|truncateSync|symlinkSync|chmodSync)\\b',
    '\\bfs\\.(?:rm|rmdir|unlink|rename|mkdir|copyFile|cp|writeFile|appendFile|truncate)\\b',
    '\\[(?:System\\.)?IO\\.(?:File|Directory)\\]::(?:Write|Append|Delete|Move|Copy|Create|Replace|Set)',
    '\\bos\\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir|removedirs|chmod)\\b',
    '\\bshutil\\.(?:copy|copy2|copyfile|copytree|move|rmtree)\\b',
    '\\.(?:write_text|write_bytes|unlink|mkdir|rmdir|rename|touch)\\(',
    '\\bopen\\([^)]{0,200},\\s*[\'"][wax]',
  ].join('|'),
  'i',
);

/** Código que dispara outros processos: o efeito é desconhecido. */
const RE_CODIGO_EXECUTA =
  /\b(?:child_process|execSync|execFileSync|spawnSync|exec|execFile|spawn|fork|subprocess|system|popen|Popen|Invoke-Expression|iex|Start-Process)\b/i;

/** Sempre alteram arquivos ou estado, qualquer que seja o argumento. */
const CMD_MUTANTE = new Set([
  'rm', 'rmdir', 'del', 'erase', 'rd', 'mv', 'move', 'cp', 'copy', 'xcopy', 'robocopy', 'mkdir', 'md',
  'touch', 'ln', 'chmod', 'chown', 'chgrp', 'patch', 'tee', 'truncate', 'shred', 'dd', 'rsync', 'scp',
  'install', 'mklink', 'attrib', 'icacls', 'takeown', 'setx', 'schtasks', 'taskkill', 'kill', 'pkill',
  'killall', 'ren', 'rename', 'dos2unix', 'unix2dos',
  // PowerShell (cmdlets e aliases)
  'remove-item', 'ri', 'move-item', 'mi', 'copy-item', 'cpi', 'new-item', 'ni', 'rename-item', 'rni',
  'set-content', 'sc', 'add-content', 'ac', 'clear-content', 'clc', 'out-file', 'tee-object',
  'expand-archive', 'compress-archive', 'set-itemproperty', 'sp', 'new-itemproperty',
  'remove-itemproperty', 'rp', 'rename-itemproperty', 'set-item', 'si', 'clear-item', 'cli',
  'stop-process', 'spps', 'start-service', 'sasv', 'stop-service', 'spsv', 'restart-service',
  'set-service', 'new-service', 'remove-service', 'set-acl', 'register-scheduledtask',
  'unregister-scheduledtask', 'set-executionpolicy', 'install-module', 'uninstall-module',
  'update-module', 'install-package', 'uninstall-package', 'new-psdrive', 'set-date',
]);

/** Só leem (com qualquer argumento), a menos que haja redirecionamento para arquivo. */
const CMD_LEITURA = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'wc', 'sort',
  'uniq', 'cut', 'tr', 'jq', 'yq', 'echo', 'printf', 'pwd', 'which', 'where', 'whereis', 'whoami',
  'hostname', 'date', 'env', 'printenv', 'stat', 'file', 'du', 'df', 'tree', 'less', 'more', 'diff',
  'cmp', 'comm', 'sha1sum', 'sha256sum', 'md5sum', 'cksum', 'basename', 'dirname', 'realpath',
  'readlink', 'true', 'false', 'test', '[', '[[', 'sleep', 'column', 'nl', 'od', 'xxd', 'hexdump',
  'strings', 'uname', 'id', 'ps', 'netstat', 'ss', 'nproc', 'free', 'uptime', 'cd', 'pushd', 'popd',
  'chdir', 'export', 'set', 'unset', 'read', 'local', 'declare', 'typeset', 'clear', 'cls', 'findstr',
  'tasklist', 'systeminfo', 'ver', 'vol', 'ping', 'nslookup', 'ipconfig', 'nvidia-smi', 'seq',
  // PowerShell
  'get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'sls', 'get-item', 'gi',
  'get-itemproperty', 'gp', 'get-itempropertyvalue', 'gpv', 'test-path', 'resolve-path', 'rvpa',
  'get-location', 'gl', 'set-location', 'sl', 'push-location', 'pop-location', 'measure-object',
  'measure', 'select-object', 'select', 'where-object', '?', 'sort-object', 'format-table', 'ft',
  'format-list', 'fl', 'format-wide', 'fw', 'out-string', 'out-host', 'oh', 'out-null',
  'get-process', 'gps', 'get-service', 'gsv', 'get-command', 'gcm', 'get-help', 'help',
  'write-output', 'write', 'write-host', 'write-verbose', 'write-debug', 'write-information',
  'get-date', 'get-filehash', 'convertfrom-json', 'convertto-json', 'convertfrom-csv',
  'convertto-csv', 'import-csv', 'import-clixml', 'get-member', 'gm', 'group-object', 'group',
  'get-nettcpconnection', 'test-netconnection', 'tnc', 'get-ciminstance', 'gcim', 'get-wmiobject',
  'gwmi', 'get-volume', 'get-psdrive', 'gdr', 'get-acl', 'get-alias', 'gal', 'get-variable', 'gv',
  'set-variable', 'sv', 'get-module', 'gmo', 'get-history', 'h', 'history', 'start-sleep',
  'compare-object', 'compare', 'foreach-object', '%', 'get-unique', 'gu', 'join-path',
  'split-path', 'get-random', 'get-winevent', 'get-eventlog', 'get-hotfix', 'get-computerinfo',
  'get-uptime', 'get-host', 'get-culture', 'get-executionpolicy', 'clear-host', 'set-strictmode',
  'write-progress', 'get-clipboard', 'out-default',
]);

/** Prefixos que não mudam o comando avaliado. */
const PREFIXOS = new Set([
  'sudo', 'time', 'nohup', 'nice', 'stdbuf', 'command', 'builtin', 'exec', 'env', 'then', 'do', 'else',
  'elif', 'if', 'while', 'until', '!', 'try', 'catch', 'finally', 'begin', 'process', 'end', 'not',
]);

/** Palavras que abrem estruturas: o resto do segmento não é comando. */
const CABECALHOS = new Set([
  'for', 'foreach', 'case', 'esac', 'fi', 'done', 'in', 'function', 'filter', 'param', 'switch',
  'return', 'exit', 'break', 'continue',
]);

const GIT_LEITURA = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'grep', 'ls-files', 'ls-tree', 'ls-remote', 'rev-parse',
  'rev-list', 'describe', 'shortlog', 'cat-file', 'show-ref', 'for-each-ref', 'name-rev', 'merge-base',
  'whatchanged', 'count-objects', 'check-ignore', 'check-attr', 'var', 'help', 'version', 'annotate',
  'show-branch', 'cherry', 'range-diff', 'diff-tree', 'diff-files', 'diff-index', 'verify-commit',
  'verify-tag', 'fsck',
]);

const GIT_MUTANTE = new Set([
  'add', 'commit', 'checkout', 'reset', 'apply', 'merge', 'rebase', 'pull', 'push', 'fetch', 'restore',
  'switch', 'cherry-pick', 'revert', 'rm', 'mv', 'clean', 'init', 'clone', 'am', 'gc', 'prune',
  'update-index', 'update-ref', 'filter-branch', 'filter-repo', 'bisect', 'sparse-checkout',
  'mergetool', 'commit-tree', 'write-tree', 'read-tree', 'symbolic-ref', 'repack', 'replace',
  'maintenance', 'pack-refs',
]);

const NPM_LEITURA = new Set([
  'test', 't', 'tst', 'ls', 'list', 'll', 'la', 'view', 'v', 'info', 'show', 'outdated', 'doctor', 'root',
  'prefix', 'bin', 'why', 'explain', 'help', 'search', 's', 'ping', 'whoami', 'fund', 'query',
]);

const NPM_MUTANTE = new Set([
  'install', 'i', 'in', 'isntall', 'add', 'ci', 'clean-install', 'remove', 'rm', 'r', 'un', 'uninstall',
  'unlink', 'update', 'up', 'upgrade', 'link', 'ln', 'prune', 'dedupe', 'ddp', 'rebuild', 'rb',
  'publish', 'unpublish', 'pack', 'init', 'create', 'set', 'patch', 'import', 'deprecate', 'dist-tag',
  'owner', 'access',
]);

const GO_LEITURA = new Set(['test', 'vet', 'list', 'version', 'env', 'doc', 'help']);
const CARGO_LEITURA = new Set([
  'test', 'check', 'clippy', 'tree', 'metadata', 'search', 'verify-project', 'version', '-v',
  '--version', 'help', 'locate-project', 'pkgid', 'bench',
]);
const DOTNET_LEITURA = new Set(['test', 'list', '--info', '--version', '--list-sdks', '--list-runtimes', 'help']);
const KUBECTL_LEITURA = new Set([
  'get', 'describe', 'logs', 'top', 'version', 'explain', 'api-resources', 'api-versions',
  'cluster-info', 'auth',
]);
const PY_MOD_LEITURA = new Set([
  'pytest', 'unittest', 'doctest', 'pyflakes', 'pylint', 'mypy', 'flake8', 'pydoc', 'json.tool',
  'tabnanny', 'pycodestyle', 'pydocstyle', 'bandit', 'timeit', 'site', 'platform', 'this',
]);

/**
 * Mesma largura do texto bruto: as aspas viram \x01 e, dentro delas, espaços e operadores viram '_'.
 * Assim o que está entre aspas nunca é lido como operador, redirecionamento ou outro comando.
 */
function neutralizar(bruto) {
  let out = '';
  let aspa = null;
  for (let i = 0; i < bruto.length; i += 1) {
    const ch = bruto[i];
    if (aspa) {
      if (ch === aspa) {
        const anterior = bruto[i - 1];
        const escapado =
          aspa === '"' && (anterior === '`' || (anterior === '\\' && !/^[\s|;&)]?$/.test(bruto[i + 1] ?? '')));
        if (!escapado) {
          aspa = null;
          out += '\x01';
          continue;
        }
      }
      out += /[\s|;&<>(){}`$]/.test(ch) ? '_' : ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      aspa = ch;
      out += '\x01';
      continue;
    }
    out += ch;
  }
  return out;
}

/** Fronteiras [início, fim) dos comandos simples (pipes, ;, &&, ||, &, (), {}, crase, quebra de linha). */
function fronteirasSegmentos(neutro) {
  const re = /\$\{[^}]*\}|\|\||&&|[|;\n\r(){}`]|&(?![\d>])/g;
  const segs = [];
  let ini = 0;
  let m;
  while ((m = re.exec(neutro))) {
    if (m[0].startsWith('${')) continue;
    if (m.index > ini) segs.push([ini, m.index]);
    ini = m.index + m[0].length;
  }
  if (neutro.length > ini) segs.push([ini, neutro.length]);
  return segs;
}

function nomeComando(token) {
  const s = String(token || '')
    .replace(/\x01/g, '')
    .split(/[\\/]/)
    .pop();
  return s.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
}

function desaspar(s) {
  const t = String(s || '').trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) return t.slice(1, -1);
  return t;
}

/** Argumento (entre aspas ou não) logo depois da flag reFlag, no texto bruto do segmento. */
function argumentoApos(bruto, reFlag) {
  const m = reFlag.exec(bruto);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (bruto[i] === ' ' || bruto[i] === '\t') i += 1;
  const q = bruto[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    let out = '';
    while (j < bruto.length && bruto[j] !== q) {
      if (q === '"' && (bruto[j] === '\\' || bruto[j] === '`') && bruto[j + 1] === '"') {
        out += '"';
        j += 2;
        continue;
      }
      out += bruto[j];
      j += 1;
    }
    return out;
  }
  const resto = bruto.slice(i);
  const fim = resto.search(/\s/);
  return fim < 0 ? resto : resto.slice(0, fim);
}

function avaliarCodigo(codigo) {
  if (typeof codigo !== 'string') return 'desconhecido';
  if (RE_API_ESCRITA.test(codigo)) return 'mutante';
  if (RE_CODIGO_EXECUTA.test(codigo)) return 'desconhecido';
  return 'leitura';
}

function primeiroPosicional(args, comValor = null) {
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith('-')) return { i, valor: args[i].toLowerCase() };
    if (comValor && comValor.test(args[i])) i += 1;
  }
  return { i: -1, valor: '' };
}

function avaliarGit(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    i += /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path)$/.test(args[i]) ? 2 : 1;
  }
  const sub = (args[i] || '').toLowerCase();
  const resto = args.slice(i + 1);
  if (!sub || /^(--version|--help)$/.test(sub)) return 'leitura';
  if (GIT_LEITURA.has(sub)) return 'leitura';
  if (sub === 'reflog') return /^(expire|delete)$/.test(resto[0] || '') ? 'mutante' : 'leitura';
  if (sub === 'branch' || sub === 'tag') {
    const altera =
      sub === 'branch'
        ? /^(-d|-D|-m|-M|-c|-C|-f|--delete|--move|--copy|--force|-u|--set-upstream-to.*|--unset-upstream|--edit-description|--track|--no-track)$/
        : /^(-d|--delete|-a|-s|-f|-m|-F|--annotate|--sign|--force)$/;
    if (resto.some((a) => altera.test(a))) return 'mutante';
    const listar = resto.some((a) =>
      /^(-l|--list|-a|--all|-r|--remotes|-v|-vv|--verbose|--contains|--no-contains|--merged|--no-merged|--points-at|--show-current|-n\d*|--format.*|--sort.*|--column.*)$/.test(a),
    );
    return !listar && resto.some((a) => !a.startsWith('-')) ? 'mutante' : 'leitura';
  }
  if (sub === 'remote') return !resto.length || /^(-v|--verbose|show|get-url)$/.test(resto[0]) ? 'leitura' : 'mutante';
  if (sub === 'stash') return /^(list|show)$/.test(resto[0] || '') ? 'leitura' : 'mutante';
  if (sub === 'config') {
    if (resto.some((a) => /^(--get|--get-all|--get-regexp|--list|-l|--get-urlmatch)$/.test(a))) return 'leitura';
    if (resto.some((a) => /^(--unset|--unset-all|--add|--replace-all|--rename-section|--remove-section|-e|--edit)$/.test(a))) {
      return 'mutante';
    }
    return resto.filter((a) => !a.startsWith('-')).length <= 1 ? 'leitura' : 'mutante';
  }
  if (sub === 'worktree') return resto[0] === 'list' ? 'leitura' : 'mutante';
  if (sub === 'notes') return !resto[0] || /^(list|show)$/.test(resto[0]) ? 'leitura' : 'mutante';
  if (sub === 'submodule') {
    if (resto[0] === 'foreach') return 'desconhecido';
    return !resto[0] || /^(status|summary)$/.test(resto[0]) ? 'leitura' : 'mutante';
  }
  if (sub === 'lfs') return /^(ls-files|status|env|version)$/.test(resto[0] || '') ? 'leitura' : 'mutante';
  if (GIT_MUTANTE.has(sub)) return 'mutante';
  return 'desconhecido';
}

function avaliarScriptNpm(script) {
  const s = String(script || '').toLowerCase();
  if (!s) return 'leitura'; // "npm run" sozinho lista os scripts
  if (/^(test|tests|test:[\w:.-]+|lint|lint:check|typecheck|type-check|check|check:[\w:.-]+|tsc|validate|verify)$/.test(s)) {
    return 'leitura';
  }
  if (/^(build|build:[\w:.-]+|format|fmt|fix|lint:fix|gen|generate|codegen|gen:[\w:.-]+|migrate|migrate:[\w:.-]+|seed|clean|prepare|compile|bundle|dist)$/.test(s)) {
    return 'mutante';
  }
  return 'desconhecido';
}

function avaliarNpm(cmd, args, bruto, prof) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    i += /^(--prefix|-C|--dir|--cwd|-w|--workspace|--filter|-F)$/.test(args[i]) ? 2 : 1;
  }
  const sub = (args[i] || '').toLowerCase();
  const resto = args.slice(i + 1);
  if (!sub) return cmd === 'yarn' && !args.length ? 'mutante' : 'leitura';
  if (NPM_LEITURA.has(sub)) return 'leitura';
  if (sub === 'version') return resto.some((a) => !a.startsWith('-')) ? 'mutante' : 'leitura';
  if (sub === 'audit') return resto.includes('fix') ? 'mutante' : 'leitura';
  if (sub === 'config' || sub === 'c') return /^(get|list|ls)$/.test(resto[0] || '') ? 'leitura' : 'mutante';
  if (sub === 'cache') return /^(ls|list|verify)$/.test(resto[0] || '') ? 'leitura' : 'mutante';
  if (/^(run|run-script|rum|urn)$/.test(sub)) return avaliarScriptNpm(primeiroPosicional(resto).valor);
  if (/^(exec|x|dlx)$/.test(sub)) {
    const p = primeiroPosicional(resto, /^(-p|--package|-c|--call)$/);
    return p.i < 0 ? 'desconhecido' : avaliarCmd(nomeComando(resto[p.i]).replace(/@[^@]*$/, ''), resto.slice(p.i + 1), bruto, prof);
  }
  if (NPM_MUTANTE.has(sub)) return 'mutante';
  if (cmd !== 'npm') return avaliarScriptNpm(sub); // yarn/pnpm/bun <script>
  return 'desconhecido';
}

function avaliarNode(args, bruto) {
  for (const a of args) {
    if (!a.startsWith('-')) return 'desconhecido'; // script: pode fazer qualquer coisa
    if (/^--test(?:$|[-=])/.test(a) || /^(-v|--version|-h|--help|-c|--check)$/.test(a)) return 'leitura';
    if (/^(-e|--eval|-p|--print)$/.test(a) || /^--(eval|print)=/.test(a)) {
      return avaliarCodigo(argumentoApos(bruto, /\s(?:-e|--eval|-p|--print)(?:=|(?=\s))/));
    }
  }
  return 'desconhecido';
}

function avaliarPython(args, bruto, prof) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-c') return avaliarCodigo(argumentoApos(bruto, /\s-c(?=\s)/));
    if (a === '-m') {
      const mod = (args[i + 1] || '').toLowerCase();
      const resto = args.slice(i + 2);
      if (PY_MOD_LEITURA.has(mod)) return 'leitura';
      if (mod === 'pip' || mod === 'pip3') {
        const sub = primeiroPosicional(resto).valor || (resto[0] || '').toLowerCase();
        return /^(list|show|freeze|check|--version|-v|help|search|index|inspect|config)$/.test(sub) ? 'leitura' : 'mutante';
      }
      if (['black', 'isort', 'autopep8', 'yapf', 'autoflake'].includes(mod)) {
        return resto.some((x) => /^--(check|diff)$/.test(x)) ? 'leitura' : 'mutante';
      }
      if (mod === 'ruff') return avaliarCmd('ruff', resto, bruto, prof);
      if (['venv', 'virtualenv', 'ensurepip', 'build', 'twine', 'compileall', 'py_compile'].includes(mod)) return 'mutante';
      return 'desconhecido';
    }
    if (/^(-V|--version|-h|--help)$/.test(a)) return 'leitura';
    if (!a.startsWith('-')) return 'desconhecido'; // script
  }
  return 'desconhecido';
}

function destinoNulo(v) {
  return /^(\/dev\/null|nul|-)$/i.test(String(v || ''));
}

function metodoSoLeitura(v) {
  return /^(GET|HEAD|OPTIONS|DEFAULT)$/i.test(String(v || ''));
}

function avaliarCurl(args) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    let m;
    if ((m = /^(?:-X|--request)=?(.*)$/.exec(a))) {
      if (!metodoSoLeitura(m[1] || args[i + 1])) return 'mutante';
      continue;
    }
    if (/^(?:-d|--data(?:-\w+)?|--json|-F|--form(?:-string)?|-T|--upload-file|-O|--remote-name(?:-all)?|-J|--remote-header-name)(?:=.*)?$/.test(a)) {
      return 'mutante';
    }
    if (/^-d./.test(a)) return 'mutante';
    if ((m = /^(?:-o|--output|-c|--cookie-jar|-D|--dump-header)=?(.*)$/.exec(a))) {
      if (!destinoNulo(m[1] || args[i + 1])) return 'mutante';
      continue;
    }
    if (/^-[a-zA-Z]{2,}$/.test(a)) {
      const letras = a.slice(1);
      if (/[dFTOJ]/.test(letras)) return 'mutante';
      const ultima = letras[letras.length - 1];
      if (ultima === 'X' && !metodoSoLeitura(args[i + 1])) return 'mutante';
      if ((ultima === 'o' || ultima === 'c' || ultima === 'D') && !destinoNulo(args[i + 1])) return 'mutante';
    }
  }
  return 'leitura';
}

function avaliarIrm(args) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    const m = /^-meth\w*(?::(.*))?$/i.exec(a);
    if (m && !metodoSoLeitura(m[1] || args[i + 1])) return 'mutante';
    if (/^-(outf\w*|inf\w*|bod\w*|form)$/i.test(a)) return 'mutante';
  }
  return 'leitura';
}

function avaliarDocker(cmd, args) {
  const a = cmd === 'docker-compose' ? ['compose', ...args] : args;
  let i = 0;
  while (i < a.length && a[i].startsWith('-')) i += /^(-H|--host|--context|-c|--config|--log-level|-l)$/.test(a[i]) ? 2 : 1;
  const sub = (a[i] || '').toLowerCase();
  const resto = a.slice(i + 1);
  if (sub === 'compose') {
    let j = 0;
    while (j < resto.length && resto[j].startsWith('-')) {
      j += /^(-f|--file|-p|--project-name|--env-file|--profile|--project-directory)$/.test(resto[j]) ? 2 : 1;
    }
    return /^(ps|logs|config|ls|images|top|version|port|events)$/.test((resto[j] || '').toLowerCase()) ? 'leitura' : 'mutante';
  }
  if (['container', 'image', 'volume', 'network', 'context', 'plugin', 'system'].includes(sub)) {
    return /^(ls|list|inspect|logs|top|stats|port|df|info|history|events)$/.test((resto[0] || '').toLowerCase()) ? 'leitura' : 'mutante';
  }
  const s = sub || (a[0] || '').toLowerCase();
  return /^(ps|images|logs|inspect|version|info|stats|top|port|history|search|events|diff|--version|-v)$/.test(s) ? 'leitura' : 'mutante';
}

function avaliarGh(args) {
  const sub = (args[0] || '').toLowerCase();
  const acao = (args[1] || '').toLowerCase();
  if (!sub || /^(--version|--help|status|browse|search|version)$/.test(sub)) return 'leitura';
  if (sub === 'auth') return /^(status|token)$/.test(acao) ? 'leitura' : 'mutante';
  if (sub === 'api') {
    for (let i = 0; i < args.length; i += 1) {
      const m = /^(?:-X|--method)=?(.*)$/.exec(args[i]);
      if (m && !metodoSoLeitura(m[1] || args[i + 1])) return 'mutante';
    }
    return args.some((x) => /^(-f|-F|--field|--raw-field|--input)$/.test(x)) ? 'mutante' : 'leitura';
  }
  return /^(view|list|ls|status|checks|diff|watch)$/.test(acao) ? 'leitura' : 'mutante';
}

function avaliarTar(args) {
  if (args.some((a) => a === '--list')) return 'leitura';
  if (args.some((a) => /^--(extract|get|create|append|update|delete|catenate|concatenate)$/.test(a))) return 'mutante';
  const grupo = args.find((a) => /^-?[A-Za-z]+$/.test(a) && !a.startsWith('--')) || '';
  const letras = grupo.replace(/^-/, '');
  if (/[xcruA]/.test(letras)) return 'mutante';
  if (/t/.test(letras)) return 'leitura';
  return 'desconhecido';
}

function avaliarWrapper(cmd, bruto, prof) {
  if (prof >= 2) return 'desconhecido';
  let payload = null;
  if (cmd === 'cmd') {
    const m = /\s\/[ck]\s+/i.exec(bruto);
    if (m) payload = desaspar(bruto.slice(m.index + m[0].length));
  } else if (cmd === 'pwsh' || cmd === 'powershell') {
    payload = argumentoApos(bruto, /\s-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?(?=[\s:])/i);
  } else {
    payload = argumentoApos(bruto, /\s-[a-zA-Z]*c(?=\s)/);
  }
  if (payload === null) return 'desconhecido';
  const r = analisarComando(payload, prof + 1);
  return r.mutante ? 'mutante' : r.leitura ? 'leitura' : 'desconhecido';
}

/** Avalia um comando simples: 'leitura' | 'mutante' | 'desconhecido' | 'vazio'. */
function avaliarCmd(cmd, args, bruto, prof) {
  if (!cmd) return 'vazio';
  if (CMD_MUTANTE.has(cmd)) return 'mutante';
  if (args.some((a) => /^--(?:write|fix|in-place)(?:=|$)/i.test(a))) return 'mutante';
  const sub = primeiroPosicional(args).valor;
  switch (cmd) {
    case 'sed':
      return args.some((a) => /^-[a-z]*i/i.test(a) && !a.startsWith('--')) ? 'mutante' : 'leitura';
    case 'perl':
      return args.some((a) => /^-[a-z]*i/i.test(a) && !a.startsWith('--')) ? 'mutante' : 'desconhecido';
    case 'awk':
    case 'gawk':
      return args.includes('-i') && args.some((a) => /inplace/i.test(a)) ? 'mutante' : 'leitura';
    case 'find':
      if (args.some((a) => /^-(?:delete|fprint\w*|fls)$/.test(a))) return 'mutante';
      return args.some((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a)) ? 'desconhecido' : 'leitura';
    case 'git':
      return avaliarGit(args);
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return avaliarNpm(cmd, args, bruto, prof);
    case 'npx':
    case 'pnpx':
    case 'bunx': {
      const p = primeiroPosicional(args, /^(-p|--package|-c|--call)$/);
      if (p.i < 0) return 'desconhecido';
      return avaliarCmd(nomeComando(args[p.i]).replace(/@[^@]*$/, ''), args.slice(p.i + 1), bruto, prof);
    }
    case 'tsc': {
      if (args.some((a) => /^(-v|--version|-h|--help)$/i.test(a))) return 'leitura';
      const semEmitir = args.some((a) => /^--?noemit$/i.test(a)) && !args.some((a) => /^(-b|--build)$/.test(a));
      return semEmitir ? 'leitura' : 'mutante';
    }
    case 'prettier':
      return args.includes('-w') ? 'mutante' : 'leitura';
    case 'eslint':
    case 'stylelint':
    case 'tslint':
      return 'leitura';
    case 'biome':
      return args.some((a) => /^--(apply|apply-unsafe)$/.test(a)) ? 'mutante' : 'leitura';
    case 'vitest':
    case 'jest':
    case 'mocha':
    case 'ava':
    case 'tap':
    case 'pytest':
    case 'py.test':
    case 'playwright':
    case 'cypress':
    case 'karma':
      if (sub === 'install') return 'mutante';
      return args.some((a) => /^(-u|--update-?snapshots?|--updateSnapshot)$/i.test(a)) ? 'mutante' : 'leitura';
    case 'node':
      return avaliarNode(args, bruto);
    case 'python':
    case 'python3':
    case 'py':
      return avaliarPython(args, bruto, prof);
    case 'black':
    case 'isort':
    case 'autopep8':
    case 'yapf':
    case 'rustfmt':
    case 'autoflake':
      return args.some((a) => /^--(check|diff)$/.test(a)) ? 'leitura' : 'mutante';
    case 'ruff':
      if (sub === 'format') return args.some((a) => /^--(check|diff)$/.test(a)) ? 'leitura' : 'mutante';
      return 'leitura';
    case 'gofmt':
      return args.includes('-w') ? 'mutante' : 'leitura';
    case 'go':
      if (GO_LEITURA.has(sub)) return 'leitura';
      return sub === 'run' ? 'desconhecido' : 'mutante';
    case 'cargo': {
      const s = sub || (args[0] || '').toLowerCase();
      if (CARGO_LEITURA.has(s)) return 'leitura';
      return s === 'run' ? 'desconhecido' : 'mutante';
    }
    case 'dotnet': {
      const s = sub || (args[0] || '').toLowerCase();
      if (DOTNET_LEITURA.has(s)) return 'leitura';
      return s === 'run' || s === 'watch' ? 'desconhecido' : 'mutante';
    }
    case 'curl':
      return avaliarCurl(args);
    case 'wget': {
      const junto = ` ${args.join(' ')} `;
      return /\s--spider\s/.test(junto) || /\s-q?O\s*(?:-|\/dev\/null|nul)\s/i.test(junto) || /\s-qO-\s/.test(junto)
        ? 'leitura'
        : 'mutante';
    }
    case 'invoke-restmethod':
    case 'irm':
    case 'invoke-webrequest':
    case 'iwr':
      return avaliarIrm(args);
    case 'ollama': {
      const s = sub || (args[0] || '').toLowerCase();
      if (!s) return 'desconhecido';
      return /^(ps|list|ls|show|help|--version|-v|version)$/.test(s) ? 'leitura' : 'mutante';
    }
    case 'docker':
    case 'podman':
    case 'docker-compose':
      return avaliarDocker(cmd, args);
    case 'gh':
      return avaliarGh(args);
    case 'kubectl':
    case 'oc':
      if (KUBECTL_LEITURA.has(sub)) return 'leitura';
      if (sub === 'config') return /^(view|get-contexts|current-context|get-clusters)$/.test(primeiroPosicional(args.slice(args.indexOf('config') + 1)).valor) ? 'leitura' : 'mutante';
      return 'mutante';
    case '7z':
    case '7za':
    case '7zr':
      return /^[lti]$/i.test(sub) ? 'leitura' : 'mutante';
    case 'unzip':
      return args.some((a) => /^-[a-zA-Z]*[ltvZ]/.test(a)) ? 'leitura' : 'mutante';
    case 'tar':
      return avaliarTar(args);
    case 'reg':
      return sub === 'query' ? 'leitura' : 'mutante';
    case 'timeout': {
      if (args[0] && /^\/t$/i.test(args[0])) return 'leitura';
      let i = 0;
      while (args[i] && args[i].startsWith('-')) i += 1;
      i += 1; // duração
      return args[i] ? avaliarCmd(nomeComando(args[i]), args.slice(i + 1), bruto, prof) : 'leitura';
    }
    case 'xargs':
    case 'watch': {
      let i = 0;
      while (args[i] && args[i].startsWith('-')) i += /^-[IdnLPsEa]$/.test(args[i]) ? 2 : 1;
      return args[i] ? avaliarCmd(nomeComando(args[i]), args.slice(i + 1), bruto, prof) : 'leitura';
    }
    case 'bash':
    case 'sh':
    case 'zsh':
    case 'dash':
    case 'pwsh':
    case 'powershell':
    case 'cmd':
      return avaliarWrapper(cmd, bruto, prof);
    default:
      return CMD_LEITURA.has(cmd) ? 'leitura' : 'desconhecido';
  }
}

function avaliarSegmento(tokens, bruto, prof) {
  const t = tokens.slice();
  let chamada = false;
  while (t.length) {
    const x = t[0];
    const xl = x.toLowerCase();
    if (x === '&' || x === '.' || x === '@' || x === '!') {
      chamada = chamada || x === '&' || x === '.';
      t.shift();
      continue;
    }
    if (PREFIXOS.has(xl)) {
      t.shift();
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) {
      t.shift(); // VAR=valor comando (bash)
      continue;
    }
    if (/^\$[\w:.]+(?:\[[^\]]*\])?$/.test(x) && t[1] && /^[-+*/.]?=$/.test(t[1])) {
      t.splice(0, 2); // $x = ... (PowerShell)
      continue;
    }
    const atrib = /^\$[\w:.]+[-+*/]?=(.*)$/.exec(x);
    if (atrib) {
      if (atrib[1]) t[0] = atrib[1];
      else t.shift();
      continue;
    }
    break;
  }
  if (!t.length) return 'vazio';
  const primeiro = t[0];
  const pl = primeiro.toLowerCase();
  if (CABECALHOS.has(pl)) return 'vazio';
  if (primeiro.startsWith('$')) return chamada ? 'desconhecido' : 'vazio';
  const estatica = /^\[[\w.]+\]::(\w+)/.exec(primeiro);
  if (estatica) {
    if (RE_API_ESCRITA.test(primeiro)) return 'mutante';
    return /^(Read|Exists|Get|Combine|Round|Parse|TryParse|Join|Format|Now|Today|ToString|Equals|Compare|IsNullOrEmpty|IsNullOrWhiteSpace)/i.test(estatica[1])
      ? 'vazio'
      : 'desconhecido';
  }
  if (pl === '[' || pl === '[[') return 'leitura';
  if (/^\[/.test(primeiro)) return 'vazio'; // [tipo]
  if (/^[-.\])},=+*]/.test(primeiro) && !/^\.{1,2}[\\/]/.test(primeiro)) return 'vazio'; // operador, propriedade
  if (/^\d+$/.test(primeiro)) return 'vazio';
  return avaliarCmd(nomeComando(primeiro), t.slice(1), bruto, prof);
}

/**
 * Analisa um comando de shell (Bash ou PowerShell).
 * Retorna { mutante, leitura }: mutante = altera arquivos/estado com certeza razoável;
 * leitura = todos os comandos são sabidamente só de leitura. Nenhum dos dois = desconhecido.
 */
export function analisarComando(comando, prof = 0) {
  if (typeof comando !== 'string' || !comando.trim()) return { mutante: false, leitura: false };
  if (comando.length > MAX_COMANDO_ANALISE) return { mutante: false, leitura: false };
  const bruto = comando;
  const neutro = neutralizar(bruto);
  let mutante = false;
  let leitura = true;
  // Substituição de comando dentro de aspas duplas ("$(...)"): o que roda ali não é analisado.
  if (/"[^"]*\$\([^"]*"/.test(bruto)) leitura = false;
  const semInofensivos = neutro
    .replace(/\d?>>?\s*(?:&\d|\/dev\/null\b|\$null\b|nul\b)/gi, ' ')
    .replace(/[*&]>>?\s*(?:&\d|\/dev\/null\b|\$null\b|nul\b)/gi, ' ');
  // Redirecionamento para arquivo (ignora =>, ->, >=).
  if (/(^|[^=\-<>])>{1,2}(?!=)\s*[^\s&|>]/.test(semInofensivos)) mutante = true;
  for (const [ini, fim] of fronteirasSegmentos(semInofensivos)) {
    const tokens = semInofensivos
      .slice(ini, fim)
      .split(/\s+/)
      .map((x) => x.replace(/\x01/g, ''))
      .filter(Boolean);
    const r = avaliarSegmento(tokens, bruto.slice(ini, fim), prof);
    if (r === 'mutante') mutante = true;
    else if (r === 'desconhecido') leitura = false;
  }
  if (mutante) leitura = false;
  return { mutante, leitura };
}

/** O comando de shell provavelmente altera arquivos/estado? */
export function comandoMutante(comando) {
  return analisarComando(comando).mutante;
}

/** O comando de shell é sabidamente só de leitura (lista branca)? */
export function comandoLeitura(comando) {
  return analisarComando(comando).leitura;
}

/** Remove do comando o que não muda o efeito (espaços, 2>&1, truncagem final da saída). */
export function normalizarComando(comando) {
  let c = String(comando ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  let antes;
  do {
    antes = c;
    c = c
      .replace(/\s*(?:\d|\*|&)?>>?\s*(?:&\d|\/dev\/null\b|\$null\b|nul\b)/gi, '')
      .replace(/\s*\|\s*(?:tail|head)(?:\s+-[nc]\s*\+?\d+|\s+-\d+)?\s*$/i, '')
      .replace(/\s*\|\s*(?:Select-Object|select)\s+-(?:First|Last)\s+\d+\s*$/i, '')
      .replace(/\s*\|\s*(?:Out-String|Out-Host|more|cat)\s*$/i, '')
      .replace(/\s*;\s*$/, '')
      .trim();
  } while (c !== antes);
  return c.replace(/(^|[;&|]\s*)(npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+test|t|tst)(?=\s|$)/gi, '$1$2 test');
}

/** Consultas de status/espera: repetir depois de um tempo é polling legítimo. */
const RE_CONSULTA_SHELL = new RegExp(
  [
    '\\b(?:curl|wget|irm|iwr|Invoke-RestMethod|Invoke-WebRequest)\\b[^|;&]*?\\/(?:health\\w*|api\\/(?:ps|tags|version)|v1\\/models|status|ready|ping|metrics)\\b',
    '\\bollama\\s+(?:ps|list|ls)\\b',
    '\\bgit\\s+status\\b',
    '\\b(?:tail|Get-Content|gc)\\b[^|;&]*(?:\\s-f\\b|\\s-F\\b|-Wait\\b|-Tail\\b|\\.log\\b)',
    '\\bdocker(?:-compose|\\s+compose)?\\s+(?:ps|logs)\\b',
    '\\bgh\\s+(?:run|pr)\\s+(?:view|checks|watch|list)\\b',
    '\\b(?:sleep|Start-Sleep)\\b',
    '\\btimeout\\s+\\/t\\b',
    '\\bkubectl\\s+(?:get|logs)\\b',
    '\\bnvidia-smi\\b',
    '\\b(?:Get-Process|tasklist)\\b',
  ].join('|'),
  'i',
);
const TOKENS_CONSULTA = new Set(['status', 'health', 'progress', 'poll', 'wait', 'monitor', 'logs', 'ping', 'ready', 'heartbeat']);

/** Verbos que indicam escrita em ferramentas MCP/outras (nome ou campo action). */
const VERBOS_ESCRITA = new Set([
  'create', 'update', 'delete', 'del', 'remove', 'rm', 'edit', 'set', 'send', 'post', 'put', 'patch',
  'write', 'click', 'type', 'key', 'press', 'scroll', 'drag', 'drop', 'hover', 'upload', 'move',
  'rename', 'insert', 'add', 'publish', 'deploy', 'execute', 'exec', 'run', 'eval', 'javascript',
  'submit', 'fill', 'input', 'navigate', 'goto', 'open', 'close', 'select', 'apply', 'commit',
  'merge', 'reply', 'respond', 'cancel', 'archive', 'unarchive', 'restore', 'register', 'registrar',
  'criar', 'apagar', 'excluir', 'enviar', 'salvar', 'gravar', 'editar', 'atualizar', 'batch',
  'resize', 'switch', 'start', 'stop', 'kill', 'install', 'uninstall', 'generate', 'save', 'import',
  'copy', 'duplicate', 'mark', 'pin', 'unpin', 'approve', 'comment', 'assign', 'toggle', 'enable',
  'disable', 'reset', 'clear', 'upsert', 'sync', 'push', 'pull', 'trigger', 'schedule', 'book', 'pay',
  'transfer', 'change', 'modify', 'replace', 'append', 'tap', 'swipe', 'back', 'forward', 'reload',
  'refresh', 'mutate', 'invoke', 'spawn', 'dismiss', 'bind', 'unbind', 'connect', 'reconnect',
  'login', 'logout', 'share', 'invite', 'attach', 'detach', 'lock', 'unlock', 'rollback', 'revert',
  'tag', 'deny', 'allow', 'grant', 'revoke', 'confirm', 'accept', 'decline', 'clean',
]);

/** Nome que começa com verbo de leitura (get_run, read_page, list_events): só a action decide. */
const VERBOS_LEITURA_INICIAIS = new Set([
  'get', 'list', 'read', 'search', 'find', 'query', 'fetch', 'show', 'describe', 'view', 'status',
  'count', 'inspect', 'lookup', 'browse', 'resolve', 'check', 'explore', 'preview', 'ask', 'buscar',
  'consultar', 'ler', 'listar', 'obter',
]);

function tokensNome(s) {
  return String(s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Ferramenta "outra" (MCP, embutida desconhecida) altera algo quando dá certo? */
export function ferramentaMutante(nome, entrada, cfg = null) {
  if (cfg && cfg.mutantesExtras && cfg.mutantesExtras.has(nome)) return true;
  if (cfg && cfg.leituraExtras && cfg.leituraExtras.has(nome)) return false;
  const curto = String(nome || '').split('__').pop();
  const doNome = tokensNome(curto);
  const tokens = VERBOS_LEITURA_INICIAIS.has(doNome[0]) ? [] : doNome;
  if (entrada && typeof entrada === 'object') {
    if (typeof entrada.action === 'string') tokens.push(...tokensNome(entrada.action));
    if (typeof entrada.method === 'string' && /^(post|put|patch|delete)$/i.test(entrada.method)) return true;
  }
  return tokens.some((t) => VERBOS_ESCRITA.has(t));
}

/** A chamada é uma consulta de status/espera (o resultado muda com o tempo)? */
export function ehConsulta(nome, entrada) {
  if (SHELL.has(nome)) return RE_CONSULTA_SHELL.test(String((entrada && entrada.command) || ''));
  if (LEITURA.has(nome) || MUTANTES.has(nome) || DELEGACAO.has(nome)) return false;
  const tokens = tokensNome(String(nome || '').split('__').pop());
  if (entrada && typeof entrada === 'object' && typeof entrada.action === 'string') tokens.push(...tokensNome(entrada.action));
  return tokens.some((t) => TOKENS_CONSULTA.has(t)) && !ferramentaMutante(nome, entrada);
}

/**
 * Categoria da ferramenta:
 *   isenta | leitura | shell-mutante | mutante | delegacao | outra
 * Shell desconhecido (python script.py, node gerar.mjs) é 'outra': pode ter alterado algo.
 */
export function classificar(nome, entrada, cfg = null) {
  if (ISENTAS.has(nome) || (cfg && cfg.isentasExtras && cfg.isentasExtras.has(nome))) return 'isenta';
  if (MUTANTES.has(nome)) return 'mutante';
  if (DELEGACAO.has(nome)) return 'delegacao';
  if (SHELL.has(nome)) {
    const a = analisarComando(entrada && entrada.command);
    return a.mutante ? 'shell-mutante' : a.leitura ? 'leitura' : 'outra';
  }
  if (LEITURA.has(nome)) return 'leitura';
  return 'outra';
}

/** A chamada, se der certo, muda arquivos/estado (avança a época)? */
function mutaSeOk(categoria, nome, entrada, cfg) {
  if (categoria === 'mutante' || categoria === 'shell-mutante') return true;
  if (categoria !== 'outra') return false;
  return SHELL.has(nome) || ferramentaMutante(nome, entrada, cfg);
}

/** Forma canônica da chamada (o que importa para saber se é "a mesma"). */
export function chamadaCanonica(nome, entrada, cwd = '') {
  if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)) return { nome, entrada: entrada ?? null };
  if (SHELL.has(nome)) {
    const comando = normalizarComando(entrada.command);
    const ler = /^(?:cat|type|gc|Get-Content)\s+(?:-Path\s+)?("[^"]+"|'[^']+'|[^\s"'|;&<>*?$]+)$/i.exec(comando);
    if (ler) return { nome: 'Read', entrada: { file_path: resolverCaminho(desaspar(ler[1]), cwd) } };
    const copia = { ...entrada, command: comando };
    for (const k of CAMPOS_SHELL_IGNORADOS) delete copia[k];
    const c = normalizarCaminho(cwd);
    if (c) copia.cwd = c;
    return { nome: 'shell', entrada: copia };
  }
  const copia = { ...entrada };
  if (DELEGACAO.has(nome)) {
    delete copia.description;
    delete copia.run_in_background;
  }
  if (COM_CAMINHO.has(nome)) {
    for (const k of CAMPOS_CAMINHO) {
      if (typeof copia[k] === 'string' && copia[k]) copia[k] = resolverCaminho(copia[k], cwd);
    }
    if ((nome === 'Grep' || nome === 'Glob' || nome === 'LS') && !copia.path) {
      const c = normalizarCaminho(cwd);
      if (c) copia.path = c;
    }
  }
  return { nome, entrada: copia };
}

/** Base da assinatura: chamada canônica + sha1 estável. */
export function assinaturaBase(nome, entrada, cwd = '') {
  const c = chamadaCanonica(nome, entrada, cwd);
  return `${c.nome}|${sha1(serializarEstavel(c.entrada)).slice(0, 16)}`;
}

/** Assinatura final (com época quando aplicável). */
export function assinatura(nome, entrada, epoca = null, cwd = '') {
  const base = assinaturaBase(nome, entrada, cwd);
  return epoca === null || epoca === undefined ? base : `${base}|e${epoca}`;
}

/** mtime:tamanho do alvo de Read/Grep/Glob/LS (ou de "cat arquivo"); null se não se aplica. */
export function statAlvo(nome, entrada, cwd = '') {
  try {
    const c = chamadaCanonica(nome, entrada, cwd);
    if (!COM_ALVO.has(c.nome) || !c.entrada || typeof c.entrada !== 'object') return null;
    const alvo = c.entrada.file_path || c.entrada.notebook_path || c.entrada.path;
    if (typeof alvo !== 'string' || !alvo) return null;
    const st = fs.statSync(path.resolve(alvo));
    return `${Math.trunc(st.mtimeMs)}:${st.size}`;
  } catch (e) {
    return e && e.code === 'ENOENT' ? 'ausente' : null;
  }
}

/** A resposta de uma ferramenta (PostToolUse) indica erro? */
export function respostaIndicaErro(resp) {
  if (resp === null || resp === undefined) return false;
  if (typeof resp === 'string') return /^\s*(<tool_use_error>|Error:)/.test(resp);
  if (typeof resp !== 'object' || Array.isArray(resp)) return false;
  if (resp.is_error === true || resp.isError === true) return true;
  if (resp.interrupted === true) return true;
  if (resp.success === false) return true;
  for (const k of ['exitCode', 'exit_code', 'returnCode', 'return_code']) {
    const v = resp[k];
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n !== 0) return true;
  }
  if (typeof resp.error === 'string' && resp.error.trim()) return true;
  return false;
}

/** Resumo curto e mascarado do alvo da chamada (para as mensagens). */
export function resumoChamada(entrada) {
  if (!entrada || typeof entrada !== 'object') return '';
  const alvo =
    entrada.file_path ??
    entrada.notebook_path ??
    entrada.command ??
    entrada.pattern ??
    entrada.url ??
    entrada.query ??
    entrada.path ??
    entrada.description ??
    entrada.prompt ??
    '';
  let s = String(alvo).replace(/\s+/g, ' ').trim();
  s = s
    .replace(/(bearer\s+|authorization:\s*|api[_-]?key\s*[=:]\s*|token\s*[=:]\s*|password\s*[=:]\s*|senha\s*[=:]\s*)\S+/gi, '$1***')
    .replace(/[A-Za-z0-9_\-]{32,}/g, '***');
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

export function estadoInicial(agora = Date.now()) {
  return {
    v: VERSAO_ESTADO,
    criado: agora,
    atualizado: agora,
    epoca: 0,
    externaVista: 0,
    proprias: 0,
    mutPorAssin: {},
    historico: [],
    contados: [],
    chamadasTurno: 0,
    checkpointsEmitidos: 0,
    falhas: [],
    falhasEdit: {},
    alertas: {},
    postVisto: false,
  };
}

function mapaNumerico(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([, n]) => Number.isFinite(n) && n >= 0));
}

function itemValido(x) {
  return (
    x &&
    typeof x === 'object' &&
    !Array.isArray(x) &&
    typeof x.b === 'string' &&
    typeof x.s === 'string' &&
    Number.isFinite(x.t)
  );
}

/** Garante a forma do estado (tolera campos ausentes/errados e o formato antigo). */
export function normalizarEstado(bruto, agora = Date.now()) {
  const base = estadoInicial(agora);
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return base;
  const num = (v, p = 0) => (Number.isFinite(v) && v >= 0 ? v : p);
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  return {
    v: VERSAO_ESTADO,
    criado: num(bruto.criado, agora),
    atualizado: num(bruto.atualizado, agora),
    epoca: num(bruto.epoca),
    externaVista: num(bruto.externaVista),
    proprias: num(bruto.proprias),
    mutPorAssin: mapaNumerico(bruto.mutPorAssin),
    historico: Array.isArray(bruto.historico) ? bruto.historico.filter(itemValido) : [],
    contados: strings(bruto.contados).slice(-MAX_IDS_CONTADOS),
    chamadasTurno: num(bruto.chamadasTurno),
    checkpointsEmitidos: num(bruto.checkpointsEmitidos),
    falhas: Array.isArray(bruto.falhas) ? bruto.falhas.filter((x) => x === 0 || x === 1) : [],
    falhasEdit: mapaNumerico(bruto.falhasEdit),
    alertas: mapaNumerico(bruto.alertas),
    postVisto: bruto.postVisto === true,
  };
}

/** Conta uma chamada de ferramenta no turno, sem contar duas vezes o mesmo tool_use_id. */
function contarChamada(estado, idChamada, origem) {
  const id = typeof idChamada === 'string' && idChamada ? idChamada : '';
  if (origem === 'post' && !id) return; // sem id: assume que o PreToolUse já contou
  if (id && estado.contados.includes(id)) return;
  estado.chamadasTurno += 1;
  if (id) {
    estado.contados.push(id);
    if (estado.contados.length > MAX_IDS_CONTADOS) estado.contados.splice(0, estado.contados.length - MAX_IDS_CONTADOS);
  }
}

function podarMapa(mapa, max = MAX_CHAVES) {
  const chaves = Object.keys(mapa);
  if (chaves.length > max) for (const k of chaves.slice(0, chaves.length - max)) delete mapa[k];
}

function registrarMutacaoPropria(estado, base) {
  estado.mutPorAssin[base] = (estado.mutPorAssin[base] || 0) + 1;
  const chaves = Object.keys(estado.mutPorAssin);
  if (chaves.length > MAX_MUT_POR_ASSIN) {
    for (const k of chaves.slice(0, chaves.length - MAX_MUT_POR_ASSIN / 2)) delete estado.mutPorAssin[k];
  }
}

/** Época local + mutações de outros agentes da sessão (monótona). */
function epocaEfetiva(estado, ctx) {
  const lido = ctx && Number.isFinite(ctx.mutCompartilhadas) ? ctx.mutCompartilhadas : 0;
  const externa = Math.max(0, lido - (estado.proprias || 0));
  if (externa > estado.externaVista) estado.externaVista = externa;
  return estado.epoca + estado.externaVista;
}

function saidaContexto(evento, textos) {
  if (!textos.length) return null;
  return {
    hookSpecificOutput: {
      hookEventName: evento,
      additionalContext: textos.join('\n\n'),
    },
  };
}

/**
 * Entre as repetições de uma ação mutante, alguma observação trouxe resultado novo? (ex.: rolar a
 * página e tirar print: o "ok" do rolar é sempre igual, mas os prints mudam => progresso real).
 */
function houveNovidade(estado, desde, sig) {
  const h = estado.historico;
  const inicio = h.indexOf(desde);
  for (let i = Math.max(0, inicio + 1); i < h.length; i += 1) {
    const e = h[i];
    if (e.n || e.s === sig || !e.r) continue;
    let anterior = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (h[j].b === e.b && !h[j].n && h[j].r) {
        anterior = h[j];
        break;
      }
    }
    if (!anterior || anterior.r !== e.r) return true;
  }
  return false;
}

/** Quantas execuções anteriores contam como repetição desta (0 = não é loop). */
function contarRepeticoes(estado, cfg, item, usaSaida, agora, mutavel = false) {
  let anteriores = estado.historico.filter((e) => e.s === item.s && !e.n);
  if (item.c && cfg.pollMs > 0) {
    // Polling: só a cadeia de repetições próximas no tempo conta.
    const cadeia = [];
    let ref = agora;
    for (let i = anteriores.length - 1; i >= 0; i -= 1) {
      if (ref - anteriores[i].t > cfg.pollMs) break;
      cadeia.unshift(anteriores[i]);
      ref = anteriores[i].t;
    }
    anteriores = cadeia;
  }
  if (anteriores.length < cfg.repeticoes) return 0;
  if (usaSaida) {
    const saidas = new Set(
      anteriores
        .slice(-cfg.repeticoes)
        .map((e) => e.r)
        .filter(Boolean),
    );
    if (saidas.size > 1) return 0; // a saída mudou: algo mudou no mundo
  }
  if (mutavel && houveNovidade(estado, anteriores[anteriores.length - cfg.repeticoes], item.s)) return 0;
  return anteriores.length;
}

/** Ciclo de período 2 ou 3 com as mesmas saídas: retorna { periodo, nomes } ou null. */
function detectarCiclo(estado, cfg, item) {
  const exec = estado.historico.filter((e) => !e.n);
  for (const p of [2, 3]) {
    if (exec.length < 2 * p) continue;
    const seq = exec.slice(-2 * p);
    if (item.b !== seq[0].b || item.b !== seq[p].b) continue;
    let ok = true;
    for (let i = 0; i < p && ok; i += 1) if (seq[i].b !== seq[i + p].b) ok = false;
    if (!ok) continue;
    if (new Set(seq.slice(0, p).map((e) => e.b)).size < 2) continue; // repetição pura: regra A
    for (let i = 0; i < p && ok; i += 1) {
      const a = seq[i].r;
      const b = seq[i + p].r;
      if (a && b && a !== b) ok = false; // progresso: a saída mudou
    }
    if (ok && item.r && seq[p].r && item.r !== seq[p].r) ok = false;
    if (ok && cfg.pollMs > 0) {
      for (let i = 0; i < p && ok; i += 1) {
        if ((seq[i].c || seq[i + p].c) && seq[i + p].t - seq[i].t > cfg.pollMs) ok = false;
      }
    }
    if (ok) return { periodo: p, nomes: seq.slice(0, p).map((e) => e.b.split('|')[0]) };
  }
  return null;
}

function aoPreToolUse(entrada, estado, cfg, agora, ctx) {
  const nome = typeof entrada.tool_name === 'string' ? entrada.tool_name : '';
  if (!nome) return { saida: null };
  contarChamada(estado, entrada.tool_use_id, 'pre');

  const input = entrada.tool_input ?? null;
  const categoria = classificar(nome, input, cfg);
  if (categoria === 'isenta') return { saida: null };

  const cwd = typeof entrada.cwd === 'string' ? entrada.cwd : '';
  const canonica = chamadaCanonica(nome, input, cwd);
  const base = assinaturaBase(nome, input, cwd);
  const efetiva = epocaEfetiva(estado, ctx);
  const stat = ctx && typeof ctx.stat === 'string' ? ctx.stat : null;
  let sig;
  if (categoria === 'leitura') {
    sig = `${base}|e${efetiva}${stat ? `|m${stat}` : ''}`;
  } else if (categoria === 'delegacao') {
    // Só a época local: as edições do próprio subagente não liberam reenviar a mesma delegação.
    sig = `${base}|x${Math.max(0, estado.epoca - (estado.mutPorAssin[base] || 0))}`;
  } else if (categoria === 'mutante') {
    sig = base;
  } else {
    sig = `${base}|x${Math.max(0, efetiva - (estado.mutPorAssin[base] || 0))}`;
  }

  const leituraArquivo = LEITURA_ARQUIVO.has(canonica.nome);
  const usaSaida = categoria !== 'mutante' && categoria !== 'delegacao' && !leituraArquivo;
  const item = { b: base, s: sig, t: agora };
  const id = typeof entrada.tool_use_id === 'string' ? entrada.tool_use_id : '';
  if (id) item.id = id;
  if (ehConsulta(nome, input)) item.c = 1;
  if (leituraArquivo && stat) item.r = `m${stat}`;

  const mutavel = categoria !== 'mutante' && categoria !== 'delegacao' && mutaSeOk(categoria, nome, input, cfg);
  const vezes = contarRepeticoes(estado, cfg, item, usaSaida, agora, mutavel);
  const ciclo = vezes ? null : detectarCiclo(estado, cfg, item);
  if (vezes || ciclo) item.n = 1;
  estado.historico.push(item);
  if (estado.historico.length > cfg.janela) estado.historico.splice(0, estado.historico.length - cfg.janela);

  if (vezes || ciclo) {
    const tipo = ciclo ? 'ciclo' : categoria === 'leitura' ? 'leitura' : categoria === 'delegacao' ? 'delegacao' : 'outra';
    return {
      saida: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: textoNegacao({
            nome,
            resumo: resumoChamada(input),
            vezes,
            janela: cfg.janela,
            categoria: tipo,
            sequencia: ciclo ? ciclo.nomes.join(' -> ') : '',
          }),
        },
      },
      log: ciclo ? `negado-ciclo ${nome} periodo=${ciclo.periodo}` : `negado ${nome} vezes=${vezes}`,
    };
  }

  // Compatibilidade: sem PostToolUse registrado, a mutação avança a época já no Pre.
  if (!estado.postVisto && categoria !== 'delegacao' && mutaSeOk(categoria, nome, input, cfg)) {
    estado.epoca += 1;
    if (categoria !== 'mutante') registrarMutacaoPropria(estado, base);
    item.p = 1;
    return { saida: null, anexarMutacao: true };
  }
  return { saida: null };
}

function acharItem(estado, id, base) {
  if (typeof id === 'string' && id) {
    for (let i = estado.historico.length - 1; i >= 0; i -= 1) if (estado.historico[i].id === id) return estado.historico[i];
    return null;
  }
  for (let i = estado.historico.length - 1; i >= 0; i -= 1) {
    const e = estado.historico[i];
    if (e.b === base && !e.n && e.r === undefined) return e;
  }
  return null;
}

function chaveCurta(texto) {
  return sha1(String(texto)).slice(0, 12);
}

/**
 * Escolhe o alerta de falha mais grave (um só), apenas numa chamada que falhou. Espera: o mesmo
 * alerta dobra o intervalo a cada repetição (janela, 2x, 4x... até o intervalo do checkpoint) e,
 * depois de qualquer alerta, os de gravidade igual ou menor esperam FLUXO_JANELA_FALHAS chamadas.
 */
function escolherAlerta(estado, cfg, { falhou, item, input, arquivoEdit }) {
  if (!falhou) return null;
  const cands = [];
  const nF = estado.falhas.reduce((a, b) => a + b, 0);
  if (nF >= cfg.falhas2) cands.push({ sev: 4, chave: 'n2', texto: () => textoFalhas(2, nF, cfg.janelaFalhas) });
  else if (nF >= cfg.falhas1) cands.push({ sev: 2, chave: 'n1', texto: () => textoFalhas(1, nF, cfg.janelaFalhas) });
  if (falhou && item) {
    const iguais = estado.historico.filter((e) => e.f && e.b === item.b && (!e.r || !item.r || e.r === item.r)).length;
    const k = chaveCurta(item.b);
    if (iguais >= cfg.falhasMesma * 2) cands.push({ sev: 3, chave: `c2|${k}`, texto: () => textoMesmaFalha(2, resumoChamada(input), iguais) });
    else if (iguais >= cfg.falhasMesma) cands.push({ sev: 1, chave: `c1|${k}`, texto: () => textoMesmaFalha(1, resumoChamada(input), iguais) });
  }
  if (arquivoEdit && estado.falhasEdit[arquivoEdit]) {
    const n = estado.falhasEdit[arquivoEdit];
    const k = chaveCurta(arquivoEdit);
    if (n >= cfg.falhasEdit * 2) cands.push({ sev: 3.5, chave: `e2|${k}`, texto: () => textoFalhaEdit(2, resumoChamada(input), n) });
    else if (n >= cfg.falhasEdit) cands.push({ sev: 1.5, chave: `e1|${k}`, texto: () => textoFalhaEdit(1, resumoChamada(input), n) });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.sev - a.sev);
  const topo = cands[0];
  const agoraN = estado.chamadasTurno;
  const ultimo = estado.alertas[topo.chave];
  const emitidos = estado.alertas[`${topo.chave}#`] || 0;
  const espera = Math.min(cfg.janelaFalhas * 2 ** Math.max(0, emitidos - 1), Math.max(cfg.janelaFalhas, cfg.checkpoint));
  if (ultimo !== undefined && agoraN - ultimo < espera) return null; // o mesmo alerta, ainda em espera
  const sevAnterior = estado.alertas._sev;
  if (sevAnterior !== undefined && topo.sev <= sevAnterior && agoraN - (estado.alertas._em || 0) < cfg.janelaFalhas) return null;
  estado.alertas[topo.chave] = agoraN;
  estado.alertas[`${topo.chave}#`] = emitidos + 1;
  delete estado.alertas._sev;
  delete estado.alertas._em;
  estado.alertas._sev = topo.sev;
  estado.alertas._em = agoraN;
  podarMapa(estado.alertas);
  return { texto: topo.texto(), log: `alerta ${topo.chave.split('|')[0]}` };
}

function aoPostToolUse(entrada, estado, cfg, evento) {
  const nome = typeof entrada.tool_name === 'string' ? entrada.tool_name : '';
  contarChamada(estado, entrada.tool_use_id, 'post');
  estado.postVisto = true;
  const textos = [];
  const logs = [];
  let anexarMutacao = false;

  const input = entrada.tool_input ?? null;
  const categoria = nome ? classificar(nome, input, cfg) : 'outra';
  if (nome && categoria !== 'isenta') {
    const cwd = typeof entrada.cwd === 'string' ? entrada.cwd : '';
    const base = assinaturaBase(nome, input, cwd);
    const falhou = evento === 'PostToolUseFailure' || respostaIndicaErro(entrada.tool_response);
    const item = acharItem(estado, entrada.tool_use_id, base);
    if (item) {
      if (!(typeof item.r === 'string' && item.r.startsWith('m'))) {
        const r = hashResposta(evento === 'PostToolUseFailure' ? (entrada.error ?? entrada.tool_response) : entrada.tool_response);
        if (r) item.r = r;
      }
      if (falhou) item.f = 1;
    }

    estado.falhas.push(falhou ? 1 : 0);
    if (estado.falhas.length > cfg.janelaFalhas) estado.falhas.splice(0, estado.falhas.length - cfg.janelaFalhas);

    // A época só avança quando a mutação deu certo.
    if (!falhou && !(item && item.p)) {
      if (categoria === 'delegacao') {
        estado.epoca += 1; // o subagente pode ter alterado arquivos
        registrarMutacaoPropria(estado, base);
      } else if (mutaSeOk(categoria, nome, input, cfg)) {
        estado.epoca += 1;
        if (categoria !== 'mutante') registrarMutacaoPropria(estado, base);
        anexarMutacao = true;
      }
    }

    let arquivoEdit = '';
    if (MUTANTES.has(nome)) {
      const c = chamadaCanonica(nome, input, cwd).entrada;
      arquivoEdit = (c && (c.file_path || c.notebook_path)) || '';
      if (arquivoEdit) {
        if (falhou) estado.falhasEdit[arquivoEdit] = (estado.falhasEdit[arquivoEdit] || 0) + 1;
        else delete estado.falhasEdit[arquivoEdit];
        podarMapa(estado.falhasEdit);
      }
    }

    const alerta = escolherAlerta(estado, cfg, { falhou, item, input, arquivoEdit });
    if (alerta) {
      textos.push(alerta.texto);
      logs.push(alerta.log);
    }
  }

  if (cfg.checkpointsMax > 0) {
    const devidos = Math.floor(estado.chamadasTurno / cfg.checkpoint);
    if (devidos > estado.checkpointsEmitidos) {
      estado.checkpointsEmitidos = devidos;
      textos.push(
        devidos <= cfg.checkpointsMax
          ? textoCheckpoint(estado.chamadasTurno)
          : textoCheckpointExtra(estado.chamadasTurno, cfg.checkpoint),
      );
      logs.push(`checkpoint chamadas=${estado.chamadasTurno}`);
    }
  }

  return { saida: saidaContexto(evento, textos), log: logs.join('; ') || undefined, anexarMutacao };
}

function aoUserPromptSubmit(estado) {
  estado.chamadasTurno = 0;
  estado.checkpointsEmitidos = 0;
  estado.falhas = [];
  estado.falhasEdit = {};
  estado.alertas = {};
  estado.historico = []; // o usuário falou: repetir a pedido dele é legítimo
  estado.contados = [];
  return { saida: null };
}

/** Compactação/retomada: o contexto do modelo mudou, o histórico de repetição não vale mais. */
function aoCompactar(estado, origem) {
  if (origem === 'clear') return aoUserPromptSubmit(estado);
  estado.historico = [];
  return { saida: null, log: `historico-zerado ${origem}` };
}

/**
 * Processa um evento sobre o estado (mutado no lugar). Sem E/S.
 * ctx (opcional): { stat: 'mtime:tamanho' do alvo, mutCompartilhadas: bytes de <sessão>.mut }.
 * Retorna { saida: objeto|null, log?: string, anexarMutacao?: boolean }.
 */
export function processar(entrada, estado, cfg, agora = Date.now(), ctx = null) {
  if (!entrada || typeof entrada !== 'object') return { saida: null };
  estado.atualizado = agora;
  switch (entrada.hook_event_name) {
    case 'UserPromptSubmit':
      return aoUserPromptSubmit(estado);
    case 'PreToolUse':
      return aoPreToolUse(entrada, estado, cfg, agora, ctx || {});
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return aoPostToolUse(entrada, estado, cfg, entrada.hook_event_name);
    case 'PreCompact':
    case 'PostCompact':
      return aoCompactar(estado, 'compact');
    case 'SessionStart': {
      const origem = String(entrada.source || '');
      return ['compact', 'clear', 'resume'].includes(origem) ? aoCompactar(estado, origem) : { saida: null };
    }
    default:
      return { saida: null };
  }
}

// ---------------------------------------------------------------------------
// E/S: estado em disco, trava, limpeza, log
// ---------------------------------------------------------------------------

const EVENTOS = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PreCompact',
  'PostCompact',
  'SessionStart',
]);

export function sanear(texto, max = 100) {
  const s = String(texto ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, max);
  return s.replace(/^_+$/, '');
}

export function nomeArquivoEstado(entrada, dir) {
  const sessao = sanear(entrada && entrada.session_id) || 'sem-sessao';
  const agente = sanear(entrada && entrada.agent_id, 60);
  return path.join(dir, `${agente ? `${sessao}__${agente}` : sessao}.json`);
}

/** Arquivo compartilhado da sessão (principal + subagentes): 1 byte por mutação. */
export function arquivoMutacoes(entrada, dir) {
  return path.join(dir, `${sanear(entrada && entrada.session_id) || 'sem-sessao'}.mut`);
}

function tamanhoArquivo(arquivo) {
  try {
    return fs.statSync(arquivo).size;
  } catch {
    return 0;
  }
}

function anexarMutacaoCompartilhada(arquivo) {
  for (let t = 0; t < 2; t += 1) {
    try {
      fs.appendFileSync(arquivo, '.', 'utf8');
      return true;
    } catch {
      dormir(5);
    }
  }
  return false;
}

function dormir(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
}

/**
 * Lê o estado. ENOENT => novo. Erro de E/S (EPERM/EBUSY...) ou JSON inválido => tenta de novo;
 * se persistir: JSON inválido vai para .corrompido (e começa do zero); erro de E/S => não gravável.
 * Retorna { estado, novo, gravavel, aviso? }.
 */
export function carregarEstado(arquivo, agora = Date.now()) {
  let jsonInvalido = false;
  let codigo = '';
  for (let t = 0; t < 3; t += 1) {
    let texto;
    try {
      texto = fs.readFileSync(arquivo, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return { estado: estadoInicial(agora), novo: true, gravavel: true };
      codigo = (e && e.code) || 'desconhecido';
      jsonInvalido = false;
      if (codigo === 'EISDIR') break;
      dormir(5 * (t + 1));
      continue;
    }
    try {
      return { estado: normalizarEstado(JSON.parse(texto), agora), novo: false, gravavel: true };
    } catch {
      jsonInvalido = true;
      dormir(5 * (t + 1));
    }
  }
  if (jsonInvalido) {
    try {
      fs.renameSync(arquivo, `${arquivo}.corrompido`);
      return { estado: estadoInicial(agora), novo: true, gravavel: true, aviso: 'estado-corrompido movido para .corrompido' };
    } catch (e) {
      return { estado: estadoInicial(agora), novo: false, gravavel: false, aviso: `estado-corrompido sem mover ${(e && e.code) || ''}` };
    }
  }
  return { estado: estadoInicial(agora), novo: false, gravavel: false, aviso: `estado-ilegivel ${codigo}` };
}

/** Escrita atômica (.tmp + rename). Se o rename falhar, apaga o .tmp e lança: nunca grava direto. */
export function salvarEstado(arquivo, estado) {
  const tmp = `${arquivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(estado), 'utf8');
  let ultimo = null;
  for (let t = 0; t < 8; t += 1) {
    try {
      fs.renameSync(tmp, arquivo);
      return;
    } catch (e) {
      ultimo = e;
      dormir(Math.min(2 ** t, 32));
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {}
  throw ultimo || new Error('rename falhou');
}

/**
 * Trava por arquivo (wx) para chamadas paralelas da mesma sessão. Sem disputa não espera nada;
 * com disputa espera no máximo orcamentoMs. fn recebe true se obteve a trava; sem trava o
 * chamador decide sem salvar (nunca trava a sessão, nunca corrompe o estado).
 */
export function comTrava(arquivo, fn, { orcamentoMs = 1500, velhaMs = 5000 } = {}) {
  const trava = `${arquivo}.lock`;
  const inicio = Date.now();
  let fd = null;
  let espera = 1;
  for (let voltas = 0; fd === null && voltas < 5000; voltas += 1) {
    try {
      fd = fs.openSync(trava, 'wx');
    } catch (e) {
      // No Windows, uma trava sendo apagada (delete pendente) devolve EPERM/EACCES/EBUSY.
      if (!e || !['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) break;
      try {
        if (Date.now() - fs.statSync(trava).mtimeMs > velhaMs) {
          fs.unlinkSync(trava);
          continue;
        }
      } catch {}
      if (Date.now() - inicio >= orcamentoMs) break;
      dormir(espera);
      espera = Math.min(espera * 2, 8);
    }
  }
  try {
    return fn(fd !== null);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
      try {
        fs.unlinkSync(trava);
      } catch {}
    }
  }
}

function mesmoCaminho(a, b) {
  const n = (p) => {
    const r = path.resolve(p);
    return WIN ? r.toLowerCase() : r;
  };
  return n(a) === n(b);
}

/**
 * Cria o diretório de estado. O marcador (que autoriza a limpeza) só é criado se o gancho criou
 * o diretório agora ou se é o diretório padrão do gancho. Pasta já existente (compartilhada) fica
 * sem marcador e nunca é limpa.
 */
export function prepararDiretorio(dir) {
  const criado = fs.mkdirSync(dir, { recursive: true });
  if (criado !== undefined || mesmoCaminho(dir, path.join(os.tmpdir(), 'fluxo-anti-loop'))) {
    try {
      fs.writeFileSync(
        path.join(dir, MARCADOR),
        'Diretório de estado do gancho anti-loop (I:\\OMNIROUTE\\fluxo\\anti-loop.mjs). A limpeza automática só apaga arquivos do próprio gancho.\n',
        { encoding: 'utf8', flag: 'wx' },
      );
    } catch {}
  }
}

/** O .json (ou .json.N.tmp) tem cara de estado do gancho? (começa com {"v":) */
function pareceEstado(caminho) {
  let fd = null;
  try {
    fd = fs.openSync(caminho, 'r');
    const buf = Buffer.alloc(8);
    const n = fs.readSync(fd, buf, 0, 8, 0);
    return buf.subarray(0, n).toString('utf8').startsWith('{"v":');
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Apaga arquivos DO GANCHO mais velhos que maxIdadeMs. Três travas: o diretório precisa ter o
 * marcador, o nome precisa seguir PADRAO_PROPRIO e um .json precisa ter conteúdo de estado.
 */
export function limparAntigos(dir, maxIdadeMs, agora = Date.now()) {
  let removidos = 0;
  if (!fs.existsSync(path.join(dir, MARCADOR))) return 0;
  let nomes = [];
  try {
    nomes = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const nome of nomes) {
    if (!PADRAO_PROPRIO.test(nome)) continue;
    const caminho = path.join(dir, nome);
    try {
      const st = fs.statSync(caminho);
      if (!st.isFile() || agora - st.mtimeMs <= maxIdadeMs) continue;
      if (/\.json(\.\d+\.tmp)?$/.test(nome) && !pareceEstado(caminho)) continue;
      fs.unlinkSync(caminho);
      removidos += 1;
    } catch {}
  }
  return removidos;
}

export function registrarLog(dir, linha) {
  try {
    const arquivo = path.join(dir, 'anti-loop.log');
    try {
      if (fs.statSync(arquivo).size > LOG_MAX_BYTES) fs.writeFileSync(arquivo, '', 'utf8');
    } catch {}
    fs.appendFileSync(arquivo, `${new Date().toISOString()} ${linha}\n`, 'utf8');
  } catch {}
}

/**
 * Executa um evento completo: carrega o estado, processa, salva, retorna a saída
 * (objeto para o stdout) ou null. Nunca lança.
 */
export function executar(entrada, { env = process.env, agora = Date.now() } = {}) {
  let cfg;
  try {
    cfg = lerConfig(env);
    if (!cfg.ativo) return null;
    if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)) return null;
    const evento = entrada.hook_event_name;
    if (!EVENTOS.has(evento)) return null;

    prepararDiretorio(cfg.dir);
    const arquivo = nomeArquivoEstado(entrada, cfg.dir);
    const arquivoMut = arquivoMutacoes(entrada, cfg.dir);
    const ctx = { stat: null, mutCompartilhadas: 0 };
    if (evento === 'PreToolUse') ctx.stat = statAlvo(entrada.tool_name, entrada.tool_input, entrada.cwd);

    let resultado = { saida: null };
    let novo = false;
    const logs = [];
    comTrava(arquivo, (temTrava) => {
      ctx.mutCompartilhadas = tamanhoArquivo(arquivoMut);
      const carregado = carregarEstado(arquivo, agora);
      novo = carregado.novo;
      if (carregado.aviso) logs.push(carregado.aviso);
      resultado = processar(entrada, carregado.estado, cfg, agora, ctx);
      if (resultado.anexarMutacao && anexarMutacaoCompartilhada(arquivoMut)) carregado.estado.proprias += 1;
      if (!temTrava) {
        logs.push('sem-trava: decidiu sem salvar');
        return;
      }
      if (!carregado.gravavel) {
        logs.push('estado-nao-gravavel: decidiu sem salvar');
        return;
      }
      try {
        salvarEstado(arquivo, carregado.estado);
      } catch (e) {
        // Sem salvar, a decisão desta chamada continua valendo.
        logs.push(`erro-salvar ${(e && (e.code || e.name)) || 'desconhecido'}`);
      }
    });
    if (resultado.log) logs.push(resultado.log);
    if (logs.length) registrarLog(cfg.dir, `${evento} ${logs.join('; ')}`);
    if (novo || evento === 'UserPromptSubmit') {
      limparAntigos(cfg.dir, cfg.diasEstado * 24 * 60 * 60 * 1000, agora);
    }
    return resultado.saida || null;
  } catch (e) {
    try {
      if (cfg && cfg.dir) registrarLog(cfg.dir, `erro ${(e && (e.code || e.name)) || 'desconhecido'}`);
    } catch {}
    return null;
  }
}

export function lerStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin || stdin.isTTY) {
      resolve('');
      return;
    }
    const partes = [];
    let fim = false;
    const terminar = () => {
      if (fim) return;
      fim = true;
      clearTimeout(timer);
      try {
        stdin.pause();
        stdin.destroy();
      } catch {}
      resolve(Buffer.concat(partes).toString('utf8'));
    };
    const timer = setTimeout(terminar, timeoutMs);
    stdin.on('data', (c) => partes.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
    stdin.on('end', terminar);
    stdin.on('close', terminar);
    stdin.on('error', terminar);
  });
}

export async function main() {
  process.exitCode = 0;
  // Rede de segurança: nunca segurar a sessão.
  const guarda = setTimeout(() => process.exit(0), 8000);
  guarda.unref();
  process.on('uncaughtException', () => {
    process.exitCode = 0;
  });
  process.on('unhandledRejection', () => {
    process.exitCode = 0;
  });
  try {
    if (String(process.env.FLUXO_ANTILOOP ?? '1').trim() === '0') return;
    const bruto = (await lerStdin()).replace(/^\uFEFF/, '');
    if (!bruto.trim()) return;
    let entrada;
    try {
      entrada = JSON.parse(bruto);
    } catch {
      return;
    }
    const saida = executar(entrada, { env: process.env });
    if (saida) process.stdout.write(JSON.stringify(saida));
  } catch {
    // silencioso: um gancho nunca derruba a sessão
  } finally {
    process.exitCode = 0;
  }
}

function chamadoDiretamente() {
  try {
    if (!process.argv[1]) return false;
    const norm = (p) => {
      let r = path.resolve(p);
      try {
        r = fs.realpathSync(r);
      } catch {}
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    return norm(process.argv[1]) === norm(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (chamadoDiretamente()) {
  main();
}
