import Phaser from "phaser";
import { COLOR_HEX, COLORS, TEXT_PRESETS } from "../theme";
import { drawDiagonalScanlines, createPulsingDot, addCornerLabel, getResponsiveTextSize } from "../ui";
import { takeScreenshot } from "../screenshot";
import { playTone, unlockAudio } from "../audio";
import { HIGHSCORE_KEY, BESTPHASE_KEY, TOTAL_PHASES } from "./MenuScene";

// ============================================================================
// CONSTANTES (todas com rationale documentado no DESIGN.md seção Arquitetura)
// ============================================================================
const TILE = 40;

// Layout do canvas: grid centralizado horizontalmente, com chrome top e bottom.
// Chrome: ~80px top + grid + ~80px bottom = 600. Grid 15×11 = 600×440.
const CANVAS_W = 800;
const CANVAS_H = 600;

const BOMB_TIMER = 2000;       // ms até detonar — canônico do Bomberman
const FLAME_DURATION = 500;    // ms que o tile mata
const FLAME_PULSE_WARN = 500;  // ms antes da detonação onde o anel pulsa mais forte

const PLAYER_BASE_SPEED = 100;     // px/s — atravessa o grid em ~6s
const PLAYER_SIZE = 26;            // sprite ligeiramente menor que TILE pra passar nos corredores
const SPEED_BUMP = 22;             // +X px/s por power-up de velocidade

const DEFAULT_RADIUS = 1;
const DEFAULT_BOMBS = 1;
const MAX_RADIUS = 6;
const MAX_BOMBS = 6;
const MAX_SPEED = 180;

const STARTING_LIVES = 3;
const POWERUP_DROP_RATE = 0.20;

// Snap threshold: distância máxima do centro do corredor pra permitir mudança de direção.
// Sem isso, jogador precisaria parar exatamente no centro pra virar — frustante.
const TURN_SNAP_THRESHOLD = 8;

// ============================================================================
// TIPOS
// ============================================================================
enum TileType {
  EMPTY = 0,
  WALL = 1,    // indestrutível
  BRICK = 2,   // destrutível
  EXIT = 3,    // saída revelada (visível só após brick destruído)
}

type PowerupKind = "radius" | "bombs" | "speed";
type AiKind = "balloom" | "oneal" | "doll" | "pass" | "pontan";

interface Bomb {
  gridX: number;
  gridY: number;
  detonatesAt: number;
  radius: number;
  sprite: Phaser.GameObjects.Arc;
  ring: Phaser.GameObjects.Arc;
}

interface Flame {
  gridX: number;
  gridY: number;
  expiresAt: number;
  sprite: Phaser.GameObjects.Rectangle;
  inner: Phaser.GameObjects.Rectangle;
}

interface Powerup {
  kind: PowerupKind;
  gridX: number;
  gridY: number;
  sprite: Phaser.GameObjects.Rectangle;
  label: Phaser.GameObjects.Text;
}

interface Enemy {
  kind: AiKind;
  px: number;
  py: number;
  speed: number;
  dirX: -1 | 0 | 1;
  dirY: -1 | 0 | 1;
  alive: boolean;
  hp: number;
  invulUntil: number;
  body: Phaser.GameObjects.Arc;
  detail: Phaser.GameObjects.Arc | Phaser.GameObjects.Rectangle | null;
  // Estado interno da IA — varia por tipo
  nextDecideAt: number; // pra IAs que decidem em intervalos (Balloom)
}

interface PhaseEnemyConfig {
  kind: AiKind;
  count: number;
}

interface PhaseConfig {
  number: number;
  name: string;
  cols: number;
  rows: number;
  brickDensity: number;
  enemies: PhaseEnemyConfig[];
  guaranteedPowerups: PowerupKind[];
  timeLimit: number; // segundos
}

const PHASES: PhaseConfig[] = [
  { number: 1, name: "APRENDENDO A EXPLODIR", cols: 15, rows: 11, brickDensity: 0.40,
    enemies: [{ kind: "balloom", count: 3 }],
    guaranteedPowerups: ["radius", "bombs"], timeLimit: 200 },
  { number: 2, name: "DENSIDADE", cols: 15, rows: 11, brickDensity: 0.55,
    enemies: [{ kind: "balloom", count: 4 }, { kind: "oneal", count: 1 }],
    guaranteedPowerups: ["radius", "bombs", "speed"], timeLimit: 180 },
  { number: 3, name: "ELES ENXERGAM O FOGO", cols: 15, rows: 11, brickDensity: 0.50,
    enemies: [{ kind: "oneal", count: 3 }, { kind: "doll", count: 2 }],
    guaranteedPowerups: ["radius", "bombs", "speed", "radius"], timeLimit: 180 },
  { number: 4, name: "CAÇADORES", cols: 15, rows: 11, brickDensity: 0.50,
    enemies: [{ kind: "doll", count: 2 }, { kind: "pass", count: 2 }],
    guaranteedPowerups: ["radius", "bombs", "speed"], timeLimit: 160 },
  { number: 5, name: "O MINOTAURO", cols: 13, rows: 11, brickDensity: 0.40,
    enemies: [{ kind: "pontan", count: 1 }],
    guaranteedPowerups: [], timeLimit: 150 },
];

type State = "ready" | "playing" | "paused" | "phase-clear" | "dead" | "gameover" | "win";

interface SceneInitData {
  phase?: number;
  score?: number;
  lives?: number;
}

// AI speeds (multiplier de PLAYER_BASE_SPEED pra dar sensação consistente)
const AI_SPEEDS: Record<AiKind, number> = {
  balloom: 60,
  oneal: 90,
  doll: 90,
  pass: 120,
  pontan: 120,
};

const AI_SCORE: Record<AiKind, number> = {
  balloom: 100,
  oneal: 200,
  doll: 200,
  pass: 400,
  pontan: 800,
};

// ============================================================================
// GAME SCENE
// ============================================================================
export class GameScene extends Phaser.Scene {
  // ---- core state
  private currentPhase = 1;
  private phaseConfig!: PhaseConfig;
  private state: State = "ready";
  private gridCols = 15;
  private gridRows = 11;
  private gridOffsetX = 0;
  private gridOffsetY = 0;
  private timeRemainingMs = 0;

  // ---- grid
  private tiles: TileType[][] = [];
  private tileSprites: (Phaser.GameObjects.Rectangle | null)[][] = [];
  private brickSprites: (Phaser.GameObjects.Rectangle | null)[][] = [];
  private exitGridX = -1;
  private exitGridY = -1;
  private exitRevealed = false;

  // ---- player
  private player!: Phaser.GameObjects.Arc;
  private playerEye!: Phaser.GameObjects.Arc;
  private playerPx = 0;
  private playerPy = 0;
  private playerDirX: -1 | 0 | 1 = 0;
  private playerDirY: -1 | 0 | 1 = 0;
  private playerSpeed = PLAYER_BASE_SPEED;
  private playerMaxBombs = DEFAULT_BOMBS;
  private playerRadius = DEFAULT_RADIUS;
  private playerAlive = true;

  // ---- entities
  private bombs: Bomb[] = [];
  private flames: Flame[] = [];
  private powerups: Powerup[] = [];
  private enemies: Enemy[] = [];

  // ---- score / progression
  private score = 0;
  private lives = STARTING_LIVES;

  // ---- chrome
  private scoreLabel!: Phaser.GameObjects.Text;
  private phaseLabel!: Phaser.GameObjects.Text;
  private livesLabel!: Phaser.GameObjects.Text;
  private timerLabel!: Phaser.GameObjects.Text;
  private overlayBg!: Phaser.GameObjects.Rectangle;
  private overlayTitle!: Phaser.GameObjects.Text;
  private overlayHint!: Phaser.GameObjects.Text;

  // ---- input
  private keys!: Record<
    "UP" | "DOWN" | "LEFT" | "RIGHT" | "W" | "A" | "S" | "D" | "SPACE" | "P" | "ESC" | "K" | "R",
    Phaser.Input.Keyboard.Key
  >;

  constructor() { super("game"); }

  // ==========================================================================
  // INIT — chamado a cada scene.start("game", data). Phaser reusa instância;
  // sem reset explícito aqui, todo field stale persiste (lição do Invaders).
  // ==========================================================================
  init(data: SceneInitData) {
    this.currentPhase = Phaser.Math.Clamp(data?.phase ?? 1, 1, PHASES.length);
    this.phaseConfig = PHASES[this.currentPhase - 1];

    // Fase 1 = jogo novo, reset score/lives. Fases > 1 carregam o estado.
    if (this.currentPhase === 1) {
      this.score = 0;
      this.lives = STARTING_LIVES;
      this.playerMaxBombs = DEFAULT_BOMBS;
      this.playerRadius = DEFAULT_RADIUS;
      this.playerSpeed = PLAYER_BASE_SPEED;
    } else {
      this.score = data?.score ?? 0;
      this.lives = data?.lives ?? STARTING_LIVES;
      // Power-ups acumulados entre fases ficam no registry
      this.playerMaxBombs = this.registry.get("playerMaxBombs") ?? DEFAULT_BOMBS;
      this.playerRadius = this.registry.get("playerRadius") ?? DEFAULT_RADIUS;
      this.playerSpeed = this.registry.get("playerSpeed") ?? PLAYER_BASE_SPEED;
    }

    this.state = "ready";
    this.playerAlive = true;
    this.playerDirX = 0;
    this.playerDirY = 0;
    this.bombs = [];
    this.flames = [];
    this.powerups = [];
    this.enemies = [];
    this.tiles = [];
    this.tileSprites = [];
    this.brickSprites = [];
    this.exitRevealed = false;
    this.exitGridX = -1;
    this.exitGridY = -1;

    this.gridCols = this.phaseConfig.cols;
    this.gridRows = this.phaseConfig.rows;
    this.gridOffsetX = (CANVAS_W - this.gridCols * TILE) / 2;
    this.gridOffsetY = (CANVAS_H - this.gridRows * TILE) / 2;
  }

  // ==========================================================================
  // CREATE
  // ==========================================================================
  create() {
    this.add.rectangle(0, 0, CANVAS_W, CANVAS_H, COLOR_HEX.bg).setOrigin(0, 0);
    drawDiagonalScanlines(this, CANVAS_W, CANVAS_H, 18, 0.04);

    this.buildLevel();
    this.spawnPlayer();
    this.spawnEnemies();
    this.placeExit();
    this.placeGuaranteedPowerups();

    this.drawChrome();
    this.drawOverlay();
    this.showReadyOverlay();

    const kb = this.input.keyboard!;
    this.keys = {
      UP: kb.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
      DOWN: kb.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
      LEFT: kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT),
      RIGHT: kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT),
      W: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      A: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      S: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      D: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      SPACE: kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      P: kb.addKey(Phaser.Input.Keyboard.KeyCodes.P),
      ESC: kb.addKey(Phaser.Input.Keyboard.KeyCodes.ESC),
      K: kb.addKey(Phaser.Input.Keyboard.KeyCodes.K),
      R: kb.addKey(Phaser.Input.Keyboard.KeyCodes.R),
    };
    kb.on("keydown", unlockAudio);

    this.timeRemainingMs = this.phaseConfig.timeLimit * 1000;

    this.refreshChrome();
  }

  // ==========================================================================
  // LEVEL BUILDING
  // ==========================================================================

  private buildLevel() {
    // Init grid com EMPTY, depois aplicar perímetro + walls internas + bricks aleatórios.
    for (let r = 0; r < this.gridRows; r++) {
      this.tiles[r] = [];
      this.tileSprites[r] = [];
      this.brickSprites[r] = [];
      for (let c = 0; c < this.gridCols; c++) {
        this.tiles[r][c] = TileType.EMPTY;
        this.tileSprites[r][c] = null;
        this.brickSprites[r][c] = null;
      }
    }

    // Walls do perímetro
    for (let r = 0; r < this.gridRows; r++) {
      this.tiles[r][0] = TileType.WALL;
      this.tiles[r][this.gridCols - 1] = TileType.WALL;
    }
    for (let c = 0; c < this.gridCols; c++) {
      this.tiles[0][c] = TileType.WALL;
      this.tiles[this.gridRows - 1][c] = TileType.WALL;
    }

    // Walls internas em padrão xadrez (col par AND row par, dentro do perímetro)
    for (let r = 2; r < this.gridRows - 1; r += 2) {
      for (let c = 2; c < this.gridCols - 1; c += 2) {
        this.tiles[r][c] = TileType.WALL;
      }
    }

    // Bricks aleatórios em tiles EMPTY, exceto na área 3×3 do spawn (1,1).
    // Spawn 3×3 = rows 1..3 × cols 1..3 (incluindo o player em (1,1)).
    const isSpawnArea = (r: number, c: number) => r >= 1 && r <= 3 && c >= 1 && c <= 3;
    for (let r = 0; r < this.gridRows; r++) {
      for (let c = 0; c < this.gridCols; c++) {
        if (this.tiles[r][c] !== TileType.EMPTY) continue;
        if (isSpawnArea(r, c)) continue;
        if (Math.random() < this.phaseConfig.brickDensity) {
          this.tiles[r][c] = TileType.BRICK;
        }
      }
    }

    // Renderiza
    for (let r = 0; r < this.gridRows; r++) {
      for (let c = 0; c < this.gridCols; c++) {
        this.renderTile(r, c);
      }
    }
  }

  private renderTile(r: number, c: number) {
    const t = this.tiles[r][c];
    const { x, y } = this.tileToPixel(r, c);

    // Limpa sprite antigo
    if (this.tileSprites[r][c]) {
      this.tileSprites[r][c]!.destroy();
      this.tileSprites[r][c] = null;
    }
    if (this.brickSprites[r][c]) {
      this.brickSprites[r][c]!.destroy();
      this.brickSprites[r][c] = null;
    }

    if (t === TileType.WALL) {
      const rect = this.add.rectangle(x, y, TILE - 2, TILE - 2, COLOR_HEX.bgSoft);
      rect.setStrokeStyle(1, COLOR_HEX.border, 1);
      // Detalhe sutil pra distinguir de brick: linha diagonal
      this.tileSprites[r][c] = rect;
    } else if (t === TileType.BRICK) {
      const outer = this.add.rectangle(x, y, TILE - 2, TILE - 2, COLOR_HEX.border);
      outer.setStrokeStyle(1, COLOR_HEX.muted, 0.4);
      const inner = this.add.rectangle(x, y, TILE - 12, TILE - 12, COLOR_HEX.bgSoft);
      inner.setStrokeStyle(1, COLOR_HEX.muted, 0.2);
      this.tileSprites[r][c] = outer;
      this.brickSprites[r][c] = inner;
    } else if (t === TileType.EXIT && this.exitRevealed) {
      // Exit vira visível só quando exitRevealed = true
      const rect = this.add.rectangle(x, y, TILE - 8, TILE - 8, COLOR_HEX.secondary, 0.25);
      rect.setStrokeStyle(2, COLOR_HEX.secondary, 1);
      this.tileSprites[r][c] = rect;
    }
  }

  private spawnPlayer() {
    const spawnR = 1, spawnC = 1;
    const { x, y } = this.tileToPixel(spawnR, spawnC);
    this.playerPx = x;
    this.playerPy = y;
    this.player = this.add.circle(x, y, PLAYER_SIZE / 2, COLOR_HEX.accent);
    this.player.setStrokeStyle(1, COLOR_HEX.fg, 0.5);
    this.playerEye = this.add.circle(x + 4, y - 3, 2, COLOR_HEX.fg);
  }

  private spawnEnemies() {
    // Pool de tiles candidatos: EMPTY, longe do spawn (Manhattan ≥6).
    const candidates: Array<[number, number]> = [];
    for (let r = 1; r < this.gridRows - 1; r++) {
      for (let c = 1; c < this.gridCols - 1; c++) {
        if (this.tiles[r][c] !== TileType.EMPTY) continue;
        const distFromSpawn = Math.abs(r - 1) + Math.abs(c - 1);
        if (distFromSpawn < 6) continue;
        candidates.push([r, c]);
      }
    }
    Phaser.Utils.Array.Shuffle(candidates);

    for (const cfg of this.phaseConfig.enemies) {
      for (let i = 0; i < cfg.count; i++) {
        const slot = candidates.pop();
        if (!slot) break; // falta de espaço (extremamente raro)
        const [r, c] = slot;
        this.createEnemy(cfg.kind, r, c);
      }
    }
  }

  private createEnemy(kind: AiKind, gridR: number, gridC: number) {
    const { x, y } = this.tileToPixel(gridR, gridC);
    const size = kind === "pontan" ? PLAYER_SIZE + 8 : PLAYER_SIZE - 4;
    const color = kind === "pontan" ? COLOR_HEX.danger
                : kind === "pass"   ? COLOR_HEX.amber
                : kind === "doll"   ? COLOR_HEX.secondary
                : kind === "oneal"  ? COLOR_HEX.success
                :                     COLOR_HEX.muted;
    const body = this.add.circle(x, y, size / 2, color);
    body.setStrokeStyle(1, COLOR_HEX.fg, 0.4);
    let detail: Phaser.GameObjects.Arc | Phaser.GameObjects.Rectangle | null = null;
    if (kind === "pontan") {
      // Boss tem 2 olhos pra ficar mais distinto
      detail = this.add.circle(x, y - 2, 3, COLOR_HEX.fg);
    } else {
      detail = this.add.circle(x, y - 2, 2, COLOR_HEX.fg);
    }
    const enemy: Enemy = {
      kind,
      px: x, py: y,
      speed: AI_SPEEDS[kind],
      dirX: 0, dirY: 0,
      alive: true,
      hp: kind === "pontan" ? 3 : 1,
      invulUntil: 0,
      body,
      detail,
      nextDecideAt: 0,
    };
    // Direção inicial aleatória
    this.pickNewEnemyDir(enemy);
    this.enemies.push(enemy);
  }

  private placeExit() {
    // Saída fica em um tile BRICK aleatório. Quando o brick é destruído, exit fica visível.
    const brickPositions: Array<[number, number]> = [];
    for (let r = 0; r < this.gridRows; r++) {
      for (let c = 0; c < this.gridCols; c++) {
        if (this.tiles[r][c] === TileType.BRICK) brickPositions.push([r, c]);
      }
    }
    if (brickPositions.length === 0) {
      // Caso degenerado (densidade muito baixa): coloca exit num tile vazio random.
      const empties: Array<[number, number]> = [];
      for (let r = 1; r < this.gridRows - 1; r++) {
        for (let c = 1; c < this.gridCols - 1; c++) {
          if (this.tiles[r][c] === TileType.EMPTY && (r > 3 || c > 3)) empties.push([r, c]);
        }
      }
      if (empties.length > 0) {
        const [r, c] = Phaser.Utils.Array.GetRandom(empties);
        this.exitGridY = r;
        this.exitGridX = c;
        this.exitRevealed = true;
        this.tiles[r][c] = TileType.EXIT;
        this.renderTile(r, c);
      }
      return;
    }
    const [r, c] = Phaser.Utils.Array.GetRandom(brickPositions);
    this.exitGridY = r;
    this.exitGridX = c;
  }

  private placeGuaranteedPowerups() {
    // Esconde N power-ups embaixo de bricks aleatórios (diferentes da saída).
    const brickPositions: Array<[number, number]> = [];
    for (let r = 0; r < this.gridRows; r++) {
      for (let c = 0; c < this.gridCols; c++) {
        if (this.tiles[r][c] === TileType.BRICK && !(r === this.exitGridY && c === this.exitGridX)) {
          brickPositions.push([r, c]);
        }
      }
    }
    Phaser.Utils.Array.Shuffle(brickPositions);

    // Guarda em side-map: ao destruir brick, checa esse map e spawna powerup.
    this.guaranteedPowerupMap = {};
    for (const kind of this.phaseConfig.guaranteedPowerups) {
      const slot = brickPositions.pop();
      if (!slot) break;
      const [r, c] = slot;
      this.guaranteedPowerupMap[`${r},${c}`] = kind;
    }
  }

  private guaranteedPowerupMap: Record<string, PowerupKind> = {};

  // ==========================================================================
  // UPDATE LOOP
  // ==========================================================================

  update(time: number, delta: number) {
    const dt = delta / 1000;
    const justDown = Phaser.Input.Keyboard.JustDown;

    if (justDown(this.keys.K)) takeScreenshot(this.game, "gamedev-10-bomberman");
    if (justDown(this.keys.ESC)) { this.scene.start("menu"); return; }

    if (justDown(this.keys.P) && (this.state === "playing" || this.state === "paused")) {
      this.togglePause();
      return;
    }

    // R: dependendo do state
    if (justDown(this.keys.R)) {
      if (this.state === "gameover") { this.scene.start("game", { phase: 1 }); return; }
      if (this.state === "dead") { this.scene.start("game", { phase: this.currentPhase, score: this.score, lives: this.lives }); return; }
      if (this.state === "phase-clear") { this.advanceToNextPhase(); return; }
      if (this.state === "win") { this.scene.start("menu"); return; }
    }

    // SPACE no ready state: começa
    if (this.state === "ready" && justDown(this.keys.SPACE)) {
      this.state = "playing";
      this.hideOverlay();
    }

    if (this.state !== "playing") return;

    // Timer
    this.timeRemainingMs -= delta;
    if (this.timeRemainingMs <= 0) {
      this.timeRemainingMs = 0;
      this.die("TEMPO ESGOTADO");
      return;
    }

    this.updatePlayer(time, dt);
    this.updateBombs(time);
    this.updateFlames(time);
    this.updateEnemies(time, dt);
    this.checkPlayerCollisions(time);
    this.checkPowerupPickup();
    this.checkExit();
    this.refreshChrome();
  }

  // ==========================================================================
  // PLAYER MOVEMENT
  // ==========================================================================

  private updatePlayer(_time: number, dt: number) {
    if (!this.playerAlive) return;

    // Input → direção desejada
    let wantX: -1 | 0 | 1 = 0;
    let wantY: -1 | 0 | 1 = 0;
    if (this.keys.LEFT.isDown || this.keys.A.isDown) wantX = -1;
    else if (this.keys.RIGHT.isDown || this.keys.D.isDown) wantX = 1;
    if (this.keys.UP.isDown || this.keys.W.isDown) wantY = -1;
    else if (this.keys.DOWN.isDown || this.keys.S.isDown) wantY = 1;

    // Priorize uma direção (no Bomberman não tem diagonal). Se ambos pressionados,
    // mantém a atual se possível, senão escolhe um.
    if (wantX !== 0 && wantY !== 0) {
      if (this.playerDirX !== 0) wantY = 0;
      else wantX = 0;
    }

    // Se quer mover perpendicular ao atual, checa snap pro centro do corredor.
    if (wantX !== 0 && this.playerDirY !== 0) {
      // Vertical → quer horizontal: precisa estar perto do centro horizontal do tile
      const { c } = this.pixelToTile(this.playerPx, this.playerPy);
      const centerX = this.gridOffsetX + c * TILE + TILE / 2;
      if (Math.abs(this.playerPx - centerX) < TURN_SNAP_THRESHOLD) {
        this.playerPx = centerX;
        this.playerDirX = wantX;
        this.playerDirY = 0;
      }
    } else if (wantY !== 0 && this.playerDirX !== 0) {
      const { r } = this.pixelToTile(this.playerPx, this.playerPy);
      const centerY = this.gridOffsetY + r * TILE + TILE / 2;
      if (Math.abs(this.playerPy - centerY) < TURN_SNAP_THRESHOLD) {
        this.playerPy = centerY;
        this.playerDirX = 0;
        this.playerDirY = wantY;
      }
    } else if ((wantX !== 0 || wantY !== 0) && this.playerDirX === 0 && this.playerDirY === 0) {
      // Parado, direção nova
      this.playerDirX = wantX;
      this.playerDirY = wantY;
    } else if (wantX === 0 && wantY === 0) {
      // Soltou tudo
      this.playerDirX = 0;
      this.playerDirY = 0;
    }

    // Tenta mover na direção atual
    if (this.playerDirX !== 0 || this.playerDirY !== 0) {
      const nextX = this.playerPx + this.playerDirX * this.playerSpeed * dt;
      const nextY = this.playerPy + this.playerDirY * this.playerSpeed * dt;
      if (!this.actorCollidesAt(nextX, nextY, PLAYER_SIZE / 2)) {
        this.playerPx = nextX;
        this.playerPy = nextY;
      } else {
        // Snap pro centro do tile atual quando bate em algo (evita encostar e ficar travado)
        const { r, c } = this.pixelToTile(this.playerPx, this.playerPy);
        const center = this.tileToPixel(r, c);
        if (this.playerDirX !== 0) this.playerPx = center.x;
        if (this.playerDirY !== 0) this.playerPy = center.y;
      }
    }

    this.player.x = this.playerPx;
    this.player.y = this.playerPy;
    this.playerEye.x = this.playerPx + (this.playerDirX > 0 ? 4 : this.playerDirX < 0 ? -4 : 4);
    this.playerEye.y = this.playerPy + (this.playerDirY > 0 ? 4 : this.playerDirY < 0 ? -4 : -3);

    // Plantar bomba
    if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE)) {
      this.tryPlantBomb();
    }
  }

  // ==========================================================================
  // COLLISION com grid (usado por player e enemies)
  // ==========================================================================

  // Checa se o actor de bounding circle (cx, cy, radius) colide com WALL/BRICK/BOMB.
  // Bomb sob os próprios pés do actor recém-plantado NÃO bloqueia (até ele sair).
  private actorCollidesAt(cx: number, cy: number, radius: number): boolean {
    // Testa as 4 quinas do bbox do actor
    const margin = radius - 2; // pequena folga pra evitar gluing
    const corners = [
      [cx - margin, cy - margin],
      [cx + margin, cy - margin],
      [cx - margin, cy + margin],
      [cx + margin, cy + margin],
    ];
    for (const [px, py] of corners) {
      const { r, c } = this.pixelToTile(px, py);
      if (r < 0 || r >= this.gridRows || c < 0 || c >= this.gridCols) return true;
      const t = this.tiles[r][c];
      if (t === TileType.WALL || t === TileType.BRICK) return true;
      // Bombas: blocking, exceto se o actor ainda está em cima dela
      if (this.bombAt(r, c)) {
        const inSameTile = this.pixelTileMatches(cx, cy, r, c);
        if (!inSameTile) return true;
      }
    }
    return false;
  }

  private pixelTileMatches(px: number, py: number, r: number, c: number): boolean {
    const t = this.pixelToTile(px, py);
    return t.r === r && t.c === c;
  }

  private bombAt(r: number, c: number): boolean {
    for (const b of this.bombs) if (b.gridX === c && b.gridY === r) return true;
    return false;
  }

  // ==========================================================================
  // BOMBS + EXPLOSIONS
  // ==========================================================================

  private tryPlantBomb() {
    if (this.bombs.length >= this.playerMaxBombs) return;
    const { r, c } = this.pixelToTile(this.playerPx, this.playerPy);
    if (this.bombAt(r, c)) return;
    if (this.tiles[r][c] !== TileType.EMPTY && this.tiles[r][c] !== TileType.EXIT) return;
    const { x, y } = this.tileToPixel(r, c);
    const sprite = this.add.circle(x, y, TILE / 2 - 8, COLOR_HEX.fg);
    const ring = this.add.circle(x, y, TILE / 2 - 4, 0, 0).setStrokeStyle(2, COLOR_HEX.accent, 1);
    const bomb: Bomb = {
      gridX: c,
      gridY: r,
      detonatesAt: this.time.now + BOMB_TIMER,
      radius: this.playerRadius,
      sprite,
      ring,
    };
    this.bombs.push(bomb);
    playTone(330, 80, "triangle", 0.06);
  }

  private updateBombs(time: number) {
    const toDetonate: Bomb[] = [];
    for (const b of this.bombs) {
      // Pulse visual: anel encolhe conforme se aproxima da detonação
      const remaining = b.detonatesAt - time;
      const t = 1 - remaining / BOMB_TIMER;
      const scale = 1 + Math.sin(time / 60) * (remaining < FLAME_PULSE_WARN ? 0.18 : 0.06);
      b.ring.setScale(scale);
      b.sprite.setScale(0.95 + t * 0.05);
      if (remaining <= 0) toDetonate.push(b);
    }
    for (const b of toDetonate) this.detonate(b);
  }

  // Detonar = remover bomba + criar chamas em cruz + propagar reação em cadeia.
  // Algoritmo iterativo (fila de bombas a detonar) — evita stack overflow em cadeia longa.
  private detonate(bomb: Bomb) {
    const queue: Bomb[] = [bomb];
    while (queue.length > 0) {
      const b = queue.shift()!;
      const idx = this.bombs.indexOf(b);
      if (idx < 0) continue; // já processada nesta cadeia
      this.bombs.splice(idx, 1);
      b.sprite.destroy(); b.ring.destroy();
      playTone(110, 180, "sawtooth", 0.14);
      this.cameras.main.shake(80 + b.radius * 20, 0.005 + b.radius * 0.001);

      // Centro
      this.spawnFlame(b.gridY, b.gridX);

      // 4 direções, propagando até radius ou wall/brick
      const dirs: Array<[number, number]> = [[0, 1], [0, -1], [1, 0], [-1, 0]];
      for (const [dr, dc] of dirs) {
        for (let i = 1; i <= b.radius; i++) {
          const r = b.gridY + dr * i;
          const c = b.gridX + dc * i;
          if (r < 0 || r >= this.gridRows || c < 0 || c >= this.gridCols) break;
          const t = this.tiles[r][c];
          if (t === TileType.WALL) break; // wall bloqueia imediatamente, sem chama
          // Brick: chama nele, destrói, mas para a propagação ali
          if (t === TileType.BRICK) {
            this.spawnFlame(r, c);
            this.destroyBrick(r, c);
            break;
          }
          this.spawnFlame(r, c);
          // Reação em cadeia: outra bomba neste tile
          for (const other of this.bombs) {
            if (other.gridX === c && other.gridY === r && !queue.includes(other)) {
              queue.push(other);
            }
          }
        }
      }
    }
  }

  private spawnFlame(r: number, c: number) {
    // Se já tem flame neste tile, só estende a duração (acumula um pouco)
    const existing = this.flames.find((f) => f.gridX === c && f.gridY === r);
    if (existing) {
      existing.expiresAt = Math.max(existing.expiresAt, this.time.now + FLAME_DURATION);
      return;
    }
    const { x, y } = this.tileToPixel(r, c);
    const sprite = this.add.rectangle(x, y, TILE - 4, TILE - 4, COLOR_HEX.accent, 0.18);
    const inner = this.add.rectangle(x, y, TILE - 16, TILE - 16, COLOR_HEX.amber, 0.55);
    this.flames.push({
      gridX: c,
      gridY: r,
      expiresAt: this.time.now + FLAME_DURATION,
      sprite,
      inner,
    });
    // Power-up no tile? Chama destrói
    const pIdx = this.powerups.findIndex((p) => p.gridX === c && p.gridY === r);
    if (pIdx >= 0) {
      this.powerups[pIdx].sprite.destroy();
      this.powerups[pIdx].label.destroy();
      this.powerups.splice(pIdx, 1);
    }
  }

  private updateFlames(time: number) {
    const remaining: Flame[] = [];
    for (const f of this.flames) {
      if (time >= f.expiresAt) {
        f.sprite.destroy(); f.inner.destroy();
        continue;
      }
      // Fade out nos últimos 150ms
      const left = f.expiresAt - time;
      if (left < 150) {
        const a = left / 150;
        f.sprite.setAlpha(0.18 * a);
        f.inner.setAlpha(0.55 * a);
      }
      remaining.push(f);
    }
    this.flames = remaining;
  }

  private flameAt(r: number, c: number): boolean {
    for (const f of this.flames) if (f.gridX === c && f.gridY === r) return true;
    return false;
  }

  private destroyBrick(r: number, c: number) {
    if (this.tiles[r][c] !== TileType.BRICK) return;
    // Score por brick
    this.score += 10;

    // Era a saída?
    if (r === this.exitGridY && c === this.exitGridX) {
      this.tiles[r][c] = TileType.EXIT;
      this.exitRevealed = true;
      this.renderTile(r, c);
      return;
    }

    // Tinha power-up garantido?
    const key = `${r},${c}`;
    const guaranteed = this.guaranteedPowerupMap[key];
    if (guaranteed) {
      delete this.guaranteedPowerupMap[key];
      this.tiles[r][c] = TileType.EMPTY;
      this.renderTile(r, c);
      this.spawnPowerup(r, c, guaranteed);
      return;
    }

    // Drop aleatório?
    if (Math.random() < POWERUP_DROP_RATE) {
      const kinds: PowerupKind[] = ["radius", "bombs", "speed"];
      const kind = Phaser.Utils.Array.GetRandom(kinds);
      this.tiles[r][c] = TileType.EMPTY;
      this.renderTile(r, c);
      this.spawnPowerup(r, c, kind);
      return;
    }

    this.tiles[r][c] = TileType.EMPTY;
    this.renderTile(r, c);
  }

  private spawnPowerup(r: number, c: number, kind: PowerupKind) {
    const { x, y } = this.tileToPixel(r, c);
    const color = kind === "radius" ? COLOR_HEX.danger
                : kind === "bombs"  ? COLOR_HEX.amber
                :                     COLOR_HEX.secondary;
    const sprite = this.add.rectangle(x, y, TILE - 14, TILE - 14, color, 0.22).setStrokeStyle(2, color, 1);
    const symbol = kind === "radius" ? "+R" : kind === "bombs" ? "+B" : "+V";
    const label = this.add.text(x, y, symbol, { ...TEXT_PRESETS.monoLabelFg, fontSize: "12px", color: COLORS.fg }).setOrigin(0.5);
    this.powerups.push({ kind, gridX: c, gridY: r, sprite, label });
  }

  private checkPowerupPickup() {
    const { r, c } = this.pixelToTile(this.playerPx, this.playerPy);
    const idx = this.powerups.findIndex((p) => p.gridX === c && p.gridY === r);
    if (idx < 0) return;
    const p = this.powerups[idx];
    this.applyPowerup(p.kind);
    p.sprite.destroy(); p.label.destroy();
    this.powerups.splice(idx, 1);
    this.score += 50;
    playTone(880, 100, "triangle", 0.10);
    this.time.delayedCall(80, () => playTone(1175, 120, "triangle", 0.10));
  }

  private applyPowerup(kind: PowerupKind) {
    if (kind === "radius") this.playerRadius = Math.min(MAX_RADIUS, this.playerRadius + 1);
    else if (kind === "bombs") this.playerMaxBombs = Math.min(MAX_BOMBS, this.playerMaxBombs + 1);
    else if (kind === "speed") this.playerSpeed = Math.min(MAX_SPEED, this.playerSpeed + SPEED_BUMP);
  }

  private checkExit() {
    if (!this.exitRevealed) return;
    if (this.enemies.some((e) => e.alive)) return; // ainda tem inimigo
    const { r, c } = this.pixelToTile(this.playerPx, this.playerPy);
    if (r === this.exitGridY && c === this.exitGridX) {
      this.phaseClear();
    }
  }

  // ==========================================================================
  // ENEMIES (IA)
  // ==========================================================================

  private updateEnemies(_time: number, dt: number) {
    const time = this.time.now;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      this.updateEnemyAi(e, time);
      this.moveEnemy(e, dt);
      e.body.x = e.px;
      e.body.y = e.py;
      if (e.detail) {
        e.detail.x = e.px;
        e.detail.y = e.py - 2;
      }
      // Piscar quando invul
      if (time < e.invulUntil) {
        e.body.alpha = (Math.floor(time / 80) % 2) ? 1 : 0.4;
      } else {
        e.body.alpha = 1;
      }
    }
  }

  private updateEnemyAi(e: Enemy, _time: number) {
    // Verifica se o enemy está perto do centro de um tile (intersecção)
    const { r, c } = this.pixelToTile(e.px, e.py);
    const center = this.tileToPixel(r, c);
    const atCenter = Math.abs(e.px - center.x) < 2 && Math.abs(e.py - center.y) < 2;

    if (!atCenter && e.dirX === 0 && e.dirY === 0) {
      // Estava parado, escolhe direção
      this.pickNewEnemyDir(e);
      return;
    }

    if (atCenter) {
      // Snap exato
      e.px = center.x;
      e.py = center.y;

      // Decide próxima direção baseado no tipo
      if (e.kind === "balloom") {
        // Random walk simples: na intersecção, ~30% chance de mudar
        if (Math.random() < 0.3 || !this.canMove(e, e.dirX, e.dirY)) {
          this.pickNewEnemyDir(e);
        }
      } else if (e.kind === "oneal") {
        // Decide a cada intersecção (>1 saída possível)
        const exits = this.getExits(r, c);
        if (exits.length > 0) {
          // Prefere continuar reto se possível
          if (this.canMove(e, e.dirX, e.dirY) && Math.random() < 0.5) {
            // mantém
          } else {
            const next = Phaser.Utils.Array.GetRandom(exits);
            e.dirX = next[0] as -1 | 0 | 1;
            e.dirY = next[1] as -1 | 0 | 1;
          }
        } else {
          this.pickNewEnemyDir(e);
        }
      } else if (e.kind === "doll") {
        // Random walk + evita tiles em chama
        const exits = this.getExits(r, c).filter(([dx, dy]) => !this.flameAt(r + dy, c + dx));
        if (exits.length > 0) {
          if (this.canMove(e, e.dirX, e.dirY) && !this.flameAt(r + e.dirY, c + e.dirX) && Math.random() < 0.5) {
            // mantém
          } else {
            const next = Phaser.Utils.Array.GetRandom(exits);
            e.dirX = next[0] as -1 | 0 | 1;
            e.dirY = next[1] as -1 | 0 | 1;
          }
        } else {
          this.pickNewEnemyDir(e);
        }
      } else if (e.kind === "pass" || e.kind === "pontan") {
        // BFS quando player está perto. Senão random + evita chama.
        const playerTile = this.pixelToTile(this.playerPx, this.playerPy);
        const manhattan = Math.abs(playerTile.r - r) + Math.abs(playerTile.c - c);
        const detectRange = e.kind === "pontan" ? 999 : 5; // Pontan sempre persegue
        if (manhattan <= detectRange) {
          const dir = this.bfsNextStep(r, c, playerTile.r, playerTile.c, /*avoidFlame*/ true);
          if (dir) {
            e.dirX = dir[0] as -1 | 0 | 1;
            e.dirY = dir[1] as -1 | 0 | 1;
            return;
          }
        }
        // Fallback: random + avoid flame
        const exits = this.getExits(r, c).filter(([dx, dy]) => !this.flameAt(r + dy, c + dx));
        if (exits.length > 0) {
          const next = Phaser.Utils.Array.GetRandom(exits);
          e.dirX = next[0] as -1 | 0 | 1;
          e.dirY = next[1] as -1 | 0 | 1;
        } else {
          this.pickNewEnemyDir(e);
        }
      }
    }
  }

  // Retorna as direções viáveis a partir do tile (r, c).
  private getExits(r: number, c: number): Array<[number, number]> {
    const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    return dirs.filter(([dx, dy]) => {
      const nr = r + dy, nc = c + dx;
      if (nr < 0 || nr >= this.gridRows || nc < 0 || nc >= this.gridCols) return false;
      const t = this.tiles[nr][nc];
      if (t === TileType.WALL || t === TileType.BRICK) return false;
      if (this.bombAt(nr, nc)) return false;
      return true;
    });
  }

  private canMove(e: Enemy, dx: number, dy: number): boolean {
    if (dx === 0 && dy === 0) return false;
    const nextX = e.px + dx * 4;
    const nextY = e.py + dy * 4;
    return !this.actorCollidesAt(nextX, nextY, (PLAYER_SIZE - 4) / 2);
  }

  private pickNewEnemyDir(e: Enemy) {
    const { r, c } = this.pixelToTile(e.px, e.py);
    const exits = this.getExits(r, c);
    if (exits.length === 0) {
      e.dirX = 0;
      e.dirY = 0;
      return;
    }
    const [dx, dy] = Phaser.Utils.Array.GetRandom(exits);
    e.dirX = dx as -1 | 0 | 1;
    e.dirY = dy as -1 | 0 | 1;
  }

  private moveEnemy(e: Enemy, dt: number) {
    if (e.dirX === 0 && e.dirY === 0) return;
    const nextX = e.px + e.dirX * e.speed * dt;
    const nextY = e.py + e.dirY * e.speed * dt;
    if (!this.actorCollidesAt(nextX, nextY, (PLAYER_SIZE - 4) / 2)) {
      e.px = nextX;
      e.py = nextY;
    } else {
      // Snap pro centro do tile atual e zera direção pra escolher nova
      const { r, c } = this.pixelToTile(e.px, e.py);
      const center = this.tileToPixel(r, c);
      e.px = center.x;
      e.py = center.y;
      e.dirX = 0;
      e.dirY = 0;
    }
  }

  // BFS simples no grid retornando a 1ª direção pra ir de (sr, sc) até (tr, tc).
  // Considera bricks/walls/bombs como bloqueios. Se avoidFlame, tiles em chama também.
  private bfsNextStep(sr: number, sc: number, tr: number, tc: number, avoidFlame: boolean): [number, number] | null {
    if (sr === tr && sc === tc) return null;
    const key = (r: number, c: number) => `${r},${c}`;
    const visited = new Set<string>();
    const cameFrom = new Map<string, [number, number, number, number]>(); // currKey -> [pr, pc, dx, dy]
    const queue: Array<[number, number]> = [[sr, sc]];
    visited.add(key(sr, sc));
    const dirs: Array<[number, number]> = [[0, 1], [0, -1], [1, 0], [-1, 0]];
    let found = false;
    while (queue.length > 0) {
      const [cr, cc] = queue.shift()!;
      if (cr === tr && cc === tc) { found = true; break; }
      for (const [dx, dy] of dirs) {
        const nr = cr + dy, nc = cc + dx;
        if (nr < 0 || nr >= this.gridRows || nc < 0 || nc >= this.gridCols) continue;
        const k = key(nr, nc);
        if (visited.has(k)) continue;
        const t = this.tiles[nr][nc];
        if (t === TileType.WALL || t === TileType.BRICK) continue;
        if (this.bombAt(nr, nc)) continue;
        if (avoidFlame && this.flameAt(nr, nc)) continue;
        visited.add(k);
        cameFrom.set(k, [cr, cc, dx, dy]);
        queue.push([nr, nc]);
      }
    }
    if (!found) return null;
    // Reconstrói até o primeiro passo
    let cur: [number, number] = [tr, tc];
    let firstDir: [number, number] | null = null;
    while (true) {
      const k = key(cur[0], cur[1]);
      const from = cameFrom.get(k);
      if (!from) break;
      const [pr, pc, dx, dy] = from;
      firstDir = [dx, dy];
      if (pr === sr && pc === sc) break;
      cur = [pr, pc];
    }
    return firstDir;
  }

  // ==========================================================================
  // COLLISIONS (player vs flame, player vs enemy, etc)
  // ==========================================================================

  private checkPlayerCollisions(time: number) {
    if (!this.playerAlive) return;
    const { r, c } = this.pixelToTile(this.playerPx, this.playerPy);

    // Flame?
    if (this.flameAt(r, c)) {
      this.die("PEGOU FOGO");
      return;
    }

    // Inimigo (collision por distância — mais permissivo que bbox)
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const dx = e.px - this.playerPx;
      const dy = e.py - this.playerPy;
      if (dx * dx + dy * dy < (PLAYER_SIZE * 0.7) * (PLAYER_SIZE * 0.7)) {
        this.die("ENCONTRO RUIM");
        return;
      }
    }

    // Inimigos pegando fogo
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (time < e.invulUntil) continue;
      const tile = this.pixelToTile(e.px, e.py);
      if (this.flameAt(tile.r, tile.c)) {
        if (e.kind === "pontan") {
          e.hp--;
          e.invulUntil = time + 1000;
          this.cameras.main.flash(60, 255, 100, 100, false);
          playTone(440, 60, "triangle", 0.10);
          if (e.hp <= 0) this.killEnemy(e);
        } else {
          this.killEnemy(e);
        }
      }
    }
  }

  private killEnemy(e: Enemy) {
    e.alive = false;
    e.body.destroy();
    if (e.detail) e.detail.destroy();
    this.score += AI_SCORE[e.kind];
    playTone(660, 80, "triangle", 0.10);
  }

  // ==========================================================================
  // STATE TRANSITIONS
  // ==========================================================================

  private die(reason: string) {
    if (!this.playerAlive) return;
    this.playerAlive = false;
    this.lives--;
    this.cameras.main.shake(220, 0.012);
    this.cameras.main.flash(140, 220, 40, 40, false);
    playTone(160, 320, "sawtooth", 0.16);

    if (this.lives <= 0) {
      this.state = "gameover";
      this.saveBest();
      this.time.delayedCall(700, () => {
        if (this.state !== "gameover") return;
        this.showOverlay("FIM", `${reason} · score ${this.score} · R pra recomeçar · ESC menu`);
      });
    } else {
      this.state = "dead";
      this.time.delayedCall(700, () => {
        if (this.state !== "dead") return;
        this.showOverlay("VOCÊ MORREU", `${reason} · ${this.lives} ${this.lives === 1 ? "vida" : "vidas"} · R pra recomeçar a fase`);
      });
    }
  }

  private phaseClear() {
    if (this.state !== "playing") return;
    this.state = "phase-clear";
    const secondsLeft = Math.ceil(this.timeRemainingMs / 1000);
    this.score += secondsLeft * 10;

    this.cameras.main.flash(280, 122, 209, 122, false);
    playTone(660, 120, "triangle", 0.14);
    this.time.delayedCall(140, () => playTone(880, 150, "triangle", 0.14));
    this.time.delayedCall(320, () => playTone(1175, 220, "triangle", 0.14));

    this.saveBest();

    this.time.delayedCall(700, () => {
      if (this.state !== "phase-clear") return;
      if (this.currentPhase >= PHASES.length) {
        this.state = "win";
        this.showOverlay("ZEROU O JOGO", `score ${this.score} · você venceu as ${PHASES.length} fases · ESC ou R pro menu`);
      } else {
        this.showOverlay(`FASE ${this.currentPhase} OK`, `+${secondsLeft * 10} bônus tempo · score ${this.score} · R pra próxima`);
      }
    });
  }

  private advanceToNextPhase() {
    // Persiste power-ups acumulados entre fases
    this.registry.set("playerMaxBombs", this.playerMaxBombs);
    this.registry.set("playerRadius", this.playerRadius);
    this.registry.set("playerSpeed", this.playerSpeed);
    this.scene.start("game", {
      phase: this.currentPhase + 1,
      score: this.score,
      lives: this.lives,
    });
  }

  private togglePause() {
    if (this.state === "playing") {
      this.state = "paused";
      this.showOverlay("PAUSADO", "P pra continuar · ESC menu");
    } else if (this.state === "paused") {
      this.state = "playing";
      this.hideOverlay();
    }
  }

  private saveBest() {
    try {
      const raw = localStorage.getItem(HIGHSCORE_KEY);
      const prev = raw ? parseInt(raw, 10) : 0;
      if (this.score > prev) localStorage.setItem(HIGHSCORE_KEY, String(this.score));

      const rawP = localStorage.getItem(BESTPHASE_KEY);
      const prevP = rawP ? parseInt(rawP, 10) : 1;
      const reached = Math.min(TOTAL_PHASES, this.currentPhase + (this.state === "phase-clear" || this.state === "win" ? 1 : 0));
      if (reached > prevP) localStorage.setItem(BESTPHASE_KEY, String(reached));
    } catch {}
  }

  // ==========================================================================
  // CHROME + OVERLAY
  // ==========================================================================

  private drawChrome() {
    addCornerLabel(this, 22, 22, "/ 10", "BOMBERMAN", false);
    createPulsingDot(this, CANVAS_W - 22 - 4, 22 + 6, 4, COLOR_HEX.accent);

    this.scoreLabel = this.add.text(CANVAS_W / 2, 22, "", { ...TEXT_PRESETS.monoLabelFg, fontSize: "16px" }).setOrigin(0.5, 0);
    this.phaseLabel = this.add.text(CANVAS_W - 38, 22, "", TEXT_PRESETS.monoLabel).setOrigin(1, 0);
    this.livesLabel = this.add.text(CANVAS_W - 22, 44, "", TEXT_PRESETS.hint).setOrigin(1, 0);

    this.timerLabel = this.add.text(22, 44, "", { ...TEXT_PRESETS.monoLabelAccent, fontSize: "13px" }).setOrigin(0, 0);
    this.add.text(22, CANVAS_H - 22, "GAMEDEV.10", TEXT_PRESETS.hint).setOrigin(0, 1);

    this.add.text(CANVAS_W - 22, CANVAS_H - 22, "← → ↑ ↓ · ESPAÇO bomba · P · ESC · K", TEXT_PRESETS.hint).setOrigin(1, 1);
  }

  private refreshChrome() {
    this.scoreLabel.setText(`SCORE  ${String(this.score).padStart(5, "0")}`);
    this.phaseLabel.setText(`FASE ${String(this.currentPhase).padStart(2, "0")} / ${String(PHASES.length).padStart(2, "0")} · ${this.phaseConfig.name}`);
    this.livesLabel.setText(`VIDAS  ${"♦".repeat(Math.max(0, this.lives))}`);
    const seconds = Math.ceil(this.timeRemainingMs / 1000);
    this.timerLabel.setText(`TEMPO  ${String(seconds).padStart(3, "0")}s  ·  R${this.playerRadius} B${this.playerMaxBombs} V${Math.round((this.playerSpeed - PLAYER_BASE_SPEED) / SPEED_BUMP)}`);
  }

  private drawOverlay() {
    this.overlayBg = this.add.rectangle(CANVAS_W / 2, CANVAS_H / 2, CANVAS_W, CANVAS_H, COLOR_HEX.bg, 0.82);
    this.overlayTitle = this.add.text(CANVAS_W / 2, CANVAS_H / 2 - 30, "", TEXT_PRESETS.heroOutline)
      .setOrigin(0.5)
      .setFontSize(getResponsiveTextSize(this, "title"));
    this.overlayHint = this.add.text(CANVAS_W / 2, CANVAS_H / 2 + 40, "", { ...TEXT_PRESETS.hint, color: COLORS.fg }).setOrigin(0.5);
    this.hideOverlay();
  }

  private showReadyOverlay() {
    this.showOverlay(`FASE ${String(this.currentPhase).padStart(2, "0")}`, `${this.phaseConfig.name} · ESPAÇO pra começar`);
  }

  private showOverlay(title: string, hint: string) {
    this.overlayBg.setVisible(true);
    this.overlayTitle.setVisible(true).setText(title);
    this.overlayHint.setVisible(true).setText(hint);
  }

  private hideOverlay() {
    this.overlayBg.setVisible(false);
    this.overlayTitle.setVisible(false);
    this.overlayHint.setVisible(false);
  }

  // ==========================================================================
  // HELPERS: pixel ↔ grid
  // ==========================================================================

  private tileToPixel(r: number, c: number): { x: number; y: number } {
    return {
      x: this.gridOffsetX + c * TILE + TILE / 2,
      y: this.gridOffsetY + r * TILE + TILE / 2,
    };
  }

  private pixelToTile(px: number, py: number): { r: number; c: number } {
    return {
      r: Math.floor((py - this.gridOffsetY) / TILE),
      c: Math.floor((px - this.gridOffsetX) / TILE),
    };
  }
}
