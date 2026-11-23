import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  Check,
  ChevronDown,
  FileBox,
  FolderOpen,
  Footprints,
  Library,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  UserRound,
  UserRoundPlus,
  X,
} from 'lucide-react';
import type { CastState, HumanCast } from '../scene/humans/cast';
import { MAX_ACTORS, MAX_JSON_CHARS } from '../scene/humans/take';
import example from '../../docs/prompts/human-motion-v1.example.json';
import rigTake from '../../docs/prompts/man-rig.walk-and-greet.json';
import { library, type LibraryId } from '../scene/humans/library';

interface Props {
  cast: RefObject<HumanCast | null>;
  state: CastState;
  office: boolean;
  onInserted: (names: string[]) => void;
}
const smallButton =
  'inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold hover:bg-black/5 cursor-pointer disabled:opacity-40';

export function HumanInsertMenu(props: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Insert human"
        title="Insert human"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? 'human-library' : undefined}
        className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border border-[#3d5a52]/20 bg-[#edf3ef] px-2.5 py-1.5 text-xs font-semibold text-[#34534a] hover:bg-[#dfebe4]"
      >
        <UserRoundPlus size={15} />
        <span className="hidden lg:inline">Insert human</span>
      </button>
      {open && <LibraryDialog {...props} close={close} />}
    </>
  );
}

function LibraryDialog({ cast, state, office, onInserted, close }: Props & { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const active = useRef(true);
  const [source, setSource] = useState<'library' | 'file'>('library');
  const [libraryId, setLibraryId] = useState<LibraryId>('visitor');
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const full = state.people.length >= MAX_ACTORS;
  const rigSelected =
    source === 'library'
      ? libraryId === 'rigged'
      : files.length === 1 && files[0].name === library.rigged.file;
  useEffect(() => {
    const el = dialog.current!,
      owner = cast.current;
    el.showModal();
    active.current = true;
    return () => {
      active.current = false;
      owner?.cancelInsert();
      el.close();
    };
  }, [cast]);
  const dismiss = () => {
    cast.current?.cancelInsert();
    dialog.current?.close();
    close();
  };
  const insert = async () => {
    if (!cast.current || busy || reading) return;
    setBusy(true);
    setError('');
    try {
      const names = await cast.current.insert(source === 'library' ? libraryId : files, text);
      if (active.current) {
        onInserted(names);
        dismiss();
      }
    } catch (e) {
      if (active.current && !(e instanceof DOMException && e.name === 'AbortError'))
        setError(e instanceof Error ? e.message : 'Could not insert the model.');
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const openTake = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_JSON_CHARS) {
      setError('Choose a motion JSON file of at most 64 KiB.');
      return;
    }
    setReading(true);
    setError('');
    try {
      const content = await file.text();
      if (active.current) setText(content);
    } catch {
      if (active.current) setError('Could not read the motion JSON file.');
    } finally {
      if (active.current) setReading(false);
    }
  };
  const fillSample = () => {
    if (!rigSelected) setLibraryId('animated'); // Ada names the clips embedded in Visitor.glb.
    setText(
      JSON.stringify(
        rigSelected
          ? rigTake
          : { ...example, models: { visitor: example.models.visitor }, actors: [example.actors[0]] },
        null,
        2
      )
    );
    setError('');
  };
  return (
    <dialog
      ref={dialog}
      id="human-library"
      aria-labelledby="human-library-title"
      onCancel={(e) => {
        e.preventDefault();
        dismiss();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (e.target === dialog.current) dismiss();
      }}
      className="m-auto max-h-[calc(100dvh-24px)] w-[420px] max-w-[calc(100vw-24px)] overflow-auto rounded-2xl border border-black/10 bg-[#fcfbf8] p-0 text-[#242520] shadow-2xl backdrop:bg-[#19221d]/35"
    >
      <div className="p-5">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <p className="font-mono-tech mb-1 text-[10px] font-semibold uppercase tracking-[0.15em] text-[#54695e]">
              Scene library / People
            </p>
            <h2 id="human-library-title" className="text-xl font-bold tracking-tight">
              Insert human
            </h2>
          </div>
          <button
            onClick={dismiss}
            className={smallButton}
            aria-label="Close insert human"
            title="Close (Esc)"
          >
            <X size={16} />
          </button>
        </div>
        <fieldset disabled={busy || reading} className="min-w-0">
          <legend className="sr-only">Model source</legend>
          <div className="mb-3 flex rounded-xl border border-black/[.06] bg-[#efeee9] p-1">
            {(
              [
                { id: 'library', name: 'Studio library', Icon: Library },
                { id: 'file', name: 'Local GLB', Icon: FolderOpen },
              ] as const
            ).map(({ id, name, Icon }) => (
              <button
                key={id}
                aria-pressed={source === id}
                onClick={() => {
                  setSource(id);
                  setError('');
                }}
                className={`flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg py-2 text-xs font-semibold ${source === id ? 'bg-white text-[#354f45] shadow-sm' : 'text-[#69675e] hover:text-black'}`}
              >
                <Icon size={14} />
                {name}
              </button>
            ))}
          </div>
          {source === 'library' ? (
            <div className="flex items-stretch overflow-hidden rounded-xl border border-[#d6dfd9] bg-[#f1f5f1]">
              <div className="flex w-24 shrink-0 items-end justify-center bg-[#dbe6df]">
                <img src={library[libraryId].portrait} alt="" className="h-26 w-full object-cover" />
              </div>
              <div className="min-w-0 flex-1 px-3.5 py-3">
                <span className="font-mono-tech text-[9px] uppercase tracking-widest text-[#4b6758]">
                  Included model
                </span>
                <select
                  aria-label="Library model"
                  value={libraryId}
                  onChange={(e) => {
                    setLibraryId(e.target.value as LibraryId);
                    setError('');
                  }}
                  className="block max-w-full cursor-pointer rounded-sm text-sm font-bold text-[#354f45]"
                >
                  {Object.entries(library).map(([id, entry]) => (
                    <option key={id} value={id}>
                      {entry.title}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] leading-relaxed text-[#585e55]">
                  {library[libraryId].file}
                  <br />
                  {library[libraryId].description}
                </p>
              </div>
              <Check size={15} aria-label="Selected" className="m-3 shrink-0 text-[#416054]" />
            </div>
          ) : (
            <label className="relative block cursor-pointer rounded-xl border border-dashed border-[#95a99e] bg-[#f2f5f1] p-4 text-center focus-within:outline-2 focus-within:outline-[#3d5a52] hover:bg-[#eaf0eb]">
              <FileBox size={20} className="mx-auto mb-1.5 text-[#4a695c]" />
              <span className="block break-words text-sm font-semibold">
                {files.length ? files.map((f) => f.name).join(', ') : 'Choose GLB files'}
              </span>
              <span className="mt-1 block text-[11px] text-[#5d625a]">
                Self-contained · 8 MiB each · stays on this device
              </span>
              <input
                type="file"
                accept=".glb,model/gltf-binary"
                multiple
                aria-label="Human GLB files"
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                onChange={(e) => {
                  setFiles(Array.from(e.target.files ?? []));
                  setError('');
                }}
              />
              <span className="mt-1 block text-[10px] text-[#5d625a]">
                Feet at origin in metres · ≤32k triangles or authored LOD0–3
              </span>
            </label>
          )}
          <p className="mt-2.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-[#5d6057]">
            <Footprints size={13} className="mt-0.5 shrink-0" />
            {text.trim()
              ? 'The take sets the starting marks and motion.'
              : rigSelected
                ? 'Greets you with a wave beside Elena, then idles. No motion JSON needed.'
                : 'Placed on open floor near Elena, facing the same direction.'}
          </p>
          {office && (
            <details className="group mt-3 rounded-xl border border-black/10 bg-white px-3">
              <summary className="flex cursor-pointer list-none items-center justify-between py-2.5 text-xs font-semibold">
                Motion JSON{' '}
                <span className="ml-auto mr-2 text-[10px] font-normal text-[#6b6860]">
                  {text.trim() ? 'v1 take' : 'Optional'}
                </span>
                <ChevronDown size={13} className="group-open:rotate-180" />
              </summary>
              <p className="mb-2 text-[11px] text-[#626259]">
                Paste or open a v1 office take. Model filenames must match exactly.
              </p>
              <textarea
                aria-label="Motion JSON"
                maxLength={MAX_JSON_CHARS}
                value={text}
                spellCheck={false}
                onChange={(e) => {
                  setText(e.target.value);
                  setError('');
                }}
                placeholder={'{ "format": "planwalk.humans.v1", … }'}
                className="font-mono-tech h-22 w-full resize-y rounded-lg border border-black/10 bg-[#fafaf7] p-2 text-[11px]"
              />
              <div className="my-1 flex flex-wrap items-center justify-between gap-1">
                <label className={`${smallButton} relative focus-within:outline-2`}>
                  <FolderOpen size={12} />
                  {reading ? 'Reading…' : 'Open JSON'}
                  <input
                    type="file"
                    accept=".json,application/json"
                    aria-label="Open motion JSON file"
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    onChange={(e) => {
                      void openTake(e.currentTarget.files?.[0]);
                      e.currentTarget.value = '';
                    }}
                  />
                </label>
                {(source === 'library' || rigSelected) && (
                  <button
                    className={smallButton}
                    onClick={fillSample}
                    title={
                      rigSelected
                        ? 'Walk down the aisle, turn and wave'
                        : 'Select the animated visitor and load Ada’s take'
                    }
                  >
                    {rigSelected ? 'Use walk & greet take' : 'Use Ada’s sample take'}
                  </button>
                )}
                {text && (
                  <button
                    className={smallButton}
                    onClick={() => {
                      setText('');
                      setError('');
                    }}
                  >
                    Reset JSON
                  </button>
                )}
              </div>
            </details>
          )}
        </fieldset>
        <section aria-label="Additional humans in scene" className="mt-4 border-t border-black/10 pt-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold">In this scene</h3>
            <span className="font-mono-tech text-[10px] text-[#65685f]">
              {state.people.length} / {MAX_ACTORS} extras
            </span>
          </div>
          {!state.people.length ? (
            <p className="mt-1 text-[11px] text-[#62645c]">No extras yet. Elena stays your tour guide.</p>
          ) : (
            <>
              <ul className="mt-1">
                {state.people.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center gap-2 border-b border-dashed border-black/[.08] py-1"
                  >
                    <UserRound size={14} className="shrink-0 text-[#496457]" />
                    <span className="min-w-0 flex-1 truncate text-xs">
                      <strong>{p.label}</strong> <span className="text-[#6b6860]">· {p.file}</span>
                    </span>
                    <button
                      className={smallButton}
                      disabled={busy}
                      onClick={() => {
                        cast.current?.remove(p.id);
                        setError('');
                      }}
                      aria-label={`Remove ${p.label}`}
                      title={`Remove ${p.label}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-1 flex gap-1">
                <button
                  className={smallButton}
                  disabled={!!state.problem || busy}
                  onClick={() => cast.current?.togglePause()}
                >
                  {state.paused ? <Play size={12} /> : <Pause size={12} />}
                  {state.paused ? 'Play humans' : 'Pause humans'}
                </button>
                <button
                  className={smallButton}
                  disabled={!!state.problem || busy}
                  onClick={() => cast.current?.replay()}
                >
                  <RotateCcw size={12} />
                  Replay
                </button>
                {state.people.length > 1 && (
                  <button
                    className={`${smallButton} ml-auto`}
                    disabled={busy}
                    onClick={() => {
                      cast.current?.clear();
                      setError('');
                    }}
                  >
                    Clear extras
                  </button>
                )}
              </div>
            </>
          )}
        </section>
        {(error || state.problem) && (
          <p
            role="alert"
            className="mt-3 break-words rounded-lg bg-[#f9ebe3] px-3 py-2 text-xs leading-relaxed text-[#8b3c27]"
          >
            {error || state.problem}
          </p>
        )}
        {full && <p className="mt-2 text-[11px] text-[#62645c]">Remove a human to free a slot.</p>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button className={smallButton} onClick={dismiss}>
            Cancel
          </button>
          <button
            onClick={() => void insert()}
            disabled={busy || reading || full || (source === 'file' && !files.length)}
            className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-[#38594c] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#2b483d] disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Plus size={14} />
            {busy ? 'Inserting…' : 'Insert into scene'}
          </button>
        </div>
      </div>
    </dialog>
  );
}
