import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownUp,
  FileUp,
  Play,
  RefreshCw,
  Search,
  Square,
} from "lucide-react";
import { errorText, invalidate, post, useAPI } from "../api";
import type { ProcessInfo } from "../types";
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
} from "../ui";
import { ConfirmButton, Modal } from "../dialogs";

const pageSize = 20;

export function ProcessPage() {
  const health = useAPI<{ device: boolean }>("health", undefined, 5000);
  const processes = useAPI<{ processes: ProcessInfo[]; count: number }>(
    "process_list",
    undefined,
    5000,
  );
  const [filter, setFilter] = useState(""),
    [sort, setSort] = useState<"pid" | "cpu" | "rss" | "name">("rss"),
    [descending, setDescending] = useState(true),
    [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ProcessInfo | null>(null);
  const [startOpen, setStartOpen] = useState(false),
    [startCommand, setStartCommand] = useState(""),
    [startCwd, setStartCwd] = useState("/blackbox");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const hardware = health.data?.device === true && !health.isError;
  const visible = useMemo(() => {
    const needle = filter.toLocaleLowerCase();
    return (processes.data?.processes ?? [])
      .filter((process) =>
        `${process.pid} ${process.name} ${process.cmd} ${process.user}`
          .toLocaleLowerCase()
          .includes(needle),
      )
      .sort((a, b) => {
        const order =
          sort === "name"
            ? a.name.localeCompare(b.name)
            : sort === "rss"
              ? a.rss_bytes - b.rss_bytes
              : sort === "cpu"
                ? (a.cpu_percent ?? -1) - (b.cpu_percent ?? -1)
                : a.pid - b.pid;
        return descending ? -order : order;
      });
  }, [processes.data, filter, sort, descending]);
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageProcesses = visible.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  async function perform(name: string, data: unknown, success: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await post(name, data);
      setMessage(success);
      await invalidate("process_list");
    } catch (error) {
      setError(errorText(error));
      throw error;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Processes"
        description="View and manage device processes. These operations run as root."
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
      <Card description="CPU is the share of total system usage between samples; unknown values are not shown as zero. Process start identity is checked before termination.">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="min-w-40 flex-1">
            <Label htmlFor="process-filter">
              Filter name / command / PID / user
            </Label>
            <div className="relative">
              <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
              <Input
                className="pl-9"
                id="process-filter"
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value);
                  setPage(1);
                }}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="process-sort">Sort</Label>
            <Select
              value={sort}
              onValueChange={(value) => {
                setSort(value as typeof sort);
                setPage(1);
              }}
            >
              <SelectTrigger id="process-sort" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rss">Memory</SelectItem>
                <SelectItem value="cpu">CPU</SelectItem>
                <SelectItem value="pid">PID</SelectItem>
                <SelectItem value="name">Name</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            aria-label={descending ? "Sort ascending" : "Sort descending"}
            onClick={() => {
              setDescending((value) => !value);
              setPage(1);
            }}
          >
            <ArrowDownUp />
            {descending ? "Descending" : "Ascending"}
          </Button>
          <Button
            variant="outline"
            onClick={() => void processes.refetch()}
            disabled={processes.isFetching}
          >
            <RefreshCw />
            Refresh
          </Button>
          <Button
            disabled={!hardware || busy}
            onClick={() => setStartOpen(true)}
          >
            <Play />
            Start process
          </Button>
        </div>
        {processes.isPending ? (
          <Spinner />
        ) : processes.isError ? (
          <Notice tone="warning">
            Cannot read processes: {processes.error.message}
          </Notice>
        ) : visible.length === 0 ? (
          <EmptyState title="No matching processes" />
        ) : (
          <>
            <Table className="min-w-[620px]">
              <TableHeader>
                <TableRow>
                  <TableHead>PID</TableHead>
                  <TableHead>Process / command</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>CPU</TableHead>
                  <TableHead>Memory</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageProcesses.map((process) => (
                  <TableRow key={`${process.pid}:${process.start_time}`}>
                    <TableCell className="font-mono">{process.pid}</TableCell>
                    <TableCell className="max-w-sm">
                      <div className="font-medium">{process.name}</div>
                      <div
                        className="truncate font-mono text-xs text-muted-foreground"
                        title={process.cmd}
                      >
                        {process.cmd}
                      </div>
                    </TableCell>
                    <TableCell>{process.user || "—"}</TableCell>
                    <TableCell className="font-mono">
                      {process.cpu_percent == null
                        ? "—"
                        : `${process.cpu_percent.toFixed(1)}%`}
                    </TableCell>
                    <TableCell className="font-mono">
                      {formatBytes(process.rss_bytes)}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          !hardware ||
                          busy ||
                          process.pid <= 1 ||
                          process.name === "adbd" ||
                          process.name === "systemd"
                        }
                        onClick={() => setSelected(process)}
                      >
                        Manage
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="mt-4 flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">
                Total {visible.length} items · Page {currentPage} / {pageCount}{" "}
                page
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={currentPage === 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  Previous page
                </Button>
                <Button
                  variant="outline"
                  disabled={currentPage === pageCount}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Next page
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
      <Modal
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title="Manage processes"
        description="Check the command and process start identity. Unknown processes may belong to firmware or other applications."
      >
        {selected && (
          <div className="space-y-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt>PID / parent PID</dt>
              <dd className="font-mono">
                {selected.pid} / {selected.ppid}
              </dd>
              <dt>Name</dt>
              <dd>{selected.name}</dd>
              <dt>Command</dt>
              <dd className="break-all font-mono">{selected.cmd}</dd>
              <dt>Start identity</dt>
              <dd className="font-mono">{selected.start_time}</dd>
              <dt>Swap</dt>
              <dd>{formatBytes(selected.vsz_bytes)}</dd>
            </dl>
            <div className="flex flex-wrap gap-2">
              {[15, 9].map((signal) => (
                <ConfirmButton
                  key={signal}
                  title={`Send SIG${signal === 15 ? "TERM" : "KILL"} to PID ${selected.pid}?`}
                  description={
                    signal === 15
                      ? "Requests process exit. This may interrupt ongoing operations."
                      : "Force killing may lose unsaved data. Use only when necessary."
                  }
                  disabled={busy}
                  variant={signal === 9 ? "destructive" : "outline"}
                  onConfirm={async () => {
                    await perform(
                      "process_kill",
                      {
                        pid: selected.pid,
                        start_time: selected.start_time,
                        signal,
                        confirm: true,
                      },
                      "Signal sent. Refresh the process list to check its status.",
                    );
                    setSelected(null);
                  }}
                >
                  <Square />
                  {signal === 15 ? "Request exit" : "Force kill"}
                </ConfirmButton>
              ))}
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={startOpen}
        onOpenChange={setStartOpen}
        title="Start managed process"
        description="Commands run in the Action Control service process group and stop when the console exits. Do not start wireless services here if they need to survive a console restart."
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="start-cwd">Working directory</Label>
            <Input
              id="start-cwd"
              value={startCwd}
              onChange={(event) => setStartCwd(event.target.value)}
              className="font-mono"
            />
          </div>
          <div>
            <Label htmlFor="start-command">Background command</Label>
            <Input
              id="start-command"
              value={startCommand}
              onChange={(event) => setStartCommand(event.target.value)}
              className="font-mono"
            />
          </div>
          <ConfirmButton
            title="Run this command as root?"
            description={startCommand}
            disabled={busy || !startCommand.trim() || !startCwd.startsWith("/")}
            onConfirm={async () => {
              await perform(
                "process_start",
                { cmd: startCommand, cwd: startCwd, confirm: true },
                "Background process started. Check its status in the process list.",
              );
              setStartOpen(false);
            }}
          >
            <FileUp />
            Start
          </ConfirmButton>
        </div>
      </Modal>
    </>
  );
}
