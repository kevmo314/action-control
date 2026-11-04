import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  KeyRound,
  Radio,
  RefreshCw,
  Save,
  Signal,
  Trash2,
  Wifi,
  WifiOff,
} from "lucide-react";
import { errorText, get, invalidate, post, useAPI } from "../api";
import { useViewState } from "../lib/view-state";
import type {
  Config,
  HotspotConfig,
  KnownNetwork,
  WiFiNetwork,
  WiFiStatus,
  NativeHotspotResult,
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
import { Card, EmptyState, Notice, PageHeader, Spinner } from "../ui";
import { ConfirmButton, Modal } from "../dialogs";

type NetworkRow = {
  ssid: string;
  bssid: string;
  signal: number | null;
  band?: string;
  encrypted: boolean;
  saved: boolean;
  connected: boolean;
  lastConnected?: string;
};

const stateNames: Record<string, string> = {
  connected: "Connected",
  disconnected: "Not connected",
  down: "Wi-Fi is off",
  unknown: "Unknown status",
};

export function NetworkPage() {
  const health = useAPI<{ device: boolean; http_port: string }>(
    "health",
    undefined,
    5000,
  );
  const status = useAPI<WiFiStatus>("wifi_status", undefined, 3000);
  const config = useAPI<Config>("config");
  const managed = config.data?.network_control === "managed";
  const hardware = health.data?.device === true && !health.isError;
  const canChange =
    managed && hardware && Boolean(status.data) && !status.isError;
  const httpPort = health.data?.http_port || "8080";
  const hotspotAddress = `http://192.168.2.1:${httpPort}/#/network`;
  const [reconnect, setReconnect] = useViewState<{
    mode: "client" | "hotspot" | "off";
    ssid: string;
    address: string;
    previous: string;
    time: string;
  } | null>("network.reconnect.v2", null);
  const known = useQuery<{ networks: KnownNetwork[] }>({
    queryKey: ["known_list"],
    queryFn: ({ signal }) => get("known_list", undefined, signal),
    enabled: managed,
  });
  const hotspot = useQuery<HotspotConfig>({
    queryKey: ["hotspot_config"],
    queryFn: ({ signal }) => get("hotspot_config", undefined, signal),
    enabled: managed,
  });
  const queryClient = useQueryClient();
  const scan = useQuery<{ networks: WiFiNetwork[] }>({
    queryKey: ["wifi_scan"],
    queryFn: ({ signal }) => get("wifi_scan", undefined, signal),
    enabled: false,
    retry: false,
  });
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [connect, setConnect] = useState(false);
  const [ssid, setSSID] = useState("");
  const [confirmHotspot, setConfirmHotspot] = useState(false);
  const [bssid, setBSSID] = useState("");
  const [password, setPassword] = useState("");
  const [open, setOpen] = useState(false);
  const [reuse, setReuse] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [apSSID, setAPSSID] = useState("");
  const [apPassword, setAPPassword] = useState("");
  const [apOpen, setAPOpen] = useState(false);
  const [band, setBand] = useState("2.4G");
  const [channel, setChannel] = useState("6");
  const [apLoaded, setAPLoaded] = useState(false);
  const [nativeHotspotBusy, setNativeHotspotBusy] = useState(false);
  const [hiddenSuccess, setHiddenSuccess] = useState("");
  const previousMode = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!managed) {
      setConnect(false);
      setConfirmHotspot(false);
      setPassword("");
      setAPPassword("");
    }
  }, [managed]);

  function loadHotspot(value: HotspotConfig) {
    setAPSSID(value.ssid);
    setBand(value.band);
    setChannel(String(value.channel));
    setAPOpen(value.open);
    setAPPassword("");
  }

  useEffect(() => {
    if (hotspot.data && !apLoaded) {
      loadHotspot(hotspot.data);
      setAPLoaded(true);
    }
  }, [hotspot.data, apLoaded]);

  useEffect(() => {
    const mode = status.data?.mode;
    if (!mode) return;
    if (previousMode.current && previousMode.current !== mode) {
      queryClient.removeQueries({ queryKey: ["wifi_scan"], exact: true });
    }
    previousMode.current = mode;
  }, [status.data?.mode, queryClient]);

  useEffect(() => {
    const operation = status.data?.operation;
    if (operation?.status !== "succeeded" || hiddenSuccess === operation.id)
      return;
    const timer = window.setTimeout(() => setHiddenSuccess(operation.id), 4000);
    return () => window.clearTimeout(timer);
  }, [status.data?.operation, hiddenSuccess]);

  const operating =
    status.data?.operation?.status === "queued" ||
    status.data?.operation?.status === "running";
  const apDirty = Boolean(
    hotspot.data &&
    (apSSID !== hotspot.data.ssid ||
      band !== hotspot.data.band ||
      Number(channel) !== hotspot.data.channel ||
      apOpen !== hotspot.data.open ||
      apPassword),
  );

  const networks = useMemo<NetworkRow[]>(() => {
    const saved = new Map(
      (known.data?.networks ?? []).map((item) => [item.ssid, item]),
    );
    const rows = new Map<string, NetworkRow>();
    for (const network of scan.data?.networks ?? []) {
      const key = network.ssid || network.bssid;
      const current = rows.get(key);
      if (
        current &&
        (current.signal ?? -Infinity) >= (network.signal ?? -Infinity)
      )
        continue;
      const remembered = saved.get(network.ssid);
      rows.set(key, {
        ssid: network.ssid,
        bssid: network.bssid,
        signal: network.signal,
        band: network.band,
        encrypted: network.encrypted,
        saved: Boolean(remembered),
        connected:
          (status.data?.role ?? status.data?.mode) === "client" &&
          status.data?.ssid === network.ssid,
        lastConnected: remembered?.last_connected,
      });
    }
    for (const network of known.data?.networks ?? []) {
      if (!rows.has(network.ssid)) {
        rows.set(network.ssid, {
          ssid: network.ssid,
          bssid: network.bssid ?? "",
          signal: null,
          encrypted: network.has_password,
          saved: true,
          connected:
            (status.data?.role ?? status.data?.mode) === "client" &&
            status.data?.ssid === network.ssid,
          lastConnected: network.last_connected,
        });
      }
    }
    return [...rows.values()].sort(
      (a, b) =>
        Number(b.connected) - Number(a.connected) ||
        Number(b.saved) - Number(a.saved) ||
        (b.signal ?? -Infinity) - (a.signal ?? -Infinity) ||
        a.ssid.localeCompare(b.ssid),
    );
  }, [
    known.data?.networks,
    scan.data?.networks,
    status.data?.mode,
    status.data?.role,
    status.data?.ssid,
  ]);

  const refresh = () =>
    invalidate(
      "wifi_status",
      "known_list",
      "hotspot_config",
      "config",
      "dji_network",
    );

  async function queue(name: string, body: object = {}) {
    setBusy(true);
    setError("");
    setMessage("");
    if (name === "wifi_connect" || name === "wifi_off") {
      setReconnect({
        mode: name === "wifi_connect" ? "client" : "off",
        ssid: name === "wifi_connect" ? ssid : "Turn off Wi-Fi",
        address: "",
        previous: location.href,
        time: new Date().toLocaleString("en-US"),
      });
    }
    try {
      await post(name, { ...body, confirm: true });
      setMessage(
        "Operation accepted. The connection may drop temporarily; an interrupted response does not mean the operation failed.",
      );
      queryClient.removeQueries({ queryKey: ["wifi_scan"], exact: true });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function showConnect(network?: NetworkRow) {
    setSSID(network?.ssid ?? "");
    setBSSID(network?.bssid ?? "");
    setOpen(network?.encrypted === false);
    setReuse(network?.saved ?? false);
    setPassword("");
    setConnectError("");
    setConnect(true);
  }

  async function applyHotspot() {
    setBusy(true);
    setError("");
    setMessage("");
    setReconnect({
      mode: "hotspot",
      ssid: apSSID,
      address: hotspotAddress,
      previous: location.href,
      time: new Date().toLocaleString("en-US"),
    });
    try {
      const body: Record<string, unknown> = {
        ssid: apSSID,
        band,
        channel: Number(channel),
        confirm: true,
      };
      if (apOpen) body.password = "";
      else if (apPassword) body.password = apPassword;
      await post("hotspot_apply", body);
      setAPPassword("");
      setMessage(
        "Hotspot switch accepted. If disconnected, join the target hotspot and open the access URL below.",
      );
      queryClient.removeQueries({ queryKey: ["wifi_scan"], exact: true });
      await refresh();
    } catch (cause) {
      setError(
        `Switch not confirmed: ${errorText(cause)}. Check connection and recovery status before retrying.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function nativeHotspotAction(action: "start" | "stop") {
    setNativeHotspotBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await post<NativeHotspotResult>("native_hotspot", {
        action,
      });
      if (result.status !== "ok" || result.native_code !== 0) {
        throw new Error(
          result.reason ||
            `Native hotspot operation failed (${result.native_code ?? "Unknown"})`,
        );
      }
      setMessage(
        action === "start"
          ? "Native hotspot started. Connect to the camera hotspot and visit http://192.168.2.1:8080."
          : "Native hotspot stopped. Wireless is back in the native disabled state.",
      );
      await refresh();
    } catch (cause) {
      setError(`Native hotspot operation failed: ${errorText(cause)}`);
    } finally {
      setNativeHotspotBusy(false);
    }
  }

  const mode = status.data?.mode;
  const role = status.data?.role ?? mode;
  const primaryState = !status.data
    ? "No status received"
    : role === "hotspot"
      ? "Hotspot running"
      : role === "closed"
        ? "Wi-Fi is off"
        : (stateNames[status.data.state] ?? "Unknown status");
  const operation = status.data?.operation;

  return (
    <>
      <PageHeader
        title="Network"
        description={
          managed
            ? "Manage wireless connections and hotspots independently."
            : "Use native camera networking to access the console, album, and files."
        }
        actions={
          <Button
            variant="outline"
            disabled={status.isFetching}
            onClick={() => void refresh()}
          >
            <RefreshCw />
            Refresh
          </Button>
        }
      />
      <div className="mb-5 space-y-3">
        {error && <Notice tone="error">{error}</Notice>}
        {message && <Notice tone="success">{message}</Notice>}
        {config.error && <Notice tone="error">{config.error.message}</Notice>}
        {status.error && hardware && (
          <Notice tone="error">
            Wireless status unavailable: {status.error.message}
          </Notice>
        )}
        {managed && operation?.status === "failed" && (
          <Notice
            tone={
              operation.recovery_status === "restored" ? "warning" : "error"
            }
          >
            {operation.recovery_status === "restored"
              ? `Switch failed; restored to ${operation.recovery_ssid ? `“${operation.recovery_ssid}”` : operation.recovery_mode === "native" ? "Native networking" : operation.recovery_mode === "closed" ? "Wireless disabled" : "Previous network"}.`
              : "The last network operation failed."}
            {operation.recovery_status === "failed" &&
              " Automatic recovery also failed. Use USB ADB to access the device."}
            <details className="mt-2">
              <summary className="cursor-pointer">Failure details</summary>
              <p className="mt-2 break-all">{operation.error}</p>
            </details>
          </Notice>
        )}
        {managed && operating && (
          <Notice>
            <Spinner /> Network operation
            {operation?.recovery_status === "restoring"
              ? "Restoring previous connection"
              : operation?.status === "queued"
                ? "Queued"
                : "Running"}
            . Do not submit again.
          </Notice>
        )}
        {managed &&
          operation?.status === "succeeded" &&
          hiddenSuccess !== operation.id && (
            <Notice tone="success">Network operation completed.</Notice>
          )}
      </div>

      {managed && reconnect && (
        <Card className="mb-5" title="Access after switching">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-2 text-sm">
              <p className="break-all">
                Target: {reconnect.ssid}{" "}
                <span className="text-xs text-muted-foreground">
                  · {reconnect.time}
                </span>
              </p>
              {reconnect.mode === "off" ? (
                <p className="text-muted-foreground">
                  After turning off Wi-Fi, use USB ADB forwarding to access the
                  console and re-enable networking, or reboot the camera to
                  restore native networking.
                </p>
              ) : reconnect.address ? (
                <p>
                  After joining this hotspot, open:
                  <a
                    className="break-all font-medium underline underline-offset-4"
                    href={reconnect.address}
                  >
                    {reconnect.address}
                  </a>
                </p>
              ) : (
                <p className="text-muted-foreground">
                  After joining the same Wi-Fi network, find the new camera IP
                  address in your router. You can also use USB ADB forwarding.
                </p>
              )}
              {reconnect.mode !== "off" && (
                <p className="text-muted-foreground">
                  If switching fails and the previous configuration is
                  available, the device will try to restore the previous
                  connection. After recovery, you can
                  <a
                    className="mx-1 underline underline-offset-4"
                    href={reconnect.previous}
                  >
                    Retry original URL
                  </a>
                  .
                </p>
              )}
              <details>
                <summary className="cursor-pointer">
                  Restore access over USB
                </summary>
                <p className="mt-2">Connect USB, then run on your computer:</p>
                <pre className="mt-2 max-w-full overflow-x-auto rounded-md bg-muted p-3 text-xs">
                  adb forward tcp:8080 tcp: {httpPort}
                </pre>
                <a
                  className="mt-2 inline-block underline underline-offset-4"
                  href="http://127.0.0.1:8080/#/network"
                >
                  Open USB access URL
                </a>
              </details>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setReconnect(null)}
            >
              Dismiss
            </Button>
          </div>
        </Card>
      )}

      <Card className="mb-5" title="Current network">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Wifi className="size-7 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-lg font-semibold">{primaryState}</p>
              {(status.data?.owner === "native" || mode === "native") && (
                <Badge className="mt-1" variant="secondary">
                  DJI native management
                </Badge>
              )}
              <p className="break-all text-sm text-muted-foreground">
                {status.data?.ssid || "No network connection"}
              </p>
            </div>
          </div>
          <div className="text-right text-sm">
            <p className="text-muted-foreground">IP address</p>
            <p className="select-all font-mono">{status.data?.ip || "—"}</p>
            {status.data?.ip && (
              <a
                className="mt-1 inline-block text-xs underline underline-offset-4"
                href={`http://${status.data.ip}:${httpPort}/#/network`}
              >
                Access at this URL
              </a>
            )}
          </div>
        </div>
        {!managed && (
          <p className="mt-4 text-sm text-muted-foreground">
            Use the wireless settings on the camera. Connect your phone or
            computer to the native camera hotspot to access the console at the
            address above. An existing LAN connection can also be used.
          </p>
        )}
        <details className="mt-5 border-t pt-4 text-sm">
          <summary className="cursor-pointer font-medium">Details</summary>
          <dl className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Underlying state</dt>
              <dd>{status.data?.state ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Signal</dt>
              <dd>
                {status.data?.signal == null
                  ? "—"
                  : `${status.data.signal} dBm`}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Frequency</dt>
              <dd>
                {status.data?.freq_mhz == null
                  ? "—"
                  : `${status.data.freq_mhz} MHz`}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Sent / received</dt>
              <dd>
                {status.data?.tx_bitrate_mbps ?? "—"} /{" "}
                {status.data?.rx_bitrate_mbps ?? "—"} Mbps
              </dd>
            </div>
          </dl>
        </details>
      </Card>

      {!managed && hardware && (
        <Card className="mb-5" title="Native hotspot">
          <p className="text-sm text-muted-foreground">
            Managed by native camera networking without taking over wlan0. Once
            enabled, connect your phone to the camera hotspot and visit
            <code className="mx-1 rounded bg-muted px-1">
              http://192.168.2.1:{httpPort}
            </code>
            . The HTTP interface has no login authentication or encryption.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <ConfirmButton
              title="Start native hotspot?"
              description="The camera will start its own Wi-Fi hotspot and DHCP server. Network changes may briefly disconnect this page. Do not expose the unauthenticated console to untrusted networks."
              disabled={nativeHotspotBusy || status.data?.role === "hotspot"}
              onConfirm={() => void nativeHotspotAction("start")}
            >
              <Wifi /> Start native hotspot
            </ConfirmButton>
            <ConfirmButton
              variant="outline"
              title="Stop native hotspot?"
              description="The camera will turn off its native Wi-Fi hotspot. Your phone will disconnect. Use USB ADB or enable the hotspot again to restore access."
              disabled={nativeHotspotBusy || status.data?.role !== "hotspot"}
              onConfirm={() => void nativeHotspotAction("stop")}
            >
              <WifiOff /> Stop native hotspot
            </ConfirmButton>
          </div>
        </Card>
      )}

      <details className="mb-5 rounded-xl border bg-card px-6 py-5 shadow-sm">
        <summary className="cursor-pointer font-semibold">
          Advanced network management
        </summary>
        <div className="mt-4 max-w-2xl space-y-3">
          <Label htmlFor="network-control">Management mode</Label>
          <Select
            value={config.data?.network_control ?? "native"}
            disabled={!config.data || busy || operating}
            onValueChange={async (value) => {
              setBusy(true);
              setError("");
              setMessage("");
              try {
                await post("config", { network_control: value });
                await refresh();
                setMessage(
                  value === "native"
                    ? "Using native networking."
                    : "Independent management enabled. It takes effect when performing network operations.",
                );
              } catch (cause) {
                setError(errorText(cause));
              } finally {
                setBusy(false);
              }
            }}
          >
            <SelectTrigger id="network-control">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="native">
                Use native networking (recommended)
              </SelectItem>
              <SelectItem value="managed">
                Independent management (advanced)
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            The camera manages wireless connections by default. Independent
            management takes over wireless networking when switching networks,
            which may interrupt the DJI Mimo connection.
          </p>
          {managed && (
            <p className="text-sm text-muted-foreground">
              Before returning to native mode, go to{" "}
              <a className="underline underline-offset-4" href="#/system">
                System page
              </a>{" "}
              Restore the native network and wait for completion.
            </p>
          )}
        </div>
      </details>

      {managed && (
        <>
          <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
            <Card
              title="Connect Wi-Fi"
              description="Choose a saved network or scan for nearby networks. Switching networks may disconnect this page."
            >
              <div className="mb-4 flex flex-wrap gap-2">
                <Button
                  disabled={!canChange || scan.isFetching || busy || operating}
                  onClick={() => void scan.refetch()}
                >
                  <RefreshCw />
                  {scan.isFetching ? "Scanning…" : "Scan nearby networks"}
                </Button>
                <Button
                  variant="outline"
                  disabled={!canChange || busy || operating}
                  onClick={() => showConnect()}
                >
                  Connect to another network
                </Button>
              </div>
              {scan.error && (
                <Notice tone="error">Scan failed: {scan.error.message}</Notice>
              )}
              {known.isPending ? (
                <Spinner />
              ) : known.error ? (
                <Notice tone="error">{known.error.message}</Notice>
              ) : !networks.length ? (
                <EmptyState
                  title="No saved networks"
                  description="Scan nearby networks or enter a network name manually."
                />
              ) : (
                <div className="divide-y">
                  {networks.map((network) => (
                    <div
                      key={network.ssid || network.bssid}
                      className="flex items-center justify-between gap-3 py-4"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <Signal className="size-5 shrink-0 text-primary" />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="break-all text-sm font-medium">
                              {network.ssid || "Hidden network"}
                            </p>
                            {network.connected && (
                              <Badge>Current connection</Badge>
                            )}
                            {network.saved && (
                              <Badge variant="secondary">Saved</Badge>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {network.signal == null
                              ? "Unknown signal"
                              : `${network.signal} dBm`}{" "}
                            ·{" "}
                            {network.encrypted
                              ? "Password required"
                              : "Open network"}
                          </p>
                          {(network.bssid || network.band) && (
                            <details className="mt-2 text-xs text-muted-foreground">
                              <summary className="cursor-pointer">
                                Network details
                              </summary>
                              <p className="mt-1 font-mono">
                                {network.bssid || "Unknown BSSID"}
                                {network.band ? ` · ${network.band}` : ""}
                              </p>
                            </details>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {!network.connected && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!canChange || busy || operating}
                            onClick={() => showConnect(network)}
                          >
                            Connect
                          </Button>
                        )}
                        {network.saved && (
                          <details className="relative">
                            <summary className="cursor-pointer list-none rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent">
                              More
                            </summary>
                            <div className="absolute right-0 z-10 mt-1 rounded-md border bg-popover p-1 shadow-md">
                              <ConfirmButton
                                title="Forget this network?"
                                description={`Delete “${network.ssid}”. This does not actively disconnect the current connection.`}
                                disabled={!canChange || busy || operating}
                                onConfirm={async () => {
                                  await post("known_forget", {
                                    ssid: network.ssid,
                                    confirm: true,
                                  });
                                  await refresh();
                                }}
                              >
                                <Trash2 /> Forget
                              </ConfirmButton>
                            </div>
                          </details>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <details className="mt-5 border-t pt-4">
                <summary className="cursor-pointer text-sm font-medium">
                  Advanced settings
                </summary>
                <label className="mt-4 flex items-start gap-3 text-sm">
                  <Checkbox
                    className="mt-1"
                    checked={config.data?.auto_connect ?? false}
                    disabled={!canChange || busy || operating}
                    onCheckedChange={async (checked) => {
                      setBusy(true);
                      setError("");
                      try {
                        await post("auto_connect", {
                          enabled: checked === true,
                        });
                        await refresh();
                        setMessage(
                          "Auto-connect settings saved. They take effect on the next full boot.",
                        );
                      } catch (cause) {
                        setError(errorText(cause));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  />
                  <span>
                    Scan and connect to the most recently used saved network on
                    boot
                    <span className="mt-1 block text-xs text-muted-foreground">
                      When enabled, takes over wireless networking and attempts
                      to connect on the next full boot.
                    </span>
                  </span>
                </label>
                {config.error && (
                  <div className="mt-3">
                    <Notice tone="error">{config.error.message}</Notice>
                  </div>
                )}
              </details>
            </Card>

            <Card
              title="Camera hotspot"
              description="Set up a camera hotspot for a phone or computer. This does not share an internet connection."
            >
              {hotspot.error && (
                <Notice tone="error">
                  Cannot read hotspot configuration: {hotspot.error.message}
                </Notice>
              )}
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  setConfirmHotspot(true);
                }}
              >
                <div>
                  <Label htmlFor="hotspot-ssid">Hotspot name</Label>
                  <Input
                    id="hotspot-ssid"
                    value={apSSID}
                    required
                    onChange={(event) => setAPSSID(event.target.value)}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    1–32 UTF-8 bytes.
                  </p>
                </div>
                {!apOpen && (
                  <div>
                    <Label htmlFor="hotspot-password">New password</Label>
                    <Input
                      id="hotspot-password"
                      type="password"
                      autoComplete="new-password"
                      placeholder={
                        hotspot.data?.has_password
                          ? "Leave blank to keep the current password"
                          : "Enter the hotspot password"
                      }
                      value={apPassword}
                      required={!hotspot.data?.has_password}
                      onChange={(event) => setAPPassword(event.target.value)}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      8–63 bytes or a 64-digit hexadecimal PSK.
                    </p>
                  </div>
                )}
                <details className="border-t pt-4">
                  <summary className="cursor-pointer text-sm font-medium">
                    Advanced settings
                  </summary>
                  <div className="mt-4 space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor="hotspot-band">Band</Label>
                        <Select
                          value={band}
                          onValueChange={(value) => {
                            setBand(value);
                            setChannel(value === "5G" ? "149" : "6");
                          }}
                        >
                          <SelectTrigger id="hotspot-band" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="2.4G">2.4 GHz</SelectItem>
                            <SelectItem value="5G">5 GHz</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label htmlFor="hotspot-channel">Channel</Label>
                        <Select value={channel} onValueChange={setChannel}>
                          <SelectTrigger
                            id="hotspot-channel"
                            className="w-full"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(band === "5G"
                              ? [
                                  36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108,
                                  112, 116, 120, 124, 128, 132, 136, 140, 144,
                                  149, 153, 157, 161, 165,
                                ]
                              : Array.from(
                                  { length: 14 },
                                  (_, index) => index + 1,
                                )
                            ).map((value) => (
                              <SelectItem key={value} value={String(value)}>
                                {value}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <p className="text-xs leading-5 text-muted-foreground">
                      Available channels depend on firmware, region, and
                      wireless conditions.
                    </p>
                    <label className="flex items-center gap-3 text-sm">
                      <Checkbox
                        checked={apOpen}
                        onCheckedChange={(checked) => {
                          setAPOpen(checked === true);
                          setAPPassword("");
                        }}
                      />
                      Open hotspot (no password)
                    </label>
                    {apOpen && (
                      <Notice tone="warning">
                        An open hotspot has no Wi-Fi encryption. Use only in
                        trusted environments.
                      </Notice>
                    )}
                  </div>
                </details>
                <div className="flex flex-wrap items-center gap-2">
                  {(mode !== "hotspot" || apDirty) && (
                    <Button
                      type="submit"
                      disabled={
                        !canChange || busy || operating || !hotspot.data
                      }
                    >
                      {mode === "hotspot" ? <Save /> : <Radio />}
                      {mode === "hotspot"
                        ? "Save and restart hotspot"
                        : "Save and start hotspot"}
                    </Button>
                  )}
                  {mode === "hotspot" && !apDirty && (
                    <Badge>Hotspot is running</Badge>
                  )}
                  {apDirty && hotspot.data && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => loadHotspot(hotspot.data!)}
                    >
                      Discard changes
                    </Button>
                  )}
                </div>
              </form>
            </Card>
          </div>

          <details className="mt-5 rounded-xl border bg-card px-6 py-5 shadow-sm">
            <summary className="cursor-pointer font-semibold text-destructive">
              Dangerous operations
            </summary>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t pt-4">
              <p className="max-w-2xl text-sm text-muted-foreground">
                Turns off the client and hotspot. Afterwards, access requires
                USB ADB forwarding or reboot the camera to restore web access.
              </p>
              <ConfirmButton
                title="Turn off wireless networking?"
                description="Disconnects Wi-Fi and the hotspot. USB ADB forwarding or a full reboot is required to restore access."
                disabled={!canChange || busy || operating}
                variant="destructive"
                onConfirm={() => queue("wifi_off")}
              >
                <WifiOff /> Turn off wireless networking
              </ConfirmButton>
            </div>
          </details>
          <Modal
            open={confirmHotspot}
            onOpenChange={(value) => {
              if (!busy) setConfirmHotspot(value);
            }}
            title={
              mode === "hotspot"
                ? "Save and restart hotspot?"
                : "Save and start hotspot?"
            }
            description={`Switch to hotspot “${apSSID}”. This page may disconnect. On failure, the device will attempt to restore the previous connection and settings.`}
          >
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setConfirmHotspot(false)}
              >
                Cancel
              </Button>
              <Button
                disabled={!canChange || busy || operating}
                onClick={async () => {
                  await applyHotspot();
                  setConfirmHotspot(false);
                }}
              >
                {busy ? "Submitting…" : "Confirm switch"}
              </Button>
            </div>
          </Modal>

          <Modal
            open={connect}
            onOpenChange={(value) => {
              if (!busy) {
                setConnect(value);
                if (!value) setPassword("");
              }
            }}
            title={ssid ? `Connect to “${ssid}”` : "Connect to another network"}
            description="Switches to client mode. Your browser may disconnect. If the connection fails, the previous network will be restored where possible."
          >
            <form
              className="space-y-4"
              onSubmit={async (event) => {
                event.preventDefault();
                setConnectError("");
                try {
                  const body: Record<string, unknown> = { ssid, bssid };
                  if (!reuse) body.password = open ? "" : password;
                  await queue("wifi_connect", body);
                  setConnect(false);
                  setPassword("");
                } catch (cause) {
                  setConnectError(
                    `${errorText(cause)}. If disconnected, wait for status to refresh before submitting again.`,
                  );
                }
              }}
            >
              {reuse ? (
                <Notice>
                  Uses saved credentials to connect. Switching networks may
                  disconnect this page.
                </Notice>
              ) : (
                <>
                  <div>
                    <Label htmlFor="wifi-ssid">Network name</Label>
                    <Input
                      id="wifi-ssid"
                      autoFocus
                      value={ssid}
                      onChange={(event) => setSSID(event.target.value)}
                      required
                    />
                  </div>
                  {!open && (
                    <div>
                      <Label htmlFor="wifi-password">Password</Label>
                      <Input
                        id="wifi-password"
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        required
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        8–63 bytes or a 64-digit hexadecimal PSK.
                      </p>
                    </div>
                  )}
                </>
              )}
              <details className="border-t pt-4">
                <summary className="cursor-pointer text-sm font-medium">
                  Advanced settings
                </summary>
                <div className="mt-4 space-y-4">
                  <div>
                    <Label htmlFor="wifi-bssid">Specify BSSID (optional)</Label>
                    <Input
                      id="wifi-bssid"
                      className="font-mono"
                      placeholder="aa:bb:cc:dd:ee:ff"
                      value={bssid}
                      onChange={(event) => setBSSID(event.target.value)}
                    />
                  </div>
                  {!reuse && (
                    <label className="flex items-center gap-3 text-sm">
                      <Checkbox
                        checked={open}
                        onCheckedChange={(checked) => setOpen(checked === true)}
                      />
                      Open network (no password)
                    </label>
                  )}
                </div>
              </details>
              {connectError && (
                <Notice tone="error">
                  {connectError}
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-2"
                    onClick={() => setConnect(false)}
                  >
                    View recovery options
                  </Button>
                </Notice>
              )}
              <div className="flex justify-end">
                <Button
                  type="submit"
                  disabled={!canChange || busy || operating}
                >
                  <KeyRound /> {busy ? "Submitting…" : "Confirm connection"}
                </Button>
              </div>
            </form>
          </Modal>
        </>
      )}
    </>
  );
}
