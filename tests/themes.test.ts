import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { loadThemeFromPath, setThemeJsonValidator } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { validateThemeJson } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-schema.js";
test("the single offense theme is red throughout and renders under truecolor and reduced-color terminals", () => {
  setThemeJsonValidator(validateThemeJson);
  for (const colorMode of ["truecolor", "256color"] as const) {
    const offense = loadThemeFromPath(resolve("themes/cyber-offense.json"), colorMode);
    expect(offense.fg("accent", "OFFENSE")).toContain("OFFENSE");
    expect(offense.fg("border", "label")).toBe(offense.fg("accent", "label"));
    const base = JSON.parse(readFileSync(resolve("node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json"), "utf8"));
    const data = JSON.parse(readFileSync(resolve("themes/cyber-offense.json"), "utf8"));
    expect(Object.keys(data.colors).sort()).toEqual(Object.keys(base.colors).sort());
    expect(data.colors.accent).toBe("red");
    expect(data.colors.border).toBe("red");
    expect(data.colors.borderAccent).toBe("red");
    expect(JSON.stringify(data).toLowerCase()).not.toContain("blue");
  }
});
