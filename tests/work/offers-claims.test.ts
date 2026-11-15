import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Offers and claims (#award-bids, #662, #760): only the agent offered the work
 * can accept it, once, inside the offer window and under the person's
 * capacity; accepting starts the claim and withdraws the other bids.
 */
const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
  issueClaim: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), count: vi.fn() },
  issueBid: { findFirst: vi.fn(), updateMany: vi.fn() },
  bug: { update: vi.fn(), findFirstOrThrow: vi.fn() },
  bugActivity: { createMany: vi.fn() },
}));
const publish = vi.hoisted(() => vi.fn());
const notifyLater = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notifyLater }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-api/events", () => ({ publish }));
vi.mock("@/lib/watch", () => ({ ensureWatching: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-notifications", () => ({ notifyClaimOffered: vi.fn() }));
vi.mock("@/lib/workflow", async (original) => {
  const { DEFAULT_PROJECT_WORKFLOW } = await import("@/lib/workflow-config");
  return { ...await original<typeof import("@/lib/workflow")>(), workflowFor: vi.fn(async () => ({ ...DEFAULT_PROJECT_WORKFLOW })) };
});

import { acceptOffer, isOfferExpired, OFFER_TTL_MS, releaseClaim } from "@/lib/agent-api/offer";
import { DEFAULT_PROJECT_WORKFLOW } from "@/lib/workflow-config";
import type { AgentContext } from "@/lib/agents/require-agent";
import { yourOpenBidsWhere, yourWorkWhere } from "@/lib/my-work-filter";
import { whatsNext } from "@/lib/whats-next";
import { offerable, pickAgent } from "@/lib/agents/proactive-offers";
import { priorityNow, type PriorityNowIssue } from "@/lib/priority-now";

const agent = { agentId: "agent-1", name: "Ada's Claude", ownerId: "ada", organisationId: "t1", level: "working", burst: false, keyId: "k1" } as AgentContext;
const offered = (overrides: Record<string, unknown> = {}) => ({
  id: "claim-1",
  bugId: "bug-1",
  agentId: "agent-1",
  beneficiaryUserId: "ada",
  status: "offered",
  offeredAt: new Date(),
  releasedAt: null,
  releaseReason: null,
  beneficiary: { name: "Ada" },
  bug: { id: "bug-1", title: "Bug 1", substatus: "open", assigneeId: null, organisationId: "t1", projectId: "p1", areaId: null, voteCount: 0, assignee: null },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((run: (tx: unknown) => unknown) => run(db));
  db.$queryRaw.mockResolvedValue([{ id: "bug-1" }]);
  db.issueClaim.findUnique.mockResolvedValue(offered());
  db.issueClaim.findFirst.mockResolvedValue(null);
  db.issueClaim.count.mockResolvedValue(0);
  db.bug.update.mockResolvedValue({ id: "bug-1", assigneeId: "ada", status: "in_progress", substatus: "in_progress" });
  db.issueBid.updateMany.mockResolvedValue({ count: 2 });
});

describe("accepting an offer", () => {
  it("refuses a paused agent before accepting or changing the offer", async () => {
    await expect(acceptOffer({ ...agent, pausedAt: new Date() }, "claim-1")).rejects.toMatchObject({ status: 423 });
    expect(db.issueClaim.update).not.toHaveBeenCalled();
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("rechecks pause under the agent lock when the owner pauses after authentication", async () => {
    db.$queryRaw.mockResolvedValueOnce([{ id: "bug-1" }]).mockResolvedValueOnce([{ pausedAt: new Date() }]);
    await expect(acceptOffer(agent, "claim-1")).rejects.toMatchObject({ status: 423 });
    expect(db.issueClaim.update).not.toHaveBeenCalled();
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("starts the claim, moves the issue In progress and withdraws the other bids", async () => {
    db.issueBid.findFirst.mockResolvedValue({ id: "bid-1" });
    const result = await acceptOffer(agent, "claim-1");
    expect(result).toMatchObject({ expired: false, claim: { id: "claim-1", status: "active" } });
    expect(db.bug.update).toHaveBeenCalledWith(expect.objectContaining({ data: { assigneeId: "ada", status: "in_progress", substatus: "in_progress" } }));
    expect(db.issueBid.updateMany).toHaveBeenCalledWith({ where: { bugId: "bug-1", withdrawnAt: null, awardedAt: null }, data: { withdrawnAt: expect.any(Date) } });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "claim.accepted" }));
  });

  it("is only for the agent it was offered to, and not from another organisation", async () => {
    await expect(acceptOffer({ ...agent, agentId: "agent-2" }, "claim-1")).rejects.toMatchObject({ status: 409 });
    await expect(acceptOffer({ ...agent, organisationId: "t2" }, "claim-1")).rejects.toMatchObject({ status: 404 });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("refuses when the issue already has an active claim, including a race lost on the unique index", async () => {
    db.issueClaim.findFirst.mockResolvedValue({ id: "claim-active", status: "active", releasedAt: null });
    await expect(acceptOffer(agent, "claim-1")).rejects.toMatchObject({ status: 409 });
    db.$transaction.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6" }));
    await expect(acceptOffer(agent, "claim-1")).rejects.toMatchObject({ status: 409 });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("releases an expired offer instead of starting it", async () => {
    db.issueClaim.findUnique.mockResolvedValue(offered({ offeredAt: new Date(Date.now() - DEFAULT_PROJECT_WORKFLOW.offerWindowSeconds * 1000 - 1000) }));
    await expect(acceptOffer(agent, "claim-1")).rejects.toMatchObject({ status: 410 });
    expect(db.issueClaim.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "released", releaseReason: "expired" }) }));
  });

  it("releases it when the person already holds their limit of work In progress", async () => {
    db.issueClaim.count.mockResolvedValue(DEFAULT_PROJECT_WORKFLOW.maxActiveClaims);
    await expect(acceptOffer(agent, "claim-1")).rejects.toMatchObject({ status: 409 });
    expect(db.issueClaim.count.mock.calls[0][0].where.bug).toMatchObject({ status: "in_progress" });
    expect(db.issueClaim.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ releaseReason: "capacity" }) }));
  });
});

describe("the offer window", () => {
  it("expires an offer at its window, but not before", () => {
    const offeredAt = new Date("2026-10-19T12:00:00.000Z");
    expect(isOfferExpired(offeredAt, offeredAt.getTime() + OFFER_TTL_MS - 1)).toBe(false);
    expect(isOfferExpired(offeredAt, offeredAt.getTime() + OFFER_TTL_MS)).toBe(true);
    expect(isOfferExpired(null, offeredAt.getTime())).toBe(true);
  });
});

/**
 * Your work on Project Overview (#your-work): what is yours to move, and which
 * kind it is. Claims held or offered for you are listed; open bids are only
 * counted; finished work and importance marks don't count.
 */
describe("your work", () => {
  it("lists your claims, not your bids, and nothing finished", () => {
    const where = yourWorkWhere("u1");
    expect(where.status).toEqual({ notIn: ["resolved", "closed"] });
    // #plan-review: an award under plan review is yours too.
    expect(where.claims).toEqual({ some: { beneficiaryUserId: "u1", status: { in: ["offered", "planning", "active"] }, releasedAt: null } });
    expect(yourOpenBidsWhere("u1")).toEqual({ status: "open", bids: { some: { beneficiaryUserId: "u1", withdrawnAt: null, awardedAt: null } } });
  });

  it("tags each kind: a bid waits, an offer is yours to accept, late work is overdue", () => {
    const now = Date.parse("2026-11-05T12:00:00Z");
    expect(whatsNext("open", [], true, now)).toMatchObject({ tag: "Your bid", yours: false });
    expect(whatsNext("open", [{ status: "offered" }], true, now)).toMatchObject({ tag: "Offered to you", yours: true });
    expect(whatsNext("in_progress", [{ status: "active", deliverBy: new Date(now + 3_600_000 * 5) }], false, now)).toMatchObject({ tag: "Assigned to you", yours: true });
    expect(whatsNext("in_progress", [{ status: "active", deliverBy: new Date(now - 1) }], false, now)).toMatchObject({ tag: "Overdue", late: true });
    expect(whatsNext("error", [{ status: "active" }], false, now)).toMatchObject({ tag: "Can't merge", yours: true });
  });
});

describe("releasing a claim", () => {
  const issueId = "clreleaseissue0000000000000";
  const release = (status: string, pullRequestUrl: string | null = null) => {
    db.$queryRaw.mockResolvedValue([{ id: issueId }]);
    db.issueClaim.findFirst.mockResolvedValue(offered({ bugId: issueId, status }));
    db.issueClaim.count.mockResolvedValue(0);
    db.bug.findFirstOrThrow.mockResolvedValue({ id: issueId, title: "Bug 1", reporterId: "reporter", status: "in_progress", assigneeId: "ada", projectId: "p1", areaId: null, pullRequestUrl });
    return releaseClaim(agent, "p1", issueId);
  };

  it("alerts watchers when letting go of active work reopens bidding", async () => {
    await expect(release("active")).resolves.toMatchObject({ reopened: true });
    expect(notifyLater).toHaveBeenCalledWith({ kind: "status_changed", actorId: "ada", actorName: agent.name, bugId: issueId, bugTitle: "Bug 1", reporterId: "reporter", from: "in_progress", to: "open" });
  });

  it("sends no alert when bidding does not reopen", async () => {
    await expect(release("offered")).resolves.toMatchObject({ reopened: false });
    await expect(release("active", "https://github.com/emerjent/ziki/pull/1")).resolves.toMatchObject({ reopened: false });
    expect(notifyLater).not.toHaveBeenCalled();
  });
});

/**
 * Priority now and proactive offers (#priority-now, #proactive-offers): the
 * site offers a project's top-priority unheld issues to idle agents. The
 * order decides what is offered first; the gates keep it from taking work
 * someone asked for or holds.
 */

describe("priority now and proactive offers (#proactive-offers)", () => {
  const row = (number: number, priority: string) => ({ id: `b${number}`, number, title: `#${number}`, priority, areaId: null, difficulty: "medium", _count: { bids: 0 }, claims: [] });

  it("ranks urgent, then high, then medium, then low, and stops at the limit", async () => {
    const byPriority: Record<string, ReturnType<typeof row>[]> = {
      urgent: [row(7, "urgent")],
      high: [row(3, "high"), row(4, "high")],
      medium: [row(1, "medium"), row(2, "medium")],
      low: [row(9, "low")],
    };
    const findMany = vi.fn(async ({ where, take }: { where: { priority: string | { notIn: string[] } }; take: number }) =>
      (typeof where.priority === "string" ? byPriority[where.priority]! : byPriority.medium!).slice(0, take));
    const top = await priorityNow({ organisationId: "t1", projectId: "p1", offerWindowSeconds: 1800 }, 4, { bug: { findMany } } as never);
    expect(top.map((issue) => issue.number)).toEqual([7, 3, 4, 1]);
    // Low was never read: the limit was reached first.
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it("offers only an issue nobody holds, with no open bids, that isn't complex", () => {
    const issue = (overrides: Partial<PriorityNowIssue> = {}): PriorityNowIssue => ({
      id: "b1", number: 1, title: "x", priority: "urgent", areaId: null, difficulty: "medium", openBids: 0, offer: null, ...overrides,
    });
    expect(offerable(issue())).toBe(true);
    expect(offerable(issue({ openBids: 1 }))).toBe(false);
    expect(offerable(issue({ difficulty: "complex" }))).toBe(false);
    expect(offerable(issue({ offer: { claimId: "c1", agentId: "a1", agentName: "Pixel", ownerName: "Ada", offeredAt: new Date(), planning: false } }))).toBe(false);
  });

  it("picks an area match first, then the agent seen most recently, never one offered the issue before", () => {
    const now = Date.now();
    const idle = [
      { id: "recent", ownerUserId: "u1", areaIds: new Set<string>(), lastSeenAt: new Date(now - 1_000) },
      { id: "area", ownerUserId: "u2", areaIds: new Set(["checkout"]), lastSeenAt: new Date(now - 600_000) },
      { id: "older", ownerUserId: "u3", areaIds: new Set<string>(), lastSeenAt: new Date(now - 300_000) },
    ];
    expect(pickAgent({ areaId: "checkout" }, idle, new Set())?.id).toBe("area");
    expect(pickAgent({ areaId: null }, idle, new Set())?.id).toBe("recent");
    expect(pickAgent({ areaId: "checkout" }, idle, new Set(["area"]))?.id).toBe("recent");
    expect(pickAgent({ areaId: null }, idle, new Set(["recent", "area", "older"]))).toBeNull();
  });
});
