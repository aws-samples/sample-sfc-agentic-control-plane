/**
 * TelemetryDashboard — Live channel values table with Chart.js sparklines.
 *
 * Fetches channel telemetry every 10 seconds and renders a table with:
 *   Channel Name | Current Value | Sparkline (mini Chart.js line) | Last Updated
 *
 * Clicking a row opens a detail modal with a full-size chart, data table, and CSV export.
 */
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  TimeScale,
  Tooltip,
} from "chart.js";
import "chartjs-adapter-date-fns";
import { Line } from "react-chartjs-2";
import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import {
  getChannelTelemetry,
  type TelemetryChannel,
} from "../api/client";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  TimeScale,
  Tooltip
);

const LOOKBACK_OPTIONS = [
  { label: "1 min", value: 1 },
  { label: "5 min", value: 5 },
  { label: "15 min", value: 15 },
  { label: "30 min", value: 30 },
];

interface Props {
  packageId: string;
}

function Sparkline({ data }: { data: number[] }) {
  const chartData = {
    labels: data.map((_, i) => i),
    datasets: [
      {
        data,
        borderColor: "#38bdf8",
        backgroundColor: "rgba(56,189,248,0.1)",
        borderWidth: 1.5,
        tension: 0.3,
        fill: true,
        pointRadius: 0,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: { display: false },
      y: { display: false },
    },
    animation: false as const,
  };

  return (
    <div className="h-8 w-32">
      <Line data={chartData} options={options} />
    </div>
  );
}

function ChannelDetailModal({
  channel,
  onClose,
}: {
  channel: TelemetryChannel;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const chartData = {
    labels: channel.timestamps.map((t) => new Date(t)),
    datasets: [
      {
        label: channel.name,
        data: channel.sparkline,
        borderColor: "#38bdf8",
        backgroundColor: "rgba(56,189,248,0.1)",
        borderWidth: 2,
        tension: 0.3,
        fill: true,
        pointRadius: 2,
        pointBackgroundColor: "#38bdf8",
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { enabled: true },
    },
    scales: {
      x: {
        type: "time" as const,
        time: { tooltipFormat: "HH:mm:ss" },
        ticks: { color: "#94a3b8", maxTicksLimit: 10 },
        grid: { color: "#334155" },
      },
      y: {
        ticks: { color: "#94a3b8" },
        grid: { color: "#334155" },
      },
    },
    animation: false as const,
  };

  const handleCopyCsv = () => {
    const header = "timestamp,value";
    const rows = channel.timestamps.map(
      (ts, i) => `${ts},${channel.sparkline[i]}`
    );
    const csv = [header, ...rows].join("\n");
    navigator.clipboard.writeText(csv).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-3xl max-h-[85vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-200 font-mono">
            {channel.name}
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopyCsv}
              className="btn btn-secondary text-xs py-1 px-3"
            >
              {copied ? "Copied!" : "Copy CSV"}
            </button>
            <button
              onClick={onClose}
              className="text-slate-500 hover:text-slate-300 text-lg px-2"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Chart */}
        <div className="h-48 mb-4">
          <Line data={chartData} options={chartOptions} />
        </div>

        {/* Data table */}
        <div className="flex-1 overflow-auto border border-slate-700 rounded">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-slate-800">
              <tr className="border-b border-slate-700 text-slate-400">
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Timestamp</th>
                <th className="px-3 py-2 font-medium text-right">Value</th>
              </tr>
            </thead>
            <tbody>
              {channel.timestamps.map((ts, i) => (
                <tr
                  key={i}
                  className="border-b border-slate-700/30 hover:bg-slate-700/20"
                >
                  <td className="px-3 py-1.5 text-slate-500">{i + 1}</td>
                  <td className="px-3 py-1.5 font-mono text-slate-300">
                    {new Date(ts).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    } as Intl.DateTimeFormatOptions)}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-sky-300 text-right">
                    {channel.sparkline[i]?.toFixed(4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="mt-3 flex justify-between text-xs text-slate-500">
          <span>{channel.sparkline.length} data points</span>
          <span>
            Min: {Math.min(...channel.sparkline).toFixed(3)} | Max:{" "}
            {Math.max(...channel.sparkline).toFixed(3)}
          </span>
        </div>
      </div>
    </div>
  );
}

const PAGE_SIZE = 20;

export default function TelemetryDashboard({ packageId }: Props) {
  const [lookback, setLookback] = useState(5);
  const [selectedChannel, setSelectedChannel] = useState<TelemetryChannel | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => setPage(0), [searchTerm, lookback]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["telemetry", packageId, lookback],
    queryFn: () => getChannelTelemetry(packageId, lookback),
    refetchInterval: 10_000,
  });

  const channels: TelemetryChannel[] = data?.channels ?? [];
  const lastUpdated = data?.lastUpdated;

  const filtered = channels.filter((ch) =>
    ch.name.toLowerCase().includes(searchTerm.toLowerCase())
  );
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 p-4">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-slate-200">
            Channel Values
          </h3>
          {channels.length > 0 && (
            <span className="rounded bg-sky-900/50 px-2 py-0.5 text-xs text-sky-300">
              {searchTerm
                ? `${filtered.length} of ${channels.length}`
                : channels.length}{" "}
              channel{(searchTerm ? filtered.length : channels.length) !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="text-xs text-slate-500">
              {new Date(lastUpdated).toLocaleTimeString()}
            </span>
          )}
          <div className="flex gap-1">
            {LOOKBACK_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setLookback(opt.value)}
                className={`rounded px-2 py-0.5 text-xs transition ${
                  lookback === opt.value
                    ? "bg-sky-600 text-white"
                    : "bg-slate-700 text-slate-400 hover:bg-slate-600"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      {isLoading && (
        <p className="py-8 text-center text-sm text-slate-500">
          Loading telemetry...
        </p>
      )}

      {isError && (
        <p className="py-8 text-center text-sm text-red-400">
          Failed to load telemetry data.
        </p>
      )}

      {!isLoading && !isError && channels.length === 0 && (
        <p className="py-8 text-center text-sm text-slate-500">
          Waiting for channel data...
        </p>
      )}

      {!isLoading && !isError && channels.length > 0 && (
        <div className="space-y-2">
          {/* Search — shown when > 10 channels */}
          {channels.length > 10 && (
            <input
              type="text"
              placeholder="Search channels..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-[#0f1117] border border-[#2a3044] rounded px-3 py-1.5 text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-sky-600"
            />
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-xs text-slate-400">
                  <th className="pb-2 pr-4 font-medium">Channel</th>
                  <th className="pb-2 pr-4 font-medium text-right">Value</th>
                  <th className="pb-2 pr-4 font-medium">Trend</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map((ch) => (
                  <tr
                    key={ch.name}
                    className="border-b border-slate-700/50 last:border-0 cursor-pointer hover:bg-slate-700/30 transition"
                    onClick={() => setSelectedChannel(ch)}
                  >
                    <td className="py-2 pr-4 font-mono text-xs text-slate-300">
                      {ch.name}
                    </td>
                    <td className="py-2 pr-4 text-right font-mono text-xs text-sky-300">
                      {ch.currentValue !== null
                        ? typeof ch.currentValue === "number"
                          ? ch.currentValue.toFixed(3)
                          : ch.currentValue
                        : "—"}
                    </td>
                    <td className="py-2 pr-4">
                      {ch.sparkline.length > 1 ? (
                        <Sparkline data={ch.sparkline} />
                      ) : (
                        <span className="text-xs text-slate-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination — shown when filtered results exceed PAGE_SIZE */}
          {filtered.length > PAGE_SIZE && (
            <div className="flex items-center justify-between pt-1">
              <button
                className="btn btn-secondary text-xs py-1 px-2"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                Prev
              </button>
              <span className="text-xs text-slate-500">
                Page {page + 1} of {totalPages}
              </span>
              <button
                className="btn btn-secondary text-xs py-1 px-2"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {/* Channel detail modal */}
      {selectedChannel && (
        <ChannelDetailModal
          channel={selectedChannel}
          onClose={() => setSelectedChannel(null)}
        />
      )}
    </div>
  );
}
