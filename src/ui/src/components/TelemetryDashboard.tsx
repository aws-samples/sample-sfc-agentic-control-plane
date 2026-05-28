/**
 * TelemetryDashboard — Live channel values table with Chart.js sparklines.
 *
 * Fetches channel telemetry every 10 seconds and renders a table with:
 *   Channel Name | Current Value | Sparkline (mini Chart.js line) | Last Updated
 */
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
} from "chart.js";
import { Line } from "react-chartjs-2";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  getChannelTelemetry,
  type TelemetryChannel,
} from "../api/client";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler);

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

export default function TelemetryDashboard({ packageId }: Props) {
  const [lookback, setLookback] = useState(5);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["telemetry", packageId, lookback],
    queryFn: () => getChannelTelemetry(packageId, lookback),
    refetchInterval: 10_000,
  });

  const channels: TelemetryChannel[] = data?.channels ?? [];
  const lastUpdated = data?.lastUpdated;

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
              {channels.length} channel{channels.length !== 1 ? "s" : ""}
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
              {channels.map((ch) => (
                <tr
                  key={ch.name}
                  className="border-b border-slate-700/50 last:border-0"
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
      )}
    </div>
  );
}
