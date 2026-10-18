# Plano: Jarvis local orquestrando as IAs

Data: 2026-10-12 · **Aprovado pelo usuário com as modificações.** Daqui em diante só se para em decisão importante.
Atualizações da aprovação:

- O Jarvis é o **gerente dentro do Habblaud**, com janela de conversa estilo Claude (seção 5).
- A conta Antigravity **gmail tem prioridade** sobre a bcgestao (as duas estão no plano "starter").
- A chave obrigatória no OmniRoute foi autorizada.

## 1. Desenho final

```
                 VOCÊ (palavra final)
          ┌──────────────┴───────────────┐
   VS Code (texto/código)          Voz / palmas (desktop)
   Claude Code, perfil omniroute   OpenJarvis (I:\OpenJarvis)
          └──────────────┬───────────────┘
        JARVIS = combo "gerente-jarvis" (Qwen local, gerente no Habblaud e na voz)
   sessões do VS Code = combo "orquestrador" (nuvem > ... > local, nunca para)
                         │  1. Claude aprimora o pedido (combo "aprimorador")
                         │  2. Jarvis divide e distribui
     ┌────────────┬──────┴──────┬──────────────┬─────────────┐
 executor-claude   executor-codex   executor-antigravity  executor-copilot  processador-privado-local
 (1 Claude)    (1 ChatGPT)  (gmail >          (VS Code,     (dado sensível,
                             bcgestao)         cota mensal)  nunca sai do PC)
     └── cada executor tem failover para os outros e termina no modelo local ──┘
                         │  3. revisor de OUTRA provedora debate (máx. 2 rodadas)
                         │  4. divergência vira opções → você decide
                 Cérebro (memória comum: MCP cerebro)
```

Um cérebro só, com duas portas de entrada:

- **Jarvis Code (VS Code)**: é o fluxo novo do OmniRoute que acabei de montar. Edita arquivos, roda testes e delega para os executores.
- **Jarvis Voz (OpenJarvis)**: ouve em pt-BR, responde falando e ativa com duas palmas. O motor dele é o OmniRoute (combo `gerente-jarvis`), então usa o mesmo modelo local que já está carregado e alcança qualquer IA pelo nome do combo.

**Decisão de 2026-10-12 (após testes):** o gerente LOCAL é o Jarvis (Habblaud e voz, prompt pequeno, resposta em ~1 s). Nas sessões do Claude Code no VS Code o gerente é a nuvem (`orquestrador`), com o local no fim da fila. Motivo: o prompt do Claude Code tem ~50 mil tokens e o OmniRoute corta em 110 s fixos; o Qwen leva ~170 s a frio e o Gemma 12B inventou resposta.

## 2. Análise de segurança do prompt do OpenJarvis

Verificado no código do repositório em 2026-10-12 (open-jarvis/OpenJarvis, organização, Apache-2.0, cerca de 11 mil estrelas, ativo).

| Ponto | Situação | O que o plano faz |
|---|---|---|
| Comandos do prompt (`_bootstrap`, `config set`, `chat --voice`, `start`, extras `desktop` e `voice`) | Existem no código atual | Mantidos |
| `security.profile personal` | Existe: servidor só em 127.0.0.1, modo "redact", sem atalhos de ferramenta | Mantido |
| **Analytics ligado por padrão** | Envia métricas de uso (SO, motor, contagem de turnos, hash do modelo; sem texto da conversa) para um PostHog em `34.231.106.201.sslip.io` | **Desligar** (`analytics.enabled false`), já que você quer tudo local |
| Telemetria | Fica só no PC (`~/.openjarvis/telemetry.db`) | Ok |
| Ferramentas perigosas (`shell_exec`) | Exigem confirmação (`enforce_tool_confirmation = true`) | Manter ligado |
| Servidor web (porta 8000) | 127.0.0.1 por padrão; recusa abrir para a rede sem chave; CORS restrito | Fixar 127.0.0.1 |
| `jarvis tunnel` (cloudflared) | Abriria o Jarvis para a internet | **Nunca rodar**; cloudflared não está instalado |
| Canais (WhatsApp, Telegram etc.) | Desligados por padrão; ligados, uma mensagem remota poderia acionar ferramentas | Manter desligados |
| App desktop (Tauri) | Tem atualização automática de binários | Não instalar; usar só a interface web |
| Cadeia de suprimentos | `uv sync` e `npm install` baixam centenas de pacotes | `uv sync --locked` (hashes fixos), `npm.cmd ci` (lockfile), commit fixado e auditoria antes |
| Pasta "jarvis" | No Windows `I:\jarvis` é a mesma pasta que o `I:\Jarvis` atual | Clonar em **I:\OpenJarvis** |
| winget Node LTS e Git | Você já tem Node 24.15 (I:\Node.JS) e Git; instalar de novo cria conflito de PATH | **Não instalar**; só falta o `uv` |
| `ollama pull gemma4:e4b` (9,6 GB) | Disputaria a placa de 12 GB com o orquestrador | **Não baixar**: usar `orq-gemma`/OmniRoute; e4b só se a voz ficar lenta |
| Whisper | Padrão `float16` falha na CPU; a GPU já está ocupada pelo modelo local | `speech.device cpu`, `compute_type int8`, modelo `small` (melhor em pt) |
| `npm` em script | `npm.ps1` é bloqueado pela política de execução (já aconteceu no Jarvis antigo) | Usar `npm.cmd` |
| Disco C: (80 GB livres) | uv, Python e modelos do HuggingFace iriam para o C: | `UV_CACHE_DIR`, `UV_PYTHON_INSTALL_DIR` e `HF_HOME` no I: |
| Detector de palmas | Escuta o microfone localmente, sem rede | Ok |

**Conclusão:** com essas mudanças não vejo caminho de invasão novo. Os riscos reais estão no que **já existe** no PC:

1. 🔴 **OmniRoute sem chave e com CORS aberto.** Testei: ele aceita `/v1/chat/completions` sem chave e devolve `access-control-allow-origin` para qualquer site. Um site malicioso aberto no navegador pode usar suas contas Claude, GPT e Antigravity em segundo plano. **Correção:** ligar "exigir chave de API" no OmniRoute. Antes eu confiro quais clientes ainda chamam sem chave.
2. 🟠 **Ollama exposto na rede.** Ele escuta em todas as interfaces (`::`), e a regra de firewall "Ollama WSL2" está como `Allow Any`, numa rede marcada como Pública. Quem estiver na mesma rede (192.168.0.3:11434) pode usar e apagar seus modelos. **Correção (você roda, é configuração de segurança do Windows):** restringir a regra à rede do WSL ou desativá-la se não usa WSL.
3. 🟡 **Jarvis antigo com voz e PowerShell livre.** Um vídeo ou chamada dizendo "ei Jarvis, apaga…" conta como ordem direta. Ele está parado desde 2026-09-15, mas o atalho de inicialização continua lá.

## 3. O Jarvis antigo (I:\Jarvis)

- Não será apagado nem sobrescrito: é um repositório git com bastante conhecimento (palavra de ativação, léxico de nomes do vault, busca bge-m3, Kiwix, regra de autorização).
- Parou de funcionar em 2026-09-15 (último log). O atalho `Jarvis.lnk` continua na pasta Inicializar.
- **Proposta (pede sua aprovação):** mover `Jarvis.lnk` para `I:\Jarvis\_inicializacao-desativada\`, para não disputar microfone e GPU com o OpenJarvis. Volta com um clique.
- **Aproveitamento:**
  - Cérebro: o MCP `I:/Cerebro/mcp.mjs` é ligado ao OpenJarvis (ele aceita MCP).
  - A regra "nunca decide sozinho" fica com a confirmação de ferramentas ligada.
  - O léxico de nomes e a palavra de ativação "ei Jarvis" ficam como etapa 2 opcional.

## 4. Etapas

| # | Etapa | Quem faz (fluxo novo) | Precisa de você? |
|---|---|---|---|
| 0 | Blindagem: chave obrigatória no OmniRoute, firewall do Ollama | Jarvis prepara; você executa o comando do firewall | **Sim** |
| 1 | Clonar em I:\OpenJarvis e fixar o commit | orquestrador | não |
| 2 | Auditoria do código baixado (scripts de instalação, pós-instalação do npm, dependências) | `revisor-seguranca` + `revisor`, em paralelo | **Sim: seguir ou parar** |
| 3 | Instalar `uv` (winget), caches no I:, `uv sync --locked --extra desktop --extra voice` | orquestrador | não |
| 4 | Configurar: bootstrap com Ollama `orq-gemma`, perfil personal, analytics desligado, voz pf_dora, pt, Whisper small na CPU | orquestrador | não |
| 5 | Validar 100% local: `doctor`, `ask`, `chat --voice` | orquestrador | testar a voz |
| 6 | Trocar o motor para o OmniRoute (combo `orquestrador`, chave em `LMSTUDIO_API_KEY`) e o roteamento por combo | `executor-codex` + `revisor` | colocar a chave no `.env` |
| 7 | Interface web: `npm.cmd ci`, `npm.cmd run build`, `jarvis start` | orquestrador | não |
| 8 | `jarvis-show` (palmas + jingle + interface + voz) e testes | `executor-codex` constrói, `revisor` de outra provedora revisa | ajustar sensibilidade |
| 9 | VS Code: tarefa "Jarvis: perguntar" e atalho | `executor-codex` | não |
| 10 | Desativar a inicialização do Jarvis antigo | orquestrador | **Sim** |
| 11 | Resumo (instalado, onde, disco, 3 comandos) e registro no Cérebro | `executor-antigravity` | não |

Disco estimado: 4 a 6 GB no I:. Não baixa os 9,6 GB do gemma4:e4b.

## 5. Jarvis gerente dentro do Habblaud

Quase tudo já existe no Habblaud (feito por outra sessão, commit `ad53ebb`):

- a janela de chat `OmniChatPanel`, com seletor de combo e streaming;
- o modo gerente (`/api/omniroute/run`), que lê o projeto, propõe alterações e pede aprovação a cada escrita;
- acesso ao Cérebro.

O que falta construir:

| # | Peça | Como fica |
|---|---|---|
| H1 | **Personagem Jarvis** | Gerente fixo numa sala "Diretoria", com roupa de gerente e crachá. Aparece sempre, mesmo sem sessão aberta, com um balão mostrando o que está fazendo. Também aparece na lista lateral. |
| H2 | **Clique no Jarvis** | Abre a janela de conversa estilo Claude: lista de conversas (histórico salvo em `/data`), markdown, resposta em tempo real, etiqueta de qual IA respondeu, cartões **Aprovar/Recusar** e **Decidir** (2 a 4 opções), botão parar, escolha de projeto e tecla de atalho `J`. Os outros funcionários continuam abrindo a gaveta de detalhes de sempre. |
| H3 | **Cérebro do Jarvis** | O chat usa o combo `gerente-jarvis` (Qwen local; conversa sem raciocínio, ~1 s). O aprimorador refina o pedido, o Jarvis divide e consulta os `executor-*`, o `revisor` de outra provedora debate (máx. 2 rodadas) e o que for importante vira cartão de decisão para você. |
| H4 | **Despachante no PC** (`I:\OMNIROUTE\fluxo\despachante.mjs`) | Quando você aprova "executar", ele abre a tarefa na IA escolhida: Claude Code (perfil omniroute, com o agente `executor-*` certo) ou Codex, na pasta do projeto. A sessão aparece no escritório como funcionário trabalhando, e as permissões continuam pelo "Responder pelo escritório". **Blindagem:** escuta só em 127.0.0.1 com token próprio; aceita só projetos registrados; comandos fixos (nada de shell livre); exige aprovação no chat; registra tudo em log. |
| H5 | **Lista de combos** | Atualizar no cliente e no servidor do Habblaud: sai `direcionador`, entram `aprimorador` e `executor-*`. |
| H6 | **Ponte VS Code e Codex** | Revisar e concluir o worktree `vscode-session-bridge`, que outra sessão deixou sem commit, para as sessões do VS Code e do Codex virarem funcionários. |
| H7 | **Voz no Habblaud** (fase 2) | Botão de microfone na janela do Jarvis usando a fala local do OpenJarvis (127.0.0.1:8000, liberando a origem do Habblaud). As duas palmas abrem o Habblaud direto na conversa do Jarvis. |

Ordem: H5 → H1 → H2 → H3 → H4 → H6 → H7, cada peça com testes e revisor de outra provedora.
