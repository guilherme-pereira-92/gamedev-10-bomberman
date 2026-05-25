# 10 — Bomberman

Grid 2D, bombas em cruz, IA que decide se foge ou morre. O jogo onde o tabuleiro vira o personagem principal.

## Conceito & inspiração

Bomberman clássico (Hudson Soft, 1983) reduzido ao essencial single-player: um grid fechado, paredes indestrutíveis formando o esqueleto, paredes destrutíveis escondendo power-ups, inimigos patrulhando, e o jogador plantando bombas que explodem em cruz após um timer fixo. Você ganha a fase quando mata todos os inimigos e pisa na saída revelada sob um dos blocos destrutíveis.

Esse jogo entra como #10 porque é o primeiro da jornada onde o **tabuleiro é o sistema**. Em Snake o grid era só um espaço de coordenadas; aqui o grid carrega estado (tipo de tile, se está em chama, se esconde power-up, se é a saída), múltiplos atores leem e escrevem nesse estado, e a IA precisa *raciocinar* sobre ele. É o salto de "grid como geometria" pra "grid como base de dados consultável em tempo real".

Inspirações diretas: Bomberman (NES, 1985) pra layout e timing canônico (bomba = 2s, explosão visível ~0.5s), Super Bomberman (SNES) pra hierarquia de inimigos (lento+burro → rápido+esperto).

O que mantenho do clássico: grid fixo, paredes indestrutíveis em padrão xadrez interno, explosão em cruz, 3 power-ups canônicos (raio, quantidade de bombas, velocidade), inimigos que morrem com 1 hit de chama. O que descarto: multiplayer (jornada single-player até agora), passagem por bombas (kick/punch — adicionaria mecânica demais), inimigos que atravessam paredes destrutíveis (transforma o jogo em "fuja", não "controle o tabuleiro"), e qualquer power-up de habilidade ativa (detonator remoto, escudo) — quero que toda decisão venha do *posicionamento*, não de um botão extra.

## O que esse jogo ensina

Conceitos novos que os 9 anteriores não cobriram:

- **Grid 2D como tilemap estruturado com múltiplas camadas lógicas** — Snake tinha 1 grid 1D-ish (lista de segmentos); aqui é uma matriz `tiles[y][x]` com enum de tipo (`EMPTY`, `WALL`, `BRICK`, `BOMB`, `FLAME`, `EXIT`, `POWERUP`) e camadas paralelas pra tempo de detonação e dono da bomba.
- **Conversão constante entre pixel space e grid space** — player se move em pixels (smooth), mas planta bombas no tile snapped. Função `pixelToGrid()` / `gridToPixel()` vira utility de primeira classe.
- **Timer encadeado e propagação de explosões** — bomba A explode, atinge tile da bomba B, B detona instantaneamente (não espera seu timer). Reação em cadeia precisa de BFS no momento da explosão, não de um polling de "estou em chama?".
- **Pathfinding básico em grid (BFS)** — usado pela IA das fases finais pra escolher direção que maximiza distância do flame radius ativo. Primeiro algoritmo de grafo real da jornada.
- **State machine de IA com níveis de "consciência"** — Lvl 1: random walk. Lvl 2: random + não entra em tile em chama. Lvl 3: BFS evitando flame radius previsto (1 step lookahead nas bombas plantadas). Mostra como IA escala em sofisticação sem virar uma bola só.
- **Tile destrutível como container de loot** — quando um BRICK é destruído, rola tabela de drop (peso configurado). Primeira vez na jornada que loot vem de destruir terreno, não de matar inimigo ou de spawn programado.
- **Hitbox em grid vs hitbox arcade** — explosão "ocupa" um tile inteiro durante seu lifetime; player só morre se o *centro* do sprite estiver dentro da área do tile em chama. Detalhe que evita mortes injustas em transições.
- **Layout procedural com constraints** — paredes indestrutíveis são fixas (padrão), mas os bricks destrutíveis são gerados aleatoriamente com regras: nunca cobrir o spawn 3x3 do player, garantir que a saída fique acessível depois de destruir N bricks.

## Regras do jogo

### Objetivo
Eliminar todos os inimigos da fase, encontrar a saída escondida em um dos blocos destrutíveis, e pisar nela. Tudo isso antes do timer da fase zerar.

### Controles
- **Setas / WASD** — movimento (4 direções, sem diagonal)
- **Espaço** — plantar bomba no tile atual
- **ESC** — voltar ao menu
- **K** — screenshot

Sem botão de tiro, sem botão de pulo, sem dash. Toda a profundidade vem do *quando* e *onde* plantar.

### Mecânica core
- Movimento é contínuo em pixels mas restrito por colisão com paredes em grid. Auto-snap pro centro do corredor quando o input alinha (evita ficar preso em quina).
- Bomba: timer fixo de **2.0s** até detonar. Explosão em cruz com raio inicial **1 tile** em cada direção (4 tiles atingidos + o centro = 5 tiles). Raio aumenta com power-up. Paredes indestrutíveis bloqueiam a propagação imediatamente. Paredes destrutíveis bloqueiam mas são destruídas no processo (a chama não passa adiante naquela direção).
- Reação em cadeia: chama tocando outra bomba detona a outra na hora.
- Player começa com **1 bomba simultânea** plantável. Power-up aumenta esse limite.
- Inimigos morrem ao tocar qualquer tile em chama. Player também — incluindo as próprias bombas. A morte é instantânea.
- Power-ups ficam visíveis no chão após o BRICK ser destruído, e somem se forem atingidos por outra explosão (penalidade por jogar com pressa).

### Win / Lose
- **Win da fase**: 0 inimigos vivos + player no tile da saída.
- **Lose**: player toca em qualquer flame, ou toca em qualquer inimigo, ou timer da fase zera.
- **3 vidas totais**. Morrer reseta a fase atual (com layout regenerado — bricks novos, posições de power-up novas, saída em lugar novo). Acabar as vidas vai pra GameOverScene.

### Pontuação
- Brick destruído: **10 pts**
- Power-up coletado: **50 pts**
- Inimigo eliminado: **100 / 200 / 400 pts** (escala com tipo)
- Fase completa: **bônus = segundos restantes × 10**

Pontuação serve pra leaderboard local (localStorage) — sem unlock baseado em score.

## Narrativa

Sem narrativa — jogo arcade puro.

## Design de fases / waves / níveis

Cinco fases. Cada uma introduz UMA coisa nova. A curva de dificuldade vem de mudança qualitativa (tipo de inimigo, densidade de brick, layout), não de inflação numérica.

### Fase 1 — "Aprendendo a explodir"
- **Layout**: grid 15×11 (mais sobre essa escolha em Arquitetura). Densidade de brick: **40%** dos tiles vazios.
- **Inimigos**: 3 × `Balloom` (mais lento, random walk puro, ignora chama — a IA mais burra possível).
- **Power-ups gerados**: 1 raio, 1 bomba extra.
- **Timer**: 200s.
- **Por que esses números**: 40% de brick é alto o suficiente pra forçar o jogador a abrir caminho com bomba (sem isso o jogo vira andar livre), mas baixo o suficiente pra ele ver o tabuleiro inteiro do spawn. 3 inimigos é o mínimo pra ter mais de 1 ameaça simultânea sem cercar logo de cara. 200s é folgado de propósito — fase 1 é tutorial implícito.

### Fase 2 — "Densidade"
- **Layout**: 15×11, densidade **55%**.
- **Inimigos**: 4 × Balloom + 1 × `Oneal` (1.5× mais rápido que Balloom, ainda random walk mas com decisão a cada intersecção e não a cada tile — anda mais "decidido").
- **Power-ups**: 1 raio, 1 bomba, 1 velocidade.
- **Timer**: 180s.
- **Por que**: +15% de brick significa mais tempo plantando bomba pra abrir caminho — testa gestão de tempo. Oneal não é mais inteligente, é mais *rápido*: ensina o jogador que velocidade do inimigo importa antes de ensinar que cérebro do inimigo importa. Timer cai 10% (200→180) porque o jogador já sabe os controles — não precisa do colchão de segurança.

### Fase 3 — "Eles enxergam o fogo"
- **Layout**: 15×11, densidade **50%** (cai um pouco — abre espaço pros inimigos manobrarem).
- **Inimigos**: 3 × Oneal + 2 × `Doll` (mesma velocidade do Oneal, mas **evita ativamente tiles em chama** — IA lvl 2).
- **Power-ups**: 1 raio, 1 bomba, 1 velocidade, 1 raio extra (pool de 4 garantidos).
- **Timer**: 180s.
- **Por que**: aqui a curva qualitativa muda. Até a fase 2, plantar bomba perto de inimigo = morte garantida pro inimigo. Agora alguns *fogem*. Densidade cai pra **50%** porque IA que evita chama precisa de espaço pra de fato evitar — em 55% ela ficaria presa e morreria por azar, não por mérito do jogador. Mantenho timer em 180s pra forçar o jogador a engajar, não esperar.

### Fase 4 — "Caçadores"
- **Layout**: 15×11, densidade **50%**.
- **Inimigos**: 2 × Doll + 2 × `Pass` (rápido — 2× Balloom — e usa BFS curto pra **perseguir** o player quando está a ≤5 tiles de distância).
- **Power-ups**: 1 raio, 1 bomba, 1 velocidade.
- **Timer**: 160s.
- **Por que**: introduz IA *agressiva*. Até agora os inimigos ignoravam o player; aqui dois deles vão atrás dele. Limito a 2 perseguidores (não 4) porque BFS de 4 atores rodando todo frame fica caro e — mais importante — encurralaria o jogador trivialmente. O raio de detecção de 5 tiles deixa o jogador *ver* o inimigo chegar e ter tempo de reagir com bomba.

### Fase 5 — "O minotauro"
- **Layout**: 13×11 (mais apertado — sem o último par de colunas).
- **Inimigos**: 1 × `Pontan` (boss). Anda na velocidade do Pass, BFS completo (evita chama prevista + persegue player), aguenta **3 hits** de chama (HP) com i-frames de 1s entre hits.
- **Power-ups**: 0 garantidos (só drops aleatórios de brick).
- **Timer**: 150s.
- **Por que**: arena menor força confronto — não dá pra fugir indefinidamente. Boss é único inimigo (não 1 boss + minions) porque quero a atenção 100% no padrão dele. **3 HP** é o mesmo que o boss de Invaders — mantém consistência da jornada e o jogador já sabe o que esperar de "boss". I-frames de 1s impedem que uma explosão grande mate o boss em 1 frame só (efetivamente seria 1 hit, anula o HP). 150s é apertado mas não cruel: com raio 3+ e 3 bombas (build esperado chegando aqui), 150s sobra.

## Arquitetura técnica

### Tile size e dimensões do grid

**Tile = 40px**. Grid jogável de **15 cols × 11 rows = 600×440 pixels**. Centralizado horizontalmente em 800×600, deixando ~100px de margem em cima pro chrome/HUD e margem embaixo.

Considerei 32px (daria 25×18 = 800×576 — preenche a tela toda) e rejeitei: grid grande demais pra ação de Bomberman ficar legível em 5 fases, e em 32px o sprite do player fica pequeno demais pra o estilo visual da jornada. 40px dá fôlego pra arte pixel-ish ficar nítida e mantém o jogo "dentro de uma moldura" — visualmente coerente com o restante dos jogos da jornada que não usam tela inteira.

Padrão clássico de paredes indestrutíveis nas linhas/colunas pares internas: linha 0, col 0, e (linha par, col par) pra todo par. Em 15×11 isso dá uma malha confortável de circulação.

### Estrutura de cenas

- `MenuScene` — start + leaderboard local + créditos. Padrão da jornada.
- `GameScene` — única cena de gameplay. Recebe `{ level: 1..5, score: number, lives: number }` via `scene.start()`. Reinicia a si mesma ao mudar de fase (não cria N cenas). Mantém estado entre fases via registry global do Phaser.
- `GameOverScene` — placeholder com score final + opção de voltar ao menu. Padrão da jornada.

### Estruturas de dados load-bearing

- **`tiles: TileType[][]`** — matriz `[row][col]` com o tipo de cada tile. Source of truth pra colisão, propagação de explosão, e renderização de fundo.
- **`bombs: Bomb[]`** — lista de bombas ativas. Cada uma tem `{ gridX, gridY, timer, radius, ownerId }`. Owner permite no futuro multiplayer e hoje serve pra distinguir bomba do player de bomba que veio de cadeia.
- **`flames: Flame[]`** — tiles em chama com `{ gridX, gridY, expiresAt }`. Existe paralelo ao `tiles` porque um tile pode ter chama E ter um power-up debaixo (ordem de resolução: chama destrói power-up).
- **`actors: Actor[]`** — player + inimigos numa lista única. Cada um tem `{ pixelX, pixelY, gridX, gridY, speed, aiType, alive }`. Lista única simplifica o loop de checagem "alguém pisou em chama?".

### Trade-offs considerados

**Phaser Tilemap vs matriz própria**: rejeitei Phaser Tilemap. É overkill pra 15×11, e adiciona um nível de indireção (mudar um tile = mudar no tilemap + atualizar render) que não compensa. Matriz própria + `Phaser.GameObjects.Image` por tile dá controle total e debug trivial (console.table na matriz).

**Bomba como timer setTimeout vs delta no update()**: rejeitei setTimeout. Pause do jogo (ESC) precisa pausar bombas; setTimeout não respeita pause de Phaser. Delta no update é canônico e testável.

**Propagação de explosão recursiva vs iterativa**: iterativa. Recursão em reação em cadeia pode estourar stack se o jogador encadear 15 bombas (não vai acontecer, mas evito o footgun). Fila de "bombas a detonar agora" processada em while.

**BFS por frame na fase 4-5 vs cache**: BFS por frame, mas só pros inimigos que estão a ≤ N tiles. Em fase 5 só há 1 ator com BFS ativo. Custo trivial.

### Constantes load-bearing com rationale

- `TILE = 40` — discutido acima.
- `BOMB_TIMER = 2000ms` — canônico do Bomberman. Curto demais (1s) tira janela de manobra; longo demais (3s+) deixa o jogo lento.
- `FLAME_DURATION = 500ms` — janela em que o tile mata. Curto pra não bloquear corredor por muito tempo, longo o bastante pra ser visível.
- `PLAYER_BASE_SPEED = 100 px/s` = 2.5 tiles/s — andar de um lado ao outro do grid em ~6s. Confortável.
- `POWERUP_DROP_RATE = 0.20` — 20% dos bricks dropam algo. Em 40% de densidade de brick num 15×11 isso dá ~25 power-ups por fase potenciais, dos quais ~5 são realmente coletados (resto explode). Calibrado pra build progredir mas não trivializar.
- `MAX_RADIUS = 6`, `MAX_BOMBS = 6`, `MAX_SPEED = 180 px/s` — caps pra impedir snowballing após coletar 10 power-ups numa fase de sorte.

### Acento visual (constraint #ff4500)

O laranja `#ff4500` fica restrito a: o sprite do player, o pulso do timer da bomba (anel ao redor do sprite da bomba que pulsa nos últimos 0.5s antes de explodir), e o flash inicial da explosão (1 frame). Tudo o mais usa a paleta secundária — chama em sequência amber→success→muted pra dar gradiente quente sem furar o constraint.

## Roadmap

### MVP (v1) — o que ship
- Grid 15×11 com paredes indestrutíveis em padrão, bricks aleatórios com regra de não cobrir spawn 3×3.
- Player: 4-direction movement com auto-snap, plantar bomba no Espaço, 1 bomba inicial, raio inicial 1.
- Bomba com timer 2s, explosão em cruz, reação em cadeia, destruição de bricks.
- 3 power-ups: raio (+1), bomba (+1), velocidade (+20 px/s).
- 5 fases completas conforme spec acima (Balloom → Oneal → Doll → Pass → Pontan boss).
- 3 IAs distintas: random walk, avoid-flame, BFS pursuit.
- Boss com 3 HP + i-frames.
- 3 vidas, GameOver, pontuação básica, leaderboard local.
- Chrome padrão da jornada + screenshot K + ESC pro menu.
- Áudio synth via playTone: plant, explode, power-up, death, win.

### Polish (post-v1)
- Animação de explosão em sprites (centro + horizontal + vertical + ponta — 4 frames cada).
- Shake screen leve na explosão grande (raio ≥ 3).
- Indicador visual no chão mostrando a área que VAI explodir nos últimos 0.5s do timer (ajuda o jogador, mas só liga depois que ele já jogou uma vez — descoberta vira learning).
- "Soft mode" pra debug: tecla F mostra o grid com tipo de cada tile.
- Transição entre fases com card ("FASE 2") em vez de cut seco.
- Variação de paleta sutil por fase (mantendo o constraint do `#ff4500`).
- Modo "endless" pós-fase-5 com inimigos infinitos e leaderboard separado.

## Journal de decisões

### 2026-05-25 — design inicial
Tile fixado em 40px com grid 15×11 pra coerência visual com o resto da jornada (sem usar tela toda). Curva de dificuldade em 5 fases definida por mudança *qualitativa* de IA (random → avoid-flame → pursuit → boss), não por inflação numérica. Densidade de brick cai sutilmente nas fases com IA esperta porque IA precisa de espaço pra demonstrar inteligência. Acento `#ff4500` reservado pro player + pulso de bomba + flash de explosão.

### 2026-05-25 — fix: player travava na própria bomba + BOMB_TIMER 2000 → 2500

**Bug**: o `actorCollidesAt` checava 4 cantos do bbox do player. Quando o player tenta sair da tile da bomba, os cantos da borda **trailing** ainda tocam a tile da bomba. O check fazia `inSameTile(player_center, bomb_tile)` — assim que o center cruza pra próxima tile, isso retorna false, e os cantos trailing veem a bomba como sólida. Resultado: player gruda na bomba que acabou de plantar.

**Fix**: adicionado flag `playerOverlap` por bomba (true ao plantar). Update do player limpa o flag quando o **center** sai da tile da bomba. O collision check só permite atravessar bombas com `playerOverlap=true`, e só pro player (inimigos nunca atravessam bomba). Esse é o modelo canônico do Bomberman — "você fica em cima até sair, depois não pode voltar".

**Calibração**: aproveitei pra bumpar `BOMB_TIMER` de 2000ms (canônico clássico) pra 2500ms. Com o bug do travamento, sair vivo era impossível mesmo se o timer fosse 5s. Mas mesmo depois do fix, 2000ms exige reação rápida demais pra um jogador novo no Bomberman — 2500ms dá folga sem mudar significativamente o feel.

Também aumentei `FLAME_PULSE_WARN` de 500 → 600ms (anel pulsa mais forte nos últimos 600ms antes da detonação) pra dar feedback visual ligeiramente mais antecipado de "tá explodindo agora".
