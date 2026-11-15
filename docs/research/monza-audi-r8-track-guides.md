# Monza — Audi R8 LMS Evo II (ACC): dados dos Track Guides

Pesquisa feita em 2026-11-15 para alimentar o engenheiro de voz (`track-knowledge.ts`).

## Fontes
- **TT** — Track Titan, "ACC Monza Audi R8 LMS Evo II 2022 (Dry) Track Guide (Hotlap + Telemetry)", https://youtu.be/qwkawq-rdFU — painel por curva (Apex Speed / Lowest Gear) + gráfico de freio lido por pixel. Mesmo carro.
- **TX** — TraxionGG, "How to be fast at Monza on ACC" (BMW), https://youtu.be/O7R-abglkZ0 — narração.
- **YK** — Yorkie065, "Monza In-Depth Track Guide", https://youtu.be/jC6sz9DIwBk — narração.
- **TR** — Tone Racing, "Monza Beginner Lap Guide" (McLaren), https://youtu.be/eczYVLlzC_c — narração.

Tempos de referência do Audi (TT): melhor 1:45.7 · top 5% 1:47.2 · média ~1:50.5.

## Por curva (numeração do Track Titan)

| Curva | Nome | Apex (TT) | Marcha (TT) | Frenagem | Fonte da frenagem |
|---|---|---|---|---|---|
| 1 | Rettifilo (1ª perna) | 66 km/h | 1ª | pouco antes da placa de 150; reta, na linha branca | TX, YK (TR: 3ª placa depois da torre) |
| 2 | Rettifilo (2ª perna) | 61 km/h | 1ª | sem frenagem nova (toque leve) | YK |
| 3 | Curva Grande | 218 km/h | (3ª no painel — suspeito, é de pé embaixo) | sem frenagem | TT gráfico |
| 4 | Roggia (1ª perna) | 83 km/h | 2ª | placa de 150 | YK (memória antiga: "logo depois da 150") |
| 5 | Roggia (2ª perna) | 91 km/h | 2ª | sem frenagem nova | TT gráfico |
| 6 | Lesmo 1 | 132 km/h | 3ª | toque leve; poucas referências (guard-rail da direita) | TX, TR (laranja à direita) |
| 7 | Lesmo 2 | 119 km/h | 3ª | um pouco antes da placa de 50 | TT vídeo (placa visível), TX, YK |
| 8 | Serraglio (kink) | — | 4ª | pé embaixo | TT (apex 0 = sem dado) |
| 9 | Ascari (entrada) | 149 km/h | 3ª | logo depois da marca laranja no guard-rail, antes da placa de 100 | TT vídeo (placa 100 à frente), TX |
| 10 | Ascari (saída) | 168 km/h | 3ª | sem frenagem | TT gráfico |
| 11 | Parabolica | 127 km/h | 3ª | placa de 100; vira por volta da 50, trail braking até ápice cedo | YK, TX |

Freio detectado no gráfico do TT apenas nas curvas 1, 4, 6, 7, 9, 11.

## Pendências / incertezas
- Placa exata nas curvas 1, 4, 6 e 11 não é legível no vídeo (720p); usada a narração.
- Marcha da curva 3 no painel do TT é "lowest gear" do segmento — não usar.
