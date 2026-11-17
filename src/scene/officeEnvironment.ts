import { isMobile, SplatFileType, SplatMesh } from '@sparkjsdev/spark';
import officeUrl from '../../data/sog/office.sog?url&no-inline';
import type { SplatQuality } from './gaussianSplats';

export function officeLodBudget(quality: SplatQuality): number {
  return (quality === 'fine' ? 320_000 : 160_000) / (isMobile() ? 2 : 1);
}

export async function loadOfficeEnvironment(signal: AbortSignal): Promise<SplatMesh> {
  // A StrictMode probe mount is cleaned up synchronously. Do not start its 16 MiB request.
  await Promise.resolve();
  signal.throwIfAborted();
  const response = await fetch(officeUrl, { signal });
  if (!response.ok) throw new Error(`office.sog: HTTP ${response.status}`);
  const fileBytes = await response.arrayBuffer();
  signal.throwIfAborted();
  const mesh = new SplatMesh({
    fileBytes, fileType: SplatFileType.PCSOGSZIP, lod: true,
    editable: false, raycastable: false,
  });
  try {
    await mesh.initialized;
    // Spark's worker can finish decoding after a preset change or unmount.
    signal.throwIfAborted();
    if (!mesh.packedSplats?.lodSplats?.numSplats) throw new Error('Empty office splat hierarchy');
    mesh.name = 'Office_SOG';
    // The capture has -Y up. Align the long window wall with X and its floor
    // (source Y ≈ 0.065) with the guide's Y=0 plane, without scaling the guide.
    mesh.rotation.set(Math.PI, -0.447, 0, 'YXZ');
    mesh.position.y = 0.065;
    return mesh;
  } catch (error) {
    mesh.dispose();
    throw error;
  }
}
