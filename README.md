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
| `bun test`                                               | Todas as suítes                                 |
| `bun run test:unit`                                      | Testes de unidade (sem infraestrutura)          |
| `bun run test:integration`                               | Testes de integração (PostgreSQL real)          |
| `bun run test:concurrency`                               | Paralelismo real, inclusive 3 processos         |
| `bun run test:resilience`                                | Processos reais mortos (SIGKILL) e recuperação  |
| `bun run migrate:up` / `migrate:down` / `migrate:status` | Migrations (reversíveis, uma por vez no `down`) |
| `bun run sqs:bootstrap`                                  | Cria as filas no emulador                       |

## Testes

Os testes de integração rodam contra o PostgreSQL do compose, sem mocks:

```bash
docker compose up -d postgres
bun run test:integration
```

Cada suíte cria e migra um banco descartável próprio (`wagering_test_<suite>`), então os testes não dependem de limpeza nem interferem nos dados de desenvolvimento.

Os testes de concorrência (`bun run test:concurrency`) disparam requisições realmente paralelas contra uma instância e contra **3 processos independentes** (`bun src/main.ts`) que compartilham apenas o PostgreSQL. Cobrem: a mesma aposta 50× em paralelo (um único débito), o cenário obrigatório de duas apostas de `80.00` sobre `100.00`, uma hot wallet com 30 apostas concorrentes e wallets independentes em paralelo. Todos terminam verificando `saldo == saldo reconstruído pelo ledger`.

Os testes de resiliência (`bun run test:resilience`, exigem `docker compose up -d postgres sqs`) sobem processos reais da aplicação com `FAULT_INJECTION` e os matam com SIGKILL em pontos exatos: logo após reservar eventos da outbox e logo após publicar sem marcar. Outra instância assume e publica tudo; a duplicata é descartada pela deduplicação por `eventId`. `FAULT_INJECTION` é recusado quando `NODE_ENV=production`.

## API

| Método e rota                            | Descrição                                                          |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `POST /wallets`                          | Cria a wallet; saldo inicial > 0 gera OPENING + CREDIT no ledger   |
| `GET /wallets/:walletId`                 | Estado atual da wallet                                             |
| `GET /wallets/:walletId/ledger`          | Ledger paginado (`?limit=1..100`, padrão 50; `cursor` opaco)       |
| `POST /wallets/:walletId/reconciliation` | Compara saldo armazenado com o ledger; divergência não é corrigida |
| `GET /health/live`                       | Liveness (sem autenticação)                                        |

```bash
curl -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

Erros têm sempre o formato `{ "error": { "code", "message", "retryable" } }`: `400` contrato inválido, `404` inexistente, `409` conflito, `503` falha transitória (com `Retry-After`), `500` erro inesperado.

## Configuração

Variáveis de ambiente são validadas na inicialização (zod); valores inválidos impedem o boot e todos os erros são listados de uma vez. Veja `.env.example`.

`APP_ROLES` define quais papéis a instância executa (`api`, `consumer`, `outbox`, `pending`). Por padrão, todos.

- `outbox`: publica os eventos da outbox em `wagering-events.fifo` (`MessageGroupId = walletId`, `MessageDeduplicationId = eventId`). Lotes reservados por lease (`FOR UPDATE SKIP LOCKED`), então várias instâncias publicam em paralelo sem repetir trabalho; falhas são retentadas com backoff exponencial, sem limite (nenhum evento confirmado é descartado).
