import { useEffect, useRef, useState } from "react";
import {
  Camera,
  Plus,
  Save,
  Trash2,
  ArrowUp,
  ArrowDown,
  RefreshCw,
  Eye,
  EyeOff,
} from "lucide-react";
import { errorText, get, post, useAPI } from "../api";
import { Notice, PageHeader } from "../ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Source = {
  id: string;
  name: string;
  kind: "url" | "html";
  url: string;
  html: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  visible: boolean;
};
type Layout = { revision: number; enabled: boolean; sources: Source[] };
type Scene = {
  layout: Layout;
  renderer: {
    revision: number;
    updated_at: string;
    error?: string;
    fps: number;
  };
};
const demo = `<style>body{margin:0;background:transparent;color:white;font:700 28px system-ui}.label{display:inline-flex;gap:14px;align-items:center;background:#121820dd;border-left:5px solid #ec4266;border-radius:8px;padding:18px 24px}small{color:#8ef0cd;font-size:15px}</style><div class="label"><small>● LIVE</small><span>Osmo Action 5</span><span id="clock"></span></div><script>setInterval(()=>document.getElementById('clock').textContent=new Date().toLocaleTimeString(),1000)</script>`;
export function StudioPage() {
  const state = useAPI<Scene>("scene", undefined, 1000);
  const stream = useAPI<{
    running: boolean;
    config: { overlay_frame?: string };
  }>("livestream", undefined, 2000);
  const [layout, setLayout] = useState<Layout>();
  const [selected, setSelected] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.data && !layout) setLayout(state.data.layout);
  }, [state.data, layout]);
  useEffect(() => {
    const timer = setInterval(() => setTick((v) => v + 1), 500);
    return () => clearInterval(timer);
  }, []);
  const source = layout?.sources.find((s) => s.id === selected);
  const change = (fn: (s: Layout) => Layout) => {
    setLayout((s) => (s ? fn(s) : s));
    setDirty(true);
  };
  const update = (v: Partial<Source>) =>
    change((s) => ({
      ...s,
      sources: s.sources.map((x) => (x.id === selected ? { ...x, ...v } : x)),
    }));
  const add = () => {
    const id = crypto.randomUUID?.() ?? `source-${Date.now()}`;
    change((s) => ({
      ...s,
      sources: [
        ...s.sources,
        {
          id,
          name: `Browser ${s.sources.length + 1}`,
          kind: "html",
          url: "",
          html: demo,
          x: 40,
          y: 580,
          width: 650,
          height: 100,
          opacity: 1,
          visible: true,
        },
      ],
    }));
    setSelected(id);
  };
  const save = async () => {
    if (!layout) return;
    setBusy(true);
    setError("");
    try {
      const r = await post<{ layout: Layout }>("scene", layout);
      setLayout(r.layout);
      setDirty(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    try {
      const v = await get<Scene>("scene");
      setLayout(v.layout);
      setDirty(false);
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  };
  const moveLayer = (delta: number) =>
    change((s) => {
      const a = [...s.sources],
        i = a.findIndex((x) => x.id === selected),
        j = i + delta;
      if (i < 0 || j < 0 || j >= a.length) return s;
      [a[i], a[j]] = [a[j], a[i]];
      return { ...s, sources: a };
    });
  const drag = (event: React.PointerEvent, item: Source, resize = false) => {
    event.preventDefault();
    event.stopPropagation();
    setSelected(item.id);
    const el = event.currentTarget as HTMLElement;
    el.setPointerCapture(event.pointerId);
    const startX = event.clientX,
      startY = event.clientY,
      scale = 1280 / (stage.current?.clientWidth || 1280);
    const move = (e: PointerEvent) => {
      const dx = Math.round((e.clientX - startX) * scale),
        dy = Math.round((e.clientY - startY) * scale);
      const patch = resize
        ? {
            width: Math.max(32, Math.min(1280 - item.x, item.width + dx)),
            height: Math.max(24, Math.min(720 - item.y, item.height + dy)),
          }
        : {
            x: Math.max(0, Math.min(1280 - item.width, item.x + dx)),
            y: Math.max(0, Math.min(720 - item.height, item.y + dy)),
          };
      change((s) => ({
        ...s,
        sources: s.sources.map((v) =>
          v.id === item.id ? { ...v, ...patch } : v,
        ),
      }));
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };
  const ready =
    state.data &&
    !state.data.renderer.error &&
    state.data.renderer.revision === layout?.revision &&
    Date.now() - Date.parse(state.data.renderer.updated_at) < 10000;
  return (
    <>
      <PageHeader
        title="Studio"
        description="Compose browser overlays over the camera feed. Saved scenes burn into outgoing SRT."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={reload} disabled={busy}>
              <RefreshCw className="size-4" />
              Reload
            </Button>
            <Button onClick={save} disabled={!dirty || busy}>
              <Save className="size-4" />
              {busy ? "Saving…" : "Save scene"}
            </Button>
          </div>
        }
      />
      {error && <Notice tone="error">{error}</Notice>}
      {state.error && <Notice tone="error">{errorText(state.error)}</Notice>}
      {state.data?.renderer.error && (
        <Notice tone="error">
          Overlay renderer: {state.data.renderer.error}. The stream stops if its
          overlay frame is stale for 15 seconds.
        </Notice>
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-3">
          <div className="overflow-hidden rounded-xl border border-slate-700 bg-[#10151d] shadow-lg">
            <div className="flex justify-between px-4 py-3 text-xs text-slate-300">
              <span>PROGRAM · 16:9</span>
              <span>
                {dirty
                  ? "UNSAVED CHANGES"
                  : ready
                    ? "RENDERER READY"
                    : "RENDERER STARTING"}
              </span>
            </div>
            <div
              ref={stage}
              className="relative aspect-video touch-none select-none overflow-hidden bg-gradient-to-br from-slate-800 via-slate-900 to-black"
              onPointerDown={() => setSelected("")}
            >
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-slate-500">
                <Camera className="size-12" />
                <span className="text-sm">Camera background</span>
                <span className="text-xs">
                  Live camera preview unavailable · camera video is present in
                  SRT
                </span>
              </div>
              <img
                src={`/api/scene/frame.png?t=${tick}`}
                alt="Saved browser overlays"
                className="pointer-events-none absolute inset-0 size-full object-fill"
                onError={(e) => {
                  e.currentTarget.style.visibility = "hidden";
                }}
                onLoad={(e) => {
                  e.currentTarget.style.visibility = "visible";
                }}
              />
              {layout?.sources.map(
                (v, i) =>
                  v.visible && (
                    <div
                      key={v.id}
                      onPointerDown={(e) => drag(e, v)}
                      className={`absolute cursor-move border ${selected === v.id ? "border-emerald-400 bg-emerald-400/5" : "border-dashed border-white/30"}`}
                      style={{
                        left: `${v.x / 12.8}%`,
                        top: `${v.y / 7.2}%`,
                        width: `${v.width / 12.8}%`,
                        height: `${v.height / 7.2}%`,
                        zIndex: i + 1,
                      }}
                    >
                      <span className="absolute -top-5 left-0 max-w-full truncate rounded bg-black/80 px-1 text-[10px] text-white">
                        {v.name}
                      </span>
                      {selected === v.id && (
                        <button
                          aria-label="Resize source"
                          onPointerDown={(e) => drag(e, v, true)}
                          className="absolute -right-1.5 -bottom-1.5 size-3 rounded-sm border border-black bg-emerald-400"
                        />
                      )}
                    </div>
                  ),
              )}
            </div>
            <div className="flex justify-between px-4 py-3 text-xs text-slate-400">
              <span>1280 × 720 layout · scaled to stream resolution</span>
              <span>Browser capture: up to 2 fps</span>
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-medium">Sources</h2>
              <Button
                size="sm"
                variant="outline"
                disabled={!layout || layout.sources.length >= 4}
                onClick={add}
              >
                <Plus className="size-4" />
                Browser source
              </Button>
            </div>
            <div className="flex items-center gap-3 rounded-md bg-muted/50 px-3 py-2 text-sm">
              <Camera className="size-4" />
              Camera
              <span className="ml-auto text-xs text-muted-foreground">
                Background · locked
              </span>
            </div>
            {[...(layout?.sources ?? [])].reverse().map((v) => (
              <div
                key={v.id}
                className={`mt-1 flex items-center gap-2 rounded-md px-2 py-1 ${selected === v.id ? "bg-accent" : ""}`}
              >
                <button
                  aria-label={v.visible ? `Hide ${v.name}` : `Show ${v.name}`}
                  onClick={() =>
                    change((s) => ({
                      ...s,
                      sources: s.sources.map((x) =>
                        x.id === v.id ? { ...x, visible: !x.visible } : x,
                      ),
                    }))
                  }
                >
                  {v.visible ? (
                    <Eye className="size-4" />
                  ) : (
                    <EyeOff className="size-4" />
                  )}
                </button>
                <button
                  className="flex-1 py-1 text-left text-sm"
                  onClick={() => setSelected(v.id)}
                >
                  {v.name}
                </button>
                <span className="text-xs text-muted-foreground">
                  {v.kind === "url" ? "Web URL" : "HTML"}
                </span>
              </div>
            ))}
            {!layout?.sources.length && (
              <p className="mt-3 text-sm text-muted-foreground">
                Add a browser source for a scoreboard, chat, clock, or custom
                graphic.
              </p>
            )}
          </div>
        </div>
        <div className="space-y-4">
          <div className="rounded-xl border bg-card p-4">
            <h2 className="mb-3 font-medium">Output</h2>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={layout?.enabled ?? false}
                onChange={(e) =>
                  change((s) => ({ ...s, enabled: e.target.checked }))
                }
              />
              Burn scene into SRT
            </label>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Enable and save before starting a stream. Source edits,
              visibility, and order update live after saving. Disable and save
              to clear overlays.
            </p>
            {stream.data?.running &&
              !stream.data.config.overlay_frame &&
              layout?.enabled && (
                <p className="mt-2 text-xs text-amber-600">
                  Restart the stream to enable its overlay layer.
                </p>
              )}
            <p className="mt-2 text-xs text-muted-foreground">
              Pages render on the camera, even when this UI is closed. Browser
              audio is excluded.
            </p>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-medium">Source properties</h2>
              {source && (
                <div className="flex">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Move layer up"
                    onClick={() => moveLayer(1)}
                  >
                    <ArrowUp className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Move layer down"
                    onClick={() => moveLayer(-1)}
                  >
                    <ArrowDown className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Delete source"
                    onClick={() => {
                      change((s) => ({
                        ...s,
                        sources: s.sources.filter((v) => v.id !== selected),
                      }));
                      setSelected("");
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              )}
            </div>
            {!source ? (
              <p className="text-sm text-muted-foreground">
                Select a source to edit. Drag it on the canvas to move; use the
                corner handle to resize.
              </p>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="source-name">Name</Label>
                  <Input
                    id="source-name"
                    value={source.name}
                    onChange={(e) => update({ name: e.target.value })}
                    maxLength={100}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="source-kind">Content</Label>
                  <select
                    id="source-kind"
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={source.kind}
                    onChange={(e) =>
                      update({ kind: e.target.value as Source["kind"] })
                    }
                  >
                    <option value="url">Web URL</option>
                    <option value="html">Custom HTML</option>
                  </select>
                </div>
                {source.kind === "url" ? (
                  <div className="space-y-2">
                    <Label htmlFor="source-url">URL</Label>
                    <Input
                      id="source-url"
                      placeholder="https://…"
                      value={source.url}
                      onChange={(e) => update({ url: e.target.value })}
                    />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="source-html">HTML / CSS / JavaScript</Label>
                    <textarea
                      id="source-html"
                      className="h-48 w-full rounded-md border bg-background p-2 font-mono text-xs"
                      value={source.html}
                      maxLength={12000}
                      onChange={(e) => update({ html: e.target.value })}
                    />
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  {(
                    [
                      ["x", "X"],
                      ["y", "Y"],
                      ["width", "Width"],
                      ["height", "Height"],
                    ] as const
                  ).map(([key, label]) => (
                    <div key={key} className="space-y-2">
                      <Label htmlFor={`source-${key}`}>{label}</Label>
                      <Input
                        id={`source-${key}`}
                        type="number"
                        min={key === "width" ? 32 : key === "height" ? 24 : 0}
                        max={key === "x" || key === "width" ? 1280 : 720}
                        value={source[key]}
                        onChange={(e) =>
                          update({ [key]: Number(e.target.value) })
                        }
                      />
                    </div>
                  ))}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="source-opacity">
                    Opacity · {Math.round(source.opacity * 100)}%
                  </Label>
                  <input
                    id="source-opacity"
                    type="range"
                    className="w-full accent-emerald-500"
                    min="0"
                    max="100"
                    value={Math.round(source.opacity * 100)}
                    onChange={(e) =>
                      update({ opacity: Number(e.target.value) / 100 })
                    }
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
