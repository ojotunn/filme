# FILME — o supercomputador dos holders

Spec congelada em 15/09/2026. Mudança só com decisão do Michel registrada aqui.

## A ideia em uma frase

Um curta-metragem em qualidade de cinema que ninguém produz: quem abre o site
empresta a placa de vídeo do próprio computador, os computadores dos visitantes
calculam o filme juntos, quadro a quadro, e quem tem mais tokens aparece mais alto
nos créditos. Na graduação do token, a estreia.

## O que fica com quem

- As creator fees do token vão direto para a carteira do Michel. Nenhum agente
  toca em dinheiro. Não existe carteira de agente neste projeto.
- Nenhuma placa é alugada. O trabalho é feito nas máquinas dos visitantes.
- Custo de operação: um serviço no Railway e o disco do volume.

## O que é computado

| item | valor |
|---|---|
| duração | 60 s |
| quadros por segundo | 24 |
| total de quadros | 1.440 |
| resolução | 1024 × 576 |
| passadas de luz por pixel (alvo) | 1.024 |
| ladrilho | 64 × 64 px (16 × 9 = 144 ladrilhos por quadro) |
| total de amostras | 1.440 × 1024 × 576 × 1.024 ≈ 8,7 × 10¹¹ |

Técnica: path tracing em WGSL (WebGPU), rodando no navegador do visitante.
A cena e o caminho de câmera são a fase 4 (arte); o protótipo usa uma cena de teste.

Os números de resolução e passadas podem ser recalibrados UMA vez, depois da
medição da fase 2, para que o filme inteiro custe entre 2 e 6 semanas com uma
centena de máquinas comuns ligadas. A recalibração vai registrada aqui.

## Unidade de trabalho

Uma unidade = (quadro, ladrilho, lote de passadas, semente).

- O servidor mantém a fila de unidades e o acumulador de cada quadro (RGB em
  float16 + contagem de passadas por pixel) no disco do volume.
- A máquina do visitante recebe a unidade, renderiza e devolve o bloco RGB float
  do ladrilho (64 × 64 × 3 floats = 48 KB) mais o número de passadas.
- O servidor soma no acumulador e regera o PNG visível do quadro.
- Ordem da fila: quadro por quadro, do 0 ao 1.439, com passadas em rodadas
  (todos os ladrilhos do quadro recebem a rodada N antes da rodada N+1), para
  que cada quadro fique visível cedo e vá limpando por igual.

## Verificação (contra lixo e trapaça)

- Cada unidade vai para DUAS máquinas diferentes, escolhidas ao acaso.
- Placas diferentes produzem diferenças pequenas em ponto flutuante, então os
  dois resultados são comparados por erro médio relativo com tolerância; a
  tolerância exata sai da fase 3 (medida entre placas reais).
- Se não batem, uma terceira máquina desempata; quem destoou perde reputação.
- Máquina com reputação abaixo do piso recebe unidades, mas o resultado só entra
  quando confirmado por outra máquina de reputação boa.
- Anônimo calcula igual; só a reputação da sessão manda.

## Token, prioridade e créditos

- Quem quiser conecta a carteira e assina uma mensagem; o servidor lê o saldo
  do token na Robinhood Chain (pons v2).
- Saldo maior = prioridade na fila de unidades e multiplicador de créditos.
  A fórmula exata é definida na fase 5 e registrada aqui.
- Créditos = passadas confirmadas × multiplicador. O letreiro final ordena por
  créditos; anônimos aparecem como "anonymous machine #N".
- Sem carteira funciona igual, sem nome.

## O site (en-US)

- O filme como está agora: barra para passar pelos quadros, cada um no estado
  atual (granulado → limpo).
- Mapa de ladrilhos do quadro atual acendendo em tempo real.
- Contador de máquinas ligadas neste instante e total de passadas calculadas.
- Tabela dos maiores contribuidores.
- Painel do token: preço, ETH arrecadado, progresso da graduação.
- Botão explícito "Start computing". A placa do visitante NUNCA é usada sem
  clique. Medidor visível do que a máquina dele está fazendo.
- Celular só assiste (não computa): evita esquentar e gastar bateria.
- Na graduação: estreia, o filme inteiro com os créditos rolando.
- Todo erro de JavaScript aparece NA TELA da própria página.

## Fases

1. Spec (este arquivo).
2. Protótipo do renderizador numa página só, cena de teste, medindo passadas por
   segundo na máquina do Michel e num notebook comum. Resultado gravado em
   `data/bench.jsonl` pelo próprio site.
3. Distribuidor: fila, entrega por WebSocket, soma dos resultados, verificação
   dupla, testado com três abas na mesma máquina.
4. A cena e a câmera (arte): modelagem, luz, caminho de 60 s, ticker na cena.
5. Carteira, prioridade e créditos ligados à chain.
6. Site completo, QA em desktop e em 390 px.
7. Ensaio com token de teste e máquinas reais por um dia.
8. Lançamento.

## Fora do escopo (decidido)

- Nenhum LLM, nenhum navegador automatizado no servidor.
- Nenhum agente com carteira.
- Nenhuma placa alugada.
- Nenhum cálculo em celular.

## Infra

- Pasta `C:\Higgsfield Games\filme`, repo github.com/ojotunn/filme.
- Porta local 8440. Prova headless usa 8441 e `DATA_DIR=prova/out`.
- Node 22+ ESM. Servidor em `src/server.js`. Site em `public/`.
- `DATA_DIR` sobrescreve onde o servidor grava (padrão `data/`), para que
  nenhuma prova toque em dado real.
- Site em inglês; comentários e documentação interna em português.
