// Regenerates the Android legacy launcher icons (ic_launcher / ic_launcher_round / ic_launcher_foreground)
// from the SVG source, since @capacitor/assets could not install here (needs a native sharp build).
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'

const svgPath = fileURLToPath(new URL('../public/wolfman-icon.svg', import.meta.url))
const resDir = fileURLToPath(new URL('../android/app/src/main/res/', import.meta.url))

const densities = [
  { dir: 'mipmap-mdpi', size: 48 },
  { dir: 'mipmap-hdpi', size: 72 },
  { dir: 'mipmap-xhdpi', size: 96 },
  { dir: 'mipmap-xxhdpi', size: 144 },
  { dir: 'mipmap-xxxhdpi', size: 192 },
]

for (const { dir, size } of densities) {
  const png = await sharp(svgPath, { density: 384 }).resize(size, size).png().toBuffer()
  for (const name of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
    await sharp(png).toFile(`${resDir}${dir}/${name}`)
  }
}

console.log('Regenerated Android launcher icons for all densities.')
