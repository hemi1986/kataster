/**
 * Build-tool graphs.
 *
 * The manifest graph in `repo.ts` answers "who declares a dependency on whom". The build tool knows more:
 * Turborepo has a task graph, Nx its project graph, Bazel the `deps` of every package. `repo-map.ts` asks
 * the tool once and stores the answer as an optional `toolGraph`; `affected.ts` uses it for the fast test
 * loop, while the manifest graph stays the source of truth.
 *
 * Every adapter is optional. No binary, no answer, no problem: the map falls back to manifests and the
 * workflow never depends on a build tool being installed.
 *
 * Edge direction: `{ from, to }` means **from depends on to** – the same direction as `internalDeps`.
 *
 * Node >= 22.18, erasable TypeScript only, no runtime dependency.
 */
import { readBazelGraph } from "./bazel.ts";
import { queryNxGraph } from "./nx.ts";
import { queryTurboGraph } from "./turbo.ts";

export type GraphSource = "turbo" | "nx" | "bazel";

export interface ToolGraph {
  source: GraphSource;
  /** The task/target the graph was queried for (Turbo). Nx and Bazel graphs are target-agnostic. */
  task?: string;
  /** Package names as they appear in `repo-map.packages`. */
  packages: string[];
  edges: { from: string; to: string }[];
  /** Package name → the build tool's own project label, used to emit that tool's native command. */
  projectNames?: Record<string, string>;
}

/** The minimum a graph adapter needs to know about a package. */
export interface GraphPackage {
  name: string;
  path: string;
}

const LABELS: Record<string, string> = { turbo: "Turborepo", nx: "Nx", bazel: "Bazel" };

export function graphLabel(graph: ToolGraph): string {
  return LABELS[graph.source] ?? graph.source;
}

/** Human label for a tooling kind, or undefined when that tool has no graph adapter. */
export function graphToolLabel(kind: string): string | undefined {
  return LABELS[kind];
}

/** How the graph was obtained – quoted in the generated repository map. */
export function graphOrigin(graph: ToolGraph): string {
  switch (graph.source) {
    case "turbo":
      return `turbo run ${graph.task ?? "build"} --dry=json`;
    case "nx":
      return "nx graph --file=<temp>";
    case "bazel":
      return "deps attributes in BUILD/BUILD.bazel";
  }
}

/** One entry point for every adapter. Returns undefined when the tool is absent or does not answer. */
export function queryToolGraph(root: string, kind: string, packages: GraphPackage[]): ToolGraph | undefined {
  switch (kind) {
    case "turbo":
      return queryTurboGraph(root);
    case "nx":
      return queryNxGraph(root, packages);
    case "bazel":
      return readBazelGraph(root, packages);
    default:
      return undefined;
  }
}
