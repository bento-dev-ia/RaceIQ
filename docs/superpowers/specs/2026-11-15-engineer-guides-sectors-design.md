# Engenheiro pelos Track Guides + histórico de setores no overlay

Aprovado pelo piloto em 2026-11-15.

## Por quê
- O engenheiro falava números das próprias voltas do piloto (ex.: Roggia "segunda, 75, freia nos 130 metros"), que divergem dos Track Guides com o Audi R8 (83 km/h, placa de 150).
- Falava da próxima curva logo depois de sair de uma (antecedência de até 1.500 m) e uma fala cortava a outra.
- Uma volta com bug de telemetria (setor de ~9 s) travava o roxo para sempre.

## Decisões
- **Guia como verdade.** `track-knowledge.ts` traz por curva (numeração oficial): marcha, velocidade no ápice, referência de frenagem e dica. Monza e Spa extraídos dos vídeos do Track Titan com o Audi R8 LMS Evo II (painel por curva + gráfico de freio lido por pixel) e de guias narrados — ver `docs/research/`. As voltas do piloto só apontam onde ele foge do guia; erro de frenagem é corrigido contra a placa, não em metros.
- **Rádio curto.** Só o número da curva ("Curva 4, segunda, 83, freia na placa de 150."); nome apenas nas famosas (Lesmo, Ascari, Parabólica, La Source, Eau Rouge, Raidillon, Pouhon, Blanchimont, Bus Stop).
- **Momento.** Dica da curva abre só a 450 m da zona de silêncio dela. A página não interrompe uma fala: enfileira e descarta o que ficou velho (> 2,5 s).
- **Sem atraso de voz.** A decisão de fala já é código determinístico (sem IA). O servidor gera em MP3, antes de sair do box, todas as frases possíveis da pista com a mesma voz do navegador (Edge neural "Francisca", via `edge-tts`; ElevenLabs se houver chave) e manda a lista para a página, que deixa os clipes decodificados em memória. Se um clipe não chegar em 400 ms, a voz do navegador fala na hora.
- **Setores (caminho B).** O servidor mede S1/S2/S3 pelo relógio da volta nas trocas de setor, guarda por carro/pista em `DATA_DIR/race-engineer/sectors/`, e colore como tela de cronometragem no momento em que o setor foi feito: roxo = melhor de todos, verde = melhor da sessão, amarelo = mais lento; cinza = volta inválida. Trava automática: setor < 8 s, < 35% do maior setor da mesma volta ou < 75% da mediana do piloto vira "⚠ suspeito" e nunca conta. Apagar volta: no overlay com o jogo pausado (✕) ou na página de configurações do engenheiro; apaga também a volta de referência do engenheiro correspondente.

## Abordagens consideradas (setores)
- A) Tudo no overlay — rápido, mas o engenheiro continuaria usando a volta bugada.
- **B) Servidor guarda, overlay mostra, apaga no overlay ou na página — escolhida.**
- C) Igual B, apagando só na página — teria que sair do jogo.
