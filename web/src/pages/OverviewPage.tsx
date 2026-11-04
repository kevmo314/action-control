import {
  ArrowRight,
  BatteryMedium,
  Cpu,
  HardDrive,
  MemoryStick,
  RefreshCw,
  Thermometer,
  Wifi,
} from "lucide-react";
import { useAPI, invalidate } from "../api";
import type { CameraStatus, DiskUsage, SystemInfo, WiFiStatus } from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Card, Notice, PageHeader, Spinner, formatBytes } from "../ui";

function StorageCard({ name, path }: { name: string; path: string }) {
  const query = useAPI<DiskUsage>("disk_usage", { path }, 15000);
  return (
    <Card>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <HardDrive className="size-4 text-muted-foreground" />
          {name}
        </div>
        <span className="font-mono text-xs text-muted-foreground">{path}</span>
      </div>
      {query.isPending ? (
        <div className="mt-5">
          <Spinner />
        </div>
      ) : query.isError ? (
        <p className="mt-5 text-sm text-muted-foreground">
          Unavailable · {query.error.message}
        </p>
      ) : (
        <>
          <p className="mt-5 text-xl font-semibold">
            {formatBytes(query.data.free)}{" "}
            <span className="text-xs font-normal text-muted-foreground">
              Available / {formatBytes(query.data.total)}
            </span>
          </p>
          <Progress
            aria-label={`${name} usage`}
            value={Math.max(0, Math.min(100, query.data.pct))}
            className="mt-4"
          />
        </>
      )}
    </Card>
  );
}
export function OverviewPage() {
  const system = useAPI<SystemInfo>("sysinfo", undefined, 5000),
    camera = useAPI<CameraStatus>("camera_status", undefined, 3000),
    wifi = useAPI<WiFiStatus>("wifi_status", undefined, 5000);
  const metrics = [
    {
      label: "Battery level",
      value:
        system.data?.battery_percent == null
          ? "—"
          : `${system.data.battery_percent}%`,
      detail: system.data?.battery_status || "Power status unavailable",
      icon: BatteryMedium,
    },
    {
      label: "Core temperature",
      value:
        system.data?.cpu_temp_c == null
          ? "—"
          : `${system.data.cpu_temp_c.toFixed(1)}°C`,
      detail:
        system.data?.battery_temp_c == null
          ? "Battery temperature unavailable"
          : `Battery ${system.data.battery_temp_c.toFixed(1)}°C`,
      icon: Thermometer,
    },
    {
      label: "CPU usage",
      value:
        system.data?.cpu_percent == null
          ? "—"
          : `${system.data.cpu_percent.toFixed(1)}%`,
      detail: "Sampled value; does not indicate encoder load",
      icon: Cpu,
    },
    {
      label: "RAM",
      value: formatBytes(system.data?.mem_used),
      detail: `Total ${formatBytes(system.data?.mem_total)}`,
      icon: MemoryStick,
    },
  ];
  return (
    <>
      <PageHeader
        title="Device overview"
        description="Keep track of capture, networking, and storage at a glance."
        actions={
          <Button
            variant="outline"
            onClick={() =>
              invalidate(
                "sysinfo",
                "camera_status",
                "wifi_status",
                "disk_usage",
              )
            }
          >
            <RefreshCw />
            Refresh
          </Button>
        }
      />
      {(camera.data?.reboot_required || system.data?.reboot_required) && (
        <div className="mb-5">
          <Notice tone="warning">
            Native camera services have been affected. Stopping the stream will
            not restore native capture; a full reboot is required.
          </Notice>
        </div>
      )}
      {system.isError && (
        <div className="mb-5">
          <Notice tone="error">{system.error.message}</Notice>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <Card key={metric.label}>
            <div className="flex items-center justify-between">
              <span className="metric-label">{metric.label}</span>
              <metric.icon className="size-4 text-muted-foreground" />
            </div>
            <p className="metric-value">{metric.value}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {metric.detail}
            </p>
          </Card>
        ))}
      </div>
      <div className="mt-6">
        <Card
          title={
            <span className="flex items-center gap-2">
              <Wifi className="size-4" />
              Wireless connection
            </span>
          }
        >
          {wifi.isError ? (
            <Notice>Wireless status unavailable: {wifi.error.message}</Notice>
          ) : wifi.isPending ? (
            <Spinner />
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <p className="truncate text-xl font-semibold">
                  {wifi.data.ssid || "Not connected to a network"}
                </p>
                <Badge>
                  {
                    {
                      client: "Client",
                      hotspot: "Hotspot",
                      closed: "Off",
                      native: "Native management",
                      unknown: "Unknown",
                    }[wifi.data.role ?? wifi.data.mode]
                  }
                </Badge>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="metric-label">IP address</p>
                  <p className="mt-2 break-all font-mono">
                    {wifi.data.ip || "—"}
                  </p>
                </div>
                <div>
                  <p className="metric-label">Signal / frequency</p>
                  <p className="mt-2">
                    {wifi.data.signal == null ? "—" : `${wifi.data.signal} dBm`}{" "}
                    / {wifi.data.freq_mhz ?? "—"} MHz
                  </p>
                </div>
              </div>
              <a
                href="#/network"
                className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-primary"
              >
                Manage network
                <ArrowRight className="size-4" />
              </a>
            </>
          )}
        </Card>
      </div>
      <div className="mb-4 mt-8 flex items-center justify-between">
        <h2 className="text-base font-semibold">Storage</h2>
        <a className="text-sm text-primary" href="#/files">
          Browse files →
        </a>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <StorageCard name="Blackbox" path="/" />
        <StorageCard name="Internal storage" path="/emulated" />
        <StorageCard name="SD card" path="/sd" />
      </div>
      <Card title="System details" className="mt-7 text-sm">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Kernel</dt>
            <dd className="mt-1 break-all font-mono">
              {system.data?.kernel || "—"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Uptime</dt>
            <dd className="mt-1">
              {system.data?.uptime_sec == null
                ? "—"
                : `${Math.floor(system.data.uptime_sec / 3600)} hours ${Math.floor((system.data.uptime_sec % 3600) / 60)} minutes`}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Battery current</dt>
            <dd className="mt-1">
              {system.data?.battery_current_ma == null
                ? "—"
                : `${system.data.battery_current_ma} mA`}
            </dd>
          </div>
        </dl>
      </Card>
    </>
  );
}
