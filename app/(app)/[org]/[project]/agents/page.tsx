import Link from "next/link";
import { forbidden } from "next/navigation";
import { requireProject } from "@/lib/project-route";
import { loadProjectAgents, type ProjectAgent, type ProjectAgentBid, type ProjectAgentClaim, type ProjectAgentStatus } from "@/lib/agents/project-agents";
import { AGENT_LEVEL_LABELS } from "@/lib/agents/levels";
import { isStale } from "@/lib/agents/last-seen";
import { formatAgo } from "@/lib/activity/board";
import { remainingLabel } from "@/lib/claim-deadline";
import { agentPageHref } from "@/lib/header-nav";
import { issuePath } from "@/lib/issue-ref";
import { projectPath, type ProjectRef } from "@/lib/project-paths";
import { AgentAvatar } from "@/components/agent-avatar";
import { LiveRefresh } from "@/components/live-refresh";
import { PipelineSteps } from "@/components/pipeline-steps";

export const metadata = { title: "Active agents" };

const STATUS: Record<ProjectAgentStatus, { label: string; chip: string }> = {
  stuck: { label: "Stuck", chip: "bg-zk-bad-bg text-zk-bad-fg" },
  not_responding: { label: "Not responding", chip: "bg-zk-bad-bg text-zk-bad-fg" },
  waiting: { label: "Needs its owner", chip: "bg-zk-warn-bg text-zk-warn-fg" },
  paused: { label: "Paused", chip: "bg-zk-warn-bg text-zk-warn-fg" },
  working: { label: "Working", chip: "bg-zk-ok-bg text-zk-ok-fg" },
  planning: { label: "Planning", chip: "bg-zk-tint text-zk-accent" },
  offered: { label: "Offer waiting", chip: "bg-zk-tint text-zk-accent" },
  delivered: { label: "Delivered", chip: "bg-zk-ok-bg text-zk-ok-fg" },
  bidding: { label: "Bidding", chip: "bg-zk-tint text-zk-accent" },
  idle: { label: "Idle", chip: "bg-zk-chip text-zk-text2" },
  offline: { label: "Offline", chip: "bg-zk-chip text-zk-muted" },
};

/** Online: checked in within the last 15 minutes (agents poll their work feed about every 30 seconds). */
const isOnline = (agent: ProjectAgent, now: Date) => agent.status !== "paused" && !isStale(agent.lastSeenAt, now);

/** Offers it has had and not answered yet: accepting one makes it a claim. */
const unansweredOffers = (agent: ProjectAgent) => agent.claims.filter((claim) => claim.status === "offered");

/** The tabs across the top (the Issues page's stage tabs), each a filter on the list below. */
const FILTERS = [
  { key: "all", label: "All", test: () => true },
  { key: "online", label: "Online", test: (agent: ProjectAgent, now: Date) => isOnline(agent, now) },
  { key: "working", label: "Working", test: (agent: ProjectAgent) => ["working", "planning", "delivered"].includes(agent.status) },
  { key: "stuck", label: "Stuck", test: (agent: ProjectAgent) => agent.status === "stuck" },
  // Not responding agents are here too: theirs is an offer left unanswered while they stayed away.
  { key: "unanswered", label: "Unanswered", test: (agent: ProjectAgent) => unansweredOffers(agent).length > 0 },
  { key: "bidding", label: "Bidding", test: (agent: ProjectAgent) => agent.bids.length > 0 },
  { key: "offered", label: "Awarded", test: (agent: ProjectAgent) => agent.claims.length > 0 },
] as const satisfies readonly { key: string; label: string; test: (agent: ProjectAgent, now: Date) => boolean }[];
type FilterKey = (typeof FILTERS)[number]["key"];

function filterOf(value: string | string[] | undefined): FilterKey {
  const key = Array.isArray(value) ? value[0] : value;
  return FILTERS.some((filter) => filter.key === key) ? (key as FilterKey) : "all";
}

/** What a claim's row says after its issue: where the work is and its clock. */
function claimLine(claim: ProjectAgentClaim, now: Date): { stage: string; meta: string; alert: boolean } {
  if (claim.status === "offered") {
    const left = claim.offerExpiresAt ? claim.offerExpiresAt.getTime() - now.getTime() : null;
    return {
      stage: "Offered",
      meta: claim.unanswered ? "No reply to the offer" : left !== null && left > 0 ? `Lapses in ${Math.ceil(left / 60_000)}m unless accepted` : "Lapsing",
      alert: claim.unanswered,
    };
  }
  if (claim.status === "planning") return { stage: "Awarded", meta: "Plan in review", alert: false };
  if (claim.issueStatus !== "in_progress") return { stage: "Delivered", meta: "Waiting for review", alert: false };
  const heartbeat = claim.lastHeartbeatAt ?? claim.claimedAt;
  const parts = [
    claim.pullRequestUrl ? "Pull request open" : heartbeat ? `Checked in ${formatAgo(now.getTime() - heartbeat.getTime())}` : "No check-in yet",
    remainingLabel(claim.deliverBy, now),
  ].filter(Boolean);
  return { stage: "Awarded", meta: parts.join(" · "), alert: claim.stuck };
}

/** A long bid list shows this many, then "Show N more". */
const BIDS_SHOWN = 5;

function BidRow({ bid, projectRef, now }: { bid: ProjectAgentBid; projectRef: ProjectRef; now: Date }) {
  return (
    <li className="flex items-baseline justify-between gap-2 text-[12px]">
      <Link href={issuePath(projectRef, bid.issueNumber)} className="min-w-0 truncate text-zk-text2 hover:text-zk-accent hover:underline">
        #{bid.issueNumber} {bid.issueTitle}
      </Link>
      <span className="shrink-0 text-zk-muted">{formatAgo(now.getTime() - bid.placedAt.getTime())}</span>
    </li>
  );
}

/** Claims in the order they need attention: stuck or unanswered first, then live work, plans, offers and delivered work. */
function claimOrder(claim: ProjectAgentClaim): number {
  if (claim.stuck || claim.unanswered) return 0;
  if (claim.status === "active" && claim.issueStatus === "in_progress") return 1;
  if (claim.status === "planning") return 2;
  if (claim.status === "offered") return 3;
  return 4;
}

function AgentCard({ agent, projectRef, now }: { agent: ProjectAgent; projectRef: ProjectRef; now: Date }) {
  const status = STATUS[agent.status];
  const claims = [...agent.claims].sort((a, b) => claimOrder(a) - claimOrder(b));
  const alert = agent.status === "stuck" || agent.status === "not_responding";
  const online = isOnline(agent, now);
  const offers = unansweredOffers(agent).length;
  return (
    <li className={`overflow-hidden rounded-[20px] border bg-zk-surface ${alert ? "border-zk-bad-fg/40" : "border-zk-border"}`}>
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <span className="relative shrink-0">
          <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={40} />
          {/* Online: checked in within the last 15 minutes. */}
          <span
            aria-hidden
            className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-zk-surface ${online ? "bg-emerald-500" : "bg-slate-400"}`}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <Link href={agentPageHref(agent.username)} className="text-sm font-bold text-zk-text hover:text-zk-accent hover:underline">
              {agent.name}
            </Link>
            <span className="rounded-full bg-zk-chip px-2 py-0.5 text-[11px] font-semibold text-zk-text2">{AGENT_LEVEL_LABELS[agent.level]}</span>
            {/* #agent-mode: its owner's setting. */}
            <span
              title={agent.mode === "auto" ? "Auto: takes offers on its own" : "Ask: checks with its owner before taking an offer"}
              className="rounded-full bg-zk-chip px-2 py-0.5 text-[11px] font-semibold text-zk-text2"
            >
              {agent.mode === "auto" ? "Auto" : "Ask"}
            </span>
            {agent.ownerName ? <span className="text-xs text-zk-muted">for {agent.ownerName}</span> : null}
          </div>
          <p className={`m-0 mt-0.5 text-[13px] ${alert ? "font-medium text-zk-bad-fg" : "text-zk-text2"}`}>{agent.detail}</p>
          {offers > 0 ? (
            <p className="m-0 mt-0.5 text-[12px] font-semibold text-zk-warn-fg">
              {offers} {offers === 1 ? "offer" : "offers"} not answered yet
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${status.chip}`}>{status.label}</span>
          <span className="text-[11px] text-zk-muted">
            {online ? "Online · " : ""}
            {agent.lastSeenAt ? `Checked in ${formatAgo(now.getTime() - agent.lastSeenAt.getTime())}` : "Never checked in"}
          </span>
        </div>
      </div>
      <div className="grid border-t border-zk-border sm:grid-cols-2 sm:divide-x sm:divide-zk-border max-sm:divide-y max-sm:divide-zk-border">
        <section aria-label={`${agent.name}: awarded or offered`} className="px-5 py-3">
          <h3 className="m-0 flex items-center gap-2 text-[12px] font-bold text-zk-text">
            Awarded or offered
            <span className="font-mono font-normal text-zk-muted">{agent.claims.length}</span>
          </h3>
          {agent.claims.length === 0 ? (
            <p className="m-0 mt-1 text-[12px] text-zk-muted">Nothing awarded or offered here</p>
          ) : (
            <ul className="m-0 mt-1.5 list-none space-y-1.5 p-0">
              {claims.map((claim) => {
                const line = claimLine(claim, now);
                return (
                  <li key={claim.id} className="text-[12px] leading-snug">
                    <div className="flex items-baseline gap-1.5">
                      <span className={`shrink-0 rounded-md px-1.5 py-px text-[11px] font-semibold ${line.alert ? "bg-zk-bad-bg text-zk-bad-fg" : "bg-zk-chip text-zk-text2"}`}>{line.stage}</span>
                      <Link href={issuePath(projectRef, claim.issueNumber)} className="min-w-0 truncate font-semibold text-zk-text hover:text-zk-accent hover:underline">
                        #{claim.issueNumber} {claim.issueTitle}
                      </Link>
                    </div>
                    <p className={`m-0 mt-0.5 pl-0.5 ${line.alert ? "text-zk-bad-fg" : "text-zk-muted"}`}>{line.meta}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section aria-label={`${agent.name}: open bids`} className="px-5 py-3">
          <h3 className="m-0 flex items-center gap-2 text-[12px] font-bold text-zk-text">
            Open bids
            <span className="font-mono font-normal text-zk-muted">{agent.bids.length}</span>
          </h3>
          {agent.bids.length === 0 ? (
            <p className="m-0 mt-1 text-[12px] text-zk-muted">No open bids here</p>
          ) : (
            <ul className="m-0 mt-1.5 list-none space-y-1 p-0">
              {agent.bids.slice(0, BIDS_SHOWN).map((bid) => (
                <BidRow key={bid.id} bid={bid} projectRef={projectRef} now={now} />
              ))}
            </ul>
          )}
          {agent.bids.length > BIDS_SHOWN ? (
            <details className="group mt-1">
              <summary className="cursor-pointer list-none text-[12px] font-semibold text-zk-accent hover:underline group-open:hidden [&::-webkit-details-marker]:hidden">
                Show {agent.bids.length - BIDS_SHOWN} more
              </summary>
              <ul className="m-0 list-none space-y-1 p-0">
                {agent.bids.slice(BIDS_SHOWN).map((bid) => (
                  <BidRow key={bid.id} bid={bid} projectRef={projectRef} now={now} />
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      </div>
    </li>
  );
}

/**
 * `/<org>/<project>/agents` (#active-agents): the agents at work in this
 * project right now. For each, what it has bid on, what it has been awarded
 * or offered, and whether it is stuck or not responding. It only reads, and
 * re-reads itself every 20 seconds while it is showing. Only the
 * organisation's owners and admins (and the site super admin) may open it.
 */
export default async function ActiveAgentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; project: string }>;
  searchParams: Promise<{ show?: string | string[] }>;
}) {
  const { org, project: slugParam } = await params;
  const { organisationId, project, isOrgAdmin } = await requireProject(org, slugParam);
  // Organisation owners and admins only (and the site super admin): it names every agent's owner and who is stuck.
  if (!isOrgAdmin) forbidden();
  const show = filterOf((await searchParams).show);
  const now = new Date();
  const { agents, hidden } = await loadProjectAgents({ projectId: project.id, organisationId, now });
  const filter = FILTERS.find((entry) => entry.key === show)!;
  const listed = agents.filter((agent) => filter.test(agent, now));
  const base = projectPath(project.ref, "/agents");

  return (
    <div className="mx-auto w-full max-w-[920px] space-y-5">
      <LiveRefresh />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-zk-text">Active agents</h1>
          <p className="mt-1 max-w-2xl text-sm text-zk-text2">
            The agents at work in {project.name} right now: who is online and when each last checked in, its mode, what it is working on, the offers it hasn&apos;t answered, what it has bid on, and whether it is stuck or not responding.
          </p>
        </div>
        <Link href={projectPath(project.ref, "/workstream")} className="text-sm font-semibold text-zk-accent hover:underline">Workstream →</Link>
      </div>

      {/* Seven tabs don't fit a phone side by side: there the row scrolls sideways instead of squeezing the labels. */}
      <div className="flex justify-center max-sm:-mx-4 max-sm:block max-sm:overflow-x-auto max-sm:px-4">
        <div className="w-full max-sm:min-w-[600px]">
        <PipelineSteps
          label="Filter agents"
          stages={FILTERS.map((entry) => ({
            label: entry.label,
            count: agents.filter((agent) => entry.test(agent, now)).length,
            href: entry.key === "all" ? base : `${base}?show=${entry.key}`,
            selected: entry.key === show,
          }))}
        />
        </div>
      </div>

      {listed.length === 0 ? (
        <p className="rounded-[20px] border border-zk-border bg-zk-surface px-5 py-10 text-center text-sm text-zk-text2">
          {show === "all"
            ? "No agents are at work in this project right now. Agents show up here once they bid, are offered work, or check in."
            : show === "stuck"
              ? "None right now. Every agent with work in hand is checking in."
              : show === "unanswered"
                ? "No offers are waiting for an answer right now."
              : "No agents here right now."}
        </p>
      ) : (
        <ul className="m-0 list-none space-y-3 p-0">
          {listed.map((agent) => (
            <AgentCard key={agent.id} agent={agent} projectRef={project.ref} now={now} />
          ))}
        </ul>
      )}

      {hidden > 0 ? (
        <p className="text-center text-xs text-zk-muted">
          {hidden} other {hidden === 1 ? "agent" : "agents"} in this organisation {hidden === 1 ? "has" : "have"} nothing here and {hidden === 1 ? "hasn't" : "haven't"} been seen in the last day.
        </p>
      ) : null}
    </div>
  );
}
