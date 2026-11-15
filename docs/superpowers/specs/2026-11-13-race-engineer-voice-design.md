# Engenheiro de corrida por voz (pt-BR) — design

## Intenção
Ajudar o piloto a baixar o tempo de volta **durante** a pilotagem: um engenheiro que fala em português,
de forma estratégica e resumida, usando a telemetria das voltas anteriores. Liga/desliga a qualquer momento.
Primeiro jogo: **Assetto Corsa Competizione**. AC original fica para depois.

## Comportamento (aprovado)
- **Foco:** por volta, treina só as 2–3 curvas onde mais se perde tempo vs a referência; resto em silêncio.
- **Antes da curva** (cedo o bastante): uma frase com o essencial do erro naquela curva —
  marcha, ponto de frenagem em metros, e uma dica (frear mais tarde/cedo, mais/menos pressão, trail brake,
  velocidade mínima, aceleração). Velocidade/pressão/trail só quando forem o erro.
- **Depois da curva:** só se ganhou/perdeu > 0,1 s ("Perdeu dois décimos, freou cedo").
- **Silêncio:** nunca fala nos ~150 m antes de um ponto de frenagem nem dentro da curva; fala nova descarta a velha.
- **Fim de volta:** tempo, diferença para o melhor, foco da próxima volta.
- **Sem referência:** avisa uma vez e fica quieto.

## Referência ("ideal")
- **Melhor trecho por curva** das voltas válidas do piloto (mesmo carro + pista), atualizado ao vivo a cada volta válida.
- **Volta de bot (opcional):** grava a posição de um carro da IA (ACC só expõe XYZ dos outros carros).
  Dá velocidade e ponto de frenagem aproximados; marcha/pressão continuam vindo do piloto.
  Onde o bot é mais rápido na curva, a velocidade/ponto de frenagem dele substituem os do piloto.

## Abordagens consideradas
1. **Backend gera falas, cliente fala com Web Speech API (escolhida).** Reaproveita pipeline ao vivo e WebSocket;
   voz neural pt-BR do Windows/Edge, offline, latência < 100 ms, custo zero.
2. TTS em nuvem (ElevenLabs) — melhor voz, mas latência 300–800 ms e custo por fala; fica como extensão futura.
3. Áudio nativo no backend (PowerShell/SAPI) — dispensa navegador aberto, mas spawn lento e só Windows.

## Arquitetura
- `server/telemetry/live-pipeline.ts`: registro `subscribeLiveFrames(cb)` chamado após `publishTelemetry`,
  passando pacote normalizado, distância na volta, comprimento da pista e sessão (car/track/game).
- `apps/backend/src/race-engineer/` (puro + testável):
  - `corner-analysis.ts` — métricas por curva a partir de amostras (frenagem, pico de freio, trail, mínima, marcha, tempo do trecho).
  - `reference.ts` — melhor trecho por curva; mescla com bot.
  - `coach.ts` — máquina de estados ao vivo: foco, janela de fala, silêncio, pré/pós-curva, fim de volta.
  - `phrases-pt-br.ts` — textos.
  - `bot-recorder.ts` — lê XYZ do carro-alvo do buffer gráfico do ACC, projeta na linha de referência.
  - `service.ts` — liga tudo: carrega voltas do DB, reage a setting, publica `race-engineer-callout` no WS.
- Setting servidor `raceEngineerEnabled` (+ `raceEngineerLearnFromBots`: aprende com todos os outros carros); cliente: toggle em Configurações → Som,
  botão rápido, atalho `Ctrl+Shift+E` (só com a janela focada; no jogo use o dashboard no celular).
- Cliente: `race-engineer-voice.ts` escolhe voz pt-BR, fala, cancela a anterior; opção local "ouvir neste aparelho".

## Não-objetivos
- AC original, outros idiomas de fala, TTS em nuvem, hotkey global do SO.

## Deixado ao implementador
Limiares exatos (15 m de frenagem, 0,1 s, 5 km/h), ritmo de fala, escolha de voz.
