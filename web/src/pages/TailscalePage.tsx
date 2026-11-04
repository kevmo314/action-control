import { useState } from "react";
import { errorText, invalidate, post, useAPI } from "../api";
import { Notice, PageHeader } from "../ui";
import { Button } from "@/components/ui/button";

type Status = {
  available: boolean;
  state: string;
  reason?: string;
  hostname: string;
  ips: string[];
  exit_node_id: string;
  allow_lan: boolean;
  exit_nodes: {
    id: string;
    name: string;
    ip: string;
    online: boolean;
    active: boolean;
  }[];
};
export function TailscalePage() {
  const status = useAPI<Status>("tailscale", undefined, 5000);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const current = status.data;
  const choice = selected ?? current?.exit_node_id ?? "";
  const apply = async (id: string) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await post("tailscale/exit-node", { id });
      setSelected(null);
      invalidate("tailscale");
      setMessage(
        id
          ? "Exit node selected. Webviews are reconnecting through this route."
          : "Exit node cleared. The camera uses its normal internet connection.",
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader
        title="Tailscale"
        description="Manage the camera’s private network and internet route."
      />
      {status.error && <Notice tone="error">{errorText(status.error)}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {message && <p className="mb-4 text-sm">{message}</p>}
      <div className="max-w-2xl space-y-4">
        <section className="rounded-xl border bg-card p-5">
          <h2 className="mb-3 font-medium">Connection</h2>
          <p>{current?.state ?? "Loading…"}</p>
          {current?.reason && (
            <p className="mt-2 text-sm text-muted-foreground">
              {current.reason}
            </p>
          )}
          {current?.available && (
            <dl className="mt-4 grid grid-cols-[100px_1fr] gap-2 text-sm">
              <dt>Camera</dt>
              <dd>{current.hostname}</dd>
              <dt>Addresses</dt>
              <dd className="break-all">{current.ips.join(", ")}</dd>
            </dl>
          )}
          <Button
            className="mt-4"
            variant="outline"
            onClick={() => invalidate("tailscale")}
            disabled={busy}
          >
            Refresh status
          </Button>
        </section>
        <section className="rounded-xl border bg-card p-5">
          <h2 className="mb-2 font-medium">Exit node</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Routes the whole camera’s internet traffic, including webviews and
            public SRT destinations. Local network access stays enabled so the
            Wi-Fi gateway and DNS remain reachable.
          </p>
          <label htmlFor="exit-node" className="mb-2 block text-sm">
            Internet route
          </label>
          <select
            id="exit-node"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            value={choice}
            onChange={(e) => setSelected(e.target.value)}
            disabled={busy || !current?.available}
          >
            <option value="">Direct connection · no exit node</option>
            {current?.exit_node_id &&
              !current.exit_nodes.some(
                (node) => node.id === current.exit_node_id,
              ) && (
                <option value={current.exit_node_id} disabled>
                  Previously selected node · unavailable
                </option>
              )}
            {current?.exit_nodes.map((node) => (
              <option key={node.id} value={node.id} disabled={!node.online}>
                {node.name} · {node.ip}
                {node.online ? "" : " · offline"}
              </option>
            ))}
          </select>
          {current?.available && current.exit_nodes.length === 0 && (
            <p className="mt-2 text-sm text-muted-foreground">
              No exit nodes are advertised to this camera. Enable an exit node
              in your tailnet first.
            </p>
          )}
          {current?.exit_node_id && (
            <p className="mt-3 text-sm text-muted-foreground">
              Selected:{" "}
              {current.exit_nodes.find(
                (node) => node.id === current.exit_node_id,
              )?.name ?? "Unavailable node"}
              {current.exit_nodes.find(
                (node) => node.id === current.exit_node_id,
              )?.active
                ? " · active"
                : " · waiting for connection"}
            </p>
          )}
          <div className="mt-4 flex gap-2">
            <Button
              disabled={
                busy ||
                !current?.available ||
                (choice !== "" && current.state !== "Running") ||
                choice === current.exit_node_id
              }
              onClick={() => apply(choice)}
            >
              {busy ? "Applying…" : "Apply route"}
            </Button>
            {current?.exit_node_id && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => apply("")}
              >
                Use direct connection
              </Button>
            )}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Webviews reconnect automatically after applying a route. Studio also
            has a Reload webviews button.
          </p>
        </section>
      </div>
    </>
  );
}
