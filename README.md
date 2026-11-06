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

> **Por que MiniStack e não LocalStack?** As imagens atuais do LocalStack exigem `LOCALSTACK_AUTH_TOKEN` (conta) para iniciar. O MiniStack é gratuito, open source (MIT), expõe a mesma API SQS na porta `4566` e é aceito pelo enunciado. A criação de filas usa apenas o AWS SDK, então trocar de emulador (ou usar AWS real) é só trocar o endpoint. A suíte `test/integration/sqs/emulator-contract.test.ts` verifica no emulador os 7 comportamentos de SQS dos quais o sistema depende (deduplicação, ordem FIFO, bloqueio de grupo, expiração de visibilidade, `ChangeMessageVisibility(0)`, ack e redrive para a DLQ).
>
> Para usar LocalStack com um token: `LOCALSTACK_AUTH_TOKEN=<token> docker compose -f docker-compose.yml -f docker-compose.localstack.yml up -d` e, em seguida, rode a suíte de contrato. O override foi validado sintaticamente; sem um token disponível, não foi executado contra o LocalStack.

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

Um teste adicional coloca **2 processos consumidores e 1 processo de API** sobre a **mesma wallet**, cada operação entregue duas vezes: 60 apostas de `2.00` sobre `100.00` terminam com exatamente 50 processadas, 10 rejeitadas e saldo `0.00`.

Os testes de resiliência (`bun run test:resilience`, exigem `docker compose up -d postgres sqs`) sobem processos reais da aplicação com `FAULT_INJECTION` e os matam com SIGKILL em pontos exatos: logo após reservar eventos da outbox, logo após publicar sem marcar e **logo após o commit de uma mensagem consumida, antes do ack**. Outra instância assume; o inbox e a deduplicação por `eventId` garantem um único efeito. `FAULT_INJECTION` é recusado quando `NODE_ENV=production`.

Um teste de ponta a ponta (README §13.7) envia pela fila, no mesmo grupo FIFO, **REFUND, ROLLBACK e uma cadeia ROLLBACK → WIN antes das transações que referenciam**, com 1 processo consumidor e **2 processos do worker de pendências**: todas as reversões ficam `PENDING_REFERENCE`, são resolvidas quando a referência chega e a órfã termina `REJECTED / REFERENCE_NOT_FOUND`. Outro teste mata o worker com SIGKILL depois de aplicar o crédito e antes do commit: nada da tentativa sobrevive e outra instância resolve a transação uma única vez.

Os testes de integração do consumidor (`test/integration/sqs`) usam filas FIFO descartáveis com DLQ e redrive próprias e cobrem ack, redelivery, rejeição de negócio, conflito, DLQ imediata, retry com backoff, esgotamento de tentativas e SIGTERM.

## API

| Método e rota                                                             | Descrição                                                                         |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `POST /wallets`                                                           | Cria a wallet; saldo inicial > 0 gera OPENING + CREDIT no ledger                  |
| `GET /wallets/:walletId`                                                  | Estado atual da wallet                                                            |
| `GET /wallets/:walletId/ledger`                                           | Ledger paginado (`?limit=1..100`, padrão 50; `cursor` opaco)                      |
| `POST /wallets/:walletId/reconciliation`                                  | Compara saldo armazenado com o ledger; divergência não é corrigida                |
| `POST /wagering/transactions`                                             | Submete BET, WIN, LOSS, REFUND ou ROLLBACK (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId`                               | Transação pelo id interno                                                         |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Transação pelo id do provedor                                                     |
| `GET /health/live`                                                        | Liveness (sem autenticação)                                                       |

```bash
curl -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"<playerId>","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

| Situação                                       | Status                    |
| ---------------------------------------------- | ------------------------- |
| Processada                                     | `201`                     |
| Aceita, aguardando a transação referenciada    | `202`                     |
| Rejeitada por regra de negócio (`failureCode`) | `422`                     |
| Conflito de idempotência                       | `409`                     |
| Contrato inválido                              | `400`                     |
| Wallet ou transação inexistente                | `404`                     |
| Falha transitória                              | `503` (com `Retry-After`) |

Um reenvio idêntico devolve o mesmo status e corpo, com `idempotentReplay: true` e o saldo observado na primeira vez. Erros têm sempre o envelope `{ "error": { "code", "message", "retryable" } }`; a resposta `422` traz também os dados da transação rejeitada (que fica gravada e auditável).

## Mensageria (SQS)

Mensagens em `wager-transactions.fifo` seguem o envelope abaixo e passam pelo **mesmo caso de uso e pelo mesmo contrato** da API. O `messageId` do envelope é a chave do inbox persistente.

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "...": "mesmos campos do POST"
  }
}
```

| Resultado                                                          | Ação do consumidor                                         |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| Processada, pendente de referência ou rejeitada (inclusive replay) | ack (`DeleteMessage`), somente após o commit               |
| Conflito de idempotência                                           | ack + log                                                  |
| Contrato inválido, JSON malformado ou wallet inexistente           | DLQ imediata, com `deadLetterReason` e `errorCode`         |
| Falha transitória ou inesperada                                    | sem ack; nova tentativa com backoff via visibility timeout |
| Tentativas esgotadas (`SQS_MAX_RECEIVE_COUNT`)                     | DLQ pela redrive policy da fila                            |

Mensagens de um mesmo `MessageGroupId` são processadas em sequência e grupos diferentes em paralelo. Em `SIGTERM`, o consumidor para de receber, conclui as mensagens em andamento por até `CONSUMER_SHUTDOWN_TIMEOUT_MS` e devolve imediatamente as demais à fila.

**Coerência de timeouts:** o processamento de uma mensagem é limitado por `DATABASE_LOCK_TIMEOUT_MS` + `DATABASE_STATEMENT_TIMEOUT_MS` (5 s + 15 s), abaixo do visibility timeout da fila (30 s), e `CONSUMER_SHUTDOWN_TIMEOUT_MS` (10 s) fica abaixo do `stop_grace_period` do container (30 s). Ao alterar qualquer um desses valores, mantenha essas relações.

## Referências pendentes (`PENDING_REFERENCE`)

Uma transação cuja referência ainda não chegou (por exemplo, um REFUND antes da BET) é aceita como `PENDING_REFERENCE` (HTTP `202`) e reprocessada pelo worker de pendências (papel `pending`), com backoff exponencial (README §7.1):

- **Limite:** `PENDING_REFERENCE_MAX_ATTEMPTS` tentativas (padrão 10, a submissão é a 1ª), com atraso de `PENDING_REFERENCE_BASE_DELAY_MS` a `PENDING_REFERENCE_MAX_DELAY_MS` (1 s a 60 s, cerca de 4 min no total). Chegada fora de ordem é questão de segundos; um limite de tentativas é determinístico e testável.
- **Esgotado o limite:** `REJECTED` com `REFERENCE_NOT_FOUND` (a referência nunca chegou) ou `REFERENCE_NOT_PROCESSED` (existe, mas nunca foi aplicada), e o evento `WagerTransactionRejected` é publicado. `attempts` termina igual ao limite.
- **Eventos:** `WagerTransactionPendingReference` na chegada e o resultado final; uma tentativa que continua aguardando não publica nada.
- **Aceleração:** quando uma transação chega a um estado final, as pendências que a referenciam vencem na hora; o worker as resolve no ciclo seguinte (`PENDING_REFERENCE_POLL_INTERVAL_MS`, 500 ms), sem esperar o backoff.
- **Concorrência:** cada tentativa é uma transação SQL: pendência travada com `FOR UPDATE SKIP LOCKED` (várias instâncias nunca pegam a mesma), depois a wallet com `FOR UPDATE`, e as mesmas regras da submissão. Se o processo morrer, o rollback devolve a pendência intacta; não há lease. A aceleração também usa `SKIP LOCKED` e nunca espera lock, o que torna as duas ordens de lock (pendência → wallet e wallet → pendência) livres de deadlock.
- **Relógio:** agendamento e comparação de `next_attempt_at` usam o `now()` do PostgreSQL, imune à diferença de relógio entre instâncias.
- **Falha inesperada** numa tentativa (lock timeout, bug): a pendência é adiada pelo backoff sem contar tentativa, com log de erro e `pending_reference_failures_total`, para não bloquear as demais.

Reenviar uma transação que estava pendente devolve o **estado atual** dela (por exemplo, `201` depois de resolvida), com `idempotentReplay: true`.

## Configuração

Variáveis de ambiente são validadas na inicialização (zod); valores inválidos impedem o boot e todos os erros são listados de uma vez. Veja `.env.example`.

`APP_ROLES` define quais papéis a instância executa (`api`, `consumer`, `outbox`, `pending`). Por padrão, todos.

- `api`: endpoints HTTP.
- `consumer`: consome `wager-transactions.fifo` (veja [Mensageria](#mensageria-sqs)).
- `pending`: reprocessa transações `PENDING_REFERENCE` (veja [Referências pendentes](#referências-pendentes-pending_reference)).
- `outbox`: publica os eventos da outbox em `wagering-events.fifo` (`MessageGroupId = walletId`, `MessageDeduplicationId = eventId`). Lotes reservados por lease (`FOR UPDATE SKIP LOCKED`), então várias instâncias publicam em paralelo sem repetir trabalho; falhas são retentadas com backoff exponencial, sem limite (nenhum evento confirmado é descartado).
