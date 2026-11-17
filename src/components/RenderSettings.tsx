import { useEffect, useState } from 'react';
import { Box, Check, ChevronDown, CircleDot, ExternalLink, SlidersHorizontal, X } from 'lucide-react';
import type { RenderMethod, SplatQuality } from '../scene/gaussianSplats';

interface RenderSettingsProps {
  method: RenderMethod;
  quality: SplatQuality;
  counts: { architecture: number; guide: number };
  office: boolean;
  ready: boolean;
  error: string | null;
  onMethodChange: (method: RenderMethod) => void;
  onQualityChange: (quality: SplatQuality) => void;
}

export function RenderSettings({ method, quality, counts, office, ready, error, onMethodChange, onQualityChange }: RenderSettingsProps) {
  const [open, setOpen] = useState(false);
  const gaussian = method === 'gaussian';
  const count = counts.architecture + counts.guide;
  const number = new Intl.NumberFormat('en');
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-label="Rendering settings"
        aria-expanded={open}
        aria-controls="render-settings"
        className="studio-glass flex cursor-pointer items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-semibold text-[#3D5A52] transition hover:bg-white"
      >
        {gaussian ? <CircleDot className="h-3.5 w-3.5" /> : <Box className="h-3.5 w-3.5" />}
        <span>{gaussian ? 'Spark.js / Gaussian' : 'Triangle preview'}</span>
        {gaussian && <span className="font-mono-tech text-[10px] font-normal text-[#6B6860]">{ready ? `${(count / 1000).toFixed(0)}k` : office ? 'Loading office…' : 'preparing'}</span>}
        {error && <span className="text-[10px] text-amber-800">Fallback</span>}
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <button className="fixed inset-0 z-30 cursor-default" aria-label="Dismiss rendering settings" onClick={() => setOpen(false)} />
          <div id="render-settings" className="studio-glass render-settings-enter absolute left-0 top-full z-40 mt-2 w-[290px] max-w-[calc(100vw-32px)] rounded-2xl p-3.5 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-1.5 text-xs font-bold text-[#1C1B19]"><SlidersHorizontal className="h-3.5 w-3.5" /> Render Engine</h2>
              <div className="flex items-center gap-2">
                <a href="https://sparkjs.dev/" target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[10px] text-[#6B6860] hover:text-[#C85A32]">Spark 2.4 <ExternalLink className="h-2.5 w-2.5" /></a>
                <button aria-label="Close rendering settings" onClick={() => setOpen(false)} className="cursor-pointer rounded-md p-1 text-[#6B6860] transition hover:bg-black/5 hover:text-[#1C1B19]"><X className="h-3 w-3" /></button>
              </div>
            </div>

            <div className="space-y-1" role="group" aria-label="Rendering method">
              {([
                { value: 'gaussian', label: 'Gaussian splatting', detail: 'Spark.js anisotropic 3D Gaussians', icon: CircleDot },
                { value: 'triangles', label: 'Triangle mesh', detail: office ? 'Navigation plan + original guide' : 'Original Three.js rasterized preview', icon: Box },
              ] as const).map((item) => (
                <button
                  key={item.value}
                  disabled={item.value === 'gaussian' && error !== null}
                  onClick={() => onMethodChange(item.value)}
                  aria-pressed={method === item.value}
                  className={`flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${method === item.value ? 'bg-[#3D5A52] text-white' : 'text-[#1C1B19] hover:bg-black/5'}`}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  <div className="flex-1"><div className="text-xs font-semibold">{item.label}</div><div className={`mt-0.5 text-[10px] ${method === item.value ? 'text-white/70' : 'text-[#6B6860]'}`}>{item.detail}</div></div>
                  {method === item.value && <Check className="h-3.5 w-3.5" />}
                </button>
              ))}
            </div>

            {gaussian && (
              <div className="mt-3 border-t border-black/10 pt-3">
                <div className="mb-2 flex items-center justify-between text-[10px] text-[#6B6860]"><span className="font-semibold uppercase tracking-wider">Sampling Quality</span><span>{office ? 'Office LOD + guide detail' : 'Live, editable scene'}</span></div>
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-black/5 p-1" role="group" aria-label="Gaussian sampling quality">
                  {(['balanced', 'fine'] as const).map((value) => (
                    <button key={value} onClick={() => onQualityChange(value)} aria-pressed={quality === value} className={`cursor-pointer rounded-md py-1.5 text-[11px] font-semibold capitalize transition ${quality === value ? 'bg-white text-[#1C1B19] shadow-sm' : 'text-[#6B6860] hover:text-[#1C1B19]'}`}>{value === 'fine' ? 'Fine detail' : 'Balanced'}</button>
                  ))}
                </div>
                <dl className="font-mono-tech mt-3 space-y-1 text-[10px] text-[#57534E]">
                  <div className="flex justify-between"><dt>{office ? 'Office (selected LOD)' : 'Architecture'}</dt><dd>{number.format(counts.architecture)} splats</dd></div>
                  <div className="flex justify-between"><dt>Articulated guide</dt><dd>{number.format(counts.guide)} splats</dd></div>
                </dl>
                <p className="mt-2 text-[10px] leading-relaxed text-[#6B6860]">
                  {office ? (
                    <>
                      The office is a fixed SOG capture. Plan edits change navigation and the triangle preview, not the scan. Elena keeps her animated joints.
                      <br />
                      <a className="underline" href="https://superspl.at/scene/40c67340" target="_blank" rel="noreferrer">Capture by Hilo</a>
                      {' · '}
                      <a className="underline" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>
                    </>
                  ) : 'Generated from the floorplan surfaces, with baked color and GPU-driven joints. This is not a photograph-trained capture. Navigation markers remain vector-sharp.'}
                </p>
              </div>
            )}
            {error && <p role="alert" className="mt-3 rounded-lg bg-amber-50 p-2 text-[10px] leading-relaxed text-amber-900">{error}</p>}
          </div>
        </>
      )}
    </div>
  );
}