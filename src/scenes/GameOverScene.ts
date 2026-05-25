// Placeholder: GameOver integrado no GameScene via overlay.
import Phaser from "phaser";

export class GameOverScene extends Phaser.Scene {
  constructor() { super("gameover"); }
  create() { this.scene.start("menu"); }
}
