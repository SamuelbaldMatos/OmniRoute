# Handoff: Estúdio de código no Habblaud + uso das contas + OmniRoute (2026-10-18)

> Cole o bloco "PROMPT" abaixo no Claude Code do VS Code. Fale em português, só pare em decisão importante e nunca exiba chaves.

---

## PROMPT

Continue o trabalho do Habblaud (`C:\Users\sam_1\habblaud`, branch `feat/jarvis-gerente`, HEAD `ae7625a`, mudanças sem commit). Leia este arquivo inteiro (`I:\OMNIROUTE\fluxo\HANDOFF-2026-10-18-ESTUDIO.md`) e o handoff anterior `I:\OMNIROUTE\fluxo\HANDOFF-2026-10-18.md`. Antes de agir, confira o estado real: `git status`, `/v1/models` do OmniRoute com a chave, `docker ps`, a pasta `~/.habblaud/usage`. Resumos são contexto, não prova.

Objetivo do usuário, em uma frase: **trabalhar com código direto no Habblaud, no navegador, numa tela só** (sem o chat do Claude nem do VS Code). O OmniRoute distribui as tarefas entre os modelos para gastar menos tokens do Claude, e a IA local segura as pontas para nenhuma tarefa parar antes de terminar. O uso de todas as contas fica visível na mesma tela. Trazer do vibe-coding-toolkit (github.com/soumatheusgomes/vibe-coding-toolkit) as práticas que evitam reconsultar dados o tempo todo.

Siga a seção "Pendências" na ordem. Ao final: typecheck, vitest, `claude plugin test` em `mod/habblaud`, reconstruir o container (`npm run docker:up`), validar no navegador (http://127.0.0.1:4747), commitar no `feat/jarvis-gerente` e registrar no Cérebro (`cerebro_registrar`, tipo entrega, citando este handoff).

---

## 1. Diagnóstico já feito (medido em 2026-10-18)

| Problema relatado | Causa encontrada | Evidência |
|---|---|---|
| Uso não aparece no Habblaud em nenhuma conta | O mod do Habblaud usa `HOME` para achar a pasta de uso, e `HOME` não existe no Windows (nem no usuário, nem na máquina). O mod nunca gravou nada | `~/.habblaud/usage` vazia; `npm run mod:status` e `usage:status` dizem "nenhum uso capturado"; o log do container mostra `uso: disabled` nas 3 contas |
| Perfil omniroute sem uso | Fala com o gateway, então o Claude Code não recebe `rateLimits` | O uso real está no OmniRoute: `/api/usage/provider-limits` funciona com a chave Bearer (Claude: 5h 53%, semana 75%) |
| "Terminal do Habblaud diz que a API não funciona" | Não se reproduziu: `/api/omniroute/chat` e `/api/omniroute/run` responderam 200 (orquestrador → gpt-6-astra-high). O erro que aparece ("Instabilidade na API") vem da sessão Melissa do perfil omniroute, de **10-12** (16× "Request timed out"), parada e ainda listada como aberta | Transcript `profiles/omniroute/projects/C--Users-sam-1/cbe42b7f-….jsonl` |
| Aparência ruim | O `OmniChatPanel` (`client/src/ui/chat.ts`) é uma faixa **recolhida por padrão**: a resposta vai para um painel fora da tela, até alguém clicar em ▴ (Alt+S) | Teste no navegador |
| OmniRoute "não roteia direito" | O roteamento funciona: os 10 combos testados deram 200 em 1 a 11 s. Mas: **conta Claude esgotada** no OmniRoute ("quota-aware: 0 with quota, skipping 1 exhausted"), então `aprimorador` e `executor-claude` caem para GPT ou Antigravity; Copilot com `rateLimitedUntil` 01/11; Qwen local devolve `(empty response)` com max_tokens baixo (o raciocínio consome a cota); taxa de sucesso histórica de 68% | Script `testa-combos.mjs` e log `~/.omniroute/logs/application/app.log` |
| Nota no vault a cada pedido | `AgentRuntime.run()` sempre chama `memory.record` no `finally`, até para um "ok" | `server/http/agent-runtime.ts`, por volta da linha 480; a nota `badb2148…` foi criada num teste |
| Reconsulta constante | `memory.prepare()` dispara até ~10 processos do `cerebro-cli` (buscar, rotear e até 8 `ler_nota`) **em cada mensagem** | `server/http/agent-memory.ts` |

### Rotas do OmniRoute que aceitam a chave Bearer (testadas)
- `GET /api/providers`: conexões. **Contém tokens em `providerSpecificData`, `apiKey` e `email`: só a lista branca sai do servidor.**
- `GET /api/usage/provider-limits`: `caches[connId].quotas`, com `{used,total,resetAt}` ou `remainingPercentage`.
- `GET /api/usage/analytics`: `summary`, `byProvider`, `byModel`, `dailyTrend`…
- `GET /api/usage/combo-health?range=24h`: `combos[].targetHealth[]`.
- Id → provedor: `db66ee5c` claude; `0bf3ebd9` codex (plus); `85b01506` agy (gmail); `292e9242` antigravity (bcgestao); `bd7a402a` github (Copilot Free, esgotado); `25bd5d56` ollama-local; `6c46979b` moonshot; `ccd350c9` cheaperinference.

---

## 2. O que já foi alterado (SEM COMMIT, NÃO TESTADO AO VIVO)

| Arquivo | Mudança | Estado |
|---|---|---|
| `mod/habblaud/hooks/register.ts` | Usa `USERPROFILE` quando falta `HOME`; `normalizePath` converte `\` em `/`; `accountIdOf` e `expandHome` aceitam `\` | `claude plugin test`: 15 passam e 2 falham. **As 2 falhas já existiam** antes da mudança (o simulador no Windows converte o caminho para `C:\home\…`); conferido com `git stash`. `plugin validate --strict` ok |
| `mod/habblaud/tests/habblaud.test.ts` | Teste "Windows: USERPROFILE com barras invertidas" | Passa |
| Caches do plugin (3 contas) | `register.ts` copiado para `~/.claude`, `~/.claude-flow` e `profiles/omniroute` em `plugins/cache/habblaud/habblaud/0.4.0/hooks/` | Copiado. **Não verificado**: abrir uma sessão nova e conferir se aparece `~/.habblaud/usage/<conta>.json` |
| `server/omniroute/status.ts` (novo) | `collectOmniStatus` + `OmniStatusService`: cache de 60 s, renovação a cada 2 min, lista branca de campos, e-mails e tokens removidos das mensagens de erro, `claudeUsageByEmail` só no servidor | Typecheck do servidor ok; **sem teste unitário ainda** |
| `server/http/omniroute.ts` | Removidos os imports dos esqueletos; criado `OmniStatusService`; rota `GET /api/omniroute/status` (só local); opção `onOmniUsage` | Typecheck ok |
| `server/index.ts` | Passa `onOmniUsage: (m) => accounts.applyOmniroute(m)` | Typecheck ok |
| `server/accounts/service.ts` | `applyOmniroute(byEmail)`: aplica a fonte `omniroute` às contas com o mesmo e-mail | Typecheck ok |
| `shared/types.ts` | `AccountUsage.source` aceita `'omniroute'` | — |
| `client/src/ui/usage.ts` | Rótulo da fonte omniroute; conta como "ao vivo" | Typecheck do cliente **não executado** |
| `server/omniroute/accounts.ts` e `spend-history.ts` | Esqueletos quebrados (retornavam vazio e importavam `../sources/utils`, que não existe), **movidos** para `I:\Cerebro\backups\habblaud-estudio-2026-10-18\server-omniroute\` | — |
| Herdado do B1 | `client/src/ui/chat.ts` (lista nova de combos), `server/http/omniroute.ts` (`OMNIROUTE_COMBOS` novos), `client/src/ui/chat-combos.test.ts` (import errado: corrigir para `'../../../server/http/omniroute'`) | Pendente |

---

## 3. Decisão do usuário (2026-10-18)

- **O estúdio pode editar TODAS as pastas.**
  - Implementar como montagem `rw` dos discos de trabalho (por exemplo `I:/` → `/host/I` e `C:/Users/sam_1` → `/host/C/Users/sam_1`) com vários workspaces nomeados.
  - Manter as proteções que já existem em `agent-tools.ts`: `.git`, `node_modules`, `.env*`, `.claude`, `*.pem/key`, `docker-compose.override.yml` e symlinks bloqueados; toda escrita e todo comando exigem aprovação.
  - Acrescentar à lista de bloqueio: `C:/Users/sam_1/.omniroute`, `.codex`, `.gemini`, `profiles/*/settings.json`, `AppData` e o vault `clientes/ projetos/ sessoes/ processos/` (dado de cliente).
  - Avisar o usuário em uma linha que montar o disco inteiro dentro do container amplia o alcance do agente (mitigado pelas aprovações). Peça confirmação só se for montar `C:\` inteiro.

---

## 4. Pendências, na ordem

### P1. Fechar o uso das contas
1. Teste unitário de `server/omniroute/status.ts`:
   - `quotaPct`;
   - `claudeUsageFrom` com "session (5h)" e "weekly (7d)";
   - lista branca: nenhum `providerSpecificData`, `apiKey` ou `email` na saída.
2. Corrigir `client/src/ui/chat-combos.test.ts`; rodar `npm run typecheck` e `npm test` até ficarem verdes.
3. `npm run docker:up` e conferir o topo da tela: Conta A e Conta C com 5h/semana, origem "OmniRoute".
4. A Conta B (`.claude-flow`) é resíduo do Ruflo, com 0 sessões. Tirar do override ou do `docker-up`, se a detecção permitir; senão, documentar.
5. Abrir uma sessão nova do Claude Code e conferir se o mod grava `~/.habblaud/usage/.claude.json`.

### P2. Runtime que não para (`server/http/agent-runtime.ts`, `omniroute.ts`)
1. **Não cancelar quando o navegador desconecta.**
   - Remover `runtime.cancel` do `res.on('close')`.
   - Guardar até ~2000 eventos por tarefa e manter uma lista de assinantes.
   - `GET /api/omniroute/jobs` (lista) e `GET /api/omniroute/jobs/:id/stream?after=N` (replay e acompanhamento por SSE).
   - Guardar as últimas 20 tarefas na memória e um resumo em `/data/jobs/`.
2. **Failover explícito** em `complete()`:
   - em erro que não seja abort nem `IncompleteJobError`, tentar o combo pedido, depois `orquestrador`, depois `gerente-jarvis`, depois `processador-privado-local`;
   - emitir uma atividade "X falhou; seguindo com Y";
   - timeout de 600 s nas chamadas sem streaming (o corte de 110 s do OmniRoute só vale em streaming);
   - verificar se `/v1/messages` repassa `reasoning_effort:"none"` ou `thinking:{type:"disabled"}` para o Qwen não voltar vazio. Testar com o script `testa-combos.mjs`.
3. `APPROVAL_TIMEOUT_MS` de 120 s para 30 min.
4. **Vários workspaces:**
   - `HABBLAUD_AGENT_WORKSPACES` (JSON nome → caminho no container); `start({workspace})`;
   - verificações genéricas pelos scripts do `package.json` (`typecheck`, `test`, `lint`, `build`), mantendo as fixas do Habblaud.
5. **Novas ferramentas:**
   - `list_files` e `search_text` (somente leitura, com limites);
   - `propose_file_write` aceitando arquivo novo (pasta-mãe existente dentro do workspace, mesma validação de caminho).
6. **Parar de gravar nota no vault em toda execução:** só registrar quando houve escrita aprovada ou aprendizado aprovado.

### P3. Não reconsultar (práticas do vibe-coding-toolkit)
1. **Cartão do projeto** (`server/http/project-context.ts`):
   - por workspace: árvore resumida (~400 arquivos, sem `node_modules`, `.git` e `dist`), começo de `AGENTS.md`, `CLAUDE.md`, `README.md`, `PRODUCT.md` e `docs/architecture.md`, scripts e dependências do `package.json`;
   - impressão digital: mtimes desses arquivos + `HEAD` do git;
   - cache em memória e em `/data/context/<ws>.json`;
   - vai no system prompt como "Cartão do projeto (cache, verificado em <data>)"; botão "atualizar" na interface.
2. **Cérebro:**
   - `memory.prepare` uma vez por conversa (`threadId`), reaproveitado nas mensagens seguintes;
   - `cerebro_rotear` em cache por workspace, por 6 h;
   - mostrar na interface "memória do Cérebro: em cache desde HH:MM".
3. Princípios do toolkit a aplicar:
   - AGENTS.md como índice curto, e não enciclopédia;
   - memória em duas camadas (índice sempre presente; detalhe sob demanda);
   - um escritor por arquivo e revisores só lendo;
   - subagentes com contexto mínimo;
   - "um resumo anterior não prova o estado atual".

### P4. Estúdio de código em tela cheia (cliente)
- Novo `client/src/ui/studio.ts` (+ CSS em `styles.css`, com as variáveis `--ui-*`), substituindo o `OmniChatPanel` em `client/src/ui/index.ts`. Mover `COMBOS` para lá e ajustar o teste.
- Botão na topbar (`topbar.addPanelButton`) e atalho (Alt+S ou E). Deve funcionar em tela estreita.
- **Esquerda:**
  - seletor de projeto (workspaces);
  - cartão do projeto com frescor;
  - "precisa de você" (agentes esperando, vindo do `store.snapshot`);
  - tarefas recentes, com reconexão.
- **Centro:**
  - conversa em markdown;
  - linha do tempo de atividades;
  - cartões de ferramenta (leitura, busca, checagem com saída);
  - **diff** antes/depois com Aprovar/Recusar;
  - campo de texto com combo, modo (Agente ou Consulta direta) e Parar.
  - O histórico da conversa fica no servidor (`/data`), não só no `localStorage`.
- **Direita:**
  - uso das contas Claude (5h/semana);
  - provedores do OmniRoute (estado, cotas em barras, "limitado até");
  - saúde do combo em uso (qual modelo respondeu, fallbacks);
  - orçamento de tokens da tarefa;
  - tokens que saíram do Claude para outros modelos (economia).
- Reaproveitar a lógica de aprovação e streaming de `chat.ts` (`parseOmniRouteStreamEvent` em `chat-stream.ts`).

### P5. Verificação e entrega
- typecheck, vitest, `claude plugin test` (mod).
- Revisão independente do diff pelo combo `revisor` (via `cerebro_consultar`) e pelo `revisor-seguranca`, porque há montagem de disco, escrita de arquivo e execução de comando.
- `npm run docker:up`; testar no navegador:
  1. um pedido simples;
  2. um pedido com leitura e escrita aprovada num workspace fora do Habblaud;
  3. recarregar a página no meio da tarefa e confirmar que ela continuou;
  4. derrubar um provedor (combo inexistente) e ver o failover chegar ao local.
- Commit no `feat/jarvis-gerente` (executores não commitam; o coordenador confere o diff).
- `cerebro_registrar` (entrega) e atualizar `SINONIMOS` se surgir um termo novo.

---

## 5. Armadilhas desta sessão
- **Git Bash converte caminhos** como `/api/...` em argumentos (vira `I:/Git/Git/api/...`). Rode scripts Node pelo PowerShell ou por `cmd //c`.
- **Não há Python** na máquina. Use Node ou a ferramenta Edit.
- **O classificador bloqueia `rm`** de arquivo sem commit: mova para `I:\Cerebro\backups\…`.
- **Os testes do mod rodam pelo próprio Claude Code:**
  - `…\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe plugin test`, dentro de `mod/habblaud`;
  - o vitest não os inclui.
- **O plugin instalado é uma cópia** em `plugins/cache/…/0.4.0`: editar o repositório não muda o que está carregado. Copie o arquivo ou reinstale (`npm run mod:install`).
- **No Docker, `/workspace` é a própria pasta do Habblaud** (rw): o agente pode editar o código do próprio Habblaud.
- **O container roda código sem commit.** Checkout ou reset desfaz tudo.
- **Chave do OmniRoute:**
  - nos scripts, ler de `profiles/omniroute/settings.json` (`env.ANTHROPIC_AUTH_TOKEN`) sem imprimir;
  - no container, vem de `OMNIROUTE_TOKEN` (override, fora do git).
- Script de teste dos combos: `C:\Users\sam_1\AppData\Local\Temp\claude\I--extensaonavegador\3a92b650-…\scratchpad\testa-combos.mjs`. Uso: `node testa-combos.mjs orquestrador codigo …`. Pode sumir junto com a pasta temporária; se sumir, recrie a partir da descrição na seção 1.

## 6. Ações do usuário em aberto
- **Conta Claude esgotada no OmniRoute:** o failover cobre. Para usar o Claude de novo, esperar a janela ou revisar a conexão no painel do OmniRoute.
- **Copilot Free bloqueado até 01/11.**
- **Riscos de segurança do handoff anterior continuam:** Ollama exposto na rede e Supabase em 0.0.0.0.
