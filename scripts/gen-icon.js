'use strict';
/**
 * 生成应用图标：SVG → PNG (多尺寸) → ICO
 * node scripts/gen-icon.js
 */
const fs   = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const toIco = require('to-ico');

/**
 * 经典剪刀造型（X 交叉刀刃）：
 *   上圆环 (20, 28)  — 上刀刃从圆环穿过轴心后向右下延伸到 (85, 62)
 *   下圆环 (20, 72)  — 下刀刃从圆环穿过轴心后向右上延伸到 (85, 38)
 *   轴心螺丝在中央 (52, 50)
 */
function makeScissorSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e2a4a"/>
      <stop offset="100%" stop-color="#0f0f1a"/>
    </linearGradient>
  </defs>

  <!-- 背景 -->
  <rect width="100" height="100" rx="20" fill="url(#bg)"/>

  <!--
    上刀刃：从上圆环右侧 (31,28) → 穿过轴心 → 刀尖 (85,64)
    下刀刃：从下圆环右侧 (31,72) → 穿过轴心 → 刀尖 (85,36)
    两条刀刃在轴心 (52,50) 处交叉，形成 X 形
  -->

  <!-- 下刀刃（先画，被上刀刃压住） -->
  <line x1="31" y1="72" x2="85" y2="36"
        stroke="#3a70e0" stroke-width="7" stroke-linecap="round"/>

  <!-- 上刀刃 -->
  <line x1="31" y1="28" x2="85" y2="64"
        stroke="#5a9aff" stroke-width="7" stroke-linecap="round"/>

  <!-- 轴心螺丝（压在两条刀刃上方） -->
  <circle cx="52" cy="50" r="6"   fill="#7c5cbf"/>
  <circle cx="52" cy="50" r="2.8" fill="#4a2a8a"/>

  <!-- 上圆环（压在刀刃上方，确保可见） -->
  <circle cx="20" cy="28" r="11" fill="#1a2040" stroke="#5a9aff" stroke-width="6"/>
  <circle cx="20" cy="28" r="4"  fill="#0f0f1a"/>

  <!-- 下圆环 -->
  <circle cx="20" cy="72" r="11" fill="#1a2040" stroke="#5a9aff" stroke-width="6"/>
  <circle cx="20" cy="72" r="4"  fill="#0f0f1a"/>
</svg>`;
}

async function main() {
  const buildDir = path.join(__dirname, '..', 'build');
  if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });

  const sizes = [16, 32, 48, 64, 128, 256];
  console.log(`生成 ${sizes.join(', ')}px 尺寸图标...`);

  const pngs = sizes.map(size => {
    const svg = makeScissorSvg(size);
    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
    const buf = resvg.render().asPng();
    console.log(`  ✓ ${size}x${size}`);
    return buf;
  });

  const ico = await toIco(pngs, { resize: true, sizes });
  const icoPath = path.join(buildDir, 'icon.ico');
  fs.writeFileSync(icoPath, ico);
  console.log(`\n✓ ICO 已保存: ${icoPath} (${(ico.length / 1024).toFixed(1)} KB)`);

  const svg256 = makeScissorSvg(256);
  const png256 = new Resvg(svg256, { fitTo: { mode: 'width', value: 256 } }).render().asPng();
  const pngPath = path.join(__dirname, '..', 'renderer', 'icon.png');
  fs.writeFileSync(pngPath, png256);
  console.log(`✓ PNG 已保存: ${pngPath}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
