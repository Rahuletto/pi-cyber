/**
 * Adapter registry — the single source the Task 6 job runner consumes.
 * Adapters are pure functions over (validated params, operator opts, stdout):
 * no filesystem writes, no subprocess logic, no shell strings anywhere.
 */
import { subfinder } from "./subfinder.ts";
import { httpx } from "./httpx.ts";
import { dnsx } from "./dnsx.ts";
import { katana } from "./katana.ts";
import { ffuf } from "./ffuf.ts";
import { naabu } from "./naabu.ts";
import { nuclei } from "./nuclei.ts";
import { uncover } from "./uncover.ts";
import { vulnx } from "./vulnx.ts";
import { interactsh } from "./interactsh.ts";
import { semgrep } from "./semgrep.ts";
import { jwtHack } from "./jwt-hack.ts";
import type { AdapterDef } from "./types.ts";

export const adapters: AdapterDef[] = [
  subfinder,
  httpx,
  dnsx,
  katana,
  ffuf,
  naabu,
  nuclei,
  uncover,
  vulnx,
  interactsh,
  semgrep,
  jwtHack,
];

export function byName(name: string): AdapterDef | undefined {
  return adapters.find((adapter) => adapter.name === name);
}
