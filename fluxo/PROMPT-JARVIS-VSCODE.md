# Prompt para colar no Claude Code (VS Code, perfil omniroute)

Copie tudo o que estiver entre as linhas `=====`. O plano já está aprovado: o agente só para em decisão importante.

=====
Tarefa: montar o JARVIS deste PC conforme o plano aprovado em I:\OMNIROUTE\fluxo\PLANO-JARVIS.md (leia inteiro antes de começar). São duas frentes: (A) Jarvis Voz com o OpenJarvis e (B) Jarvis gerente dentro do Habblaud, com janela de conversa. Use o fluxo multiagente: você (orquestrador) coordena e delega; o revisor é sempre de provedora diferente de quem executou; o debate tem no máximo 2 rodadas.

Quando parar e me perguntar (só nestes casos): achado de risco alto ou crítico na auditoria; chave ou senha que só eu posso colocar; apagar ou desativar algo meu; divergência entre agentes sem consenso; erro que persistiu depois de 2 abordagens e da delegação. No resto, siga e me mostre a evidência.

Regras fixas:
- Antes de cada etapa, diga em uma frase o que vai fazer; depois, mostre a evidência (saída do comando ou teste).
- Tudo local. Nunca me peça senha nem chave em campo de navegador; diga o NOME da variável e onde colocar, e eu coloco.
- Comando falhou: leia o erro inteiro, explique a causa em português simples e tente UMA correção diferente. Se falhar de novo, delegue o diagnóstico ao executor-codex com o erro exato e o que já tentou. Nunca repita o mesmo comando sem mudar nada.
- Não instale Node nem Git (já existem: I:\Node.JS v24.15 e I:\Git). Use `npm.cmd` (npm.ps1 é bloqueado).
- Nunca rode `jarvis tunnel`, não ligue canais (WhatsApp, Telegram etc.), não instale o app desktop (Tauri) e não ative atualização automática.
- O código baixado só é executado depois de passar pela auditoria da etapa A2.
- I:\Jarvis (Jarvis antigo) não é alterado; só o atalho de inicialização sai (etapa A10).

FRENTE A — Jarvis Voz (OpenJarvis)

A1. Clone https://github.com/open-jarvis/OpenJarvis em I:\OpenJarvis (NÃO em "jarvis": no Windows colide com I:\Jarvis) e grave o hash do commit em I:\OpenJarvis\COMMIT-INSTALADO.txt.

A2. Auditoria em paralelo, sem executar nada do repositório:
   - agente seguranca: pyproject.toml e uv.lock (dependências fora do PyPI ou URLs estranhas), frontend/package.json e lockfile (scripts de pós-instalação, `hasInstallScript`), scripts de instalação e onde o código faz chamadas de rede.
   - agente revisor: confira as conclusões e procure o que passou.
   Consolide numa tabela. Só pare se houver risco alto ou crítico.

A3. Instale o uv: `winget install -e --id astral-sh.uv`. Grave no ambiente do usuário UV_CACHE_DIR=I:\uv-cache, UV_PYTHON_INSTALL_DIR=I:\uv-python e HF_HOME=I:\hf-cache. Abra um terminal novo. Em I:\OpenJarvis rode `uv sync --locked --extra desktop --extra voice`, deixando o uv escolher o Python entre 3.10 e 3.13 (nunca 3.14; não use I:\Python311). Se faltar dependência de compilação, siga https://open-jarvis.github.io/OpenJarvis/getting-started/installation/

A4. Configure, nesta ordem:
   - `uv run jarvis _bootstrap --write-config --engine ollama --model orq-qwen:latest` (o modelo local que já fica carregado; NÃO baixe o gemma4:e4b)
   - `uv run jarvis config set analytics.enabled false`
   - `uv run jarvis config set security.profile personal`
   - `uv run jarvis config set speech.voice_id pf_dora`
   - `uv run jarvis config set speech.language pt`
   - `uv run jarvis config set speech.model small`
   - `uv run jarvis config set speech.device cpu`
   - `uv run jarvis config set speech.compute_type int8`
   Mostre o config.toml final, sem segredos.

A5. Valide tudo local: `uv run jarvis doctor` (corrija o que ele apontar), `uv run jarvis ask "Em uma frase, quem é você?"` e me peça para testar `uv run jarvis chat --voice`. Se o Kokoro reclamar do espeak, instale com `winget install -e --id eSpeak-NG.eSpeak-NG` e grave PHONEMIZER_ESPEAK_LIBRARY="C:\Program Files\eSpeak NG\libespeak-ng.dll" com setx.

A6. Motor pelo OmniRoute (executor-codex faz, revisor revisa):
   - `engine.default lmstudio`, `engine.lmstudio.host http://127.0.0.1:20128` e modelo `gerente-jarvis` (Qwen local primeiro, nuvem só se o Ollama cair). A chave vai em LMSTUDIO_API_KEY: me diga onde colocar e espere.
   - Persona do Jarvis em pt-BR com o roteamento:
     - código: executor-codex
     - análise e pesquisa: executor-antigravity
     - texto e raciocínio fino: executor-claude
     - VS Code/Copilot: executor-copilot
     - dado sensível: processador-privado-local
     - revisão: revisor
   - A confirmação de ferramentas continua ligada (`enforce_tool_confirmation`).
   - Ligue o MCP do Cérebro (comando: I:/Node.JS/node.exe I:/Cerebro/mcp.mjs) em [tools.mcp].
   - Teste `jarvis ask` e confirme no OmniRoute qual modelo respondeu. Se o motor lmstudio falhar, volte para o Ollama (`orq-qwen`) e me avise.

A7. Interface web: em I:\OpenJarvis\frontend rode `npm.cmd ci` e `npm.cmd run build`. Depois, em I:\OpenJarvis, rode `uv run jarvis start`. Confirme que ele escuta só em 127.0.0.1:8000.

A8. jarvis-show (executor-codex constrói, revisor revisa):
   - `I:\OpenJarvis\jarvis_show.py` e `I:\OpenJarvis\jarvis-show.cmd`. Ele escuta o microfone (sounddevice) e detecta DUAS palmas seguidas: pico acima de JARVIS_CLAP_THRESH, intervalo de 0,15 a 0,8 s, com período de espera depois de disparar.
   - Ao detectar: toca voz\assets\jingle.mp3 se existir, abre o Habblaud na conversa do Jarvis (https://habblaud.localhost/#jarvis; até a frente B ficar pronta, http://127.0.0.1:8000) e inicia `uv run jarvis chat --voice`.
   - Lê JARVIS_MIC e tem a opção `--listar-mics`.
   - Sem rede. Testes com áudio sintético: palma dupla dispara; palma simples, fala e ruído contínuo não disparam.
   - Me explique como ajustar a sensibilidade.

A9. VS Code: crie as tarefas "Jarvis: perguntar" (pede o texto e roda `uv run --project I:\OpenJarvis jarvis ask "<texto>"`) e "Jarvis: voz" (jarvis-show), com um atalho que não colida com os existentes.

A10. Mova o atalho "Jarvis.lnk" da pasta Inicializar para I:\Jarvis\_inicializacao-desativada\ (já aprovado; não apague nada).

FRENTE B — Jarvis gerente no Habblaud (C:\Users\sam_1\habblaud, sobe com `npm.cmd run docker:up`)

Leia antes:
- a seção 5 do plano e o README do Habblaud;
- client/src/ui/chat.ts (OmniChatPanel), client/src/ui/index.ts, server/http/omniroute.ts, server/http/agent-runtime.ts e server/http/agent-memory.ts;
- o worktree .claude/worktrees/vscode-session-bridge (código sem commit de outra sessão).
Reaproveite o que existe. Trabalhe num branch `feat/jarvis-gerente`, com commits pequenos e testes (npm.cmd test, npm.cmd run typecheck).

B1 (H5). Atualize as listas de combos (cliente COMBOS e servidor OMNIROUTE_COMBOS) para os combos atuais do OmniRoute: orquestrador, jarvis, aprimorador, executor-claude, executor-codex, executor-antigravity, executor-copilot, codigo, codigo-pesado, revisor, revisor-seguranca, complexo, maximo, analise, contexto-longo, texto, rapido, processador-privado-local. Remova direcionador e orq-*.

B2 (H1). Personagem Jarvis:
   - gerente fixo numa sala "Diretoria", com roupa de gerente e crachá "Gerente";
   - aparece sempre, mesmo sem nenhuma sessão aberta;
   - balão com o que está fazendo, ligado ao job atual;
   - aparece na lista lateral;
   - o sprite segue o estilo dos que já existem.

B3 (H2). Clique no Jarvis abre a janela de conversa estilo Claude:
   - lista de conversas (histórico persistente em /data);
   - mensagens com markdown e resposta em tempo real;
   - etiqueta de combo e modelo;
   - cartões Aprovar/Recusar (com motivo) e Decidir (2 a 4 opções, com recomendação);
   - botão parar, seletor de projeto e tecla `J`.
   Os outros funcionários continuam abrindo a gaveta de sempre. Teste no navegador (resize mobile e desktop).

B4 (H3). Cérebro do Jarvis no servidor:
   - o chat do Jarvis usa `/api/omniroute/run` com o combo `gerente-jarvis` (Qwen LOCAL). Conversa e triagem vão com `reasoning_effort: "none"` (resposta em ~1 s, já medido); só o planejamento liga o raciocínio. Mantenha o prompt do Jarvis enxuto (poucos milhares de tokens): o OmniRoute corta em 110 s a espera pelo 1º byte;
   - fluxo: pedir briefing ao aprimorador → plano → consultar os executor-* certos → revisor de outra provedora debate (máx. 2 rodadas) → resposta;
   - decisão importante vira cartão Decidir; nunca decide por mim o que for importante.

B5 (H4). Despachante no PC, `I:\OMNIROUTE\fluxo\despachante.mjs` (Node, sem dependências):
   - escuta só em 127.0.0.1, porta livre; exige token próprio (gerado na primeira execução, guardado em arquivo com acesso só do usuário; o Habblaud recebe por variável de ambiente que EU coloco no docker-compose.override.yml);
   - aceita só pastas de projetos registrados (lista em I:\OMNIROUTE\fluxo\projetos.json);
   - executa só comandos fixos: `claude -p` no perfil omniroute com `--agents`/agente executor-* e `codex exec` com o perfil padrão; nada de shell livre;
   - só despacha depois do Aprovar no chat e registra tudo em I:\OMNIROUTE\fluxo\logs\despachante.log;
   - as sessões filhas rodam com FLUXO_APRIMORAR=0 (o pedido já chega aprimorado; evita custo dobrado e recursão) e com FLUXO_ANTILOOP ligado;
   - a sessão aberta tem que aparecer no Habblaud como funcionário.
   O agente revisor-seguranca revisa antes de ligar. Inicialização automática pela pasta Inicializar.

B6 (H6). Revise o worktree vscode-session-bridge (revisor-seguranca + revisor), corrija o necessário, rode os testes e integre ao branch.

B7 (H7, fase 2). Botão de microfone na janela do Jarvis usando a fala local do OpenJarvis (adicione a origem do Habblaud aos CORS do OpenJarvis). Se ficar complexo, deixe registrado como próximo passo.

FINAL:
- Resumo do que foi instalado e onde, com o disco medido.
- Os 3 comandos do dia a dia (abrir o Habblaud e falar com o Jarvis; voz por palmas; perguntar pelo VS Code).
- O que ficou pendente.
- Registre o aprendizado verificado no Cérebro com cerebro_registrar (projeto "jarvis-gerente", sem segredos).
=====
