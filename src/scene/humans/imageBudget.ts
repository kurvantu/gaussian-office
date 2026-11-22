import * as T from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface EmbeddedMaps {
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  textures?: { source: number }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number }[];
}
interface Size {
  width: number;
  height: number;
}
interface ImagePlan extends Size {
  source: Size;
}

// Read dimensions from the embedded PNG/JPEG header *before* handing anything to an image decoder.
function dimensions(data: DataView, mime: string | undefined): Size {
  if (
    mime === 'image/png' &&
    data.byteLength >= 24 &&
    data.getUint32(0) === 0x89504e47 &&
    data.getUint32(4) === 0x0d0a1a0a &&
    data.getUint32(12) === 0x49484452
  ) {
    return { width: data.getUint32(16), height: data.getUint32(20) };
  }
  if (mime === 'image/jpeg' && data.byteLength >= 4 && data.getUint16(0) === 0xffd8) {
    let i = 2;
    while (i + 4 <= data.byteLength && data.getUint8(i++) === 0xff) {
      while (i < data.byteLength && data.getUint8(i) === 0xff) i++;
      if (i + 3 > data.byteLength) break;
      const marker = data.getUint8(i++);
      const length = data.getUint16(i);
      if (length < 2 || i + length > data.byteLength || marker === 0xda) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8) {
        return { width: data.getUint16(i + 5), height: data.getUint16(i + 3) };
      }
      i += length;
    }
  }
  throw new Error('Expected a valid embedded PNG or JPEG image.');
}

export function planImages(
  bytes: ArrayBuffer,
  binStart: number,
  doc: EmbeddedMaps,
  mobile: boolean
): ImagePlan[] {
  const images = doc.images ?? [],
    textures = doc.textures ?? [];
  if (images.length > 20 || textures.length > 20)
    throw new Error('Limit the source to 20 embedded PNG/JPEG maps.');
  const sizes = images.map((img) => {
    const v = doc.bufferViews?.[img.bufferView!],
      offset = v?.byteOffset ?? 0;
    if (
      !v ||
      v.buffer !== 0 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(v.byteLength) ||
      v.byteLength < 1 ||
      binStart + offset + v.byteLength > bytes.byteLength
    ) {
      throw new Error('Invalid embedded image buffer view.');
    }
    const size = dimensions(new DataView(bytes, binStart + offset, v.byteLength), img.mimeType);
    if (!(size.width > 0 && size.width <= 2048 && size.height > 0 && size.height <= 2048))
      throw new Error('Source maps may be at most 2048 × 2048.');
    return size;
  });
  if (sizes.reduce((n, s) => n + s.width * s.height, 0) > 24 * 1024 * 1024)
    throw new Error('Embedded images exceed the 24-megapixel source budget.');
  const sources = textures.map((t) => {
    if (!Number.isInteger(t.source) || !sizes[t.source]) throw new Error('Invalid texture source.');
    return sizes[t.source];
  });
  const side = mobile ? 512 : 1024,
    budget = 2 * side * side;
  const pixels = sources.reduce((n, s) => n + s.width * s.height, 0);
  let scale = Math.min(
    1,
    Math.sqrt(budget / Math.max(1, pixels)),
    side / Math.max(1, ...sources.map((s) => Math.max(s.width, s.height)))
  );
  // Preserve relative map resolution. Count per texture (including repeated images/samplers).
  for (;;) {
    const plans = sources.map((source) => ({
      source,
      width: Math.max(1, Math.floor(source.width * scale)),
      height: Math.max(1, Math.floor(source.height * scale)),
    }));
    if (plans.reduce((n, p) => n + p.width * p.height, 0) <= budget) return plans;
    scale *= 0.99; // one-pixel-wide maps may round up
  }
}

/** Keep material slots, color spaces, UV sets and samplers; reduce only the GPU image dimensions. */
export function useImageBudget(loader: GLTFLoader, plans: ImagePlan[]) {
  loader.register((parser) => ({
    name: 'PlanWalkImageBudget',
    loadTexture(index) {
      const p = plans[index];
      if (p.width === p.source.width && p.height === p.source.height) return null;
      const decoder =
        parser.textureLoader instanceof T.ImageBitmapLoader
          ? new T.ImageBitmapLoader(loader.manager).setOptions({
              resizeWidth: p.width,
              resizeHeight: p.height,
              resizeQuality: 'high',
              premultiplyAlpha: 'none',
            })
          : parser.textureLoader;
      return parser.loadTextureImage(index, parser.json.textures[index].source, decoder).then((texture) => {
        if (!texture?.image) throw new Error('Could not decode an embedded texture.');
        const image = texture.image;
        // HTMLImageElement fallback (or a decoder which ignored resize options).
        if (image.width !== p.width || image.height !== p.height) {
          const canvas = document.createElement('canvas');
          canvas.width = p.width;
          canvas.height = p.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Cannot downscale the visitor textures on this device.');
          ctx.drawImage(image, 0, 0, p.width, p.height);
          texture.image = canvas;
          image.close?.();
        }
        return texture;
      });
    },
  }));
}
