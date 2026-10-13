import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  dataTableStepArgument,
  noStepArguments,
  stringPairStepArguments,
  step,
  type ExecutableFeatureManifest,
  type StepDefinition,
} from "../support/manifest.ts";

interface ToolchainInstallWorld {
  protoVersion?: string;
  installerSha256?: string;
  instructions?: ReadonlyMap<string, string>;
}

const REPOSITORY_ROOT = new URL("../../", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, REPOSITORY_ROOT), "utf8");

/** `curl ... | sh`, `wget -O- ... | bash` and the like, on one line. */
const PIPED_INSTALL = /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/;

/** The text by which a file pins proto: the release installer's URL, or the version where the file builds that URL. */
function pinOf(file: string, version: string): string {
  if (file === "website/src/site.ts") return `PROTO_VERSION = "${version}"`;
  if (file.endsWith(".yml")) return `proto-version: "${version}"`;
  return `https://github.com/moonrepo/proto/releases/download/v${version}/proto_cli-installer.sh`;
}

const steps: readonly StepDefinition<ToolchainInstallWorld>[] = [
  step("the proto version pinned in .prototools is read", noStepArguments, (world) => {
    const pin = /^proto\s*=\s*"([^"]+)"$/m.exec(read(".prototools"))?.[1];
    assert.ok(pin !== undefined, ".prototools pins proto");
    world.protoVersion = pin;
  }),
  step("these files install that proto version from its release", dataTableStepArgument, (world, table) => {
    const version = world.protoVersion;
    assert.ok(version !== undefined);
    for (const { file = "" } of table.hashes) {
      const text = read(file);
      assert.ok(text.includes(pinOf(file, version)), `${file} installs proto ${version}`);
      const named: string[] = [...text.matchAll(/moonrepo\/proto\/releases\/download\/v([0-9.]+)\//g)].map(
        (match) => match[1] ?? "",
      );
      assert.deepEqual(
        named.filter((other) => other !== version),
        [],
        `${file} names only proto ${version}`,
      );
    }
  }),
  step(
    ".prototools pins proto {word}, whose installer has the SHA-256 {word}",
    stringPairStepArguments,
    (world, version, sha256) => {
      const pin = /^proto\s*=\s*"([^"]+)"$/m.exec(read(".prototools"))?.[1];
      // A new pin fails here until the checksum of its installer replaces this one.
      assert.equal(pin, version, `.prototools pins proto ${version}`);
      world.protoVersion = version;
      world.installerSha256 = sha256;
    },
  ),
  step(
    "these files check that SHA-256 before running the installer, and run it with PROTO_HOME set to ~\\/.proto",
    dataTableStepArgument,
    (world, table) => {
      const sha256 = world.installerSha256;
      assert.ok(sha256 !== undefined);
      const check = `echo "${sha256}  proto_cli-installer.sh" | sha256sum -c`;
      const run = `PROTO_HOME="$HOME/.proto" PROTO_CLI_NO_MODIFY_PATH=1 sh proto_cli-installer.sh`;
      for (const { file = "" } of table.hashes) {
        const text = read(file);
        const checkAt = text.indexOf(check);
        assert.ok(checkAt >= 0, `${file} checks the installer's SHA-256 with: ${check}`);
        assert.ok(text.indexOf(run) > checkAt, `${file} runs the checked installer with: ${run}`);
        const runs = text.split("\n").filter((line) => line.includes("sh proto_cli-installer.sh"));
        assert.deepEqual(
          runs.filter((line) => !line.includes(run)),
          [],
          `${file} runs every installer with PROTO_HOME set`,
        );
      }
    },
  ),
  step("the instructions in these files are read", dataTableStepArgument, (world, table) => {
    world.instructions = new Map(table.hashes.map(({ file = "" }) => [file, read(file)]));
  }),
  step("none of them pipes curl or wget into a shell", noStepArguments, (world) => {
    assert.ok(world.instructions !== undefined && world.instructions.size > 0);
    for (const [file, text] of world.instructions) {
      const line = text.split("\n").find((candidate) => PIPED_INSTALL.test(candidate));
      assert.equal(line, undefined, `${file} pipes a download into a shell`);
    }
  }),
];

export const toolchainInstallFeature: ExecutableFeatureManifest<ToolchainInstallWorld> = {
  id: "toolchain-install",
  uri: "tests/features/toolchain-install.feature",
  createWorld: () => ({}),
  steps,
};
