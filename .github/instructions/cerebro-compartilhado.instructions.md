---
name: "Cérebro compartilhado"
description: "Memória consolidada de projetos: consultar antes, registrar aprendizado verificado depois, em toda IA."
applyTo: "**"
---

# Memória compartilhada dos projetos

O Cérebro (`I:/CarecaBrain/CarecaBrain`) é a base consolidada de conhecimento do usuário, comum a todas as IAs. O VS Code é a central de trabalho. A ponte MCP está disponível no VS Code, Codex, Antigravity e Claude. O OmniRoute fornece modelos; não é a memória e não intercepta chats.

## Ao iniciar e retomar trabalho

1. Identifique o projeto pelo workspace e pelo pedido. Use `cerebro_buscar` com a tarefa e o projeto; depois `cerebro_rotear` para identificar processos e especialistas existentes.
2. Leia as notas relevantes com `cerebro_ler_nota`. Reaproveite decisões, padrões, código e aprendizados antes de propor algo novo. Confira a data e as evidências; registros podem estar desatualizados. Não pergunte de novo o que a base já responde.
3. Em qualquer sessão (VS Code, Codex, Antigravity ou Claude), use os agentes existentes conforme o escopo: `direcionador` para triagem, `pesquisador` para contexto, `executor` para implementação, `revisor` para validação independente e `seguranca` para riscos. O agente `omniroute` coordena. Delegue tarefas independentes com arquivos e critérios claros; evite que dois agentes editem o mesmo arquivo. Os especialistas dos 18 departamentos continuam disponíveis pelo roteador.
4. Inclua nas delegações o projeto, as notas relevantes, decisões anteriores e o resultado esperado. Peça ao subagente aprendizados candidatos com evidência; o agente principal consolida uma vez após revisar.

## Seleção de especialistas e modelos

- Passe a `cerebro_rotear` uma descrição concreta com projeto, domínio, stack e tipo de trabalho. Os resultados são candidatos ranqueados, não uma ordem automática: confira `tipo`, `setor` e `faz` contra o pedido; descarte correspondências genéricas ou de outro domínio. Termos ambíguos como “entrega”, “integração” e “roteamento” não devem sobrepor evidência explícita do domínio.
- O GPT/orquestrador continua gerente e responsável pela decisão. Para consulta de modelo via `cerebro_consultar`, escolha o combo pela entrega: código/debug/testes → `codigo` ou `codigo-pesado`; revisão → `revisor`; segurança → `seguranca`; pesquisa/análise → `analise` ou `contexto-longo`; texto → `texto`; arquitetura difícil → `complexo` ou `maximo`; tarefa simples → `rapido`; dado sensível → `local-privado`.
- Implementação usa `executor` junto ao especialista do domínio; revisão independente usa `revisor`; envolva `seguranca` em autenticação, dados, rede, arquivos, dependências, segredos ou IA. OmniRoute consulta modelos; as ferramentas e alterações continuam sob o agente da sessão atual.

## Ao concluir uma etapa ou antes de encerrar

Use `cerebro_registrar` quando houver conhecimento reutilizável verificado. Informe `projeto`, `origem` (ex.: vscode-codex), `id` estável da sessão/etapa, `tipo` (decisao/aprendizado/entrega), `titulo`, `resumo` e `evidencias` (arquivos, testes, decisão explícita do usuário). Registre objetivo, decisão e motivo, o que foi validado e pendências relevantes. Busque antes para evitar duplicatas.

Exemplo: “O projeto Aurora usa fuso America/Sao_Paulo no faturamento porque o usuário confirmou essa regra; teste X validou a virada do dia.” Não registre “a IA sugeriu usar UTC” como decisão aprovada. Hipóteses e rascunhos não viram fatos. Correções geram nota nova citando e substituindo explicitamente a anterior; nunca apague histórico ou renomeie notas.

As notas são salvas em `conhecimento/sessoes-compartilhadas/` e encontradas imediatamente por todos os clientes conectados. Conhecimento de projetos antigos continua no mesmo vault, acessível pela busca. Não copie transcrições completas. Nunca grave chaves, tokens ou segredos. Dados sensíveis permanecem locais; envie a modelos somente o contexto necessário e autorizado.

## Acesso e limites

Preferir MCP `cerebro`. Se a sessão ainda não carregou o MCP, usar:

```
node I:/Cerebro/cerebro-cli.mjs cerebro_buscar "projeto e tarefa"
node I:/Cerebro/cerebro-cli.mjs cerebro_rotear "tarefa"
node I:/Cerebro/cerebro-cli.mjs cerebro_registrar --arquivo caminho-do-resumo.json
```

Respeite as permissões e instruções do ambiente; não contorne aprovação. Indisponibilidade deve ser relatada, sem fingir que consultou ou registrou. Perguntas triviais não exigem chamada de modelo, delegação ou nota. `cerebro_consultar` consulta um combo OmniRoute quando útil; não executa ferramentas. Os agentes do chat realizam as ações e mantêm suas permissões. A configuração não muda automaticamente o modelo de todos os chats. Navegadores e ambientes isolados sem acesso local precisam de conector próprio.

Este é aprendizado por memória externa compartilhada, sem retreinamento dos modelos. O registro depende do agente seguir este ciclo e chamar a ferramenta; não há captura invisível de todos os aplicativos.
