// Testes do gancho anti-loop. Rode: node --test I:\OMNIROUTE\fluxo\anti-loop.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  MARCADOR,
  analisarComando,
  assinatura,
  assinaturaBase,
  carregarEstado,
  classificar,
  comandoLeitura,
  comandoMutante,
  estadoInicial,
  executar,
  ferramentaMutante,
  hashResposta,
  lerConfig,
  limparAntigos,
  nomeArquivoEstado,
  normalizarComando,
  processar,
  respostaIndicaErro,
  resumoChamada,
  salvarEstado,
  serializarEstavel,
  textoNegacao,
} from './anti-loop.mjs';

const SCRIPT = fileURLToPath(new URL('./anti-loop.mjs', import.meta.url));
let DIR;
let seq = 0;

before(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-loop-teste-'));
});
after(() => {
  try {
    fs.rmSync(DIR, { recursive: true, force: true });
  } catch {}
});

function novoDir() {
  const d = path.join(DIR, `caso-${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function ambiente(dir, extra = {}) {
  return { FLUXO_ESTADO_DIR: dir, ...extra };
}

// Simulador em memória (sem disco). O relógio avança 1 s por chamada.
function sessaoMemoria(extraEnv = {}) {
  const cfg = lerConfig({ FLUXO_ESTADO_DIR: os.tmpdir(), ...extraEnv });
  const estado = estadoInicial();
  let id = 0;
  const api = {
    estado,
    cfg,
    agora: 1_000_000,
    cwd: undefined,
    ctx: null,
    ev(extra) {
      return processar({ session_id: 's', cwd: api.cwd, ...extra }, estado, cfg, api.agora, api.ctx);
    },
    pre(nome, input) {
      const tid = `t${++id}`;
      api.ultimoId = tid;
      api.agora += 1000;
      return api.ev({ hook_event_name: 'PreToolUse', tool_name: nome, tool_input: input, tool_use_id: tid }).saida;
    },
    post(nome, input, resposta = { ok: true }, idChamada = api.ultimoId) {
      return api.ev({ hook_event_name: 'PostToolUse', tool_name: nome, tool_input: input, tool_response: resposta, tool_use_id: idChamada }).saida;
    },
    falha(nome, input, idChamada = api.ultimoId, erro = 'falhou') {
      return api.ev({ hook_event_name: 'PostToolUseFailure', tool_name: nome, tool_input: input, error: erro, tool_use_id: idChamada }).saida;
    },
    prompt() {
      return api.ev({ hook_event_name: 'UserPromptSubmit', prompt: 'oi' }).saida;
    },
    /** Chamada completa (Pre + Post sucesso). Retorna { pre, post }. */
    chamar(nome, input, resposta) {
      const p = api.pre(nome, input);
      if (p) return { pre: p, post: null };
      return { pre: null, post: api.post(nome, input, resposta) };
    },
    /** Chamada completa que falha (Pre + PostToolUseFailure). */
    chamarFalha(nome, input, erro = 'falhou') {
      const p = api.pre(nome, input);
      if (p) return { pre: p, post: null };
      return { pre: null, post: api.falha(nome, input, api.ultimoId, erro) };
    },
  };
  return api;
}

const negou = (saida) => saida?.hookSpecificOutput?.permissionDecision === 'deny';
const contexto = (saida) => saida?.hookSpecificOutput?.additionalContext || '';
const motivo = (saida) => saida?.hookSpecificOutput?.permissionDecisionReason || '';

describe('A) repetição', () => {
  test('bloqueia a 3a chamada idêntica com motivo e protocolo', () => {
    const s = sessaoMemoria();
    const input = { file_path: 'I:/x/arquivo.md' };
    assert.equal(s.pre('Read', input), null);
    assert.equal(s.pre('Read', input), null);
    const terceira = s.pre('Read', input);
    assert.ok(negou(terceira), 'a 3a deveria ser negada');
    const m = motivo(terceira);
    assert.equal(terceira.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(m, /LOOP BLOQUEADO/);
    assert.match(m, /PROTOCOLO DE TRAVAMENTO/);
    assert.match(m, /executor-codex/);
    assert.match(m, /429\/402/);
    assert.match(m, /arquivo\.md/);
    // continua negando enquanto a repetição estiver na janela
    assert.ok(negou(s.pre('Read', input)));
  });

  test('chamadas diferentes no meio não liberam leitura sem mutação', () => {
    const s = sessaoMemoria();
    const a = { file_path: 'a.txt' };
    s.pre('Read', a);
    s.pre('Grep', { pattern: 'x' });
    s.pre('Read', a);
    s.pre('Glob', { pattern: '*.js' });
    assert.ok(negou(s.pre('Read', a)));
  });

  test('sai da janela de 20 chamadas e volta a ser permitida', () => {
    const s = sessaoMemoria();
    const a = { file_path: 'a.txt' };
    s.pre('Read', a);
    s.pre('Read', a);
    for (let i = 0; i < 20; i += 1) s.pre('Read', { file_path: `outro-${i}.txt` });
    assert.equal(s.pre('Read', a), null);
  });

  test('reler (e testar) depois de Edit é permitido (sem PostToolUse: modo compatível)', () => {
    const s = sessaoMemoria();
    const a = { file_path: 'a.mjs' };
    const teste = { command: 'node --test a.test.mjs' };
    assert.equal(s.pre('Read', a), null);
    assert.equal(s.pre('Bash', teste), null);
    assert.equal(s.pre('Read', a), null);
    assert.equal(s.pre('Bash', teste), null);
    assert.equal(s.pre('Edit', { file_path: 'a.mjs', old_string: '1', new_string: '2' }), null);
    assert.equal(s.pre('Read', a), null, 'reler após Edit deve ser permitido');
    assert.equal(s.pre('Bash', teste), null, 'testar após Edit deve ser permitido');
    assert.equal(s.pre('Write', { file_path: 'b.mjs', content: 'x' }), null);
    assert.equal(s.pre('Read', a), null);
    assert.equal(s.pre('Bash', teste), null);
    assert.equal(s.pre('Read', a), null);
    assert.equal(s.pre('Bash', teste), null);
    // sem nova mutação, a época atual já tem 2 ocorrências de cada
    assert.ok(negou(s.pre('Read', a)));
    assert.ok(negou(s.pre('Bash', teste)));
  });

  test('Edit idêntico repetido também é loop (sem época)', () => {
    const s = sessaoMemoria();
    const e = { file_path: 'a.mjs', old_string: 'x', new_string: 'y' };
    s.pre('Edit', e);
    s.pre('Read', { file_path: 'a.mjs' });
    s.pre('Edit', e);
    assert.ok(negou(s.pre('Edit', e)));
  });

  test('comando de shell que escreve muda a época, mas a própria repetição é detectada', () => {
    const s = sessaoMemoria();
    const teste = { command: 'npm test' };
    const escreve = { command: "sed -i 's/a/b/' x.js" };
    s.pre('Bash', teste);
    s.pre('Bash', teste);
    assert.equal(s.pre('Bash', escreve), null);
    assert.equal(s.pre('Bash', teste), null, 'teste após sed -i liberado');
    assert.equal(s.pre('Bash', escreve), null);
    assert.ok(negou(s.pre('Bash', escreve)), 'mesmo sed -i 3x é loop');
  });

  test('delegação (Agent/Task) idêntica repetida conta', () => {
    const s = sessaoMemoria();
    const d = { subagent_type: 'executor', prompt: 'corrija o bug X', description: 'corrigir' };
    assert.equal(s.pre('Agent', d), null);
    assert.equal(s.pre('Agent', { ...d, description: 'outra descrição' }), null);
    const r = s.pre('Agent', d);
    assert.ok(negou(r), 'mudar só a description não é mudar de abordagem');
    assert.match(motivo(r), /delegação/);
    assert.ok(negou(s.pre('Task', d)) === false, 'Task tem assinatura própria');
  });

  test('ferramentas isentas nunca bloqueiam', () => {
    const s = sessaoMemoria();
    for (const nome of ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'AskUserQuestion']) {
      for (let i = 0; i < 10; i += 1) assert.equal(s.pre(nome, { todos: [{ a: 1 }] }), null, `${nome} #${i}`);
    }
  });

  test('FLUXO_REPETICOES configura o limiar', () => {
    const s = sessaoMemoria({ FLUXO_REPETICOES: '1' });
    s.pre('Read', { file_path: 'a' });
    assert.ok(negou(s.pre('Read', { file_path: 'a' })));
  });

  test('ferramentas desconhecidas (MCP): repetição pura bloqueia, ações no meio liberam', () => {
    const s = sessaoMemoria();
    const shot = { action: 'screenshot' };
    s.pre('mcp__browser__computer', shot);
    s.pre('mcp__browser__computer', { action: 'left_click', coordinate: [1, 2] });
    s.pre('mcp__browser__computer', shot);
    s.pre('mcp__browser__computer', { action: 'left_click', coordinate: [3, 4] });
    assert.equal(s.pre('mcp__browser__computer', shot), null);
    const s2 = sessaoMemoria();
    s2.pre('mcp__x__buscar', { q: 1 });
    s2.pre('mcp__x__buscar', { q: 1 });
    assert.ok(negou(s2.pre('mcp__x__buscar', { q: 1 })));
  });

  test('texto de leitura negada não afirma que o resultado está no contexto (achado 10)', () => {
    const t = textoNegacao({ nome: 'Read', resumo: 'a.md', vezes: 2, janela: 20, categoria: 'leitura' });
    assert.doesNotMatch(t, /já está no seu contexto/);
    assert.match(t, /offset\/limit/);
  });
});

describe('achado 1: mudanças feitas por subagentes e delegação', () => {
  test('Agent/Task concluído avança a época: testar -> delegar -> testar não é negado (1a)', () => {
    const s = sessaoMemoria();
    const teste = { command: 'node --test calc.test.mjs' };
    const falhou = { stdout: 'not ok 1 - soma', exitCode: 1 };
    const out = [];
    out.push(s.chamar('Bash', teste, falhou).pre);
    out.push(s.chamar('Agent', { subagent_type: 'executor-codex', prompt: 'corrija calc.mjs' }, { content: 'feito' }).pre);
    out.push(s.chamar('Bash', teste, falhou).pre);
    out.push(s.chamar('Agent', { subagent_type: 'executor-claude', prompt: 'corrija calc.mjs de outro jeito' }, { content: 'feito' }).pre);
    out.push(s.chamar('Bash', teste, { stdout: 'ok', exitCode: 0 }).pre);
    out.push(s.chamar('Bash', { command: 'git status' }, { stdout: 'M calc.mjs' }).pre);
    assert.deepEqual(out.map(negou), [false, false, false, false, false, false]);
  });

  test('edição de subagente (agent_id) libera a verificação no principal, via <sessão>.mut (1b)', () => {
    const dir = novoDir();
    const env = ambiente(dir);
    let n = 0;
    const chamar = (nome, input, resposta, extra = {}) => {
      const id = `id${++n}`;
      const base = { session_id: 'fp1', tool_name: nome, tool_input: input, tool_use_id: id, ...extra };
      const pre = executar({ ...base, hook_event_name: 'PreToolUse' }, { env });
      if (pre) return pre;
      executar({ ...base, hook_event_name: 'PostToolUse', tool_response: resposta }, { env });
      return null;
    };
    const teste = { command: 'node --test calc.test.mjs' };
    const falhou = { stdout: 'not ok 1', exitCode: 1 };
    assert.equal(chamar('Bash', teste, falhou), null);
    assert.equal(chamar('Bash', teste, falhou), null);
    // subagente em segundo plano edita (não há Post de Agent no meio)
    assert.equal(chamar('Edit', { file_path: 'calc.mjs', old_string: 'a', new_string: 'b' }, { ok: true }, { agent_id: 'sub1' }), null);
    assert.ok(fs.statSync(path.join(dir, 'fp1.mut')).size >= 1, 'mutação compartilhada registrada');
    assert.equal(chamar('Bash', teste, falhou), null, 'verificar a correção do subagente é permitido');
    assert.equal(chamar('Bash', teste, falhou), null);
    assert.ok(negou(chamar('Bash', teste, falhou)), 'sem nova mudança, a repetição volta a ser loop');
    // a própria mutação do principal não conta duas vezes (esquema x continua funcionando)
    const sed = { command: "sed -i 's/a/b/' x.js" };
    assert.equal(chamar('Bash', sed, { stdout: '' }), null);
    assert.equal(chamar('Bash', sed, { stdout: '' }), null);
    assert.ok(negou(chamar('Bash', sed, { stdout: '' })));
  });

  test('Read inclui mtime e tamanho: arquivo alterado por fora libera a releitura (1c)', () => {
    const dir = novoDir();
    const env = ambiente(dir);
    const arq = path.join(dir, 'alvo.txt');
    fs.writeFileSync(arq, 'versão 1');
    let n = 0;
    const ler = () => {
      const id = `r${++n}`;
      const base = { session_id: 'stat', cwd: dir, tool_name: 'Read', tool_input: { file_path: 'alvo.txt' }, tool_use_id: id };
      const pre = executar({ ...base, hook_event_name: 'PreToolUse' }, { env });
      if (!pre) executar({ ...base, hook_event_name: 'PostToolUse', tool_response: { type: 'text' } }, { env });
      return pre;
    };
    assert.equal(ler(), null);
    assert.equal(ler(), null);
    fs.writeFileSync(arq, 'versão 2, maior');
    assert.equal(ler(), null, 'o arquivo mudou');
    assert.equal(ler(), null);
    assert.ok(negou(ler()), 'arquivo igual 3x');
  });

  test('Bash: só é loop se a mesma chamada deu a MESMA saída (1d)', () => {
    const s = sessaoMemoria();
    const c = { command: 'node gerar.mjs' };
    assert.equal(s.chamar('Bash', c, { stdout: 'gerou 3 arquivos em 120ms' }).pre, null);
    assert.equal(s.chamar('Bash', c, { stdout: 'gerou 4 arquivos e avisos' }).pre, null);
    assert.equal(s.chamar('Bash', c, { stdout: 'gerou 4 arquivos e avisos' }).pre, null, 'saídas anteriores diferentes');
    assert.ok(negou(s.chamar('Bash', c, { stdout: 'x' }).pre), 'as 2 últimas saídas foram iguais');
  });
});

describe('achado 2: falsos negativos (época no Post, janela de falhas, checkpoints)', () => {
  test('Edit que falha não libera a releitura; Edit que dá certo libera', () => {
    const s = sessaoMemoria();
    const a = { file_path: 'a.mjs' };
    assert.equal(s.chamar('Read', a).pre, null);
    assert.equal(s.chamarFalha('Edit', { file_path: 'a.mjs', old_string: 'x0', new_string: 'y' }, 'old_string não encontrado').pre, null);
    assert.equal(s.chamar('Read', a).pre, null);
    const segunda = s.chamarFalha('Edit', { file_path: 'a.mjs', old_string: 'x1', new_string: 'y' }, 'old_string não encontrado');
    assert.match(contexto(segunda.post), /edição falhou 2x/);
    assert.match(contexto(segunda.post), /offset\/limit/);
    assert.ok(negou(s.chamar('Read', a).pre), 'Read -> Edit falho -> Read -> Edit falho -> Read é loop');
    assert.equal(s.chamar('Edit', { file_path: 'a.mjs', old_string: 'x2', new_string: 'y' }).pre, null);
    assert.equal(s.chamar('Read', a).pre, null, 'depois de um Edit bem-sucedido, reler é permitido');
  });

  test('Edit falho 4x no mesmo arquivo => nível 2 (delegar)', () => {
    const s = sessaoMemoria();
    const textos = [];
    for (let i = 0; i < 4; i += 1) {
      textos.push(contexto(s.chamarFalha('Edit', { file_path: 'b.mjs', old_string: `v${i}`, new_string: 'z' }).post));
    }
    assert.equal(textos[0], '');
    assert.match(textos[1], /falhou 2x/);
    assert.equal(textos[2], '');
    assert.match(textos[3], /nível 2/);
    assert.match(textos[3], /executor-codex/);
  });

  test('falhas na janela: 5 de 10 => nível 1 mesmo com leituras bem-sucedidas no meio', () => {
    const s = sessaoMemoria();
    const msgs = [];
    for (let i = 1; i <= 5; i += 1) {
      msgs.push(contexto(s.chamarFalha('Bash', { command: `tentativa ${i}` }).post));
      if (i < 5) s.chamar('Grep', { pattern: `p${i}` }, { numFiles: 0 });
    }
    assert.deepEqual(msgs.slice(0, 4), ['', '', '', '']);
    assert.match(msgs[4], /nível 1/);
    assert.match(msgs[4], /PROTOCOLO DE TRAVAMENTO/);
  });

  test('5 e 8 falhas na janela injetam nível 1 e 2; o mesmo alerta espera 10 chamadas', () => {
    const s = sessaoMemoria();
    const marcas = [];
    for (let i = 1; i <= 20; i += 1) {
      const input = { command: `tentativa ${i}` };
      assert.equal(s.pre('Bash', input), null);
      const m = s.falha('Bash', input);
      if (m) {
        assert.equal(m.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
        marcas.push([i, /nível 2/.test(contexto(m)) ? 2 : 1]);
      }
    }
    assert.deepEqual(marcas, [
      [5, 1],
      [8, 2],
      [18, 2],
    ]);
    const s2 = sessaoMemoria();
    let ultimo = null;
    for (let i = 1; i <= 8; i += 1) ultimo = s2.chamarFalha('Bash', { command: `t${i}` }).post;
    assert.match(contexto(ultimo), /PARE de tentar sozinho/);
    assert.match(contexto(ultimo), /executor-claude/);
    assert.match(contexto(ultimo), /pergunte ao usuário/i);
  });

  test('PostToolUse com erro na resposta conta como falha', () => {
    const s = sessaoMemoria();
    const respostas = [{ is_error: true }, { stdout: '', exitCode: 1 }, { interrupted: true }, { success: false }, '<tool_use_error>x</tool_use_error>'];
    const msgs = respostas.map((r, i) => {
      const input = { command: `c${i}` };
      s.pre('Bash', input);
      return s.post('Bash', input, r);
    });
    assert.deepEqual(msgs.slice(0, 4), [null, null, null, null]);
    assert.equal(msgs[4].hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(contexto(msgs[4]), /nível 1/);
  });

  test('sucessos suficientes empurram as falhas para fora da janela', () => {
    const s = sessaoMemoria();
    for (let i = 1; i <= 4; i += 1) s.chamarFalha('Bash', { command: `f${i}` });
    for (let i = 1; i <= 10; i += 1) s.chamar('Read', { file_path: `ok${i}` });
    assert.equal(s.estado.falhas.reduce((a, b) => a + b, 0), 0);
    for (let i = 5; i <= 8; i += 1) assert.equal(s.chamarFalha('Bash', { command: `f${i}` }).post, null);
  });

  test('isentas não ocupam a janela de falhas', () => {
    const s = sessaoMemoria();
    for (let i = 1; i <= 4; i += 1) {
      s.chamarFalha('Bash', { command: `x${i}` });
      s.chamar('TodoWrite', { todos: [] });
    }
    assert.equal(s.estado.falhas.length, 4);
    assert.match(contexto(s.chamarFalha('Bash', { command: 'x5' }).post), /nível 1/);
  });

  test('FLUXO_FALHAS1/FLUXO_FALHAS2/FLUXO_JANELA_FALHAS configuram os limiares', () => {
    const s = sessaoMemoria({ FLUXO_FALHAS1: '2', FLUXO_FALHAS2: '4', FLUXO_JANELA_FALHAS: '4' });
    const out = [];
    for (let i = 1; i <= 4; i += 1) out.push(contexto(s.chamarFalha('Bash', { command: `x${i}` }).post));
    assert.equal(out[0], '');
    assert.match(out[1], /nível 1/);
    assert.equal(out[2], '');
    assert.match(out[3], /nível 2/);
  });

  test('mesmo comando com o mesmo erro depois de Edits => alerta (Edit -> teste falho em loop)', () => {
    const s = sessaoMemoria();
    const teste = { command: 'npm test' };
    const falhou = { stdout: 'FAIL soma.test.js: esperado 4, recebido 5 (12ms)', exitCode: 1 };
    const textos = [];
    for (let i = 0; i < 5; i += 1) {
      assert.equal(s.chamar('Edit', { file_path: 'soma.js', old_string: `v${i}`, new_string: `v${i + 1}` }).pre, null);
      const r = s.chamar('Bash', teste, { ...falhou, stdout: falhou.stdout.replace('12', String(10 + i)) });
      assert.equal(r.pre, null, 'teste depois de Edit sempre é permitido');
      textos.push(contexto(r.post));
    }
    assert.equal(textos[0], '');
    assert.match(textos[1], /falhou 2x com o mesmo erro/);
    assert.match(textos[3], /nível 2/);
    // loop longo (150 voltas = 300 chamadas): avisos continuam, mas sem inundar o contexto
    const s3 = sessaoMemoria();
    let alertas = 0;
    let obrigatorios = 0;
    for (let i = 0; i < 150; i += 1) {
      const e = s3.chamar('Edit', { file_path: 'soma.js', old_string: `w${i}`, new_string: `w${i + 1}` });
      assert.doesNotMatch(contexto(e.post), /ALERTA/, 'Edit que deu certo não recebe alerta de falha');
      const t = contexto(s3.chamar('Bash', teste, falhou).post) + contexto(e.post);
      if (/ALERTA/.test(t)) alertas += 1;
      if (/CHECKPOINT OBRIGATÓRIO/.test(t)) obrigatorios += 1;
    }
    assert.ok(alertas >= 5 && alertas <= 15, `alertas=${alertas}`);
    assert.ok(obrigatorios >= 3, `checkpoints obrigatórios=${obrigatorios}`);
    // erro diferente a cada vez (progresso) não gera o alerta de mesmo erro
    const s2 = sessaoMemoria();
    for (let i = 0; i < 4; i += 1) {
      s2.chamar('Edit', { file_path: 'soma.js', old_string: `v${i}`, new_string: `v${i + 1}` });
      const r = s2.chamar('Bash', teste, { stdout: `FAIL caso ${'abcd'[i]}`, exitCode: 1 });
      assert.doesNotMatch(contexto(r.post), /mesmo erro/);
    }
  });
});

describe('C) orçamento do turno', () => {
  test('checkpoint em 40, 80 e 120 e, depois do máximo, obrigatório a cada 40', () => {
    const s = sessaoMemoria();
    const marcas = [];
    for (let i = 1; i <= 210; i += 1) {
      const input = { file_path: `f${i}.txt` };
      const { post } = s.chamar('Read', input);
      if (post) marcas.push([i, contexto(post)]);
    }
    assert.deepEqual(
      marcas.map(([i]) => i),
      [40, 80, 120, 160, 200],
    );
    for (const [i, texto] of marcas) {
      assert.match(texto, new RegExp(`${i} chamadas`));
      if (i <= 120) {
        assert.match(texto, /CHECKPOINT \(/);
        assert.match(texto, /3 linhas/);
        assert.match(texto, /critérios de aceite/);
        assert.match(texto, /perguntar ao usuário/);
      } else {
        assert.match(texto, /CHECKPOINT OBRIGATÓRIO/);
        assert.match(texto, /PARE e pergunte ao usuário/);
      }
    }
  });

  test('FLUXO_CHECKPOINTS_MAX=0 desliga os checkpoints', () => {
    const s = sessaoMemoria({ FLUXO_CHECKPOINTS_MAX: '0' });
    for (let i = 1; i <= 90; i += 1) assert.equal(s.chamar('Read', { file_path: `f${i}` }).post, null);
  });

  test('Pre e Post do mesmo tool_use_id contam uma vez', () => {
    const s = sessaoMemoria();
    s.chamar('Read', { file_path: 'a' });
    assert.equal(s.estado.chamadasTurno, 1);
  });

  test('UserPromptSubmit zera o turno (contagem, falhas e repetições)', () => {
    const s = sessaoMemoria();
    for (let i = 1; i <= 35; i += 1) s.chamar('Read', { file_path: `f${i}` });
    for (let i = 1; i <= 4; i += 1) s.chamarFalha('Bash', { command: `a${i}` });
    s.pre('Read', { file_path: 'z' });
    s.pre('Read', { file_path: 'z' });
    assert.equal(s.prompt(), null);
    assert.equal(s.estado.chamadasTurno, 0);
    assert.deepEqual(s.estado.falhas, []);
    assert.equal(s.pre('Read', { file_path: 'z' }), null, 'novo turno: repetição liberada');
    s.post('Read', { file_path: 'z' });
    for (let i = 1; i <= 30; i += 1) {
      const { post } = s.chamar('Read', { file_path: `g${i}` });
      assert.equal(post, null, 'sem checkpoint antes de 40 no novo turno');
    }
    assert.equal(s.chamarFalha('Bash', { command: 'c' }).post, null, 'falhas do turno anterior não contam');
  });
});

describe('achado 3: heurística de shell (lista branca de leitura, mais mutações)', () => {
  test('mutações que antes passavam como leitura', () => {
    for (const c of [
      "sed -ri 's/a/b/' x.js",
      'sed -Ei s/a/b/ x.js',
      'sed --in-place s/a/b/ x.js',
      "perl -pi -e 's/a/b/' x.js",
      "(gc a.txt) -replace 'a','b' | sc a.txt",
      'ni novo.txt',
      'ri velho.txt',
      'black .',
      'python -m black src',
      'ruff format .',
      'npx prettier -w .',
      'gofmt -w main.go',
      'cargo fmt',
      'npx tsc',
      '[System.IO.File]::WriteAllText("a.txt", "x")',
      '7z x pacote.7z',
      'curl -X DELETE http://localhost:20128/api/combos/direcionador',
      'curl -s -X POST -H "Content-Type: application/json" -d "{}" http://localhost:20128/api/combos',
      'Invoke-RestMethod -Method Delete -Uri http://localhost:20128/api/combos/x',
      'Invoke-RestMethod -Uri http://x -Method Post -Body $b',
      'ollama pull qwen3:32b',
      'docker compose up -d',
      'Get-ChildItem *.tmp | ForEach-Object { Remove-Item $_ }',
      'bash -c "rm -rf build"',
      'powershell -NoProfile -Command "Remove-Item a.txt"',
      'cmd /c del a.txt',
      'git ls-files | xargs rm',
      'echo x 2> erro.txt',
      'node -e "require(\'fs\').writeFileSync(\'a\',\'b\')"',
    ]) {
      assert.equal(comandoMutante(c), true, c);
    }
  });

  test('comandos só de leitura que antes eram tratados como mutantes', () => {
    for (const c of [
      'git log | grep move',
      'Get-ChildItem | Select-String del',
      'node -e "console.log(2>1)"',
      'echo "a > b"',
    ]) {
      assert.equal(comandoMutante(c), false, c);
      assert.equal(comandoLeitura(c), true, c);
    }
  });

  test('lista branca de leitura', () => {
    for (const c of [
      'git status',
      'git diff --stat',
      'git branch -a',
      'git config user.name',
      'ls -la',
      'cat README.md | head -5',
      'npm test',
      'npm run test',
      'node --test x.test.mjs',
      'pytest -q',
      'python -m pytest',
      'curl -s http://localhost:20128/v1/models',
      'curl -s -o /dev/null -w "%{http_code}" http://localhost:20128',
      'Invoke-RestMethod http://localhost:11434/api/ps',
      'ollama ps',
      'docker ps',
      'Get-Content a.txt -Tail 20',
      'sed -n 1,5p a.txt',
      'npx tsc --noEmit',
      'rg -n foo src',
      'powershell -Command "Get-ChildItem"',
      'find . -name "*.js"',
      '& "I:\\Node.JS\\node.exe" --test x.test.mjs',
      'Get-ChildItem | Where-Object { $_.Length -gt 1kb } | Select-Object Name',
    ]) {
      assert.equal(comandoLeitura(c), true, c);
      assert.equal(comandoMutante(c), false, c);
    }
  });

  test('desconhecido (script, programa) não é leitura nem mutação certa: categoria "outra"', () => {
    for (const c of ['python script.py', 'node gerar.mjs', 'python fix_imports.py', './build.sh', 'make']) {
      assert.deepEqual(analisarComando(c), { mutante: false, leitura: false }, c);
      assert.equal(classificar('Bash', { command: c }), 'outra', c);
    }
  });

  test('gerenciar combos pela API: listar -> apagar -> listar -> criar -> listar não é negado', () => {
    const s = sessaoMemoria();
    const listar = { command: 'curl -s http://localhost:20128/api/combos' };
    const lista = { stdout: '[{"name":"direcionador"}]' };
    const out = [];
    out.push(s.chamar('Bash', listar, lista).pre);
    out.push(s.chamar('Bash', { command: 'curl -s -X DELETE http://localhost:20128/api/combos/direcionador' }, { stdout: '' }).pre);
    out.push(s.chamar('Bash', listar, { stdout: '[]' }).pre);
    out.push(s.chamar('Bash', { command: 'curl -s -X POST -d "{}" http://localhost:20128/api/combos' }, { stdout: '{}' }).pre);
    out.push(s.chamar('Bash', listar, lista).pre);
    out.push(s.chamar('PowerShell', { command: 'Invoke-RestMethod -Method Delete http://localhost:20128/api/combos/x' }, '').pre);
    out.push(s.chamar('Bash', listar, lista).pre);
    assert.deepEqual(out.map(negou), [false, false, false, false, false, false, false]);
  });

  test('script desconhecido e formatador liberam o teste seguinte', () => {
    const s = sessaoMemoria();
    const pytest = { command: 'pytest -q' };
    const falhou = { stdout: 'E   ImportError', exitCode: 1 };
    assert.equal(s.chamar('Bash', pytest, falhou).pre, null);
    assert.equal(s.chamar('Bash', pytest, falhou).pre, null);
    assert.equal(s.chamar('Bash', { command: 'python fix_imports.py' }, { stdout: 'ok' }).pre, null);
    assert.equal(s.chamar('Bash', pytest, falhou).pre, null);
    assert.equal(s.chamar('Bash', { command: 'black .' }, { stdout: 'reformatted' }).pre, null);
    assert.equal(s.chamar('Bash', pytest, falhou).pre, null);
  });
});

describe('achado 5 e 6: polling e cwd', () => {
  test('polling com saída que muda é permitido', () => {
    const s = sessaoMemoria();
    const ps = { command: 'curl -s http://localhost:11434/api/ps' };
    for (let i = 0; i < 6; i += 1) assert.equal(s.chamar('Bash', ps, { stdout: `{"models":[],"carregando":${i}}` }).pre, null, `poll ${i}`);
  });

  test('polling com a mesma saída: espaçado (> 20 s) é permitido, rápido é negado', () => {
    const s = sessaoMemoria();
    const ps = { command: 'curl -s http://localhost:11434/api/ps' };
    const mesma = { stdout: '{"models":[]}' };
    for (let i = 0; i < 5; i += 1) {
      s.agora += 30_000;
      assert.equal(s.chamar('Bash', ps, mesma).pre, null, `poll espaçado ${i}`);
    }
    const s2 = sessaoMemoria();
    assert.equal(s2.chamar('Bash', ps, mesma).pre, null);
    assert.equal(s2.chamar('Bash', ps, mesma).pre, null);
    assert.ok(negou(s2.chamar('Bash', ps, mesma).pre), 'mesma saída em sequência rápida');
  });

  test('FLUXO_POLL_SEG configura o espaçamento', () => {
    const s = sessaoMemoria({ FLUXO_POLL_SEG: '60' });
    const st = { command: 'git status' };
    for (let i = 0; i < 2; i += 1) {
      s.agora += 30_000;
      s.chamar('Bash', st, { stdout: 'limpo' });
    }
    s.agora += 30_000;
    assert.ok(negou(s.chamar('Bash', st, { stdout: 'limpo' }).pre), '30 s < 60 s');
  });

  test('ferramenta MCP de status chamada 3x com saídas diferentes é permitida', () => {
    const s = sessaoMemoria();
    for (let i = 0; i < 4; i += 1) {
      assert.equal(s.chamar('mcp__ccd_pr__get_status', { pr: 1 }, { checks: ['pendente', 'pendente', 'ok', 'ok'][i] + 'x'.repeat(i) }).pre, null);
    }
  });

  test('o mesmo comando em pastas diferentes (cwd) não é repetição', () => {
    const s = sessaoMemoria();
    const teste = { command: 'npm test' };
    for (const p of ['a', 'b', 'c']) {
      s.cwd = `I:/repo/packages/${p}`;
      assert.equal(s.chamar('Bash', teste, { stdout: 'ok', exitCode: 0 }).pre, null, p);
    }
    s.cwd = 'I:/repo/packages/c';
    assert.equal(s.chamar('Bash', teste, { stdout: 'ok', exitCode: 0 }).pre, null);
    assert.ok(negou(s.chamar('Bash', teste, { stdout: 'ok', exitCode: 0 }).pre), '3x na mesma pasta');
  });
});

describe('achado 7 e 8: delegação em debate, alternância e MCP', () => {
  test('revisão idêntica depois de correções é permitida; sem nada no meio, negada', () => {
    const s = sessaoMemoria();
    const revisar = { subagent_type: 'revisor', prompt: 'Revise X e aponte problemas com evidência' };
    const out = [];
    for (let i = 0; i < 3; i += 1) {
      out.push(s.chamar('Agent', revisar, { content: `rodada ${i}` }).pre);
      s.chamar('Edit', { file_path: 'x.mjs', old_string: `r${i}`, new_string: `r${i + 1}` });
    }
    assert.deepEqual(out.map(negou), [false, false, false]);
    // a última rodada do laço terminou com um Edit: a 4a revisão vê mudança
    assert.equal(s.chamar('Agent', revisar, { content: 'r3' }).pre, null);
    assert.equal(s.chamar('Agent', revisar, { content: 'r4' }).pre, null);
    assert.ok(negou(s.chamar('Agent', revisar, { content: 'r5' }).pre), 'nada mudou desde as 2 últimas');
  });

  test('correção delegada a outro executor libera a revisão seguinte', () => {
    const s = sessaoMemoria();
    const revisar = { subagent_type: 'revisor', prompt: 'Revise X' };
    s.chamar('Agent', revisar, { content: 'r1' });
    s.chamar('Agent', { subagent_type: 'executor-codex', prompt: 'corrija A' }, { content: 'ok' });
    s.chamar('Agent', revisar, { content: 'r2' });
    s.chamar('Agent', { subagent_type: 'executor-codex', prompt: 'corrija B' }, { content: 'ok' });
    assert.equal(s.chamar('Agent', revisar, { content: 'r3' }).pre, null);
  });

  test('alternar aplicar/desfazer (sed a->b, b->a) é ciclo e é negado', () => {
    const s = sessaoMemoria();
    const ida = { command: "sed -i 's/a/b/' x.js" };
    const volta = { command: "sed -i 's/b/a/' x.js" };
    const out = [];
    for (let i = 0; i < 2; i += 1) {
      out.push(s.chamar('Bash', ida, { stdout: '' }).pre);
      out.push(s.chamar('Bash', volta, { stdout: '' }).pre);
    }
    assert.deepEqual(out.map(negou), [false, false, false, false]);
    const quinta = s.chamar('Bash', ida, { stdout: '' }).pre;
    assert.ok(negou(quinta), 'A,B,A,B,A');
    assert.match(motivo(quinta), /ciclo detectado/);
    // período 3: x->y, y->z, z->x em volta
    const s3 = sessaoMemoria();
    const volta3 = () => [
      s3.chamar('Bash', { command: "sed -i 's/x/y/' a.js" }, { stdout: '' }).pre,
      s3.chamar('Bash', { command: "sed -i 's/y/z/' a.js" }, { stdout: '' }).pre,
      s3.chamar('Bash', { command: "sed -i 's/z/x/' a.js" }, { stdout: '' }).pre,
    ];
    assert.deepEqual([...volta3(), ...volta3()].map(negou), [false, false, false, false, false, false]);
    assert.match(motivo(s3.chamar('Bash', { command: "sed -i 's/x/y/' a.js" }, { stdout: '' }).pre), /ciclo detectado/);
  });

  test('ação mutante repetida sem nada novo observado no meio continua sendo loop', () => {
    const s = sessaoMemoria();
    const rolar = { action: 'scroll', coordinate: [1, 1] };
    s.chamar('mcp__browser__computer', rolar, 'ok');
    s.chamar('mcp__browser__computer', { action: 'screenshot' }, { imagem: 'fim-da-pagina' });
    s.chamar('mcp__browser__computer', rolar, 'ok');
    s.chamar('mcp__browser__computer', { action: 'screenshot' }, { imagem: 'fim-da-pagina' });
    assert.ok(negou(s.chamar('mcp__browser__computer', rolar, 'ok').pre), 'o print não mudou: rolar não avança');
  });

  test('ciclo com saídas diferentes (progresso real, ex.: rolar a página) não é negado', () => {
    const s = sessaoMemoria();
    for (let i = 0; i < 5; i += 1) {
      assert.equal(s.chamar('mcp__browser__computer', { action: 'scroll', coordinate: [1, 1] }, 'ok').pre, null);
      assert.equal(s.chamar('mcp__browser__computer', { action: 'screenshot' }, { imagem: `quadro-${'abcde'[i]}` }).pre, null);
    }
  });

  test('MCP só de leitura não libera releitura; MCP com verbo de escrita libera', () => {
    const s = sessaoMemoria();
    const a = { file_path: 'a.md' };
    const out = [];
    for (let i = 0; i < 3; i += 1) {
      out.push(negou(s.chamar('Read', a).pre));
      s.chamar('mcp__claude-in-chrome__read_page', { tabId: 1 }, { arvore: `${i}` });
      s.chamar('mcp__cerebro__cerebro_buscar', { q: `x${i}` }, { r: i });
    }
    assert.deepEqual(out, [false, false, true]);
    const s2 = sessaoMemoria();
    s2.chamar('Read', a);
    s2.chamar('Read', a);
    s2.chamar('mcp__cerebro__cerebro_registrar', { titulo: 't' }, { ok: true });
    assert.equal(s2.chamar('Read', a).pre, null);
  });

  test('classificação de ferramentas MCP', () => {
    assert.equal(ferramentaMutante('mcp__cerebro__cerebro_buscar', {}), false);
    assert.equal(ferramentaMutante('mcp__cerebro__cerebro_registrar', {}), true);
    assert.equal(ferramentaMutante('mcp__claude-in-chrome__read_page', {}), false);
    assert.equal(ferramentaMutante('mcp__claude-in-chrome__computer', { action: 'left_click' }), true);
    assert.equal(ferramentaMutante('mcp__claude-in-chrome__computer', { action: 'screenshot' }), false);
    assert.equal(ferramentaMutante('mcp__x__get_run', {}), false);
    assert.equal(ferramentaMutante('mcp__x__get_settings', {}), false);
    assert.equal(ferramentaMutante('mcp__x__create_event', {}), true);
    assert.equal(ferramentaMutante('mcp__x__qualquer', {}, lerConfig({ FLUXO_MCP_MUTANTES: 'mcp__x__qualquer' })), true);
    assert.equal(ferramentaMutante('mcp__x__set_coisa', {}, lerConfig({ FLUXO_MCP_LEITURA: 'mcp__x__set_coisa' })), false);
  });
});

describe('achado 9: variação trivial não escapa', () => {
  test('normalização de comandos', () => {
    assert.equal(normalizarComando('npm test 2>&1 | tail -20'), 'npm test');
    assert.equal(normalizarComando('npm run test'), 'npm test');
    assert.equal(normalizarComando('npm t'), 'npm test');
    assert.equal(normalizarComando('npm   test 2>/dev/null | head -n 50'), 'npm test');
    assert.equal(normalizarComando('Get-ChildItem | Select-Object -First 5'), 'Get-ChildItem');
    assert.equal(normalizarComando('pytest -q 2>$null'), 'pytest -q');
    assert.equal(normalizarComando('npm test -- --grep x'), 'npm test -- --grep x');
  });

  test('variações triviais do mesmo teste são a mesma chamada; Grep no meio não libera', () => {
    const s = sessaoMemoria();
    const falhou = { stdout: 'FAIL: esperado 1', exitCode: 1 };
    assert.equal(s.chamar('Bash', { command: 'npm test' }, falhou).pre, null);
    s.chamar('Grep', { pattern: 'soma' }, { numFiles: 1 });
    assert.equal(s.chamar('Bash', { command: 'npm run test 2>&1 | tail -30', timeout: 120000 }, falhou).pre, null);
    s.chamar('Grep', { pattern: 'subtrai' }, { numFiles: 1 });
    const r = s.chamar('PowerShell', { command: 'npm test', run_in_background: false, description: 'de novo' }, falhou);
    assert.ok(negou(r.pre), 'Bash/PowerShell, 2>&1, | tail e timeout não mudam a chamada');
  });

  test('assinatura canônica', () => {
    assert.equal(assinatura('Bash', { command: 'npm  test ', description: 'a' }), assinatura('Bash', { command: 'npm test', description: 'b' }));
    assert.equal(assinaturaBase('Bash', { command: 'git status' }), assinaturaBase('PowerShell', { command: 'git status', timeout: 5 }));
    assert.notEqual(assinaturaBase('Bash', { command: 'npm test' }, 'I:/a'), assinaturaBase('Bash', { command: 'npm test' }, 'I:/b'));
    assert.equal(assinaturaBase('Read', { file_path: 'x.md' }, 'I:/proj'), assinaturaBase('Read', { file_path: 'I:/proj/x.md' }));
  });

  test('"cat arquivo" no shell é a mesma leitura que Read', () => {
    const s = sessaoMemoria();
    s.cwd = 'I:/proj';
    s.chamar('Read', { file_path: 'I:/proj/a.txt' });
    s.chamar('Read', { file_path: 'I:/proj/a.txt' });
    assert.ok(negou(s.chamar('Bash', { command: 'cat a.txt' }).pre));
  });

  test('hash da resposta ignora tempos, datas, ids e campos voláteis, mas não contagens', () => {
    assert.equal(hashResposta({ stdout: 'levou 12ms', durationMs: 5 }), hashResposta({ stdout: 'levou 345ms', durationMs: 99 }));
    assert.equal(hashResposta('ℹ duration_ms 1420.41\n1 failed in 0.12s'), hashResposta('ℹ duration_ms 98.7\n1 failed in 3.40s'));
    assert.equal(hashResposta('{"expires_at":"2026-10-12T14:00:00.123-03:00"}'), hashResposta('{"expires_at":"2026-10-12T14:05:09.9-03:00"}'));
    assert.equal(hashResposta('commit 3f9a2b7c1d e pid 123456'), hashResposta('commit 77aa00ff11 e pid 987654'));
    assert.notEqual(hashResposta('3 testes falharam'), hashResposta('2 testes falharam'));
    assert.notEqual(hashResposta('carregando 40%'), hashResposta('carregando 60%'));
    assert.notEqual(hashResposta({ stdout: 'passou' }), hashResposta({ stdout: 'falhou' }));
    assert.equal(hashResposta(undefined), undefined);
    assert.equal(typeof hashResposta('x'.repeat(200_000)), 'string');
  });
});

describe('achado 10: compactação de contexto', () => {
  test('PreCompact e SessionStart(compact/clear/resume) zeram o histórico de repetição', () => {
    for (const ev of [{ hook_event_name: 'PreCompact' }, { hook_event_name: 'SessionStart', source: 'compact' }, { hook_event_name: 'SessionStart', source: 'resume' }]) {
      const s = sessaoMemoria();
      s.chamar('Read', { file_path: 'a.md' });
      s.chamar('Read', { file_path: 'a.md' });
      s.ev(ev);
      assert.equal(s.chamar('Read', { file_path: 'a.md' }).pre, null, JSON.stringify(ev));
    }
    const s = sessaoMemoria();
    s.chamar('Read', { file_path: 'a.md' });
    s.chamar('Read', { file_path: 'a.md' });
    s.ev({ hook_event_name: 'SessionStart', source: 'startup' });
    assert.ok(negou(s.chamar('Read', { file_path: 'a.md' }).pre), 'startup não zera');
    const s2 = sessaoMemoria();
    for (let i = 0; i < 45; i += 1) s2.chamar('Read', { file_path: `f${i}` });
    s2.ev({ hook_event_name: 'SessionStart', source: 'clear' });
    assert.equal(s2.estado.chamadasTurno, 0, 'clear zera o turno');
  });

  test('executar aceita PreCompact/SessionStart e zera o estado em disco', () => {
    const dir = novoDir();
    const env = ambiente(dir);
    const ev = (id) => ({ hook_event_name: 'PreToolUse', session_id: 'comp', tool_name: 'Read', tool_input: { file_path: 'a' }, tool_use_id: id });
    executar(ev('1'), { env });
    executar(ev('2'), { env });
    assert.equal(executar({ hook_event_name: 'PreCompact', session_id: 'comp', trigger: 'auto' }, { env }), null);
    assert.equal(executar(ev('3'), { env }), null);
    assert.equal(executar({ hook_event_name: 'SessionStart', session_id: 'comp', source: 'compact' }, { env }), null);
    assert.equal(executar(ev('4'), { env }), null);
  });
});

describe('estado em disco', () => {
  test('executar persiste e bloqueia entre processos (mesma sessão)', () => {
    const dir = novoDir();
    const env = ambiente(dir);
    const ev = (id) => ({ hook_event_name: 'PreToolUse', session_id: 'sess-1', tool_name: 'Read', tool_input: { file_path: 'a' }, tool_use_id: id });
    assert.equal(executar(ev('1'), { env }), null);
    assert.equal(executar(ev('2'), { env }), null);
    assert.ok(negou(executar(ev('3'), { env })));
    const arquivos = fs.readdirSync(dir);
    assert.ok(arquivos.includes('sess-1.json'));
    assert.ok(!arquivos.some((n) => n.endsWith('.tmp')), 'escrita atômica não deixa .tmp');
    assert.ok(!arquivos.some((n) => n.endsWith('.lock')), 'trava liberada');
  });

  test('sessões e subagentes isolados', () => {
    const dir = novoDir();
    const env = ambiente(dir);
    const ev = (sessao, extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: sessao, tool_name: 'Read', tool_input: { file_path: 'a' }, ...extra });
    executar(ev('A'), { env });
    executar(ev('A'), { env });
    assert.equal(executar(ev('B'), { env }), null, 'sessão B não herda de A');
    assert.equal(executar(ev('A', { agent_id: 'sub1' }), { env }), null, 'subagente tem estado próprio');
    assert.ok(negou(executar(ev('A'), { env })));
  });

  test('session_id é saneado (sem travessia de diretório)', () => {
    const dir = novoDir();
    const f = nomeArquivoEstado({ session_id: '../../etc/passwd' }, dir);
    assert.equal(path.dirname(f), dir);
    assert.ok(!path.basename(f).includes('..'));
    assert.equal(path.basename(nomeArquivoEstado({}, dir)), 'sem-sessao.json');
  });

  test('estado corrompido vai para .corrompido (não é sobrescrito em silêncio)', () => {
    const dir = novoDir();
    const env = ambiente(dir);
    const arquivo = path.join(dir, 'corrompida.json');
    fs.writeFileSync(arquivo, '{isto não é json', 'utf8');
    const ev = { hook_event_name: 'PreToolUse', session_id: 'corrompida', tool_name: 'Read', tool_input: { file_path: 'a' } };
    assert.equal(executar(ev, { env }), null);
    assert.equal(fs.readFileSync(`${arquivo}.corrompido`, 'utf8'), '{isto não é json', 'original preservado');
    const salvo = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    assert.equal(salvo.historico.length, 1);
    assert.match(fs.readFileSync(path.join(dir, 'anti-loop.log'), 'utf8'), /estado-corrompido/);
    // forma errada (JSON válido) é tolerada
    fs.writeFileSync(arquivo, JSON.stringify({ historico: 'x', epoca: -5, contados: 3, falhas: [1, 'a', 0] }), 'utf8');
    assert.equal(executar(ev, { env }), null);
    const { estado } = carregarEstado(arquivo);
    assert.equal(estado.epoca, 0);
    assert.ok(Array.isArray(estado.historico));
  });

  test('carregarEstado distingue ausente (novo) de ilegível (não gravável)', () => {
    const dir = novoDir();
    const ausente = carregarEstado(path.join(dir, 'nao-existe.json'));
    assert.equal(ausente.novo, true);
    assert.equal(ausente.gravavel, true);
    const pasta = path.join(dir, 'e-uma-pasta.json');
    fs.mkdirSync(pasta);
    const ilegivel = carregarEstado(pasta);
    assert.equal(ilegivel.novo, false);
    assert.equal(ilegivel.gravavel, false);
  });

  test('salvarEstado grava de forma atômica e, se o rename falhar, não grava direto', () => {
    const dir = novoDir();
    const arquivo = path.join(dir, 'x.json');
    salvarEstado(arquivo, estadoInicial());
    salvarEstado(arquivo, { ...estadoInicial(), epoca: 7 });
    assert.equal(JSON.parse(fs.readFileSync(arquivo, 'utf8')).epoca, 7);
    assert.deepEqual(fs.readdirSync(dir), ['x.json']);
    // destino que não pode ser substituído (uma pasta com conteúdo): rename falha
    const dir2 = novoDir();
    const destino = path.join(dir2, 'y.json');
    fs.mkdirSync(destino);
    fs.writeFileSync(path.join(destino, 'dentro.txt'), 'x');
    assert.throws(() => salvarEstado(destino, estadoInicial()));
    assert.deepEqual(fs.readdirSync(dir2), ['y.json'], 'sem .tmp sobrando');
    assert.deepEqual(fs.readdirSync(destino), ['dentro.txt'], 'destino intacto');
  });

  test('estado ilegível: decide sem salvar e não destrói nada', () => {
    const dir = novoDir();
    const env = ambiente(dir);
    const pasta = path.join(dir, 'pasta-sessao.json');
    fs.mkdirSync(pasta);
    fs.writeFileSync(path.join(pasta, 'dentro.txt'), 'x');
    const ev = { hook_event_name: 'PreToolUse', session_id: 'pasta-sessao', tool_name: 'Read', tool_input: { file_path: 'a' } };
    assert.equal(executar(ev, { env }), null);
    assert.ok(fs.statSync(pasta).isDirectory());
    assert.deepEqual(fs.readdirSync(pasta), ['dentro.txt']);
  });

  test('FLUXO_ANTILOOP=0 desliga tudo', () => {
    const dir = novoDir();
    const env = ambiente(dir, { FLUXO_ANTILOOP: '0' });
    const ev = { hook_event_name: 'PreToolUse', session_id: 'off', tool_name: 'Read', tool_input: { file_path: 'a' } };
    for (let i = 0; i < 5; i += 1) assert.equal(executar(ev, { env }), null);
    assert.equal(fs.readdirSync(dir).length, 0, 'nem grava estado');
  });

  test('entrada inválida ou evento desconhecido não faz nada', () => {
    const dir = novoDir();
    const env = ambiente(dir);
    assert.equal(executar(null, { env }), null);
    assert.equal(executar('texto', { env }), null);
    assert.equal(executar([], { env }), null);
    assert.equal(executar({ hook_event_name: 'Stop', session_id: 'x' }, { env }), null);
    assert.equal(executar({ hook_event_name: 'PreToolUse', session_id: 'x' }, { env }), null);
  });
});

describe('achado 11: limpeza só apaga arquivos do próprio gancho', () => {
  const tresDias = () => (Date.now() - 3 * 24 * 3600 * 1000) / 1000;

  test('pasta compartilhada (sem marcador): nada é apagado', () => {
    const dir = novoDir();
    const nomes = ['MANUAL-FLUXO.md', 'anti-loop.mjs', 'aprimorar.log', 'nota-do-vault.md', 'velha.json'];
    for (const n of nomes) {
      fs.writeFileSync(path.join(dir, n), 'conteúdo');
      fs.utimesSync(path.join(dir, n), tresDias(), tresDias());
    }
    executar({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'x' }, { env: ambiente(dir) });
    for (const n of nomes) assert.ok(fs.existsSync(path.join(dir, n)), `${n} preservado`);
    assert.ok(!fs.existsSync(path.join(dir, MARCADOR)), 'pasta que já existia não ganha marcador');
    assert.equal(limparAntigos(dir, 1), 0);
  });

  test('pasta criada pelo gancho: apaga só os nomes do gancho mais velhos que 2 dias', () => {
    const dir = path.join(DIR, `criada-${++seq}`, 'estado');
    const env = ambiente(dir);
    executar({ hook_event_name: 'UserPromptSubmit', session_id: 'atual', prompt: 'x' }, { env });
    assert.ok(fs.existsSync(path.join(dir, MARCADOR)), 'marcador criado');
    const velhos = ['velha.json', 'velha__sub.json', 'velha.mut', 'velha.json.123.tmp', 'velha.json.corrompido'];
    // dados.json tem nome no padrão do gancho, mas o conteúdo não é estado: fica
    const alheios = ['MANUAL.md', 'nota.txt', 'config.yaml', 'dados.json'];
    for (const n of [...velhos, ...alheios]) {
      fs.writeFileSync(path.join(dir, n), n === 'dados.json' ? '{"clientes":[]}' : '{"v":2,"historico":[]}');
      fs.utimesSync(path.join(dir, n), tresDias(), tresDias());
    }
    fs.writeFileSync(path.join(dir, 'recente.json'), '{}');
    executar({ hook_event_name: 'UserPromptSubmit', session_id: 'atual', prompt: 'x' }, { env });
    for (const n of velhos) assert.ok(!fs.existsSync(path.join(dir, n)), `${n} removido`);
    for (const n of alheios) assert.ok(fs.existsSync(path.join(dir, n)), `${n} preservado`);
    assert.ok(fs.existsSync(path.join(dir, 'recente.json')), 'arquivo recente mantido');
    assert.ok(fs.existsSync(path.join(dir, 'atual.json')));
    assert.ok(fs.existsSync(path.join(dir, MARCADOR)));
    assert.equal(limparAntigos(path.join(dir, 'nao-existe'), 1), 0);
  });
});

describe('funções puras', () => {
  test('serialização estável ignora a ordem das chaves', () => {
    assert.equal(serializarEstavel({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), serializarEstavel({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
    assert.equal(assinatura('Read', { a: 1, b: 2 }), assinatura('Read', { b: 2, a: 1 }));
    assert.notEqual(assinatura('Read', { a: 1 }), assinatura('Grep', { a: 1 }));
    assert.notEqual(assinatura('Read', { a: 1 }, 0), assinatura('Read', { a: 1 }, 1));
  });

  test('classificação', () => {
    assert.equal(classificar('TodoWrite', {}), 'isenta');
    assert.equal(classificar('Read', {}), 'leitura');
    assert.equal(classificar('Bash', { command: 'git status' }), 'leitura');
    assert.equal(classificar('Bash', { command: 'echo x > a.txt' }), 'shell-mutante');
    assert.equal(classificar('PowerShell', { command: 'Remove-Item a.txt' }), 'shell-mutante');
    assert.equal(classificar('Edit', {}), 'mutante');
    assert.equal(classificar('Agent', {}), 'delegacao');
    assert.equal(classificar('mcp__qualquer__coisa', {}), 'outra');
    assert.equal(classificar('MinhaFerramenta', {}, lerConfig({ FLUXO_ISENTAS: 'MinhaFerramenta' })), 'isenta');
  });

  test('heurística de comando mutante (casos originais)', () => {
    for (const c of [
      'npm test 2>&1 | tail -20',
      'node -e "const f = (a) => a >= 1"',
      'git status',
      'git log --oneline -5',
      'ls -la > /dev/null',
      'Get-ChildItem | Select-Object Name',
      'curl -s -o /dev/null -w "%{http_code}" http://localhost:20128',
      'grep -w foo arquivo.txt',
      'cat README.md',
    ]) {
      assert.equal(comandoMutante(c), false, c);
    }
    for (const c of [
      'echo oi > a.txt',
      'cat x >> y.log',
      'rm -rf build',
      "sed -i 's/a/b/' x.js",
      'git commit -m x',
      'npm install',
      'Set-Content -Path a.txt -Value 1',
      'Remove-Item a.txt',
      'tar -xzf pacote.tgz',
      'npx prettier --write .',
      'node -e "require(\'fs\').writeFileSync(\'a\',\'b\')"',
    ]) {
      assert.equal(comandoMutante(c), true, c);
    }
  });

  test('resposta com erro', () => {
    assert.equal(respostaIndicaErro({ is_error: true }), true);
    assert.equal(respostaIndicaErro({ isError: true }), true);
    assert.equal(respostaIndicaErro({ exitCode: 2 }), true);
    assert.equal(respostaIndicaErro({ exit_code: '1' }), true);
    assert.equal(respostaIndicaErro({ interrupted: true }), true);
    assert.equal(respostaIndicaErro({ success: false }), true);
    assert.equal(respostaIndicaErro('<tool_use_error>x</tool_use_error>'), true);
    assert.equal(respostaIndicaErro({ stdout: 'ok', stderr: '', interrupted: false, exitCode: 0 }), false);
    assert.equal(respostaIndicaErro({ type: 'text', file: { content: 'Error: dentro do arquivo' } }), false);
    assert.equal(respostaIndicaErro(null), false);
    assert.equal(respostaIndicaErro([{ type: 'text', text: 'x' }]), false);
  });

  test('resumo mascara segredos e limita tamanho', () => {
    const r = resumoChamada({ command: 'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789" http://x' });
    assert.ok(!r.includes('sk-abcdefghijklmnopqrstuvwxyz0123456789'));
    assert.ok(resumoChamada({ command: 'x'.repeat(500) }).length <= 80);
  });
});

describe('processo (stdin/stdout)', () => {
  const rodar = (entrada, env = {}) =>
    spawnSync(process.execPath, [SCRIPT], {
      input: entrada,
      env: { ...process.env, FLUXO_ANTILOOP: '1', ...env },
      encoding: 'utf8',
      timeout: 15000,
    });

  const paralelo = (dir, sessao, N) => {
    const um = (i) =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, [SCRIPT], { env: { ...process.env, FLUXO_ANTILOOP: '1', FLUXO_ESTADO_DIR: dir } });
        p.stdout.resume();
        p.on('close', (code) => resolve(code));
        p.stdin.end(
          JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sessao, tool_name: 'Read', tool_input: { file_path: `f${i}` }, tool_use_id: `p${i}` }),
        );
      });
    return Promise.all(Array.from({ length: N }, (_, i) => um(i)));
  };

  test('stdin inválido -> exit 0 sem saída', () => {
    const dir = novoDir();
    for (const entrada of ['isto não é json', '', '{"hook_event_name":', '[1,2,3]', 'null']) {
      const r = rodar(entrada, { FLUXO_ESTADO_DIR: dir });
      assert.equal(r.status, 0, `status para ${JSON.stringify(entrada)}`);
      assert.equal(r.stdout, '');
    }
  });

  test('diretório de estado impossível -> exit 0 sem saída', () => {
    const dir = novoDir();
    const arquivoNoCaminho = path.join(dir, 'um-arquivo');
    fs.writeFileSync(arquivoNoCaminho, 'x');
    const r = rodar(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Read', tool_input: {} }), {
      FLUXO_ESTADO_DIR: path.join(arquivoNoCaminho, 'sub'),
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  test('fluxo real: nega a 3a leitura idêntica com JSON válido', () => {
    const dir = novoDir();
    const ev = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'proc', cwd: dir, tool_name: 'Read', tool_input: { file_path: 'a.txt' } });
    const t0 = Date.now();
    const r1 = rodar(ev, { FLUXO_ESTADO_DIR: dir });
    const duracao = Date.now() - t0;
    const r2 = rodar(ev, { FLUXO_ESTADO_DIR: dir });
    const r3 = rodar(`\uFEFF${ev}`, { FLUXO_ESTADO_DIR: dir });
    assert.equal(r1.status, 0);
    assert.equal(r1.stdout, '');
    assert.equal(r2.stdout, '');
    assert.equal(r3.status, 0);
    const saida = JSON.parse(r3.stdout);
    assert.equal(saida.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(saida.hookSpecificOutput.permissionDecisionReason, /PROTOCOLO DE TRAVAMENTO/);
    // Processo inteiro (inclui ~50ms de partida do Node); folga para máquinas lentas.
    assert.ok(duracao < 2000, `processo levou ${duracao}ms`);
  });

  test('chamadas paralelas da mesma sessão não corrompem nem perdem contagem (N=6)', async () => {
    const dir = novoDir();
    const N = 6;
    const codigos = await paralelo(dir, 'paralela', N);
    assert.deepEqual(codigos, Array(N).fill(0));
    const estado = JSON.parse(fs.readFileSync(path.join(dir, 'paralela.json'), 'utf8'));
    assert.equal(estado.chamadasTurno, N);
    assert.deepEqual(fs.readdirSync(dir), ['paralela.json']);
  });

  test('concorrência alta (N=40): JSON válido no fim, sem .tmp/.lock e sem contagem perdida', async () => {
    const dir = novoDir();
    const N = 40;
    const codigos = await paralelo(dir, 'carga', N);
    assert.deepEqual(codigos, Array(N).fill(0));
    const texto = fs.readFileSync(path.join(dir, 'carga.json'), 'utf8');
    const estado = JSON.parse(texto); // lança se o arquivo estiver corrompido
    assert.equal(estado.chamadasTurno, N);
    const sobras = fs.readdirSync(dir).filter((n) => /\.(tmp|lock|corrompido)$/.test(n));
    assert.deepEqual(sobras, []);
  });

  test('FLUXO_ANTILOOP=0 no processo: nada acontece', () => {
    const dir = novoDir();
    const ev = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'p0', tool_name: 'Read', tool_input: { file_path: 'a' } });
    for (let i = 0; i < 3; i += 1) {
      const r = rodar(ev, { FLUXO_ESTADO_DIR: dir, FLUXO_ANTILOOP: '0' });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
    }
  });

  test('tempo de processamento interno < 100ms por evento', () => {
    const dir = novoDir();
    const env = ambiente(dir);
    executar({ hook_event_name: 'UserPromptSubmit', session_id: 'tempo', prompt: 'x' }, { env });
    const grande = { stdout: 'x'.repeat(2_000_000), exitCode: 0 };
    let pior = 0;
    for (let i = 0; i < 50; i += 1) {
      const t = process.hrtime.bigint();
      executar({ hook_event_name: 'PreToolUse', session_id: 'tempo', tool_name: 'Bash', tool_input: { command: `c${i}` }, tool_use_id: `id${i}` }, { env });
      executar({ hook_event_name: 'PostToolUse', session_id: 'tempo', tool_name: 'Bash', tool_input: { command: `c${i}` }, tool_response: grande, tool_use_id: `id${i}` }, { env });
      pior = Math.max(pior, Number(process.hrtime.bigint() - t) / 1e6);
    }
    assert.ok(pior < 100, `pior par Pre+Post levou ${pior.toFixed(1)}ms`);
  });
});
