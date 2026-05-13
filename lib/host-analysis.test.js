const test = require("node:test");
const assert = require("node:assert/strict");

const { buildWorkspaceGraph } = require("./host-analysis");

function createDoc(fileName) {
  return {
    fileName,
    uri: {
      toString() {
        return `file://${fileName}`;
      }
    }
  };
}

test("workspace graph infers unique cross-file call targets and clears resolved undefined labels", () => {
  const alpha = createDoc("/tmp/ws/alpha.rex");
  const beta = createDoc("/tmp/ws/beta.rex");
  const graphs = new Map([
    [
      alpha.fileName,
      {
        nodes: [
          { id: "MAIN", label: "MAIN", line: 1, kind: "entry", flags: [], sectionId: "main", sectionLabel: "Main", cycleId: "" }
        ],
        edges: [],
        analysis: {
          undefinedLabels: [{ id: "HELPER", callers: ["MAIN"], line: 1 }],
          suspiciousCallTargets: [{ id: "HELPER", callers: ["MAIN"], line: 1, message: "missing" }],
          unreachableProcedures: [],
          orphanProcedures: [],
          recursiveCycles: [],
          possibleInfiniteLoops: [],
          deadCodeStatements: [],
          lineLengthWarnings: [],
          cleanupBypassRisks: [],
          metrics: [{ id: "MAIN", line: 1, fanIn: 0, fanOut: 0, cyclomaticComplexity: 1 }],
          procedures: [{ id: "MAIN", line: 1 }],
          groups: { file: [], kind: [], section: [], cycle: [] }
        }
      }
    ],
    [
      beta.fileName,
      {
        nodes: [
          { id: "MAIN", label: "MAIN", line: 1, kind: "entry", flags: [], sectionId: "main", sectionLabel: "Main", cycleId: "" },
          { id: "HELPER", label: "HELPER", line: 3, kind: "function", flags: [], sectionId: "helpers", sectionLabel: "Helpers", cycleId: "" }
        ],
        edges: [],
        analysis: {
          undefinedLabels: [],
          suspiciousCallTargets: [],
          unreachableProcedures: ["HELPER"],
          orphanProcedures: ["HELPER"],
          recursiveCycles: [],
          possibleInfiniteLoops: [],
          deadCodeStatements: [],
          lineLengthWarnings: [],
          cleanupBypassRisks: [],
          metrics: [
            { id: "MAIN", line: 1, fanIn: 0, fanOut: 0, cyclomaticComplexity: 1 },
            { id: "HELPER", line: 3, fanIn: 0, fanOut: 0, cyclomaticComplexity: 1 }
          ],
          procedures: [{ id: "MAIN", line: 1 }, { id: "HELPER", line: 3 }],
          groups: { file: [], kind: [], section: [], cycle: [] }
        }
      }
    ]
  ]);

  const graph = buildWorkspaceGraph({
    docs: [alpha, beta],
    workspaceFolder: {
      name: "ws",
      uri: { fsPath: "/tmp/ws", toString: () => "file:///tmp/ws" }
    },
    getGraphForDocument(doc) {
      return graphs.get(doc.fileName);
    }
  });

  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.from === "alpha.rex::MAIN" &&
        edge.to === "beta.rex::HELPER" &&
        edge.type === "calls-cross-file"
    )
  );
  assert.equal(graph.analysis.undefinedLabels.length, 0);
  assert.equal(graph.analysis.suspiciousCallTargets.length, 0);
  assert.ok(!graph.analysis.unreachableProcedures.includes("beta.rex::HELPER"));
  const helperMetric = graph.analysis.metrics.find((metric) => metric.id === "beta.rex::HELPER");
  assert.equal(helperMetric.fanIn, 1);
});
