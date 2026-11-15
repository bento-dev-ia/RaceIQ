# Engenheiro de corrida por voz (pt-BR)

Coach falado em português enquanto você pilota no **Assetto Corsa Competizione**.

## Como ligar
- **Configurações → Som → Engenheiro de corrida (voz)**, ou
- botão **Engenheiro** na barra lateral, ou
- **Ctrl+Shift+E** com a janela do RaceIQ em foco.

Durante o jogo o foco fica no ACC, então use o RaceIQ no celular (Configurações → Acesso, LAN/QR) para ligar/desligar.
A voz sai no aparelho com **"Falar neste aparelho"** ligado (padrão: ligado). Use a voz neural do Windows/Edge
("Microsoft Francisca/Antonio Online (Natural)") para melhor qualidade; escolha em **Voz**.

## O que ele fala
| Momento | Exemplo |
|---|---|
| Antes de uma curva em foco | "Druids, primeira, freia nos 80 metros. 15 metros mais tarde." |
| Depois da curva (±0,1 s) | "Perdeu 3 décimos, freou cedo." / "Boa, ganhou 2 décimos." |
| Na linha | "1 minuto, 29 e 6, melhor volta, 1,3 segundos mais rápido. Foco na Clark Curve." |
| Sem dados | "Ainda sem referência nessa pista, dá uma volta limpa." |

- **Foco:** as 2–3 curvas onde a última volta mais perdeu para os seus melhores trechos.
- **Silêncio:** nada é dito de 150 m antes do ponto de frenagem até você voltar a acelerar.
- **"Freia nos X metros"** = distância do início da frenagem até o turn-in (início do esterço).
- Correções de ponto de frenagem vêm em passos de no máximo 30 m por volta.
- Diferenças acima de 2 s numa curva (rodada, tráfego) são ignoradas.

## Referência
- **Seus melhores trechos** por curva (mesmo carro + pista), das voltas salvas e das voltas da sessão.
  Voltas inválidas ou que passam pelo pit lane não entram.
- **Aprender com outros carros (IA a 100%)**: o ACC só informa a *posição* dos outros carros. O RaceIQ
  projeta essa posição na sua linha e deriva velocidade e ponto de frenagem (erro mediano de ~1–3 m
  medido contra o pedal real nas suas voltas). Marcha e pressão de freio continuam vindo das suas voltas.
  Requer uma volta completa sua na sessão para montar a linha da pista.

## Limitações
- Só ACC por enquanto (Assetto Corsa original não é suportado pelo RaceIQ).
- Pistas precisam de segmentos de curva mapeados (`shared/data/tracks/acc/*-segments.json`).
- O atalho de teclado não é global no Windows.

## Ferramentas
- `bun apps/backend/scripts/race-engineer/replay-acc.ts <gravação> [--bots]` — imprime as falas de uma gravação.
- `bun apps/backend/scripts/race-engineer/calibrate-bot-brake.ts <gravação>` — mede o erro do ponto de frenagem estimado sem pedais.
