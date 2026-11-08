# Padrão de commits

O projeto segue [Conventional Commits](https://www.conventionalcommits.org/pt-br/v1.0.0/), com mensagens em português.

```
tipo(escopo): resumo

Corpo opcional: o porquê da mudança, não o como.

Rodapé opcional (BREAKING CHANGE: ..., Refs: #12)
```

## Tipos

| Tipo | Quando usar |
|---|---|
| `feat` | funcionalidade nova para quem usa |
| `fix` | correção de defeito |
| `refactor` | muda o código sem mudar o comportamento |
| `perf` | melhora de desempenho |
| `test` | testes novos ou ajustados |
| `docs` | só documentação |
| `style` | formatação, sem mudar lógica |
| `chore` | manutenção: dependências, estrutura, ícones |
| `build` | empacotamento da extensão, configuração do Worker |
| `ci` | automação de integração contínua |
| `revert` | desfaz um commit anterior |

## Escopos

Opcionais. Indicam a parte do projeto:

- `extensao`: `src/` (content script, ponte com o player, service worker)
- `popup`: `popup/`
- `servidor`: `server/` (Worker da Cloudflare)
- `icones`: `icons/` e o gerador

`test` e `docs` normalmente vão sem escopo.

## Regras do título

- No máximo **72 caracteres**.
- Resumo em português, no presente: "corrige", "adiciona", "sincroniza"... Pode ser um substantivo quando ficar mais claro ("docs: configuração do servidor").
- Sem ponto final.
- Um assunto por commit: se o título precisa de "e" para juntar duas coisas sem relação, são dois commits.
- Mudança que quebra compatibilidade (protocolo da sala, formato das mensagens) leva `!` depois do tipo e um rodapé `BREAKING CHANGE:` explicando.

## Exemplos

```
feat(extensao): espera durante anúncio de qualquer pessoa da sala
fix(popup): código da sala aceita letras minúsculas
refactor(servidor): repasse usa a API de hibernação
feat(servidor)!: mensagens da sala passam a ter versão

BREAKING CHANGE: extensões antigas não entram em salas novas.
```

## Validação automática

O hook `.githooks/commit-msg` recusa mensagens fora do padrão. Ele é ativado pelo `npm install` (script `prepare`). Para ativar à mão:

```
git config core.hooksPath .githooks
git config commit.template .gitmessage
```

Merges, reverts automáticos e commits `fixup!`/`squash!` passam sem validação.
