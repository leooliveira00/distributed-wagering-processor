# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de múltiplos provedores de jogos, via HTTP e SQS, mantendo correção financeira sob entregas duplicadas, fora de ordem e concorrentes entre múltiplas instâncias.

> 🚧 Em construção. As decisões técnicas estão (e continuarão sendo) documentadas em `ARCHITECTURE.md`.

## Stack

| Item                                   | Escolha                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| Runtime, package manager e test runner | Bun 1.4.4                                                          |
| Linguagem                              | TypeScript 6 (modo estrito)                                        |
| Framework                              | NestJS 12                                                          |
| ORM                                    | MikroORM 7                                                         |
| Banco                                  | PostgreSQL 18                                                      |
| Mensageria                             | AWS SQS via [MiniStack](https://github.com/ministackorg/ministack) |
| Orquestração local                     | Docker Compose                                                     |

> **Por que MiniStack e não LocalStack?** As imagens atuais do LocalStack exigem `LOCALSTACK_AUTH_TOKEN` (conta) para iniciar. O MiniStack é gratuito, open source (MIT), expõe a mesma API SQS na porta `4566` e é aceito pelo enunciado. A criação de filas usa apenas o AWS SDK, então trocar de emulador (ou usar AWS real) é só trocar o endpoint.

## Pré-requisitos

- Docker com Docker Compose v2
- Bun `>= 1.4.4` (apenas para rodar comandos e testes fora dos containers)

## Subindo o ambiente

```bash
docker compose up -d --build
curl http://localhost:3000/health/live
```

Serviços:

| Serviço    | Porta no host | Função                                                                   |
| ---------- | ------------- | ------------------------------------------------------------------------ |
| `app`      | `3000`        | API HTTP e workers                                                       |
| `postgres` | `55432`       | PostgreSQL (porta alternativa para não conflitar com instalações locais) |
| `sqs`      | `4566`        | Emulador SQS (MiniStack)                                                 |
| `sqs-init` | —             | Cria as filas FIFO e a redrive policy para a DLQ (idempotente)           |
| `migrate`  | —             | Aplica as migrations antes do `app` subir                                |

Filas criadas:

- `wager-transactions.fifo`: entrada de transações (redrive para a DLQ após `SQS_MAX_RECEIVE_COUNT` recebimentos)
- `wager-transactions-dlq.fifo`: dead-letter queue
- `wagering-events.fifo`: eventos de integração publicados pela outbox

## Desenvolvimento local (fora do container)

```bash
bun install
cp .env.example .env
docker compose up -d postgres sqs sqs-init
bun run migrate:up
bun run dev
```

## Comandos

| Comando                                                  | Descrição                                       |
| -------------------------------------------------------- | ----------------------------------------------- |
| `bun run dev`                                            | Sobe a aplicação com hot reload                 |
| `bun run start`                                          | Sobe a aplicação                                |
| `bun run typecheck`                                      | Checagem de tipos (`tsc --noEmit`)              |
| `bun run lint`                                           | ESLint (`strictTypeChecked`)                    |
| `bun run format` / `format:check`                        | Prettier                                        |
| `bun test` / `bun run test:unit`                         | Testes                                          |
| `bun run migrate:up` / `migrate:down` / `migrate:status` | Migrations (reversíveis, uma por vez no `down`) |
| `bun run sqs:bootstrap`                                  | Cria as filas no emulador                       |

## Configuração

Variáveis de ambiente são validadas na inicialização (zod); valores inválidos impedem o boot e todos os erros são listados de uma vez. Veja `.env.example`.

`APP_ROLES` define quais papéis a instância executa (`api`, `consumer`, `outbox`, `pending`). Por padrão, todos.
