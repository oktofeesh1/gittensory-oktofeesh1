import { createFileRoute } from "@tanstack/react-router";

import { BoundaryBadge, Stat, StatusPill } from "@/components/site/control-primitives";
import { StateBoundary } from "@/components/site/state-views";
import { TrendChart } from "@/components/site/trend-chart";
import { useApiResource } from "@/lib/api/use-api-resource";

export const Route = createFileRoute("/app/analytics")({
  component: ProductAnalytics,
});

type OperatorDashboard = {
  metrics: Array<{ label: string; value: string; delta: string }>;
  noiseReduction: Array<{ label: string; value: number; spark: number[] }>;
  usageRollupStatus?: {
    status: "empty" | "ready" | "partial" | "stale" | "incomplete";
    latestRollupDay?: string | null;
    warnings: string[];
  };
  usageRollups?: Array<{
    day: string;
    status: "complete" | "partial" | "incomplete";
    totalEvents: number;
    activeActors: number;
    activeRepos: number;
    activation: {
      fullyActivatedActors: number;
      githubActivatedRepos: number;
    };
  }>;
};

function ProductAnalytics() {
  const dashboard = useApiResource<OperatorDashboard>(
    "/v1/app/operator-dashboard",
    "Product analytics",
  );
  const data = dashboard.status === "ready" ? dashboard.data : null;

  return (
    <StateBoundary
      isLoading={dashboard.status === "loading"}
      isError={dashboard.status === "error"}
      isEmpty={dashboard.status === "ready" && dashboard.data.metrics.length === 0}
      onRetry={dashboard.reload}
      onRefresh={dashboard.reload}
      loadingTitle="Loading analytics…"
      emptyTitle="No analytics yet"
      emptyDescription="Aggregate adoption and command usage metrics will appear once the API has data."
      errorDescription={dashboard.status === "error" ? dashboard.error : undefined}
    >
      {data ? (
        <div className="space-y-8">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="font-mono text-token-2xs uppercase tracking-wider text-mint">
                Analytics
              </div>
              <h1 className="mt-1 font-display text-token-2xl font-semibold tracking-tight">
                Product analytics
              </h1>
              <p className="mt-1 max-w-2xl text-token-sm text-muted-foreground">
                Aggregate deployment, session, digest, and installation metrics from the live API.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill
                status={
                  data.usageRollupStatus?.status === "ready" ||
                  data.usageRollupStatus?.status === "partial"
                    ? "ready"
                    : data.usageRollupStatus?.status === "empty"
                      ? "info"
                      : "degraded"
                }
              >
                {data.usageRollupStatus?.status ?? "Live API"}
              </StatusPill>
              <BoundaryBadge boundary="private-api" />
            </div>
          </header>

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.metrics.map((metric) => (
              <Stat
                key={metric.label}
                label={metric.label}
                value={metric.value}
                hint={<span className="text-mint">{metric.delta}</span>}
              />
            ))}
          </section>

          <section className="rounded-token border border-border bg-transparent p-5">
            <h2 className="font-display text-token-lg font-semibold">Operational trend signals</h2>
            <p className="mt-1 text-token-xs text-muted-foreground">
              Current cached values from app health, repository coverage, and installation health.
            </p>
            <div className="mt-4 grid gap-6 lg:grid-cols-3">
              {data.noiseReduction.map((signal) => (
                <div
                  key={signal.label}
                  className="rounded-token border border-border bg-background/40 p-3"
                >
                  <div className="flex items-center justify-between text-token-xs">
                    <span className="text-muted-foreground">{signal.label}</span>
                    <span className="font-mono text-mint">{signal.value}</span>
                  </div>
                  <div className="mt-3 h-20 w-full">
                    <TrendChart values={signal.spark} height={80} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          {data.usageRollups && data.usageRollups.length > 0 ? (
            <section className="rounded-token border border-border bg-transparent p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-display text-token-lg font-semibold">
                    Daily activation rollups
                  </h2>
                  <p className="mt-1 text-token-xs text-muted-foreground">
                    Hashed actor, repo, command, tool, and maintainer-action funnels by UTC day.
                  </p>
                </div>
                <StatusPill status={data.usageRollupStatus?.warnings.length ? "degraded" : "ready"}>
                  {data.usageRollupStatus?.latestRollupDay ?? "current"}
                </StatusPill>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[680px] text-left text-token-sm">
                  <thead className="border-b border-border text-token-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4 font-medium">Day</th>
                      <th className="py-2 pr-4 font-medium">Status</th>
                      <th className="py-2 pr-4 font-medium">Events</th>
                      <th className="py-2 pr-4 font-medium">Actors</th>
                      <th className="py-2 pr-4 font-medium">Repos</th>
                      <th className="py-2 pr-4 font-medium">Activated</th>
                      <th className="py-2 font-medium">GitHub activated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.usageRollups.slice(0, 7).map((rollup) => (
                      <tr key={rollup.day} className="border-b border-border/60 last:border-0">
                        <td className="py-2 pr-4 font-mono text-token-xs">{rollup.day}</td>
                        <td className="py-2 pr-4">{rollup.status}</td>
                        <td className="py-2 pr-4 font-mono">{rollup.totalEvents}</td>
                        <td className="py-2 pr-4 font-mono">{rollup.activeActors}</td>
                        <td className="py-2 pr-4 font-mono">{rollup.activeRepos}</td>
                        <td className="py-2 pr-4 font-mono">
                          {rollup.activation.fullyActivatedActors}
                        </td>
                        <td className="py-2 font-mono">{rollup.activation.githubActivatedRepos}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </StateBoundary>
  );
}
