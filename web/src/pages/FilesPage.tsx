import { useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Download,
  File,
  Folder,
  FolderPlus,
  Images,
  HardDrive,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { apiURL, errorText, invalidate, post, useAPI } from "../api";
import { enqueueUploads } from "../lib/uploads";
import {
  isMediaFile,
  pageLink,
  parentPath,
  routeParam,
  usePageScroll,
  useViewState,
} from "../lib/view-state";
import type { DiskUsage, FileItem, FileListing } from "../types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  EmptyState,
  Notice,
  PageHeader,
  Spinner,
  formatBytes,
  formatDate,
} from "../ui";
import { ConfirmButton, Modal } from "../dialogs";

export function FilesPage() {
  const [dir, setDir] = useViewState("files.dir", "/", routeParam("dir"));
  const [search, setSearch] = useViewState(
    "files.search",
    "",
    routeParam("search"),
  );
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<{
    kind: "rename" | "mkdir";
    item?: FileItem;
  } | null>(null);
  const [name, setName] = useState("");
  const [formError, setFormError] = useState("");
  const [removeItem, setRemoveItem] = useState<FileItem | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const files = useAPI<FileListing>("list", { dir });
  usePageScroll("files", !files.isPending);
  const disk = useAPI<DiskUsage>("disk_usage", { path: dir });
  const items = useMemo(
    () =>
      files.data?.items.filter((item) =>
        item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
      ) ?? [],
    [files.data, search],
  );
  const refresh = () => invalidate("list", "disk_usage", "media_list");

  return (
    <>
      <PageHeader
        title="Files"
        description="Manage camera files. Track uploads in the top right corner."
        actions={
          <>
            <Button
              variant="outline"
              disabled={busy || files.isFetching}
              onClick={() => void refresh()}
            >
              <RefreshCw />
              Refresh
            </Button>
            <Button
              variant="outline"
              disabled={busy || !files.data}
              onClick={() => {
                setDialog({ kind: "mkdir" });
                setName("");
                setFormError("");
              }}
            >
              <FolderPlus />
              New directory
            </Button>
            <Button
              disabled={busy || !files.data}
              onClick={() => picker.current?.click()}
            >
              <Upload />
              Upload files
            </Button>
          </>
        }
      />
      <input
        ref={picker}
        type="file"
        multiple
        className="sr-only"
        aria-label="Select files to upload"
        onChange={(event) => {
          const selected = Array.from(event.target.files ?? []);
          event.target.value = "";
          enqueueUploads(selected, dir);
        }}
      />
      <div className="mb-5 flex flex-wrap gap-2" aria-label="Storage location">
        {[
          ["/", "Blackbox"],
          ["/sd", "SD card"],
          ["/emulated", "Internal storage"],
        ].map(([path, title]) => (
          <Button
            key={path}
            variant={
              dir === path || (path !== "/" && dir.startsWith(`${path}/`))
                ? "secondary"
                : "outline"
            }
            disabled={busy}
            onClick={() => {
              setDir(path);
              setSearch("");
              setError("");
              setMessage("");
            }}
          >
            <HardDrive />
            {title}
          </Button>
        ))}
      </div>
      <div className="mb-5 space-y-3">
        {error && <Notice tone="error">{error}</Notice>}
        {message && <Notice tone="success">{message}</Notice>}
        {busy && <Notice>Operation in progress…</Notice>}
        {disk.data && (
          <div className="rounded-xl border bg-card px-4 py-3">
            <div className="mb-2 flex flex-wrap justify-between gap-2 text-sm">
              <span>
                Used {formatBytes(disk.data.used)} /{" "}
                {formatBytes(disk.data.total)}
              </span>
              <span className="text-muted-foreground">
                Available {formatBytes(disk.data.free)}
              </span>
            </div>
            <progress
              className="h-1.5 w-full accent-primary"
              max={100}
              value={disk.data.pct}
              aria-label="Storage usage"
            />
          </div>
        )}
        {disk.error && (
          <Notice tone="warning">
            Cannot read capacity: {disk.error.message}
          </Notice>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav
            aria-label="Directory path"
            className="flex min-w-0 flex-wrap items-center gap-1 text-sm"
          >
            <Button
              variant="ghost"
              size="icon"
              aria-label="Parent directory"
              disabled={
                busy || !files.data || files.data.parent === files.data.path
              }
              onClick={() => files.data && setDir(files.data.parent)}
            >
              <ArrowUp />
            </Button>
            <ol className="flex min-w-0 flex-wrap items-center gap-1">
              {files.data?.crumbs.map((crumb, index) => (
                <li
                  key={crumb.path}
                  className="inline-flex min-w-0 max-w-full items-center gap-1"
                >
                  {index > 0 && (
                    <span aria-hidden="true" className="text-muted-foreground">
                      /
                    </span>
                  )}
                  {index === files.data!.crumbs.length - 1 ? (
                    <span
                      aria-current="page"
                      className="max-w-full truncate px-2 font-medium"
                      title={crumb.name}
                    >
                      {crumb.name}
                    </span>
                  ) : (
                    <Button
                      className="max-w-full truncate"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setDir(crumb.path)}
                    >
                      {crumb.name}
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          </nav>
          <div className="w-full sm:w-64">
            <Label htmlFor="file-search" className="sr-only">
              Filter current directory
            </Label>
            <Input
              id="file-search"
              placeholder="Filter current directory…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>
        {!!files.data?.warnings.length && (
          <div className="mb-4">
            <Notice tone="warning">
              Some entries could not be read. The list is incomplete:
              <ul className="mt-1 break-all">
                {files.data.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Notice>
          </div>
        )}
        {files.isPending ? (
          <Spinner />
        ) : files.error ? (
          <Notice tone="error">
            Cannot read directory: {files.error.message}
          </Notice>
        ) : items.length === 0 ? (
          <EmptyState
            title={
              search
                ? "No matching files"
                : files.data?.warnings.length
                  ? "No files to display"
                  : "Directory is empty"
            }
            description={
              search
                ? "Try a different filename."
                : files.data?.warnings.length
                  ? "Some entries could not be read; the directory may not be empty."
                  : "Upload files or create a directory."
            }
          />
        ) : (
          <div className="overflow-hidden rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Size</TableHead>
                  <TableHead className="hidden lg:table-cell">
                    Modified
                  </TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.path}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        {item.is_dir ? (
                          <Folder className="size-5 shrink-0 text-primary" />
                        ) : (
                          <File className="size-5 shrink-0 text-muted-foreground" />
                        )}
                        <div className="min-w-0">
                          {item.is_dir ? (
                            <button
                              disabled={busy}
                              className="max-w-[40vw] truncate text-left font-medium hover:underline sm:max-w-xs"
                              title={item.name}
                              onClick={() => setDir(item.path)}
                            >
                              {item.name}
                            </button>
                          ) : (
                            <span
                              className="block max-w-[40vw] truncate sm:max-w-xs"
                              title={item.name}
                            >
                              {item.name}
                            </span>
                          )}
                          <span className="block text-xs text-muted-foreground sm:hidden">
                            {item.is_dir ? "Directory" : formatBytes(item.size)}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {item.is_dir ? (
                        <Badge>Directory</Badge>
                      ) : (
                        formatBytes(item.size)
                      )}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">
                      {formatDate(item.mtime)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {!item.is_dir && (
                          <Button asChild variant="ghost" size="icon">
                            <a
                              href={apiURL("download", {
                                file: item.path,
                                dl: 1,
                              })}
                              download={item.name}
                              aria-label={`Download ${item.name}`}
                            >
                              <Download />
                            </a>
                          </Button>
                        )}
                        <DropdownMenu modal={false}>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={busy}
                              aria-label={`${item.name} more actions`}
                            >
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {!item.is_dir && isMediaFile(item.name) && (
                              <DropdownMenuItem asChild>
                                <a
                                  href={pageLink("album", {
                                    dir: parentPath(item.path),
                                    file: item.path,
                                  })}
                                >
                                  <Images /> View in album
                                </a>
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              onClick={() => {
                                setDialog({ kind: "rename", item });
                                setName(item.name);
                                setFormError("");
                              }}
                            >
                              <Pencil />
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => {
                                setRemoveItem(item);
                                setDeleteError("");
                              }}
                            >
                              <Trash2 />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
      <AlertDialog
        open={removeItem !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoveItem(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {removeItem?.is_dir ? "directory" : "file"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete “{removeItem?.name}”
              {removeItem?.is_dir ? " and all its contents" : ""}. This cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <Notice tone="error">{deleteError}</Notice>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={async (event) => {
                event.preventDefault();
                if (!removeItem) return;
                setBusy(true);
                setDeleteError("");
                try {
                  const result = await post<{ ok: boolean; warning?: string }>(
                    "delete",
                    { path: removeItem.path },
                    "DELETE",
                  );
                  setRemoveItem(null);
                  if (result.warning) {
                    setMessage(`File deleted. ${result.warning}`);
                  }
                  await refresh();
                } catch (error) {
                  setDeleteError(errorText(error));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Deleting…" : "Confirm deletion"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Modal
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null);
        }}
        title={dialog?.kind === "rename" ? "Rename" : "New directory"}
        description="Names cannot contain path separators. Existing destinations are never overwritten."
      >
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!dialog) return;
            setBusy(true);
            setFormError("");
            try {
              await post(dialog.kind, {
                path: dialog.kind === "rename" ? dialog.item!.path : dir,
                name,
              });
              setDialog(null);
              await refresh();
            } catch (e) {
              setFormError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div>
            <Label htmlFor="file-name">Name</Label>
            <Input
              autoFocus
              id="file-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={255}
              disabled={busy}
            />
          </div>
          {formError && <Notice tone="error">{formError}</Notice>}
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
