/**
 * The anatomy audit for Fig 1's pipe work, run by `moon run website:figure-audit`. The kit's `auditOrExit` only audits
 * when `--audit` is on the command line, so this script always passes it. It proves the line to Pearl Abyss clears
 * everything it passes, ends on real mounts, is held, and is painted in true depth order.
 */
import * as A from "../../vendor/anatomy/audit.mjs";
import { P } from "./layout.ts";
import { lineAssembly } from "./line.ts";

const { R } = lineAssembly();
A.auditOrExit(R, P, { argv: [...process.argv, "--audit"] });
