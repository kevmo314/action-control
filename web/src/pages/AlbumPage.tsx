import { useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Folder,
  Image,
  Maximize,
  Minimize,
  Pencil,
  Play,
  RefreshCw,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { apiURL, errorText, get, invalidate, post, useAPI } from "../api";
import type {
  MediaIndexStatus,
  MediaInfo,
  MediaItem,
  MediaListing,
  NativeMediaMeta,
} from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  EmptyState,
  Notice,
  PageHeader,
  Spinner,
  formatBytes,
  formatDate,
} from "../ui";
import { ConfirmButton, Modal } from "../dialogs";
import {
  pageLink,
  parentPath,
  routeParam,
  storageRoot,
  usePageScroll,
  useViewState,
} from "../lib/view-state";

function infoKey(item: MediaItem) {
  return ["media_info", { file: item.path, mtime: item.mtime }] as const;
}

function Thumbnail({ item }: { item: MediaItem }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const info = useQuery<MediaInfo>({
    queryKey: infoKey(item),
    queryFn: ({ signal }) => get("media_info", { file: item.path }, signal),
    enabled: item.type === "video" && loaded,
    staleTime: Infinity,
  });
  const duration = info.data?.duration_sec;
  return (
    <>
      {failed ? (
        <span className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
          <Image className="size-7" />
          No thumbnail
        </span>
      ) : (
        <img
          loading="lazy"
          decoding="async"
          src={apiURL("thumbnail", { file: item.path, v: item.mtime })}
          alt=""
          className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
      {item.type === "video" && (
        <span className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-1 rounded bg-black/70 px-2 py-1 text-xs text-white">
          <Play className="size-3" />
          {duration == null
            ? "Video"
            : `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, "0")}`}
        </span>
      )}
    </>
  );
}

function NativeMeta({ meta }: { meta: NativeMediaMeta }) {
  const entries: [string, string][] = [];
  if (meta.rating != null && meta.rating > 0)
    entries.push(["Favorite", "★".repeat(Math.min(5, meta.rating))]);
  if (meta.highlight) entries.push(["Highlight marker", "Yes"]);
  if (meta.ev_bias != null && meta.ev_bias !== 0)
    entries.push(["EV", `Code ${meta.ev_bias}`]);
  if (meta.nd_value != null && meta.nd_value > 0)
    entries.push(["ND", `Code ${meta.nd_value}`]);
  if (meta.ei_value != null && meta.ei_value > 0)
    entries.push(["EI", String(meta.ei_value)]);
  if (meta.aperture_raw != null && meta.aperture_raw > 0)
    entries.push(["Aperture", `f/${(meta.aperture_raw / 100).toFixed(1)}`]);
  if (meta.steady_mode_raw != null)
    entries.push(["Stabilization", `Code ${meta.steady_mode_raw}`]);
  if (meta.fov_type_raw != null)
    entries.push(["Field of view", `Code ${meta.fov_type_raw}`]);
  if (meta.rotation != null && meta.rotation !== 0)
    entries.push(["Rotation", `${meta.rotation}°`]);
  if (meta.slowmotion_rate != null && meta.slowmotion_rate > 1)
    entries.push(["Slow motion", `${meta.slowmotion_rate}×`]);
  if (meta.gps_status != null && meta.gps_status > 0)
    entries.push(["GPS", "Recorded"]);
  if (entries.length === 0) return null;
  return (
    <div className="mt-3 border-t pt-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide">
        Native camera settings
      </p>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {entries.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function AlbumPage() {
  const linkedFile = routeParam("file");
  const [dir, setDir] = useViewState(
    "album.dir",
    "/emulated",
    routeParam("dir"),
  );
  const [filter, setFilter] = useViewState(
    "album.filter",
    "all",
    linkedFile ? "all" : undefined,
  );
  const [search, setSearch] = useViewState(
    "album.search",
    "",
    linkedFile?.split("/").pop(),
  );
  const [sort, setSort] = useViewState("album.sort", "newest");
  const [querySearch, setQuerySearch] = useState(search);
  const [selected, setSelected] = useState<Map<string, MediaItem>>(new Map());
  const [preview, setPreview] = useState<string | null>(linkedFile ?? null);
  const [previewError, setPreviewError] = useState("");
  const [rename, setRename] = useState<MediaItem | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const queryClient = useQueryClient();
  useEffect(() => {
    const timer = window.setTimeout(() => setQuerySearch(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const mediaKey = [
    "media_list",
    { dir, type: filter, search: querySearch, sort },
  ] as const;
  const pageParams = {
    dir,
    type: filter,
    search: querySearch,
    sort,
    limit: 80,
  };
  const media = useInfiniteQuery({
    queryKey: mediaKey,
    queryFn: ({ pageParam, signal }) =>
      get<MediaListing>(
        "media_list",
        { ...pageParams, cursor: pageParam || undefined },
        signal,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor || undefined,
  });
  usePageScroll("album", !media.isPending);
  const mediaIndex = useAPI<MediaIndexStatus>("media_index_status", {
    storage: storageRoot(dir) === "/sd" ? "sd" : "emulated",
  });
  const items = media.data?.pages.flatMap((page) => page.items) ?? [];
  const listing = media.data?.pages[0];
  const current = items.find((item) => item.path === preview);
  const index = items.findIndex((item) => item.path === preview);
  const selectedItems = [...selected.values()];
  const info = useQuery<MediaInfo>({
    queryKey: current ? infoKey(current) : ["media_info", { file: preview }],
    queryFn: ({ signal }) => get("media_info", { file: preview! }, signal),
    enabled: Boolean(current),
    staleTime: Infinity,
  });
  useEffect(() => {
    setSelected(new Map());
  }, [dir, filter, querySearch, sort]);
  useEffect(() => {
    setPreviewError("");
    setZoom(1);
  }, [preview]);
  useEffect(() => {
    const update = () =>
      setFullscreen(document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  async function refresh() {
    setRefreshing(true);
    setError("");
    try {
      await queryClient.cancelQueries({ queryKey: mediaKey, exact: true });
      const first = await get<MediaListing>("media_list", {
        ...pageParams,
        refresh: true,
      });
      queryClient.setQueryData(mediaKey, { pages: [first], pageParams: [""] });
      await invalidate("list", "disk_usage", "media_index_status");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setRefreshing(false);
    }
  }

  function changeDir(value: string) {
    setDir(value);
    setSearch("");
    setQuerySearch("");
    setPreview(null);
  }
  function step(direction: number) {
    const item = items[index + direction];
    if (item) setPreview(item.path);
  }
  function toggle(item: MediaItem) {
    setSelected((previous) => {
      const next = new Map(previous);
      if (next.has(item.path)) next.delete(item.path);
      else next.set(item.path, item);
      return next;
    });
  }
  function download(files: MediaItem[]) {
    for (const item of files) {
      const link = document.createElement("a");
      link.href = apiURL("download", { file: item.path, dl: 1 });
      link.download = item.name;
      document.body.append(link);
      link.click();
      link.remove();
    }
  }
  async function remove(files: MediaItem[]) {
    setBusy(true);
    setError("");
    const warnings: string[] = [];
    try {
      for (const item of files) {
        let result: { ok: boolean; warning?: string };
        try {
          result = await post<{ ok: boolean; warning?: string }>(
            "delete",
            { path: item.path },
            "DELETE",
          );
        } catch (cause) {
          throw new Error(
            `“${item.name}” could not be deleted: ${errorText(cause)}; deleted files will not be restored. Remaining files stay selected.`,
          );
        }
        // File is deleted even when the index sync is deferred; deselect it.
        if (result.warning) warnings.push(`“${item.name}”: ${result.warning}`);
        setSelected((previous) => {
          const next = new Map(previous);
          next.delete(item.path);
          return next;
        });
        if (preview === item.path) setPreview(null);
      }
      if (warnings.length) {
        setError(
          `File deleted. Native camera services are using the media index. Sync it later with Clean stale index on the System page: ${warnings.join("; ")}`,
        );
      }
    } finally {
      setBusy(false);
      await refresh();
    }
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (stage.current?.requestFullscreen)
        await stage.current.requestFullscreen();
      else
        setPreviewError(
          "This browser does not support fullscreen. Zoom in to inspect image details.",
        );
    } catch {
      setPreviewError(
        "Fullscreen was not allowed by the browser. Zoom in to inspect image details.",
      );
    }
  }

  const groups: { name: string; items: MediaItem[] }[] = [];
  for (const item of items) {
    const date =
      sort === "newest" || sort === "oldest"
        ? new Date(item.mtime * 1000).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : "";
    let group = groups[groups.length - 1];
    if (!group || group.name !== date) {
      group = { name: date, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }

  return (
    <>
      <PageHeader
        title="Album"
        description="Find photos and videos by date, preview them, or download originals."
        actions={
          <Button
            variant="outline"
            disabled={media.isFetching || busy || refreshing}
            onClick={() => void refresh()}
          >
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
            Refresh
          </Button>
        }
      />
      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-[160px_220px_minmax(160px,1fr)_150px]">
        <div>
          <Label htmlFor="album-storage">Storage location</Label>
          <Select
            value={storageRoot(dir)}
            disabled={busy}
            onValueChange={changeDir}
          >
            <SelectTrigger id="album-storage" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="/emulated">Internal storage</SelectItem>
              <SelectItem value="/sd">SD card</SelectItem>
              <SelectItem value="/">Blackbox</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label id="album-kind-label">Media type</Label>
          <Tabs
            value={filter}
            onValueChange={setFilter}
            aria-labelledby="album-kind-label"
          >
            <TabsList className="w-full">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="image">Photos</TabsTrigger>
              <TabsTrigger value="video">Video</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div>
          <Label htmlFor="album-search">Filename</Label>
          <Input
            id="album-search"
            placeholder="Search media…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="album-sort">Sort</Label>
          <Select value={sort} onValueChange={setSort}>
            <SelectTrigger id="album-sort" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Recently modified</SelectItem>
              <SelectItem value="oldest">Oldest modified</SelectItem>
              <SelectItem value="name">Filename</SelectItem>
              <SelectItem value="largest">File size</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {dir !== storageRoot(dir) && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <Folder className="size-4" />
          <span className="break-all">{dir}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => changeDir(storageRoot(dir))}
          >
            View entire storage
          </Button>
        </div>
      )}
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {listing?.truncated && (
        <div className="mb-4">
          <Notice tone="warning">
            The list reached 100,000 items or the directory depth limit. Open a
            specific folder on the Files page to browse further.
          </Notice>
        </div>
      )}
      {!!listing?.warnings.length && (
        <details className="mb-4 rounded-lg border p-3 text-sm">
          <summary className="cursor-pointer text-amber-700 dark:text-amber-300">
            Some directories could not be read. The list may be incomplete.
          </summary>
          <ul className="mt-2 break-all text-muted-foreground">
            {listing.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
      {mediaIndex.data?.available && mediaIndex.data.stale > 0 && (
        <div className="mb-4">
          <Notice tone="warning">
            Found {mediaIndex.data.stale} stale media records.
            <a
              href="#/system?section=maintenance"
              className="ml-2 underline underline-offset-4"
            >
              Go to backup and cleanup
            </a>
          </Notice>
        </div>
      )}
      {selectedItems.length > 0 && (
        <div className="sticky top-16 z-10 mb-5 flex flex-wrap items-center gap-2 rounded-lg border bg-card/95 p-3 shadow-sm backdrop-blur">
          <Badge>
            Selected {selectedItems.length} items ·{" "}
            {formatBytes(
              selectedItems.reduce((total, item) => total + item.size, 0),
            )}
          </Badge>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setSelected(new Map())}
          >
            Clear selection
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => download(selectedItems)}
          >
            <Download />
            Download
          </Button>
          {selectedItems.length === 1 && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setRename(selectedItems[0]);
                setName(selectedItems[0].name);
                setError("");
              }}
            >
              <Pencil />
              Rename
            </Button>
          )}
          <ConfirmButton
            title={`Delete ${selectedItems.length} files?`}
            description="Permanently deletes selected media. This cannot be undone. Stops on the first failure and keeps remaining files selected."
            variant="destructive"
            disabled={busy}
            onConfirm={() => remove(selectedItems)}
          >
            <Trash2 />
            Delete
          </ConfirmButton>
          {selectedItems.length > 1 && (
            <span className="w-full text-xs text-muted-foreground">
              Your browser may ask permission to download multiple files.
            </span>
          )}
        </div>
      )}
      {media.isPending ? (
        <Spinner />
      ) : media.isError && !items.length ? (
        <Notice tone="error">
          Cannot read media: {media.error.message}
          <Button
            variant="outline"
            className="mt-2"
            onClick={() => void refresh()}
          >
            Read again
          </Button>
        </Notice>
      ) : !items.length ? (
        <EmptyState
          title="No media found"
          description={
            search || filter !== "all"
              ? "Adjust the filename or media type filter."
              : "No photos or videos to browse in this storage yet."
          }
          action={
            search || filter !== "all" ? (
              <Button
                variant="outline"
                onClick={() => {
                  setSearch("");
                  setFilter("all");
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>
              Loaded {items.length} / {listing?.count ?? items.length} files
              {search !== querySearch ? " · Filtering…" : ""}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                setSelected(new Map(items.map((item) => [item.path, item])))
              }
            >
              Select loaded items
            </Button>
          </div>
          <div className="space-y-7">
            {groups.map((group) => (
              <section key={group.name}>
                {group.name && (
                  <h2 className="mb-3 text-sm font-medium">
                    {group.name}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      Date modified
                    </span>
                  </h2>
                )}
                <ul className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
                  {group.items.map((item) => (
                    <li
                      key={`${item.path}:${item.mtime}`}
                      className="group min-w-0 overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-md"
                    >
                      <div className="relative aspect-[4/3] bg-secondary">
                        <button
                          className="h-full w-full overflow-hidden focus-visible:outline-2 focus-visible:outline-primary"
                          aria-label={`Preview ${item.name}`}
                          onClick={() => setPreview(item.path)}
                        >
                          <Thumbnail item={item} />
                        </button>
                        <Checkbox
                          checked={selected.has(item.path)}
                          disabled={busy}
                          aria-label={`${selected.has(item.path) ? "Clear selection" : "Select"} ${item.name}`}
                          className="absolute left-2 top-2 z-10 size-6 border-white/70 bg-black/30 text-white shadow-sm md:size-5"
                          onCheckedChange={() => toggle(item)}
                        />
                      </div>
                      <div className="p-3">
                        <p
                          className="truncate text-sm font-medium"
                          title={item.name}
                        >
                          {item.name}
                        </p>
                        <div className="mt-1 flex flex-wrap justify-between gap-1 text-xs text-muted-foreground">
                          <span>{formatBytes(item.size)}</span>
                          <span>{item.ext.slice(1).toUpperCase()}</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          {media.isFetchNextPageError && (
            <div className="mt-4">
              <Notice tone="warning">
                {media.error?.message}
                <Button
                  variant="outline"
                  className="ml-2"
                  onClick={() => void refresh()}
                >
                  Refresh list
                </Button>
              </Notice>
            </div>
          )}
          {media.hasNextPage && (
            <div className="mt-6 text-center">
              <Button
                variant="outline"
                disabled={media.isFetching || refreshing}
                onClick={() => void media.fetchNextPage()}
              >
                {media.isFetchingNextPage
                  ? "Loading…"
                  : `Load more (${(listing?.count ?? 0) - items.length} remaining)`}
              </Button>
            </div>
          )}
        </>
      )}
      <Modal
        open={Boolean(current)}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        title={current?.name ?? "Media preview"}
        description={
          current
            ? `${formatBytes(current.size)} · ${formatDate(current.mtime)}`
            : undefined
        }
        size="media"
      >
        {current && (
          <div
            className="min-w-0"
            onKeyDown={(event) => {
              if (
                (event.target as HTMLElement).closest(
                  "video,input,textarea,select,[role=combobox]",
                )
              )
                return;
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                step(-1);
              }
              if (event.key === "ArrowRight") {
                event.preventDefault();
                step(1);
              }
            }}
          >
            <div
              ref={stage}
              className={`media-stage relative flex min-h-48 max-h-[65dvh] overflow-auto rounded-lg bg-black ${zoom === 1 ? "items-center justify-center" : "items-start justify-start"}`}
              onTouchStart={(event) => {
                touch.current =
                  zoom !== 1 || (event.target as HTMLElement).closest("video")
                    ? null
                    : {
                        x: event.touches[0].clientX,
                        y: event.touches[0].clientY,
                      };
              }}
              onTouchEnd={(event) => {
                if (touch.current) {
                  const dx = event.changedTouches[0].clientX - touch.current.x;
                  const dy = event.changedTouches[0].clientY - touch.current.y;
                  if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5)
                    step(dx > 0 ? -1 : 1);
                  touch.current = null;
                }
              }}
            >
              {current.type === "video" ? (
                <video
                  key={current.path}
                  controls
                  playsInline
                  preload="metadata"
                  className="max-h-[65dvh] w-full"
                  src={apiURL("video_stream", { file: current.path })}
                  onError={() =>
                    setPreviewError(
                      "This browser cannot play the video. Download the original and open it in a player that supports its codec.",
                    )
                  }
                />
              ) : (
                <img
                  key={current.path}
                  src={apiURL("download", {
                    file: current.path,
                    v: current.mtime,
                  })}
                  alt={current.name}
                  className={
                    zoom === 1
                      ? "max-h-[65dvh] max-w-full object-contain"
                      : "max-w-none shrink-0"
                  }
                  style={zoom === 1 ? undefined : { width: `${zoom * 100}%` }}
                  onError={() =>
                    setPreviewError(
                      "Cannot preview this image. Download the original to view it.",
                    )
                  }
                />
              )}
              {fullscreen && (
                <Button
                  variant="secondary"
                  className="fixed right-4 top-4"
                  onClick={() => void toggleFullscreen()}
                >
                  <Minimize />
                  Exit fullscreen
                </Button>
              )}
            </div>
            {previewError && (
              <div className="mt-3">
                <Notice tone="warning">{previewError}</Notice>
              </div>
            )}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Previous item"
                  disabled={index <= 0}
                  onClick={() => step(-1)}
                >
                  <ChevronLeft />
                </Button>
                <span className="text-sm tabular-nums">
                  {index + 1} / {listing?.count ?? items.length}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Next item"
                  disabled={index < 0 || index >= items.length - 1}
                  onClick={() => step(1)}
                >
                  <ChevronRight />
                </Button>
                {index === items.length - 1 && media.hasNextPage && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={media.isFetching}
                    onClick={() => void media.fetchNextPage()}
                  >
                    Load more media
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {current.type === "image" && (
                  <>
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label="Zoom out"
                      disabled={zoom === 1}
                      onClick={() =>
                        setZoom((value) => Math.max(1, value - 0.5))
                      }
                    >
                      <ZoomOut />
                    </Button>
                    <Button variant="ghost" onClick={() => setZoom(1)}>
                      {zoom === 1 ? "Fit to window" : `${zoom * 100}%`}
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label="Zoom in"
                      disabled={zoom >= 4}
                      onClick={() =>
                        setZoom((value) => Math.min(4, value + 0.5))
                      }
                    >
                      <ZoomIn />
                    </Button>
                  </>
                )}
                <Button
                  variant="outline"
                  onClick={() => void toggleFullscreen()}
                >
                  <Maximize />
                  Fullscreen
                </Button>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2 border-t pt-4">
              <Button asChild variant="outline">
                <a
                  href={apiURL("download", { file: current.path, dl: 1 })}
                  download={current.name}
                >
                  <Download />
                  Download original
                </a>
              </Button>
              <Button asChild variant="outline">
                <a
                  href={pageLink("files", {
                    dir: parentPath(current.path),
                    search: current.name,
                  })}
                >
                  <Folder />
                  Containing folder
                </a>
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setRename(current);
                  setName(current.name);
                  setError("");
                }}
              >
                <Pencil />
                Rename
              </Button>
              <ConfirmButton
                title="Delete this media?"
                description={`Permanently delete “${current.name}”. This cannot be undone.`}
                disabled={busy}
                onConfirm={() => remove([current])}
              >
                <Trash2 />
                Delete
              </ConfirmButton>
            </div>
            <details className="mt-4 rounded-lg border p-3 text-sm">
              <summary className="cursor-pointer font-medium">
                Media information
              </summary>
              <div className="mt-3 break-all text-muted-foreground">
                <p>{current.path}</p>
                {info.isPending ? (
                  <Spinner />
                ) : info.error ? (
                  <Notice tone="warning">{info.error.message}</Notice>
                ) : (
                  info.data && (
                    <>
                      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                        <div>
                          <dt>Resolution</dt>
                          <dd>
                            {info.data.width} × {info.data.height}
                          </dd>
                        </div>
                        <div>
                          <dt>Codec</dt>
                          <dd>{info.data.codec}</dd>
                        </div>
                        {info.data.fps != null && (
                          <div>
                            <dt>Frame rate</dt>
                            <dd>{info.data.fps.toFixed(2)} fps</dd>
                          </div>
                        )}
                        {info.data.duration_sec != null && (
                          <div>
                            <dt>Duration</dt>
                            <dd>{info.data.duration_sec.toFixed(1)} sec</dd>
                          </div>
                        )}
                        {info.data.bitrate_bps != null && (
                          <div>
                            <dt>Bitrate</dt>
                            <dd>
                              {(info.data.bitrate_bps / 1e6).toFixed(2)} Mbps
                            </dd>
                          </div>
                        )}
                      </dl>
                      {info.data.native && (
                        <NativeMeta meta={info.data.native} />
                      )}
                    </>
                  )
                )}
              </div>
            </details>
          </div>
        )}
      </Modal>
      <Modal
        open={Boolean(rename)}
        onOpenChange={(open) => {
          if (!open && !busy) setRename(null);
        }}
        title="Rename media"
        description="Keep the correct file extension. Existing files are never overwritten."
      >
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!rename) return;
            setBusy(true);
            setError("");
            try {
              await post("rename", { path: rename.path, name });
              setSelected((previous) => {
                const next = new Map(previous);
                next.delete(rename.path);
                return next;
              });
              setPreview(null);
              setRename(null);
              await refresh();
            } catch (cause) {
              setError(errorText(cause));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Label htmlFor="media-name">Name</Label>
          <Input
            id="media-name"
            autoFocus
            required
            maxLength={255}
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex justify-end">
            <Button type="submit" disabled={busy || !name}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
