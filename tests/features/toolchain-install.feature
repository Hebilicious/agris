@vitest
Feature: Toolchain install
  The instructions install proto from the release the repository pins, with proto's own installer saved to a file and
  checked against its SHA-256 before it runs, and never pipe a download into a shell. The installer installs into
  `$PROTO_HOME/bin`, else `$XDG_DATA_HOME/proto/bin`, else `~/.proto/bin`, so the instructions set `PROTO_HOME` to the
  `~/.proto` they run proto from.

  @scenario:toolchain-install-pins-proto @provenance:spec @i1
  Scenario: Every install instruction names the proto version .prototools pins
    When the proto version pinned in .prototools is read
    Then these files install that proto version from its release
      | file                                 |
      | README.md                            |
      | docs/deploy.md                       |
      | .agents/skills/deploy-agris/SKILL.md |
      | website/src/site.ts                  |

  @scenario:toolchain-install-checks-installer @provenance:spec @i1
  Scenario: Every install instruction checks the installer and installs proto where it then runs it from
    Given .prototools pins proto 0.63.1, whose installer has the SHA-256 e33cc6e6e1834ac3d769e311415b4a12013ae33fe2b27cdcf34340a62d97c2b6
    Then these files check that SHA-256 before running the installer, and run it with PROTO_HOME set to ~/.proto
      | file                                 |
      | README.md                            |
      | docs/deploy.md                       |
      | .agents/skills/deploy-agris/SKILL.md |
      | website/src/pages/index.astro        |

  @scenario:toolchain-install-never-pipes @provenance:spec @i1
  Scenario: No instruction pipes a download into a shell
    When the instructions in these files are read
      | file                                 |
      | README.md                            |
      | CONTRIBUTING.md                      |
      | docs/deploy.md                       |
      | .agents/skills/deploy-agris/SKILL.md |
      | website/src/pages/index.astro        |
      | website/src/pages/llms.txt.ts        |
    Then none of them pipes curl or wget into a shell
