# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de múltiplos provedores de jogos, via HTTP e SQS, mantendo correção financeira sob entregas duplicadas, fora de ordem e concorrentes entre múltiplas instâncias.

Decisões, garantias, trade-offs e limitações estão em [`ARCHITECTURE.md`](ARCHITECTURE.md). Este README cobre setup, comandos, testes, API e uma [demo guiada](#demo-guiada).

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

### Múltiplas instâncias

```bash
docker compose --profile cluster up -d --build --wait
```

Sobe mais dois processos independentes, `app-2` (porta `3001`) e `app-3` (porta `3002`). Cada um roda todos os papéis, e os três compartilham apenas o PostgreSQL e o SQS. Qualquer instância pode receber qualquer requisição ou mensagem, e a consistência vem do banco, não de afinidade. Para derrubar uma instância e ver as outras continuarem: `docker kill wagering-app-2-1`. Para trazê-la de volta, repita o comando acima.

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
| `bun run test:resilience`                                | Processos mortos, quedas de PostgreSQL e SQS    |
| `bun run migrate:up` / `migrate:down` / `migrate:status` | Migrations (reversíveis, uma por vez no `down`) |
| `bun run sqs:bootstrap`                                  | Cria as filas no emulador                       |
| `bun run demo:race`                                      | Duas BETs de 80.00 em paralelo sobre 100.00     |
| `bun run demo:sqs`                                       | A mesma mensagem entregue 2× pela fila          |
| `bun run demo:events`                                    | Lê (e consome) os eventos publicados            |

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

Os testes de resiliência também cobrem o README §3 (_"PostgreSQL e SQS podem ficar temporariamente indisponíveis"_) e o §13.8 (reinício do serviço). Todos rodam com processos reais e infraestrutura real:

- **Queda do PostgreSQL ou do SQS** (`database-outage`, `sqs-outage`): um proxy TCP controlado pelo teste fica entre a aplicação e a dependência e simula dois tipos de queda:
  - **conexões recusadas**, como num banco ou broker reiniciando;
  - **partição de rede**, em que as conexões abertas ficam mudas para sempre, mesmo depois que a rede volta.

  Durante a queda do banco, a API responde `503` com `Retry-After` em poucos segundos, sem travar. Durante a queda do SQS, a API continua respondendo normalmente, porque o SQS não está no caminho síncrono. Nos dois casos, as mensagens não recebem ack, os eventos esperam na outbox e o processo não morre. Depois que a dependência volta, a aplicação se recupera sozinha, e cada operação é aplicada exatamente uma vez.

- **Instância morta sob carga** (`instance-killed-under-load`): 3 processos com todos os papéis recebem carga mista em 4 wallets:
  - BETs e WINs por HTTP;
  - BETs pela fila, cada mensagem entregue duas vezes;
  - ROLLBACKs que chegam antes das BETs que estornam.

  Um dos processos leva SIGKILL num ponto arbitrário da carga, sem injeção de falha. O cliente reenvia as requisições que falharam para os sobreviventes, com a mesma idempotency key.

- **Reinício completo** (`full-restart`): os 3 processos levam SIGKILL ao mesmo tempo, no meio da mesma carga. Ficam para trás mensagens na fila, eventos não publicados e pendências. Um conjunto novo de processos termina todo esse trabalho.

Nesses dois últimos testes, o saldo final de cada wallet é **calculado de antemão**, então qualquer efeito perdido ou duplicado aparece como saldo errado. Os testes também conferem que nada foi para a DLQ, que todo evento confirmado foi entregue e que a reconciliação de todas as wallets dá `consistent: true`.

Os sorteios desses testes (o momento do kill, o processo morto e a ordem das operações) vêm de uma seed impressa na saída. Para repetir uma execução, use `RESILIENCE_SEED=<seed> bun run test:resilience`.

Os testes de observabilidade (`test/integration/observability`) sobem um **processo real** e leem o seu stdout: as linhas são JSON, carregam o contexto da requisição ou da mensagem, nunca repetem uma chave e nunca contêm valores monetários. O `/metrics` é conferido contra o tráfego gerado. Um teste provoca um lock timeout real e confere `db_lock_conflicts_total`, e a readiness é testada com fila inexistente, SQS inalcançável e PostgreSQL inalcançável.

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
| `GET /health/ready`                                                       | Readiness: PostgreSQL e SQS alcançáveis (`200` ou `503`, sem autenticação)        |
| `GET /metrics`                                                            | Métricas no formato Prometheus (sem autenticação; restringir à rede interna)      |

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

**Timeouts no cliente (falhas de rede):** o `statement_timeout` é aplicado pelo servidor e não ajuda quando a rede fica muda. Por isso todo acesso externo também tem um limite no próprio cliente:

- **PostgreSQL:**
  - `DATABASE_CONNECT_TIMEOUT_MS` (5 s) limita a abertura de uma conexão e a espera por uma conexão livre no pool.
  - `DATABASE_QUERY_TIMEOUT_MS` (20 s) limita a espera por uma resposta. Precisa ser maior que o `statement_timeout`, e a conexão que estoura esse limite é descartada do pool.
- **SQS:**
  - `SQS_CONNECT_TIMEOUT_MS` (3 s) limita a abertura da conexão.
  - `SQS_REQUEST_TIMEOUT_MS` (25 s) limita cada chamada. Precisa ser maior que a espera do long polling (`SQS_CONSUMER_WAIT_TIME_SECONDS`).

O zod valida essas relações na inicialização. Uma chamada ao SQS que estoura o limite depois de já ter sido aplicada (o `DeleteMessage`, por exemplo) só faz a mensagem voltar como replay, sem efeito duplicado.

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

## Observabilidade

**Logs** em JSON (pino), uma linha por evento. Cada ponto de entrada abre um escopo de log e **toda** linha escrita dentro dele, em qualquer camada, carrega os campos do escopo: `correlationId`, `messageId` (SQS), `transactionId`, `walletId` e `providerId`.

- HTTP: o header `X-Correlation-Id` é aceito quando bem formado (caso contrário, um novo id é gerado) e sempre devolvido na resposta.
- SQS: o `correlationId` vem do atributo da mensagem ou, na falta dele, do `messageId`.
- Worker de pendências: cada tentativa tem seu próprio `correlationId`.
- **Os logs dizem qual transação ou wallet, nunca quanto:** valores e saldos não são registrados, e campos como `money`, `amount` e `balance` são mascarados como defesa adicional, assim como credenciais e corpos de requisição.

**Métricas** em `GET /metrics` (formato Prometheus). Nenhum label carrega id de wallet, jogador ou transação, para evitar explosão de séries e exposição de dados do jogador.

| Item do §12           | Métricas                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Transações por status | `wager_transactions_total{kind, status, source}` (`source`: `submission` ou `pending-worker`)                                                    |
| Duplicatas detectadas | `wager_idempotent_replays_total{entrypoint}`, `wager_idempotency_conflicts_total{entrypoint, code}`, `sqs_duplicate_messages_total`              |
| Retries               | `sqs_message_retries_total{reason}`, `outbox_publish_failures_total`, `pending_reference_attempts_total{outcome}`                                |
| Mensagens em DLQ      | `sqs_messages_dead_lettered_total{reason}` e `sqs_queue_messages{queue="dead_letter"}` (inclui o que a redrive policy moveu)                     |
| Conflitos de lock     | `db_lock_conflicts_total{reason}` (`lock_timeout`, `deadlock`, `serialization`, `optimistic_version`) e `wallet_lock_wait_seconds{source}`       |
| Outbox lag            | `outbox_pending_events`, `outbox_oldest_pending_age_seconds` e `outbox_publish_delay_seconds`                                                    |
| Latência              | `wager_processing_duration_seconds{entrypoint, outcome}` e `http_request_duration_seconds{method, route, status}` (`route` é o template da rota) |

Também são expostas as métricas padrão do processo (CPU, memória, lag do event loop). Os gauges de estado compartilhado são lidos no momento do scrape e só pela instância responsável: outbox lag no papel `outbox` e profundidade das filas no papel `consumer`. Uma leitura que falha não exporta valor antigo e é contada em `metrics_collection_failures_total`.

**Health checks**, ambos sem autenticação:

- `/health/live`: o processo está de pé. Não consulta dependências, para que uma queda do banco não reinicie todas as instâncias.
- `/health/ready`: `select 1` no PostgreSQL e `GetQueueAttributes` na fila de apostas, em paralelo e com timeout de 2 s cada. Responde `200` ou `503` com `up`/`down` e a latência de cada dependência. Detalhes do erro vão apenas para o log.

Em produção, `/metrics` deve ficar acessível apenas pela rede de monitoramento. OpenTelemetry e dashboard são opcionais no desafio e ficaram fora do escopo.

## Demo guiada

Um roteiro de cerca de 10 minutos que mostra as garantias principais com três instâncias. Use bash (no Windows, o Git Bash); só `curl` e `sed` são necessários. Antes, rode `bun install` uma vez para os scripts `demo:*`.

**1. Três instâncias no ar**

```bash
docker compose --profile cluster up -d --build --wait
for p in 3000 3001 3002; do curl -s localhost:$p/health/ready; echo; done
```

**2. Wallet com saldo inicial: OPENING no ledger** (lido por outra instância)

```bash
PLAYER=$(bun -e 'console.log(crypto.randomUUID())')
WALLET=$(curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" \
  | sed -E 's/.*"id":"([^"]+)".*/\1/')
curl -s localhost:3001/wallets/$WALLET/ledger; echo
```

**3. Idempotência entre instâncias.** Uma função auxiliar envia uma operação para a instância da porta informada:

```bash
bet() {
  curl -s -w '  -> HTTP %{http_code}\n' -X POST "localhost:$1/wagering/transactions" \
    -H 'content-type: application/json' -H "Idempotency-Key: provider-a:$2" \
    -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$2\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"$3\",\"money\":{\"amount\":\"$4\",\"currency\":\"BRL\"}$5}"
}
bet 3000 tx-1 BET 25.00   # 201 PROCESSED, saldo 75.00
bet 3001 tx-1 BET 25.00   # 201, idempotentReplay: true, mesmo saldo (outra instância)
bet 3002 tx-1 BET 30.00   # 409 IDEMPOTENCY_KEY_CONFLICT (mesma key, outro payload)
```

**4. Referência fora de ordem:** o ROLLBACK chega antes da BET.

```bash
bet 3000 rb-2 ROLLBACK 10.00 ',"referenceExternalTransactionId":"tx-2"'   # 202 PENDING_REFERENCE
bet 3001 tx-2 BET 10.00                                                     # 201
sleep 1
curl -s localhost:3002/providers/provider-a/wagering/transactions/rb-2; echo   # status PROCESSED
```

**5. Corrida pelo saldo entre instâncias:** duas BETs de 80.00 sobre 100.00 ao mesmo tempo. Uma é processada, a outra é rejeitada com `INSUFFICIENT_FUNDS`, e o saldo termina em 20.00.

```bash
DEMO_API_URLS=http://localhost:3000,http://localhost:3001 bun run demo:race
```

**6. Entrada pela fila, com entrega duplicada:** a mesma mensagem é entregue duas vezes e o inbox garante um único débito.

```bash
bun run demo:sqs
```

**7. Uma instância morre e as outras continuam**

```bash
docker kill wagering-app-2-1
curl -s localhost:3000/health/ready; echo
bun run demo:sqs                              # consumido pelas instâncias vivas
docker compose --profile cluster up -d --wait # app-2 volta
```

Uma mensagem que já tinha sido entregue à instância morta só volta a ficar visível depois do visibility timeout da fila (30 s). O `demo:sqs` avisa enquanto espera. É a entrega at-least-once funcionando, sem perda.

**8. Consistência, métricas e eventos**

```bash
curl -s -X POST localhost:3000/wallets/$WALLET/reconciliation; echo   # consistent: true
curl -s localhost:3000/metrics | grep -E '^wager_(transactions|idempotent_replays|idempotency_conflicts)_total'
bun run demo:events                                                    # eventos publicados pela outbox
```

Cada instância expõe só os próprios contadores em `/metrics`. Por exemplo, o conflito do passo 3 aparece na porta `3002`. Num ambiente com Prometheus, as séries das instâncias são somadas na consulta.

## Configuração

Variáveis de ambiente são validadas na inicialização (zod); valores inválidos impedem o boot e todos os erros são listados de uma vez. Veja `.env.example`.

`APP_ROLES` define quais papéis a instância executa (`api`, `consumer`, `outbox`, `pending`). Por padrão, todos.

- `api`: endpoints HTTP.
- `consumer`: consome `wager-transactions.fifo` (veja [Mensageria](#mensageria-sqs)).
- `pending`: reprocessa transações `PENDING_REFERENCE` (veja [Referências pendentes](#referências-pendentes-pending_reference)).
- `outbox`: publica os eventos da outbox em `wagering-events.fifo` (`MessageGroupId = walletId`, `MessageDeduplicationId = eventId`). Lotes reservados por lease (`FOR UPDATE SKIP LOCKED`), então várias instâncias publicam em paralelo sem repetir trabalho; falhas são retentadas com backoff exponencial, sem limite (nenhum evento confirmado é descartado).
