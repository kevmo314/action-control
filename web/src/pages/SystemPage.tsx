import { useEffect, useState } from "react";
import {
  Database,
  Eraser,
  Info,
  Play,
  RotateCcw,
  Settings2,
  ShieldAlert,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import { errorText, invalidate, post, useAPI } from "../api";
import type { Config, MediaIndexStatus, WiFiStatus } from "../types";
import { routeParam } from "../lib/view-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Card, Notice, PageHeader, Spinner } from "../ui";
import { ConfirmButton } from "../dialogs";

type CommandResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
  cwd: string;
};
function MediaIndexCard({
  storage,
  label,
  hardware,
  busy,
  perform,
}: {
  storage: "sd" | "emulated";
  label: string;
  hardware: boolean;
  busy: boolean;
  perform: (name: string, data: unknown, success: string) => Promise<void>;
}) {
  const index = useAPI<MediaIndexStatus>("media_index_status", { storage });
  return (
    <div className="rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">{label} media index</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Find AC004.db records for missing files. A database backup is
            created automatically before cleanup.
          </p>
        </div>
        <ConfirmButton
          title={`Clean stale media index entries on ${label}?`}
          description={`Delete ${index.data?.stale ?? 0} records for files that no longer exist. A database backup will be created in ${label} MISC directory before cleanup; VACUUM is not run.`}
          variant="destructive"
          disabled={
            !hardware || busy || !index.data?.available || !index.data.stale
          }
          onConfirm={() =>
            perform(
              "clean_media_index",
              { storage, confirm: true },
              `${label}: stale media index entries removed. A database backup is kept in the MISC directory.`,
            )
          }
        >
          <Database />
          Clean media index
        </ConfirmButton>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {index.isPending ? (
          <Spinner />
        ) : index.isError ? (
          <Notice tone="warning">{index.error.message}</Notice>
        ) : !index.data?.available ? (
          <Badge>{index.data?.reason ?? "Media index unavailable"}</Badge>
        ) : (
          <>
            <Badge>Total records: {index.data.total}</Badge>
            <Badge>Stale: {index.data.stale}</Badge>
            {index.data.invalid > 0 && (
              <Badge>Problem path: {index.data.invalid}</Badge>
            )}
            {Object.entries(index.data.by_type)
              .filter(([, count]) => count > 0)
              .map(([type, count]) => (
                <Badge key={type}>
                  {type}: {count}
                </Badge>
              ))}
          </>
        )}
      </div>
    </div>
  );
}

export function SystemPage() {
  const [maintenanceOpen, setMaintenanceOpen] = useState(
    routeParam("section") === "maintenance",
  );
  const health = useAPI<{ version: string; device: boolean }>(
    "health",
    undefined,
    5000,
  );
  const config = useAPI<Config>("config");
  const native = useAPI<{ status: string }>("dji_network", undefined, 5000);
  const network = useAPI<WiFiStatus>("wifi_status", undefined, 3000);

  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [command, setCommand] = useState(""),
    [cwd, setCwd] = useState("/blackbox"),
    [timeout, setTimeoutValue] = useState(15),
    [result, setResult] = useState<CommandResult | null>(null);
  const [concurrency, setConcurrency] = useState<number | null>(null);
  const hardware = health.data?.device === true && !health.isError;
  const managedNetwork = config.data?.network_control === "managed";
  const networkBusy =
    network.data?.operation?.status === "queued" ||
    network.data?.operation?.status === "running";
  useEffect(() => {
    if (config.data)
      setConcurrency((current) => current ?? config.data!.thumb_concurrent);
  }, [config.data]);

  async function perform(name: string, data: unknown, success: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await post(name, data);
      setMessage(success);
      await invalidate(
        "sysinfo",
        "camera_status",
        "native_camera_status",
        "process_list",
        "dji_network",
        "wifi_status",
        "config",
        "media_index_status",
      );
    } catch (e) {
      setError(errorText(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="System"
        description="Native services and maintenance tools. These operations run as root."
      />
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {message && (
        <div className="mb-4">
          <Notice tone="success">{message}</Notice>
        </div>
      )}
      <div className="space-y-6">
        <Card
          title="Performance settings"
          description="Adjust album thumbnail generation speed and resource usage."
        >
          {config.isError ? (
            <Notice tone="error">{config.error.message}</Notice>
          ) : config.isPending ? (
            <Spinner />
          ) : (
            <form
              className="flex flex-wrap items-end gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (concurrency != null)
                  void perform(
                    "config",
                    { thumb_concurrent: concurrency },
                    "Settings saved. Thumbnail concurrency changes take effect after the next console restart.",
                  ).catch(() => {});
              }}
            >
              <div className="min-w-0 flex-1 basis-64">
                <Label htmlFor="thumbnail-concurrency">
                  Concurrent thumbnails (requires console restart)
                </Label>
                <Input
                  id="thumbnail-concurrency"
                  type="number"
                  min={1}
                  max={8}
                  required
                  value={concurrency ?? ""}
                  onChange={(e) => setConcurrency(Number(e.target.value))}
                />
              </div>
              <Button type="submit" disabled={busy}>
                <Settings2 />
                Save settings
              </Button>
            </form>
          )}
        </Card>
        <Card
          title="Native services"
          description={
            managedNetwork
              ? "You can restore native networking here from independent management mode."
              : "Wireless connections are managed by the camera."
          }
        >
          <div className="flex flex-wrap items-center gap-3">
            <Badge>DJI network: {native.data?.status ?? "Unknown"}</Badge>
            {networkBusy && <Badge>Network operation in progress</Badge>}
            <a
              href="#/network"
              className="text-sm text-primary underline underline-offset-4"
            >
              View full network status
            </a>
          </div>
          {native.isError && (
            <p className="mt-3 text-sm text-muted-foreground">
              {native.error.message}
            </p>
          )}
          {network.data?.operation?.error && (
            <div className="mt-3">
              <Notice tone="warning">{network.data.operation.error}</Notice>
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {managedNetwork && (
              <>
                <ConfirmButton
                  title="Restore the native network?"
                  description="Stops wireless processes owned by this application and starts DJI native networking. The current Wi-Fi connection may disconnect; a queued response does not mean the switch has completed."
                  disabled={!hardware || busy || networkBusy}
                  onConfirm={() =>
                    perform(
                      "dji_network",
                      { action: "start", confirm: true },
                      "Native network start request submitted. Watch the network status.",
                    )
                  }
                >
                  <Play />
                  Start native networking
                </ConfirmButton>
                <ConfirmButton
                  title="Stop native networking?"
                  description="Stops DJI networking through the independent network unit and may disconnect the current session. Make sure ADB is available for recovery."
                  disabled={!hardware || busy || networkBusy}
                  onConfirm={() =>
                    perform(
                      "dji_network",
                      { action: "stop", confirm: true },
                      "Native network stop request submitted.",
                    )
                  }
                >
                  <Square />
                  Stop native networking
                </ConfirmButton>
              </>
            )}
            <details className="basis-full rounded-lg border p-3">
              <summary className="cursor-pointer text-sm font-medium">
                Advanced: stop native camera services
              </summary>
              <p className="my-3 text-sm text-muted-foreground">
                Interrupts native capture, displays, and the Mimo connection.
              </p>
              <ConfirmButton
                title="Stop native camera services?"
                description="Stops the native camera, displays, and Mimo communication service, then shows a protection notice on both displays. Native networking is managed separately. This does not start capture automatically. A full camera reboot is required to restore native functionality."
                disabled={!hardware || busy}
                variant="destructive"
                onConfirm={() =>
                  perform(
                    "dji_kill_all",
                    { confirm: true, takeover_native: true },
                    "Native camera services stopped. A full reboot is required to restore them.",
                  )
                }
              >
                <ShieldAlert />
                Stop native camera services
              </ConfirmButton>
            </details>
          </div>
        </Card>
        <Card
          title="Run command"
          description="A request/response root shell, without a PTY. The working directory is sent with each request. Interactive programs such as vim are not supported."
        >
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              setResult(null);
              try {
                const output = await post<CommandResult>("shell_exec", {
                  cmd: command,
                  cwd,
                  timeout,
                });
                setResult(output);
                setCwd(output.cwd);
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
              <div>
                <Label htmlFor="shell-cwd">Working directory</Label>
                <Input
                  id="shell-cwd"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  required
                  className="font-mono"
                />
              </div>
              <div>
                <Label htmlFor="shell-timeout">Timeout (seconds)</Label>
                <Input
                  id="shell-timeout"
                  type="number"
                  min={1}
                  max={120}
                  value={timeout}
                  onChange={(e) => setTimeoutValue(Number(e.target.value))}
                  required
                />
              </div>
            </div>
            <div>
              <Label htmlFor="shell-command">Command</Label>
              <Textarea
                id="shell-command"
                className="min-h-28 font-mono"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                spellCheck={false}
                required
              />
            </div>
            <Button
              type="submit"
              disabled={!hardware || busy || !command.trim()}
            >
              <Terminal />
              {busy ? "Operation in progress" : "Run command"}
            </Button>
          </form>
          {result && (
            <div className="mt-4 space-y-3">
              <Badge>Exit code: {result.exit_code}</Badge>
              <div>
                <p className="mb-2 text-xs text-muted-foreground">stdout</p>
                <pre className="terminal-output">
                  {result.stdout || "(no output)"}
                </pre>
              </div>
              <div>
                <p className="mb-2 text-xs text-muted-foreground">stderr</p>
                <pre className="terminal-output">
                  {result.stderr || "(no output)"}
                </pre>
              </div>
            </div>
          )}
        </Card>
        <details
          open={maintenanceOpen}
          onToggle={(event) => setMaintenanceOpen(event.currentTarget.open)}
          className="rounded-xl border bg-card p-5"
        >
          <summary className="cursor-pointer font-semibold">
            Advanced maintenance and reboot
          </summary>
          <div className="mt-5 space-y-5">
            <Notice tone="warning">
              These operations interrupt capture or connections. Fastboot / EDL
              are not normal restarts; recovery cannot be completed from this
              page. Uninstalling also does not undo bootloader unlocking, root
              ADB, or Factory Mode.
            </Notice>
            <MediaIndexCard
              storage="emulated"
              label="Camera storage"
              hardware={hardware}
              busy={busy}
              perform={perform}
            />
            <MediaIndexCard
              storage="sd"
              label="SD card"
              hardware={hardware}
              busy={busy}
              perform={perform}
            />
            <div className="flex flex-wrap gap-2">
              <ConfirmButton
                title="Restart console?"
                description="Stops capture and command processes owned by this console, then restarts the HTTP service. Independent Wi-Fi units keep running. Capture does not restart automatically."
                disabled={!hardware || busy}
                onConfirm={() =>
                  perform(
                    "restart_dashboard",
                    { confirm: true },
                    "Console restart requested. Wait for reconnection, then refresh the page.",
                  )
                }
              >
                <RotateCcw />
                Restart console
              </ConfirmButton>
              <ConfirmButton
                title="Clear thumbnail cache?"
                description="Only clears thumbnails generated by Action Control. Camera photos and videos are kept."
                disabled={busy}
                onConfirm={() =>
                  perform(
                    "clear_cache",
                    { confirm: true },
                    "Application thumbnail cache cleared.",
                  )
                }
              >
                <Eraser />
                Clear cache
              </ConfirmButton>
              <ConfirmButton
                title="Clear application logs?"
                description="Only clears private Action Control logs, leaving DJI logs and other application files untouched."
                disabled={busy}
                onConfirm={() =>
                  perform(
                    "clear_logs",
                    { confirm: true },
                    "Private application logs cleared. The systemd journal is not included.",
                  )
                }
              >
                <Trash2 />
                Clear logs
              </ConfirmButton>
            </div>
            <div className="flex flex-wrap gap-2">
              {[
                {
                  mode: "normal",
                  label: "Reboot camera",
                  detail:
                    "Interrupts all capture and connections. Native functionality is restored after reboot.",
                },
                {
                  mode: "recovery",
                  label: "Recovery",
                  detail:
                    "Enters recovery mode. The web interface goes offline. Avoid accidentally clearing media in recovery.",
                },
                {
                  mode: "bootloader",
                  label: "Fastboot",
                  detail:
                    "Enters the bootloader. The web interface and normal ADB go offline. Host Fastboot tools are required for recovery.",
                },
                {
                  mode: "edl",
                  label: "EDL / 9008",
                  detail:
                    "Enters Qualcomm 9008 download mode. Appropriate host tools are required. Cancel if recovery is not prepared.",
                },
              ].map((item) => (
                <ConfirmButton
                  key={item.mode}
                  variant="destructive"
                  title={`Confirm ${item.label}?`}
                  description={item.detail}
                  disabled={!hardware || busy}
                  onConfirm={() =>
                    perform(
                      "reboot",
                      { mode: item.mode, confirm: true },
                      `${item.label}: request submitted. A disconnected session does not confirm startup has completed.`,
                    )
                  }
                >
                  <RotateCcw />
                  {item.label}
                </ConfirmButton>
              ))}
            </div>
          </div>
        </details>
        <Card title="About Action Control">
          <div className="flex items-start gap-3">
            <Info className="mt-1 size-5 shrink-0 text-primary" />
            <div className="space-y-2 text-sm">
              <p>
                Version{" "}
                <span className="font-mono">{health.data?.version ?? "—"}</span>{" "}
                · Go backend with embedded React interface
              </p>
              <p className="text-muted-foreground">
                HTTP management and media endpoints have no login
                authentication. This service runs as root; access it only
                through ADB forwarding or a trusted network. TCP video also has
                no authentication.
              </p>
              <p className="text-muted-foreground">
                System:{" "}
                {hardware
                  ? "Camera root service"
                  : "Local filesystem mode or device unavailable"}{" "}
                · Stream format: MPEG-TS / H.264
              </p>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
