import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Dashboard graph GPU isolation", () => {
  it("never creates a WebGL context or bundles a second 3D engine", () => {
    const dashboardSource = readFileSync(
      new URL("./dashboard-view.ts", import.meta.url),
      "utf8"
    );
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencyNames = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {})
    ];

    expect(dashboardSource).not.toMatch(/getContext\(["']webgl/iu);
    expect(dashboardSource).not.toMatch(/3d-force-graph/iu);
    expect(dependencyNames).not.toContain("3d-force-graph");
    expect(dependencyNames).not.toContain("three");
  });
});
