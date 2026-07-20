import { describe, expect, it } from "vitest";
import { parseProductRoute, productRoutePath } from "./navigation.js";

describe("product routes", () => {
  it("round-trips settings secondary routes", () => {
    const route = { feature: "settings", section: "writing" } as const;
    expect(parseProductRoute(productRoutePath(route))).toEqual(route);
  });

  it("round-trips skill tertiary routes", () => {
    const route = { feature: "skills", skillId: "lore_extract", mode: "versions" } as const;
    expect(parseProductRoute(productRoutePath(route))).toEqual(route);
  });

  it("round-trips the skill import preview route", () => {
    const route = { feature: "skills", mode: "import" } as const;
    expect(parseProductRoute(productRoutePath(route))).toEqual(route);
  });

  it("round-trips the cover workspace route", () => {
    const route = { feature: "cover" } as const;
    expect(productRoutePath(route)).toBe("/cover");
    expect(parseProductRoute("/cover")).toEqual(route);
  });

  it("does not expose diagnostic or legacy aliases as product routes", () => {
    expect(parseProductRoute("/terminal")).toBeNull();
    expect(parseProductRoute("/card_draw")).toBeNull();
    expect(parseProductRoute("/traces")).toBeNull();
  });
});
