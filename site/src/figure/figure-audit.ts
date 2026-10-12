/**
 * The anatomy audit for Fig 1's pipe work: run with `--audit` (`moon run site:figure-audit`). It proves the line to
 * Pearl Abyss clears everything it passes, ends on real mounts, is held, and is painted in true depth order.
 */
import * as A from "../../vendor/anatomy/audit.mjs";
import { P } from "./layout.ts";
import { lineAssembly } from "./line.ts";

const { R } = lineAssembly();
A.auditOrExit(R, P, { argv: [...process.argv, "--audit"] });
