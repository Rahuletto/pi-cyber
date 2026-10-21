import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { loadThemeFromPath, setThemeJsonValidator } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { validateThemeJson } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-schema.js";
test("both full mode themes pass Pi schema and render under truecolor and reduced-color terminals", () => {
  setThemeJsonValidator(validateThemeJson);
  for (const colorMode of ["truecolor", "256color"] as const) {
    const offense = loadThemeFromPath(resolve("themes/cyber-offense.json"), colorMode);
    const defense = loadThemeFromPath(resolve("themes/cyber-defense.json"), colorMode);
    expect(offense.fg("accent", "OFFENSE")).toContain("OFFENSE");
    expect(offense.fg("accent", "label")).not.toBe(defense.fg("accent", "label"));
    const base = JSON.parse(readFileSync(resolve("node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json"), "utf8"));
    for (const path of ["themes/cyber-offense.json", "themes/cyber-defense.json"]) {
      const data = JSON.parse(readFileSync(resolve(path), "utf8"));
      expect(Object.keys(data.colors).sort()).toEqual(Object.keys(base.colors).sort());
      expect(data.colors.success).toBe("green");
      expect(data.colors.error).toBe("red");
    }
  }
});
