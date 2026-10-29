// Sprite gallery: palette swatches plus every sprite, animation and key variant,
// animated live at native resolution. Authoring errors are listed in red.
import { PALETTE as P } from '../engine/palette.mjs';
import { listSprites, spriteErrors, drawSprite } from '../engine/sprites.mjs';
import { drawText, drawPanel, textWidth } from '../engine/font.mjs';

export const GALLERY_W = 480;
const PAD = 6;
const INNER = GALLERY_W - PAD * 2;

export function layoutGallery() {
  const ops = [];
  let y = PAD;
  const sprites = listSprites();
  ops.push({ kind: 'title', y, text: `SPRITE GALLERY · ${sprites.length} SPRITES` });
  y += 12;

  const names = Object.keys(P);
  const perRow = Math.floor(INNER / 8);
  ops.push({ kind: 'palette', y, names, perRow });
  y += Math.ceil(names.length / perRow) * 8 + 4;

  for (const err of spriteErrors()) {
    ops.push({ kind: 'error', y, text: err.slice(0, 58) });
    y += 10;
  }

  for (const s of sprites) {
    const header = `${s.id} ${s.w}X${s.h}`;
    const cells = Object.keys(s.anims).map((anim) => ({ anim, variant: 'default', label: anim }));
    const vnames = Object.keys(s.variants).filter((v) => v !== 'default');
    const plain = vnames.filter((v) => !v.includes(':'));
    const firstAnim = Object.keys(s.anims)[0];
    for (const v of plain) cells.push({ anim: s.anims[v] ? v : firstAnim, variant: v, label: v });
    if (plain.length) {
      const prefix = `${plain[0]}:`;
      for (const v of vnames.filter((n) => n.startsWith(prefix))) {
        const st = v.slice(prefix.length);
        cells.push({ anim: s.anims[st] ? st : firstAnim, variant: v, label: st });
      }
    }
    const rows = [[]];
    let x = 0;
    for (const c of cells) {
      const cw = Math.max(s.w, textWidth(c.label.slice(0, 8))) + 10;
      if (x + cw > INNER - 4 && rows.at(-1).length) { rows.push([]); x = 0; }
      rows.at(-1).push({ ...c, x: x + (cw >> 1) });
      x += cw;
    }
    const rowH = s.h + 16;
    const boxH = 14 + rows.length * rowH + 4;
    ops.push({ kind: 'sprite', y, sprite: s, header, rows, rowH, boxH });
    y += boxH + 4;
  }
  return { ops, height: y + PAD };
}

export function drawGallery(ctx, glow, tick, layout) {
  const h = layout.height;
  for (let y = 0; y < h; y += 4) {
    for (let x = 0; x < GALLERY_W; x += 4) {
      ctx.fillStyle = ((x + y) >> 2) & 1 ? P.sky1 : P.sky0;
      ctx.fillRect(x, y, 4, 4);
    }
  }
  glow.clearRect(0, 0, GALLERY_W, h);
  for (const op of layout.ops) {
    if (op.kind === 'title') drawText(ctx, op.text, PAD, op.y, { color: P.uiFrameHi });
    else if (op.kind === 'error') drawText(ctx, op.text, PAD, op.y, { color: P.ember1 });
    else if (op.kind === 'palette') {
      op.names.forEach((name, i) => {
        const x = PAD + (i % op.perRow) * 8;
        const y = op.y + Math.floor(i / op.perRow) * 8;
        ctx.fillStyle = P.outline;
        ctx.fillRect(x, y, 7, 7);
        ctx.fillStyle = P[name];
        ctx.fillRect(x + 1, y + 1, 5, 5);
      });
    } else if (op.kind === 'sprite') {
      const s = op.sprite;
      drawPanel(ctx, PAD, op.y, INNER, op.boxH);
      drawText(ctx, op.header, PAD + 6, op.y + 5, { color: P.teal2 });
      op.rows.forEach((row, ri) => {
        const baseY = op.y + 16 + ri * op.rowH + s.h + 1;
        for (const c of row) {
          const x = PAD + 6 + c.x;
          drawSprite(ctx, s.id, x - (s.w >> 1) + s.anchor[0], baseY - (s.h - 1) + s.anchor[1], { anim: c.anim, variant: c.variant, tick, glow, glowStrength: 0.8 });
          drawText(ctx, c.label.slice(0, 8), x, baseY + 4, { color: P.uiTextDim, align: 'center' });
        }
      });
    }
  }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(glow.canvas, 0, 0);
  ctx.restore();
}
