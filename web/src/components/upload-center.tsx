import { lazy, Suspense, useEffect } from "react";
import { Check, RotateCcw, Upload, X } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Progress } from "./ui/progress";
import { EmptyState, formatBytes } from "../ui";
import {
  activeUpload,
  cancelUpload,
  clearUploads,
  retryUpload,
  showUploads,
  useUploads,
} from "../lib/uploads";
import { pageLink } from "../lib/view-state";

const Modal = lazy(() =>
  import("../dialogs").then((module) => ({ default: module.Modal })),
);

const labels = {
  queued: "Queued",
  uploading: "Uploading",
  saving: "Saving",
  succeeded: "Saved",
  failed: "Upload failed",
  cancelled: "Cancelled",
};

export function UploadCenter() {
  const { tasks, open } = useUploads();
  const active = tasks.filter(activeUpload).length;
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);
  if (!tasks.length && !open) return null;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => showUploads(true)}
        aria-label={`Uploads ${active ? `, ${active} in progress` : ""}`}
      >
        <Upload />
        <span className="hidden sm:inline">Uploads</span>
        {active > 0 && <span className="tabular-nums">{active}</span>}
      </Button>
      <Suspense fallback={null}>
        <Modal
          open={open}
          onOpenChange={showUploads}
          title="Uploads"
          description="Uploads continue when switching pages. Closing or refreshing the browser interrupts them. Existing files are never overwritten."
          size="wide"
        >
          {!tasks.length ? (
            <EmptyState title="No uploads" />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">
                  {tasks.filter((task) => task.status === "succeeded").length} /{" "}
                  {tasks.length} saved{active ? ` · ${active} in progress` : ""}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={clearUploads}
                  disabled={tasks.every(activeUpload)}
                >
                  Clear completed uploads
                </Button>
              </div>
              <ul className="space-y-3">
                {tasks.map((task) => (
                  <li key={task.id} className="min-w-0 rounded-lg border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="break-all text-sm font-medium">
                          {task.name}
                        </p>
                        <a
                          className="mt-1 block break-all text-xs text-muted-foreground underline underline-offset-2"
                          href={pageLink("files", {
                            dir: task.dir,
                            search: task.name,
                          })}
                          onClick={() => showUploads(false)}
                        >
                          {task.dir}
                        </a>
                      </div>
                      <Badge
                        variant={
                          task.status === "failed" ? "destructive" : "secondary"
                        }
                      >
                        {labels[task.status]}
                      </Badge>
                    </div>
                    <Progress
                      className="mt-3"
                      aria-label={`${task.name} upload progress`}
                      value={
                        task.status === "succeeded"
                          ? 100
                          : task.status === "saving"
                            ? 99
                            : Math.min(
                                99,
                                task.size ? (task.loaded / task.size) * 100 : 0,
                              )
                      }
                    />
                    <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>
                        {formatBytes(task.loaded)} / {formatBytes(task.size)}
                        {task.status === "uploading" && task.speed > 0
                          ? ` · ${formatBytes(task.speed)}/s`
                          : ""}
                      </span>
                      {activeUpload(task) ? (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Cancel upload ${task.name}`}
                          onClick={() => cancelUpload(task.id)}
                        >
                          <X />
                        </Button>
                      ) : task.status === "succeeded" ? (
                        <Check className="size-4 text-emerald-600" />
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Retry upload ${task.name}`}
                          onClick={() => retryUpload(task.id)}
                        >
                          <RotateCcw /> Retry
                        </Button>
                      )}
                    </div>
                    {task.error && (
                      <p
                        role="status"
                        className="mt-2 break-words text-xs text-destructive"
                      >
                        {task.error}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Modal>
      </Suspense>
    </>
  );
}
