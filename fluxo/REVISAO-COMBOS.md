 120 s + hedging 60 s | 1× | 120 s + hedging 60 s | 1× | 120 s + hedging 60 s | 1× |# Revisão dos combos do OmniRoute — 2026-10-20

Objetivo: nenhuma tarefa quebra quando um provedor falha; ela segue pela cadeia e termina.

## Onde os combos vivem

- Banco SQLite `C:\Users\sam_1\.omniroute\storage.sqlite`, tabela `combos` (JSON na coluna `data`). Servidor `I:\OMNIROUTE\runtime\node_modules\omniroute` (v3.8.51), porta 20128.
- Alteração feita **pela API de gestão** (`PUT /api/combos/:id`), não no banco, para o servidor recarregar o cache. A API aceita o token local da CLI (`x-omniroute-cli-token`, gerado por `bin/cli/utils/cliToken.mjs`); o token de inferência do perfil não tem escopo `manage` (HTTP 403).
- Fonte única das cadeias agora: `fluxo/aplicar-combos.mjs` (constante `CADEIAS`). Reaplicar: `node aplicar-combos.mjs --aplicar`.

## Backup (antes de qualquer mudança)

`I:\OMNIROUTE\backups\2026-10-20-revisao-combos\`: `storage.sqlite` (VACUUM INTO, 41,8 MB), `combos-antes.json` (26 combos pela API), `settings-antes.json` (sem segredos; a cópia do `.env` foi apagada por conter a chave de criptografia, e o `.env` não foi alterado).
Desfazer: `node aplicar-combos.mjs --restaurar I:\OMNIROUTE\backups\2026-10-20-revisao-combos\combos-antes.json` e `PUT /api/settings/payload-rules` com listas vazias.

## Teste de cada alvo (chamada real `/v1/messages`, `max_tokens` 600, com e sem ferramenta)

Comando: `node testar-combos.mjs --alvos [--extra p/m,...] --json resultados/alvos-*.json`. Coluna "tool" = pedido com a ferramenta `somar` (precisa vir `tool_use` com 17 + 25).

| Alvo | Texto | Ferramenta | Respondeu | Erro |
|---|---|---|---|---|
| `cx/gpt-6-astra-high` | OK 200 · 2,3 s · 115 chars | OK 200 · 3,0 s | gpt-6-astra-high |  |
| `cx/gpt-6-astra-xhigh` | OK 200 · 5,6 s | OK 200 · 2,5 s | gpt-6-astra-xhigh |  |
| `cx/gpt-6-astra-max` | OK 200 · 13,4 s | OK 200 · 10,8 s | gpt-6-astra-max |  |
| `cx/gpt-6-astra-medium` | OK 200 · 26,3 s | OK 200 · 26,4 s | gpt-6-astra-medium | (sob carga) |
| `cx/gpt-6-sol-high` | OK 200 · 1,9 s | OK 200 · 2,0 s | gpt-6-sol-high |  |
| `cx/gpt-6-sol-xhigh` | OK 200 · 28,2 s | OK 200 · 26,7 s | gpt-6-sol-xhigh | (sob carga) |
| `cx/gpt-6-sol-medium` | OK 200 · 2,1 s | OK 200 · 2,3 s | gpt-6-sol-medium |  |
| `cx/gpt-6-luna-high` | OK 200 · 2,6 s | OK 200 · 1,7 s | gpt-6-luna-high |  |
| `cx/gpt-6-luna-medium` | OK 200 · 11,4 s | OK 200 · 11,4 s | gpt-6-luna-medium |  |
| `cx/gpt-5.6-sol-high` | OK 200 · 4,6 s | OK 200 · 2,2 s | gpt-5.6-sol-high |  |
| `cx/gpt-5.5-xhigh` | FALHA 400 · 0,4 s | FALHA 400 | - | gpt-5.5 não suportado em conta ChatGPT |
| `cx/codex-auto-review` | FALHA 400 · 0,0 s | FALHA 400 | - | fora do catálogo do codex |
| `agy/claude-sonnet-4-6` · `antigravity/…` | FALHA 429 · 0,0 s | FALHA 429 | - | cota esgotada, reset em ~5 min (cooldowns de 3–10 s no log) |
| `agy/claude-opus-4-6-thinking` · `antigravity/…` | FALHA 429 · 0,1 s | FALHA 429 | - | idem |
| `agy/gpt-oss-120b-medium` | FALHA 429 · 0,1 s | FALHA 429 | - | idem |
| `agy/gemini-pro-agent` | FALHA 400 · 0,1 s | FALHA 400 | - | saiu do catálogo da Antigravity |
| `agy/gemini-3.8-flash-{high,medium,low}`, `antigravity/gemini-3.8-flash-tiered`, `…/gemini-3-flash`, `…/gemini-3.x-flash-lite` | FALHA 429 · 0,0 s | FALHA 429 | - | as 2 contas em cooldown de **~119 h** |
| `agy/claude-sonnet-4-6-{medium,high}`, `agy/gemini-3.6-flash-low` | FALHA 400 | FALHA 400 | - | fora do catálogo |
| `cc/claude-sonnet-5`, `cc/claude-opus-5`, `cc/claude-sonnet-4-6` | FALHA 401 · 0,0 s | FALHA 401 | - | conexão Claude com token expirado (`invalid_grant`, `is_active=0`) |
| `gh/claude-sonnet-5`, `gh/gpt-5.6-sol`, `gh/gemini-3.1-pro-preview`, `gh/gpt-5.3-codex` | FALHA 429 · 0,0 s | FALHA 429 | - | preflight 100%, reset em **268 h** (2026-11-01) |
| `cheaperinference/*` (gpt-5.6-sol, claude-sonnet-5, deepseek-v4-pro, glm-5.2, gemini-3.1-pro, kimi-k3) | FALHA 402 · 1–2 s | FALHA 402 | - | saldo da carteira zerado |
| `moonshot/kimi-k3`, `kimi-k2.7-code`, `kimi-k2.7-code-highspeed` | FALHA 429 · 0–2 s | FALHA 429 | - | preflight 100%, reset em 5 min (curto: mantido) |
| `ollama-local/orq-qwen:latest` (36B MoE, 24 GB, 60% CPU) | OK 200 · 149 s · **16 chars** | OK 200 · 150 s | orq-qwen | quase todo o orçamento vai para raciocínio |
| `ollama-local/orq-gemma:latest` | OK 200 · 79 s (com carga) | — | orq-gemma |  |
| `ollama-local/gemma4:12b` (reserva, raciocínio desligado) | timeout 200 s / depois OK 193 s · 33 tokens, só texto | OK 200 · 197 s | gemma4:12b | lento só pela GPU disputada (ver abaixo) |

Arquivos: `resultados/alvos-nuvem-1.json`, `alvos-candidatos-1.json`, `alvos-local-1.json`, `alvo-reserva-*.json`.

## O que mudou

**Fora das cadeias** (falha permanente ou cota longa): `cc/*` (reautenticar a conexão Claude no painel e recolocar), `gh/*` (volta em 2026-11-01: recolocar no topo do `executor-copilot`), `cheaperinference/*`, `cx/gpt-5.5-*`, todos os Gemini da Antigravity (119 h) e `gemini-pro-agent` (catálogo). Mantidos com falha curta: Claude/gpt-oss da Antigravity e Kimi (falham em milissegundos quando sem cota, sem custo para a cadeia).

**Cadeias** (ordem GPT → Antigravity → outros → local):

| Combo | Cadeia | Timeout/alvo | Repete cadeia |
|---|---|---|---|
| orquestrador | gpt-6-astra-high > gpt-6-sol-high > gpt-6-luna-high > agy/claude-sonnet-4-6 > agy/claude-opus-4-6-thinking > kimi-k3 > local | 120 s + hedging 60 s | 1× |
| complexo | astra-xhigh > astra-high > sol-xhigh > agy/opus-thinking > agy/sonnet > kimi-k3 > local | 120 s + hedging 60 s | 1× |
| maximo | astra-max > astra-xhigh > sol-high > agy/opus-thinking > kimi-k3 > local | 120 s + hedging 60 s | 1× |
| codigo | sol-medium > luna-high > luna-medium > agy/sonnet > kimi-k2.7-code > local | 60 s | 2× |
| codigo-pesado | astra-high > sol-high > gpt-5.6-sol-high > agy/opus-thinking > agy/sonnet > kimi-k2.7-code > local | 120 s + hedging 60 s | 1× |
| contexto-longo | sol-high > astra-high > agy/sonnet > agy/opus-thinking > kimi-k3 > local | 120 s + hedging 60 s | 1× |
| texto | sol-medium > luna-high > agy/sonnet > kimi-k3 > local | 60 s | 2× |
| analise | sol-medium > sol-high > agy/sonnet > agy/opus-thinking > kimi-k3 > local | 60 s | 2× |
| rapido | sol-medium > luna-high > luna-medium > agy/sonnet > kimi-k2.7-code-highspeed > local | 60 s | 2× |
| compactador | sol-medium > luna-high > agy/sonnet > kimi-k3 > local | 60 s | 2× |
| revisor | agy/sonnet > agy/opus-thinking > sol-high > astra-high > kimi-k3 > local | 120 s + hedging 60 s | 1× |
| revisor-seguranca | agy/opus-thinking > astra-xhigh > **sol-high** > agy/sonnet > **astra-high** > kimi-k3 > local | 120 s + hedging 60 s | 1× |
| aprimorador | agy/opus-thinking > astra-high > agy/sonnet > sol-high > kimi-k3 > local | 60 s | 2× |
| executor-claude | agy/sonnet > agy/opus-thinking > astra-high > sol-high > kimi-k2.7-code > local | 90 s | 1× |
| executor-codex | astra-high > sol-high > gpt-5.6-sol-high > agy/sonnet > kimi-k2.7-code > local | 90 s | 1× |
| executor-antigravity | agy/sonnet > agy/opus-thinking > agy/gpt-oss-120b > sol-high > kimi-k3 > local | 90 s | 1× |
| executor-copilot | sol-high > luna-high > agy/sonnet > kimi-k2.7-code > local | 60 s | 2× |
| gerente-jarvis | **orq-qwen (local, por design)** > astra-high > sol-high > agy/sonnet > kimi-k3 > local | 60 s | 1× |
| processador-privado-local | **só local**: orq-qwen > orq-gemma > gemma4:12b | 90 s | 0× |

`local` = `ollama-local/gemma4:12b`. Exceções à ordem, para preservar a função: `revisor` e `revisor-seguranca` começam fora do GPT (revisão por família diferente do executor GPT); `executor-claude`, `executor-antigravity` e `aprimorador` começam pela Antigravity (Claude), com GPT logo depois. Os aliases ocultos (`exec-*`, `jarvis`, `local-privado`, `seguranca`) apontam para esses combos e herdam tudo.

**Contra travar e contra vazio** (todos os combos):
- `targetTimeoutMs` 60 s (padrão e Jarvis), 90 s (privado) e 120 s nos 10 pesados, que também usam hedging (próximo alvo disparado em paralelo após 60 s; ver seção "Prompt grande"); antes 180–300 s. Falha de nuvem chega em milissegundos; o teto pega alvo pendurado.
- O pior caso da cadeia inteira, somando repetições, fica abaixo de 300 s, que é quando o `fetch` do Node desiste sem cabeçalhos (medido: a rodada 2 perdeu o `processador-privado-local` exatamente em 303 s com 2 × 180 s). Padrão 3 × 60 + 2 × 15 = 210 s; pesados 2 × 90 + 15 = 195 s; Jarvis 2 × (60 + 60) + 15 = 255 s; privado 3 alvos locais × 90 = 270 s.
- `maxSetRetries` 2 (pesados e Jarvis: 1) com `setRetryDelayMs` 15 s: se todos os alvos falharem de uma vez (conta Codex em cooldown de 21–31 s, Antigravity e Kimi sem cota), o combo espera e refaz a cadeia em vez de devolver erro.
- `responseValidation: { minContentLength: 1 }`: 200 sem texto (só raciocínio) cai para o próximo alvo; chamada de ferramenta válida é isenta (regra do próprio OmniRoute).
- Reserva local `gemma4:12b` (mesmos pesos do `orq-gemma`, contexto padrão, cabe nos 12 GB) com raciocínio desligado por payload rule: `PUT /api/settings/payload-rules` → `override: [{ models: [{ name: "gemma4:12b", protocol: "ollama-local" }], params: { reasoning_effort: "none" } }]`. Medido: `reasoning_effort: none` no Ollama 0.40.6 dá 0 de raciocínio (26 tokens de resposta contra 437 com raciocínio); pelo OmniRoute a resposta veio só com bloco de texto, 33 tokens. A regra não toca `orq-qwen`/`orq-gemma`: o Jarvis e o privado continuam começando neles com raciocínio; a reserva só entra no fim das duas cadeias (no privado continua sendo local).
- Configurações globais de resiliência (`comboCooldownWait`, `waitForCooldown`) não foram alteradas.

## Prompt grande (caso relatado por outra sessão)

Relato: `revisor-seguranca` com prompt de ~45 KB e `max_tokens` 6000 deu HTTP 504 em 242 s, "attempted 2", e o `revisor` resolveu o mesmo em 97 s via `gpt-6-sol-high`. Log (19:42–19:44 UTC, `app.log`): Antigravity "0 with quota, skipping" e Kimi "rate limited" foram **pulados antes do envio** (não contam como tentativa); o 6º alvo, naquele minuto, era o alias de reserva ainda fora do catálogo (trocado por `gemma4:12b` às 19:47). Sobraram `astra-xhigh` e `sol-xhigh`, que estouraram 120 s cada sem streaming. O combo não "desistiu cedo": não havia mais alvo utilizável.

Correção nos 10 combos pesados (`orquestrador`, `complexo`, `maximo`, `codigo-pesado`, `revisor`, `revisor-seguranca`, `contexto-longo`, `executor-claude/-codex/-antigravity`): `hedging: true`, `hedgeDelayMs: 60000`, `zeroLatencyOptimizationsEnabled: true` (pré-requisito do hedging no OmniRoute), `fallbackCompressionMode: "off"` (senão o fallback comprimiria o prompt da revisão), timeout por alvo de 120 s. Em `revisor-seguranca` entraram `sol-high` e `astra-high` logo atrás do `xhigh`; em `complexo`/`maximo` um `high` subiu para a 2ª/3ª posição. 180 s por alvo foi testado e descartado: estourou os 300 s do cliente (rodada 8, `executor-claude`).

Teste novo: `node testar-combos.mjs --grande` (prompt de ~45 KB de código de login com SQL injection, segredo padrão, cookie sem httpOnly e redirect aberto; `max_tokens` 6000; combos `revisor-seguranca`, `revisor`, `complexo`, `maximo`, `contexto-longo`, `codigo-pesado`).

| Execução | Resultado |
|---|---|
| `resultados/grande-1.txt` (20:48 UTC) | 6/6 OK, exit 0; `revisor-seguranca` 26 s via astra-xhigh, `maximo` e `contexto-longo` pela reserva gemma4:12b (Codex em cooldown) |
| `resultados/grande-2.txt` (21:06 UTC) | 6/6 OK, exit 0; `revisor-seguranca` 25 s, `maximo` 52 s via astra-max |

Prova do hedging (`prova-falha.mjs`, cenário 4: cadeia e config do `revisor-seguranca` com `orq-qwen` lento na frente): respondeu `gpt-6-astra-xhigh` em 65 s (texto) e 62 s (ferramenta), contra os 120–180 s que o timeout esperaria (`resultados/prova-falha-4.txt`, 8/8 OK, exit 0).

## Prova de falha simulada

`node prova-falha.mjs codigo` cria 3 combos temporários com a cadeia do `codigo` e o 1º alvo quebrado, chama com e sem ferramenta e apaga os temporários.

Com a configuração final (`resultados/prova-falha-3.txt`, 2026-10-20 20:40 UTC, exit 0):

```
2026-10-20T20:40:15.667Z  combo-base: codigo = cx/gpt-6-sol-medium > cx/gpt-6-luna-high > cx/gpt-6-luna-medium > agy/claude-sonnet-4-6 > moonshot/kimi-k2.7-code > ollama-local/gemma4:12b

OK    prova-falha-1-desabilitado txt  1º alvo: cc/claude-sonnet-5
      HTTP 200 em 1738 ms; respondeu gpt-6-sol-medium: Failover é a troca automática para um sistema de reserva quando o sist
OK    prova-falha-1-desabilitado tool 1º alvo: cc/claude-sonnet-5
      HTTP 200 em 1807 ms; respondeu gpt-6-sol-medium: tool_use {"a":17,"b":25}
OK    prova-falha-2-fora-catalogo txt  1º alvo: agy/gemini-pro-agent
      HTTP 200 em 2088 ms; respondeu gpt-6-sol-medium: Failover é a troca automática para um sistema reserva quando o sistema
OK    prova-falha-2-fora-catalogo tool 1º alvo: agy/gemini-pro-agent
      HTTP 200 em 1613 ms; respondeu gpt-6-sol-medium: tool_use {"a":17,"b":25}
OK    prova-falha-3-pendurado    txt  1º alvo: ollama-local/orq-qwen:latest
      HTTP 200 em 61672 ms; respondeu gpt-6-sol-medium: Failover é a transferência automática para um sistema de reserva quand
OK    prova-falha-3-pendurado    tool 1º alvo: ollama-local/orq-qwen:latest
      HTTP 200 em 107441 ms; respondeu gpt-6-sol-medium: tool_use {"a":17,"b":25}

combos temporários restantes: 0
exit=0
```

Na rodada anterior (`prova-falha-2.txt`, mesmo resultado 6/6), o log do OmniRoute mostra, no cenário 3, a cadeia inteira falhando (qwen cortado aos 15 s, conta Codex em cooldown de 21 s, Antigravity e Kimi sem cota, gemma cortado) e então `All targets failed — retrying set (1/2)` → `cx/gpt-6-sol-medium` respondeu. Antes da repetição de cadeia, a mesma situação devolveu **HTTP 504 em 30 s** (`resultados/prova-falha-1.txt`). Prova ao vivo extra: nas rodadas de combos, o `gerente-jarvis` teve o qwen frio cortado aos 90 s e terminou pelo GPT.

## Rodadas do teste de combos

Comando: `node testar-combos.mjs --json resultados/combos-rodada-N.json` (21 combos visíveis; os de código/execução também com ferramenta: 29 chamadas). Sai com código ≠ 0 se algum falhar ou vier vazio.

| Rodada | Configuração | Resultado |
|---|---|---|
| 1 (19:39 UTC) | cadeias novas, reserva ainda orq-qwen, sem repetição | Resumo: 29/29 OK |
| 2 (20:06) | reserva gemma4:12b, repetição de cadeia, timeouts 120 s | Resumo: 28/29 OK; falharam: processador-privado-local (privado: `fetch failed` aos 303 s → levou ao limite de 300 s) |
| 3 (20:11) | idem | Resumo: 13/29 OK; falharam: maximo, maximo[tool], processador-privado-local, revisor-seguranca, compactador, aprimorador, executor-claude, executor-claude[tool], executor-codex, executor-codex[tool], executor-antigravity, executor-antigravity[tool], executor-copilot, executor-copilot[tool], gerente-jarvis, gerente-jarvis[tool] (OmniRoute caiu às 20:11 UTC, ver armadilhas) |
| 4 (20:19) | timeouts 60/90 s | Resumo: 26/29 OK; falharam: processador-privado-local, gerente-jarvis, gerente-jarvis[tool] (qwen local travado; conta Codex em cooldown) |
| 5 (20:25) | idem | Resumo: 29/29 OK |
| **6 (20:31)** | **final**: Jarvis e privado com reserva local; teste com paralelismo 2 | **Resumo: 29/29 OK** |
| **7 (20:36)** | **final** | **Resumo: 29/29 OK** |

Rodadas 6 e 7 seguidas, ambas com código de saída 0, **com a configuração anterior ao hedging** (pesados a 90 s, sem disparo paralelo). Na 6, a conta Codex entrou em cooldown no meio e `texto`, `analise`, `rapido`, `maximo`, `revisor-seguranca` e `gerente-jarvis` terminaram pela reserva `gemma4:12b` (33–114 s, todas com texto); o `processador-privado-local` terminou pelo `orq-gemma` em 139 s. Saída completa em `resultados/combos-rodada-6.txt` e `-7.txt`.

Mapa atualizado depois das rodadas: `node I:/Cerebro/rotas-modelo.mjs` (2026-10-20T20:43 UTC) gravou `I:/Cerebro/dados/omniroute-mapa.json`; texto: `cx/gpt-6-luna-low`, `analise`, `texto`, `rapido`, `auto/*` ok, Gemini da Antigravity off (429); visão: `rapido`, `cx/gpt-6-luna-low`, `analise` ok, o resto off (gh 267 h, cxa 503 sem transporte, cinf 402, zc ENOENT, cfp sem navegador, ddgw 429).

Depois do hedging (configuração final):

| Rodada | Resultado |
|---|---|
| 8 (20:57 UTC, pesados a 180 s) | 27/29: `executor-claude` passou dos 300 s do cliente (→ timeout baixado para 120 s); privado 504 em 270 s (Ollama disputado) |
| 9 | não executou (`node` não encontrado naquele instante; exit 127) |
| 10 (21:08, final) | 27/29: `processador-privado-local` 504 em 180 s e `gerente-jarvis`[tool] 504 em 225 s, ambos no local |
| 11 (21:13, final) | **0/27 OK nas 27 chamadas concluídas; interrompida por mim antes das 2 últimas**: saturação total, ver abaixo |

**As duas rodadas verdes seguidas com a configuração final NÃO foram obtidas.** A partir de ~21:10 UTC, `I:CarecaBrain_ferramentaseferencias-ui-descrever.mjs --paralelo 3` (outra sessão, rodando desde 20:15 UTC) passou a manter a conta Codex única em cooldown contínuo de ~30 s (descrição de imagens em massa via `cx/gpt-6-luna-low`) e a encher a fila do Ollama no mesmo `gemma4:12b` (visão local, chamada direto no Ollama); `teste-busca.mjs` disputava também. Antigravity e Kimi seguiam sem cota. Uma chamada de 30 tokens direto ao Ollama não voltou em 60 s. Nesse estado não há provedor livre: os combos percorreram a cadeia, repetiram e devolveram 504 em 210–270 s, abaixo dos 300 s do cliente (não penduraram), mas sem resposta. Pendente: rodar `node testar-combos.mjs` duas vezes e `node testar-combos.mjs --grande` quando esse job terminar.

## Armadilhas encontradas (para quem vier depois)

- **Trabalho em massa e combos interativos disputam a mesma conta Codex e a mesma GPU.** A regra "trabalho em massa vai por script, GPT primeiro" faz um job de imagens derrubar todos os combos interativos enquanto roda. Precisa de outra conta/provedora para o lote, ou limite de ritmo no script do lote.
- **Conta Codex única**: um 429 em qualquer modelo `cx/*` (ex.: `gpt-6-luna-low`, usado por outra sessão no mapa de visão) marca a conta inteira em cooldown por 21–34 s. Por isso a repetição de cadeia é necessária mesmo com 3 variações de GPT.
- **Antigravity**: `agy/` e `antigravity/` são o mesmo pool (as duas contas); repetir o modelo com os dois prefixos não dá redundância.
- **Ollama disputado**: durante a revisão, `teste-busca.mjs` (outra sessão) mandava ~5 req/s de embedding ao `bge-m3` e outra sessão testava o Jarvis em `/api/chat`; os modelos grandes eram descarregados e recarregados em 90–170 s, chamadas locais levaram até 5 min e devolveram 500. Com isso a reserva local e o `processador-privado-local` ficam lentos ou falham; a nuvem não é afetada.
- O OmniRoute caiu às 20:11 UTC (17:11 local; sem log de erro, morte externa do processo) e o vigia subiu de novo às 20:13 UTC: a rodada 3 perdeu 16 chamadas por `fetch failed`. Não é falha de combo.
- `/v1/models` lista `codex-auto-review` sem prefixo, mas o modelo saiu do catálogo do Codex (400). Não é combo (não está na tabela `combos`); ficou como está.
- `rotas-modelo.mjs` sonda com `max_tokens: 20`: em modelo com raciocínio isso pode voltar vazio (abaixo de 256 o OmniRoute trata como sonda e não amplia o orçamento). Não alterei (arquivo do `I:\Cerebro`).

## O que falta do lado do usuário

- Reautenticar a conexão Claude (`cc`) no painel do OmniRoute; depois recolocar `cc/claude-*` nas cadeias em `aplicar-combos.mjs` e reaplicar.
- Depois de 2026-11-01, recolocar `gh/*` no `executor-copilot`.
- Se a GPU continuar disputada (embeddings em rajada + Jarvis), o `processador-privado-local` fica lento (139 s medido) ou pode estourar 270 s; ele não sai do PC por regra, então a saída é aliviar o Ollama, não mudar o combo.
- Recarregar saldo da `cheaperinference` se quiser essa provedora de volta.
- As descrições dos combos no painel ainda citam a ordem antiga (só texto; não afeta o roteamento).
