import Phaser from "phaser";
import { COLORS, COLOR_HEX, TEXT_PRESETS } from "../theme";
import { drawDiagonalScanlines, createPulsingDot, addCornerLabel, getResponsiveTextSize } from "../ui";
import { takeScreenshot } from "../screenshot";
import { unlockAudio } from "../audio";

const HIGHSCORE_KEY = "gamedev-10-bomberman-best";
const BESTPHASE_KEY = "gamedev-10-bomberman-bestphase";
const TOTAL_PHASES = 5;

export class MenuScene extends Phaser.Scene {
  private keys!: Record<"SPACE" | "ENTER" | "K", Phaser.Input.Keyboard.Key>;

  constructor() { super("menu"); }

  create() {
    const best = this.loadBest();
    const bestPhase = this.loadBestPhase();
    const W = this.scale.width;
    const H = this.scale.height;

    this.add.rectangle(0, 0, W, H, COLOR_HEX.bg).setOrigin(0, 0);
    drawDiagonalScanlines(this, W, H, 15, 0.045);

    addCornerLabel(this, 22, 22, "/ 10", "BOMBERMAN", false);
    createPulsingDot(this, W - 22 - 4, 22 + 6, 4, COLOR_HEX.accent);
    this.add.text(W - 38, 22,
      `FASE ${String(bestPhase).padStart(2, "0")} / ${String(TOTAL_PHASES).padStart(2, "0")}  ·  MELHOR ${String(best).padStart(5, "0")}`,
      TEXT_PRESETS.monoLabel).setOrigin(1, 0);

    this.add.text(22, H - 22, "GAMEDEV.10", TEXT_PRESETS.hint).setOrigin(0, 1);
    this.add.text(W - 22, H - 22, "BRICOLAGE · GEIST", TEXT_PRESETS.hint).setOrigin(1, 1);

    this.add.text(W / 2, H * 0.13, "/ JORNADA GAMEDEV", { ...TEXT_PRESETS.monoLabel, color: COLORS.muted }).setOrigin(0.5);
    this.add.text(W / 2, H * 0.24, "BOMBERMAN", TEXT_PRESETS.heroOutline).setOrigin(0.5).setFontSize(getResponsiveTextSize(this, "hero"));
    this.add.text(W / 2, H * 0.33, "grid · bombas em cruz · 5 fases · IAs que evoluem", TEXT_PRESETS.body).setOrigin(0.5);

    this.drawDecoration();

    this.add.text(W / 2, H * 0.83, "↑ ← ↓ → ou WASD mover · ESPAÇO plantar bomba", { ...TEXT_PRESETS.body, fontSize: "14px" }).setOrigin(0.5);
    this.add.text(W / 2, H * 0.83 + 22, "elimine os inimigos · ache a saída · não toque na chama", { ...TEXT_PRESETS.body, fontSize: "14px" }).setOrigin(0.5);
    this.add.text(W / 2, H - 56, "ESPAÇO OU ENTER PRA COMEÇAR · K SCREENSHOT", TEXT_PRESETS.hint).setOrigin(0.5);

    const kb = this.input.keyboard!;
    this.keys = {
      SPACE: kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      ENTER: kb.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER),
      K: kb.addKey(Phaser.Input.Keyboard.KeyCodes.K),
    };
    kb.on("keydown", unlockAudio);
    this.input.on("pointerdown", () => { unlockAudio(); this.scene.start("game", { phase: 1 }); });
  }

  // Decoração: mini-grid à direita do título com bomba pulsante e player laranja,
  // demonstrando o conceito visual do jogo.
  private drawDecoration() {
    const W = this.scale.width;
    const H = this.scale.height;
    const TILE = 32;
    const COLS = 7;
    const ROWS = 5;
    const gx = (W - COLS * TILE) / 2;
    const gy = H * 0.46;

    // Layout decorativo: paredes ao redor, bricks no meio, player + bomba
    //   W = wall, B = brick, . = empty, P = player, b = bomb
    const layout = [
      "WWWWWWW",
      "WP.B.bW",
      "W.W.WBW",
      "W.B...W",
      "WWWWWWW",
    ];

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const ch = layout[r][c];
        const x = gx + c * TILE + TILE / 2;
        const y = gy + r * TILE + TILE / 2;
        if (ch === "W") {
          // Wall: bgSoft com border crisp
          this.add.rectangle(x, y, TILE - 2, TILE - 2, COLOR_HEX.bgSoft).setStrokeStyle(1, COLOR_HEX.border, 1);
        } else if (ch === "B") {
          // Brick: 2 tons (mais claro que wall, com hachura visual via segunda rect interna)
          this.add.rectangle(x, y, TILE - 2, TILE - 2, COLOR_HEX.border).setStrokeStyle(1, COLOR_HEX.muted, 0.4);
          this.add.rectangle(x, y, TILE - 12, TILE - 12, COLOR_HEX.bgSoft).setStrokeStyle(1, COLOR_HEX.muted, 0.2);
        } else if (ch === "P") {
          // Player: círculo laranja com olho
          this.add.circle(x, y, TILE / 2 - 6, COLOR_HEX.accent).setStrokeStyle(1, COLOR_HEX.fg, 0.5);
          this.add.circle(x + 3, y - 3, 2, COLOR_HEX.fg);
        } else if (ch === "b") {
          // Bomba: círculo escuro com anel laranja pulsante
          const bomb = this.add.circle(x, y, TILE / 2 - 8, COLOR_HEX.fg);
          const ring = this.add.circle(x, y, TILE / 2 - 4, 0, 0).setStrokeStyle(2, COLOR_HEX.accent, 1);
          this.tweens.add({
            targets: [bomb, ring],
            scale: { from: 0.92, to: 1.08 },
            duration: 600,
            yoyo: true,
            repeat: -1,
            ease: "Sine.easeInOut",
          });
        }
      }
    }
  }

  update() {
    const justDown = Phaser.Input.Keyboard.JustDown;
    if (justDown(this.keys.K)) takeScreenshot(this.game, "gamedev-10-bomberman-menu");
    if (justDown(this.keys.SPACE) || justDown(this.keys.ENTER)) this.scene.start("game", { phase: 1 });
  }

  private loadBest(): number {
    try {
      const raw = localStorage.getItem(HIGHSCORE_KEY);
      const n = raw ? parseInt(raw, 10) : 0;
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch { return 0; }
  }

  private loadBestPhase(): number {
    try {
      const raw = localStorage.getItem(BESTPHASE_KEY);
      const n = raw ? parseInt(raw, 10) : 1;
      return Number.isFinite(n) && n >= 1 ? Math.min(n, TOTAL_PHASES) : 1;
    } catch { return 1; }
  }
}

export { HIGHSCORE_KEY, BESTPHASE_KEY, TOTAL_PHASES };
