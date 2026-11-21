import { Navigate, useLocation } from "react-router-dom";
import { useQuery } from "../../api/client";
import type { DecisionKind } from "../../api/types";
import type { ViewDef, ViewProps } from "../../registry/types";
import { Pending } from "../../ui/atoms/Pending";
import { decisionPath, itemPath, parseDecisionRoute } from "../../lib/links";
import { Refs } from "./Refs";
import { OpenQuestions } from "../item/ItemDecisions";

/** Puts the old link's query in front of the anchor. */
const withQuery = (path: string, search: string): string => {
  const i = path.indexOf("#");
  return i < 0 ? `${path}${search}` : `${path.slice(0, i)}${search}${path.slice(i)}`;
};

/**
 * The old decision links (`/needs/decisions/<id>`, `/<repo>/<n>`, `/<repo>/<n>/<kind>`) open the item page of the decision, scrolled to its block.
 * A decision without any item has no page of its own beyond its question.
 */
function DecisionRedirect({ params }: ViewProps) {
  const loc = useLocation();
  const route = parseDecisionRoute({ id: params.id, repo: params.repo, n: params.n, kind: params.kind });
  const byItem = route.by === "item" ? route : undefined;
  const byId = route.by === "id" ? route.id : undefined;
  const found = useQuery(`decision:redirect:${byId ?? ""}:${byItem ? `${byItem.repo}#${byItem.number}:${byItem.kind ?? ""}` : ""}`, async (a) => {
    if (byId) return a.decisions.get(byId);
    if (byItem) return a.decisions.forItem(byItem.repo, byItem.number, byItem.kind as DecisionKind | undefined);
    return null;
  }, { enabled: route.by !== "none" });
  if (route.by === "none") return <Navigate to={`/needs${loc.search}`} replace />;
  if (found.loading) return <Pending error={found.error} />;
  const d = found.data;
  if (byItem) return <Navigate to={withQuery(d ? decisionPath(d) : `${itemPath(byItem.repo, byItem.number)}${loc.hash}`, loc.search)} replace />;
  if (!d) return <Pending error={found.error ?? new Error("No such decision")} />;
  const to = decisionPath(d);
  if (!to.startsWith("/needs/decisions/")) return <Navigate to={withQuery(to, loc.search)} replace />;
  // A question with no item (a repo's red default branch) is answered here, with the same card an item page shows.
  return (
    <div className="mx-auto max-w-[720px] space-y-3 px-4 py-6 md:px-6">
      <h1 className="text-lg font-semibold">{d.repo ? <Refs text={d.repo} repo={d.repo} /> : d.title}</h1>
      {d.answer ? (
        <p className="text-sm font-semibold">
          <Refs text={d.question} repo={d.repo} />
        </p>
      ) : (
        // No prepared choices are read here (a repo-level question gets none): null shows its options as plain answers.
        <OpenQuestions ds={[d]} choices={null} />
      )}
    </div>
  );
}

export const decisionRedirectView: ViewDef = {
  id: "decision-redirect",
  title: "Decision",
  panels: [{ id: "body", title: "Decision", component: DecisionRedirect, defaultSize: 100 }],
};
