# Teste de carga

Este relatório registra ambiente, metodologia, resultados e análise do `bun run test:load`. Como pede o enunciado, a qualidade do experimento e a honestidade da análise pesam mais que os números brutos. Por isso, junto com os resultados estão as limitações do método e uma hipótese que testamos e foi refutada.

## Como rodar

```bash
docker compose --profile cluster up -d --build --wait   # 3 instâncias: 3000, 3001 e 3002
bun run test:load
```

Variáveis opcionais: `LOAD_DURATION_S` (padrão 30), `LOAD_WARMUP_S` (5), `LOAD_CONCURRENCY` (32), `LOAD_QUEUE_MESSAGES` (2000) e `LOAD_API_URLS`. O script ([test/load/run.ts](../test/load/run.ts)) termina com código 1 se alguma wallet não reconciliar.

## Ambiente

| Item             | Valor                                                                       |
| ---------------- | --------------------------------------------------------------------------- |
| Máquina          | notebook, Intel i5-8265U (4 núcleos, 8 threads, 15 W), 15,8 GB de RAM       |
| Sistema          | Windows 11 com Docker Desktop (WSL2)                                        |
| Aplicação        | 3 instâncias (`--profile cluster`), cada uma com todos os papéis, Bun 1.4.4 |
| Banco            | PostgreSQL 18 (container)                                                   |
| SQS              | emulador MiniStack 1.5.38 (container, processo Python)                      |
| Gerador de carga | o próprio script, com Bun, **na mesma máquina**                             |

**Tudo divide a mesma máquina:** gerador de carga, instâncias, PostgreSQL e emulador. Os números servem para **comparar os cenários entre si**, não como capacidade de produção.

## Metodologia

**Cenários.** Cada cenário HTTP roda com 32 clientes simultâneos em rodízio pelas 3 instâncias: 5 s de aquecimento, descartados, e 30 s de medição. As operações são 80% BET e 20% WIN de 1.00, e as wallets começam com 1.000.000.00, então nenhuma aposta é rejeitada por saldo.

| #   | Cenário              | Descrição                                                        |
| --- | -------------------- | ---------------------------------------------------------------- |
| 1   | Wallets distribuídas | 200 wallets escolhidas ao acaso: pouca contenção                 |
| 2   | Hot wallet           | todas as operações numa única wallet: contenção máxima pelo lock |
| 3   | Reenvios             | como o 1, mas 20% das requisições reenviam uma key já usada      |
| 4   | Fila                 | 2.000 mensagens em 100 wallets enfileiradas de uma vez           |

**No cliente:**

- a latência de cada requisição é registrada, e p50, p95, p99 e máximo são calculados **exatamente** sobre as amostras (nearest-rank), sem histograma;
- o throughput é o número de requisições concluídas por segundo de medição;
- as respostas são classificadas em: decisão de negócio (201, 202 e 422, que **não são erro**); 503 (falha temporária, que o provedor reenviaria); e erro (outro status ou falha de conexão).

**No servidor:**

- o `/metrics` das 3 instâncias é lido antes e depois de cada cenário, e os contadores são somados entre instâncias;
- as médias e o p95 do servidor vêm de histogramas. O p95 é o limite superior do bucket, por isso aparece como "≤";
- o gauge `outbox_oldest_pending_age_seconds` (atraso da outbox) é amostrado a cada segundo, e o relatório guarda o pico;
- a CPU de cada container é amostrada com `docker stats`, em percentual de **um** núcleo.

**Entre cenários**, o script espera a outbox zerar e mede a **vazão de drenagem**, ou seja, os eventos publicados por segundo sem carga HTTP. Assim nenhum cenário herda o acúmulo do anterior.

**Correção:** no fim, a reconciliação de **todas** as 301 wallets usadas precisa dar `consistent: true`.

## Resultados (rodada final)

| Cenário                 | Vazão                  | Latência p50 / p95 / p99 (ms)           | 503 | Erros             | Conflitos de lock | Espera pelo lock (média, servidor) |
| ----------------------- | ---------------------- | --------------------------------------- | --- | ----------------- | ----------------- | ---------------------------------- |
| 1. Wallets distribuídas | **196 req/s**          | 114 / 410 / 557                         | 0   | 0,02% (1 conexão) | 0                 | 22 ms                              |
| 2. Hot wallet           | **70 req/s**           | 430 / 665 / 921                         | 0   | 0                 | 0                 | 414 ms                             |
| 3. Reenvios: novas      | **219 req/s** no total | 126 / 382 / 548                         | 0   | 0                 | 0                 | 21 ms                              |
| 3. Reenvios: replays    | (1.260 replays)        | **67 / 236 / 387**                      | —   | —                 | —                 | —                                  |
| 4. Fila                 | **32 msg/s**           | processamento médio de 88 ms (servidor) | —   | 0 retries, 0 DLQ  | 0                 | —                                  |

| Cenário                 | Pico de atraso da outbox | Eventos pendentes (pico) | Drenagem depois | CPU média, % de 1 núcleo (app ×3 / Postgres / MiniStack) |
| ----------------------- | ------------------------ | ------------------------ | --------------- | -------------------------------------------------------- |
| 1. Wallets distribuídas | 17 s                     | 7.258                    | 196 eventos/s   | ~105 cada / 206 / 107                                    |
| 2. Hot wallet           | 15 s                     | 1.836                    | 101 eventos/s   | ~30 cada / 70 / **115**                                  |
| 3. Reenvios             | 30 s                     | 10.834                   | 80 eventos/s    | ~96 cada / 189 / 108                                     |

**Reconciliação: 301 wallets, 0 inconsistências.** O mesmo resultado se repetiu em todas as 5 rodadas.

### Todas as rodadas

Incluímos as rodadas anteriores para mostrar a variação entre execuções e o efeito de cada mudança.

| Rodada | Mudança                                             | Cen. 1 (req/s) | Cen. 2 (req/s) | Cen. 3 (req/s) | Fila (msg/s) | Pico de atraso da outbox (1 / 2 / 3) |
| ------ | --------------------------------------------------- | -------------- | -------------- | -------------- | ------------ | ------------------------------------ |
| A      | outbox publicando 1 evento por chamada              | 139            | 50             | 169            | 74           | 29 s / 52 s / 81 s                   |
| B      | outbox em lotes de 10 (`SendMessageBatch`)          | 144            | 62             | 189            | 43           | 13 s / 30 s / 50 s                   |
| C      | idem (repetição)                                    | 165            | 63             | 185            | 37           | 32 s / 60 s / 92 s                   |
| D      | idem, com drenagem entre cenários e CPU (final)     | 196            | 70             | 219            | 32           | 17 s / 15 s / 30 s                   |
| E      | rodada curta (10 s) com a fila de eventos esvaziada | 146            | 64             | 209            | —            | 15 s / 8 s / 14 s                    |

Nas rodadas A a C, cada cenário herdava o acúmulo da outbox do anterior, por isso o atraso cresce do cenário 1 ao 3. A rodada D corrigiu isso.

A vazão HTTP subiu de A para D (139 → 196 req/s no cenário 1). A causa provável é a drenagem entre cenários: sem acúmulo herdado, os publishers disputam menos CPU com as instâncias no início de cada cenário. **Essa alta não deve ser atribuída ao envio em lote da outbox**, cujo efeito não conseguimos separar da variação entre rodadas (veja o item 4 da análise).

## Análise

### 1. Correção sob carga

Em todas as 5 rodadas, as 301 wallets reconciliaram e a outbox drenou até zero, ou seja, nenhum evento se perdeu. Nas rodadas completas (A a D), nenhuma resposta foi 5xx, nenhuma mensagem foi para a DLQ e os únicos erros foram **3 falhas de conexão do lado do cliente** em cerca de 49 mil requisições. Sob carga, o sistema ficou mais lento, mas não deixou de estar correto.

### 2. Hot wallet: o custo do lock pessimista, medido

Com todas as operações na mesma wallet, a vazão cai de 196 para 70 req/s, e a espera média pelo lock sobe de 22 para 414 ms. É o trade-off do D3 ([ARCHITECTURE.md](../ARCHITECTURE.md#4-concorrência)) **medido**: operações da mesma wallet são serializadas, e cada uma vê o saldo confirmado pela anterior.

- A espera não chegou aos 5 s do `lock_timeout`, então não houve 503.
- Com mais clientes na mesma wallet, a espera cresceria até esse limite, e a partir daí o provedor receberia 503 com `Retry-After`: uma falha controlada, nunca uma requisição presa.
- Wallets diferentes seguem em paralelo (cenário 1), com espera média de 22 ms.
- **Por que "conflitos de lock" ficou em 0, mesmo na hot wallet.** Com lock pessimista, a disputa aparece como **espera**, não como conflito. O contador `db_lock_conflicts_total` só registra o que **falha** por concorrência (`lock_timeout`, deadlock, serialização, versão otimista), e a espera nunca chegou ao `lock_timeout`. O contador funciona: um teste de integração provoca um `lock_timeout` real e confere que ele aumenta (`metrics.http.test.ts`).

### 3. Replays custam cerca de metade de uma operação nova

Um reenvio idêntico (p50 de 67 ms contra 126 ms) não grava transação, ledger nem eventos. Ele trava a wallet, encontra o original e devolve o resultado gravado. A idempotência é persistente **e** barata.

### 4. Outbox: o gargalo é o emulador de SQS, não a aplicação

**O sintoma.** Sob carga contínua, o atraso da outbox chegou a dezenas de segundos (até 92 s na rodada C). Nenhum evento se perdeu: tudo foi publicado depois.

**A investigação**, uma hipótese por vez:

| Hipótese                                            | Teste                                                        | Resultado                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| A query de reserva fica lenta com muitos pendentes  | `EXPLAIN ANALYZE` da reserva com 11 mil eventos pendentes    | **Refutada:** menos de 1 ms (índice parcial `outbox_messages_unpublished_idx`)                         |
| O laço do worker dorme entre lotes                  | leitura do `PollingLoop`                                     | **Refutada:** ele roda de novo imediatamente quando há trabalho                                        |
| Uma ida e volta ao broker por evento limita a vazão | `SendMessage` × `SendMessageBatch` com o emulador ocioso     | Ocioso: ~5 ms por chamada, **e um lote de 10 custa o mesmo que 1 mensagem**. Motivou a correção abaixo |
| O host está saturado                                | CPU por container no cenário 2 (hot wallet)                  | **Não explica sozinho:** instâncias a ~30% e Postgres a 70%, com o MiniStack travado em **~115%**      |
| O emulador degrada com o tamanho da fila de eventos | rodada E com a fila esvaziada (antes tinha 66 mil mensagens) | **Refutada:** a drenagem ficou em ~100 eventos/s, igual                                                |

**A causa.** O MiniStack (um processo Python) fica preso em **cerca de um núcleo** (107–118%) em todos os cenários, inclusive quando o host tem folga. Com 3 publishers concorrentes, o teto prático de publicação ficou em **~100 eventos/s** (80–196 nas medições). Os cenários 1 e 3 produzem de ~280 a ~440 eventos/s (cada operação gera `WagerTransactionProcessed` e `WalletBalanceChanged`), então o acúmulo cresce enquanto a carga dura. Medido isoladamente, o emulador responde em ~5 ms por chamada. Sob concorrência, cada chamada passou de ~300 ms. Não investigamos a causa interna no emulador.

**A correção aplicada.** A outbox passou a publicar em lotes de até 10 eventos por `SendMessageBatch`, em vez de uma chamada por evento. Um teste confirma: 24 eventos geram 3 chamadas. As falhas parciais são tratadas: só o que o broker confirma é marcado como publicado, e o resto recebe backoff. **Neste ambiente, o ganho de atraso não se sustentou.** A rodada B melhorou, mas a C, com a mesma mudança, piorou, e a variação entre rodadas foi maior que o efeito.

Um efeito colateral provável: a vazão da fila (cenário 4) caiu de 74 para 32–43 msg/s. Como o emulador é um só e está saturado, consumir e publicar disputam o mesmo núcleo. Lotes maiores de publicação parecem ter deslocado o tempo do emulador para a publicação, em vez de aumentá-lo. Essa é uma hipótese consistente com os dados, mas não verificada.

**Por que manter a mudança.** Na AWS real, o SQS não é um processo único disputando CPU com a aplicação. Um lote de até 10 mensagens conta como **uma** requisição, tanto para vazão (menos idas e voltas por evento) quanto para **custo**, porque o SQS cobra por requisição. A mudança é correta, está testada e é a prática recomendada para publicar no SQS. O que não conseguimos foi demonstrar o ganho com este emulador.

**O que isso significa para o desenho.** O atraso da outbox é o sinal que a arquitetura prevê para isso. Ele é medido (`outbox_oldest_pending_age_seconds`), tem alarme proposto ([ARCHITECTURE.md §13](../ARCHITECTURE.md#13-em-produção-na-aws)) e, como os publishers se dividem por `SKIP LOCKED`, o papel `outbox` escala horizontalmente quando o broker não é o limite.

### 5. Fila

As 2.000 mensagens foram processadas sem retry, sem DLQ e sem conflito de lock, mas devagar (32 a 74 msg/s), pelo mesmo motivo do item 4: cada mensagem exige várias chamadas ao emulador (receber, apagar e ainda publicar os eventos que gera).

## Limitações do experimento

- **Gerador e sistema na mesma máquina.** O gerador disputa CPU com o que está sendo medido. Os números são comparativos, não de capacidade.
- **Clientes em laço fechado.** Cada cliente só envia a próxima requisição depois da resposta. Sob saturação, isso subestima a latência, porque o gerador desacelera junto com o sistema (_coordinated omission_). Um gerador de taxa fixa (open loop), como k6 ou wrk2, mediria a latência sob uma taxa de chegada constante.
- **Emulador no lugar do SQS real.** Ele é o gargalo de tudo o que fala com o SQS, como mostrado no item 4.
- **Percentis do servidor por histograma**, portanto aproximados. Os do cliente são exatos.
- **Poucas rodadas.** São 5 rodadas, das quais só uma é anterior à correção da outbox. A variação entre rodadas é grande, e diferenças pequenas não devem ser lidas como efeito.

## Próximos passos (fora do prazo)

- Repetir com o gerador em outra máquina e um gerador de taxa fixa.
- Medir contra o SQS real (ou LocalStack) para separar o efeito do emulador.
- Comparar a drenagem com 1 e com 3 publishers para medir quanto o emulador sofre com a concorrência.
- Variar o número de clientes na hot wallet até o `lock_timeout` para observar o ponto em que surgem os 503.
