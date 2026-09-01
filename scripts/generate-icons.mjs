// One-off icon generation: rasterizes the SVG source to PNGs and a multi-resolution ICO.
// Not part of the app runtime; run manually with `node scripts/generate-icons.mjs`.
import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const svgPath = fileURLToPath(new URL('../public/wolfman-icon.svg', import.meta.url))
const sizes = [16, 32, 48, 64, 128, 256]

const pngBuffers = await Promise.all(
  sizes.map((size) => sharp(svgPath, { density: 384 }).resize(size, size).png().toBuffer()),
)

await writeFile(new URL('../public/wolfman-icon-512.png', import.meta.url), await sharp(svgPath, { density: 384 }).resize(512, 512).png().toBuffer())
await writeFile(new URL('../public/wolfman-icon.ico', import.meta.url), await pngToIco(pngBuffers))

console.log('Generated public/wolfman-icon.ico and public/wolfman-icon-512.png')
