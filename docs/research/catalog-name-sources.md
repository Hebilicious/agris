# Catalog name sources in Pearl Abyss game files

Can the item catalog's names in all 12 locales come from Pearl Abyss's own game files? This note records what was
checked on 2026-10-13 and what it showed.

**Answer: not yet.** First-party language files were found and decoded for 9 locales. For three locales they were not:
Russian (RU) and Thai (TH) have no source we could reach, and Turkish (TR) only has a file frozen at an older patch. The
catalog data was left unchanged.

## How the client gets its names

The Windows client keeps its UI and item text in `ads/languagedata_<code>.loc`. Each region's patch server lists the
current file versions in `UploadData/ads_files`, one `languagedata_<code>.loc<TAB><version>` line per language, and
serves each file at:

```
<PATCH_URL>ads/languagedata_<code>/<version>/languagedata_<code>.loc
```

`PATCH_URL` is in the region's `service.ini` (for NA/EU, `https://naeu-o-dn.playblackdesert.com/UploadData/`). The
local client's `update.log` shows its launcher fetching exactly these URLs, for example
`https://naeu-o-dn.playblackdesert.com/UploadData/ads/languagedata_en/405/languagedata_en.loc`.

A `.loc` file is a little-endian `u32` declared size followed by a zlib stream of records:
`u32 length, u32 table, u32 id, u32 field, UTF-16LE text[length], u32 0`. Item names are the records with
`table = 0` and `field = 0`, keyed by item ID.

## Per locale

The coverage column counts how many of the catalog's 12,508 item IDs have a `table 0, field 0` name in the decoded
file.

| Locale | Code | Source                                                                                    | Version, date    | Coverage | Result                                              |
| ------ | ---- | ----------------------------------------------------------------------------------------- | ---------------- | -------- | --------------------------------------------------- |
| EN     | `en` | NA/EU CDN, `https://naeu-o-dn.playblackdesert.com/UploadData/` (also in the local client) | 405, 2026-10-08  | 12,508   | Obtained                                            |
| DE     | `de` | NA/EU CDN; local client `ads/languagedata_de.loc`                                         | 394              | 12,508   | Obtained                                            |
| FR     | `fr` | NA/EU CDN; local client `ads/languagedata_fr.loc`                                         | 396              | 12,508   | Obtained                                            |
| ES_EU  | `sp` | NA/EU CDN; local client `ads/languagedata_sp.loc`                                         | 399              | 12,508   | Obtained                                            |
| ES     | `es` | South America CDN, `https://sa-o-dn.playblackdesert.com/UploadData/`                      | 980, 2026-10-08  | 12,508   | Obtained                                            |
| PT     | `pt` | South America CDN, same host                                                              | 980, 2026-10-08  | 12,508   | Obtained                                            |
| JA     | `jp` | Japan CDN, `https://jpo-o-dn.playblackdesert.com/UploadData/`                             | 486, 2026-10-07  | 12,508   | Obtained                                            |
| ZH_TW  | `tw` | Taiwan CDN, `http://dn.blackdesert.com.tw/UploadData/`                                    | 2049, 2026-10-07 | 12,508   | Obtained                                            |
| TR     | `tr` | Turkey legacy CDN, `https://dn.tr.playblackdesert.com/UploadData/`                        | 766, 2026-07-03  | 12,281   | Partial: frozen before TR moved to the new launcher |
| KO     | —    | Korea CDN, `https://kro-o-dn.playblackdesert.com/UploadData/`, has no language file       | —                | —        | Not verified                                        |
| RU     | —    | No patch host found                                                                       | —                | —        | Missing                                             |
| TH     | —    | Asia CDN, new launcher only, `https://asia-o-dn.playblackdesert.com/4927be1a614b`         | —                | —        | Missing                                             |

How each region's patch host was found:

| Region                   | Where `PATCH_URL` came from                                                                                                 | `ads_files`                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| NA/EU                    | local `service.ini`, `update.log`, `https://naeu-o-dn.playblackdesert.com/UploadData/EU_service.ini`                        | `en 405`, `fr 396`, `sp 399`, `de 394`        |
| SA                       | installer link on `https://www.sa.playblackdesert.com/pt-BR/main/index`; `UploadData/service.ini` (`TYPE=SA`, `RES=_PT_`)   | `pt 980`, `es 980`                            |
| JP                       | installer link on `https://www.jp.playblackdesert.com/ja-JP/main/index`; `UploadData/service.ini` (`TYPE=JP`)               | `jp 486`                                      |
| TW                       | installer link on `https://www.tw.playblackdesert.com/zh-TW/main/index`; `UploadData/service.ini` (`TYPE=TW`)               | `tw 2049`                                     |
| KR                       | installer link on `https://www.kr.playblackdesert.com/ko-KR/main/index`; `UploadData/service.ini` (`TYPE=KR`, `RES=` empty) | `spare.dat 1` only                            |
| TR                       | Pearl Abyss launcher product config (below); legacy `UploadData/service.ini` (`TYPE=TR`)                                    | `en 745`, `tr_en 696`, `tr 766`               |
| Asia (SEA + TH)          | Pearl Abyss launcher product config (below)                                                                                 | 404                                           |
| Global Lab (test server) | DNS probe; product config                                                                                                   | `en 176`, `tw 169`, `jp 139` (data from 2024) |
| RU                       | not found                                                                                                                   | —                                             |

## The three gaps

### TH (Thai)

Southeast Asia and Thailand are now one region, Asia, installed only through the new Pearl Abyss Launcher
(`https://store.pearlabyss.com/Download/Launcher` redirects to
`https://pa-common-dn.pearlcdn.com/a2c669439e19/0.15.5/Pearl-Abyss-Launcher_Setup.exe`). Without signing in, the
launcher's product API answers:

```
POST https://productmanager.pearlapis.com/api/v1/Product/GetProductConfig
{"_productIdList":["3c90446b6b99","4927be1a614b","982bbd3e9b96"],"_userIp":""}   -> 200
```

Asia is product `4927be1a614b`, with `"PatchURL": "https://asia-o-dn.playblackdesert.com/4927be1a614b"` and
`"gameLanguage": {"en-us": "_EN_", "th-th": "_TH_"}`. Under that root only `service.ini` answers 200 (`TYPE=ASIA`,
`RES=_EN_`, `;PATCH_URL=` commented out). The old layout does not exist there: `ads_files`, `client_version`,
`UploadData/ads_files`, `UploadData/client_version` and about 25 guessed manifest names (`manifest.json`,
`version.json`, `EssentialManifest.json`, …) all return 404 `BlobNotFound`. The same calls on the bare host
(`https://asia-o-dn.playblackdesert.com/UploadData/...`) also return 404. Azure container listing
(`?restype=container&comp=list`) returns 404.

The new launcher builds its file list in `PASyncDll.dll` (arguments such as `EssentialManifestUri`, `ManifestUri`,
`PatchAlgorithm=Hdiff`, `FileSha256`). That DLL is packed, so its manifest paths cannot be read from its strings.
`GetProductInfo` for `4927be1a614b` returns the same configuration with no version. We stopped there. The old TH and SEA
hosts (`dn.th.playblackdesert.com`, `dn.sea.playblackdesert.com`, `dn.blackdesert.in.th`) do not resolve.

### RU (Russian)

No RU patch host was found.

- The Russian portal answers this machine with an Imperva/Incapsula block page ("Request unsuccessful. Incapsula
  incident ID …"). That happened for `https://www.ru.playblackdesert.com/ru-RU/main/index` with curl, and in a real
  Chromium through Playwright, which rendered an empty page. WebFetch got an empty page for
  `https://www.ru.playblackdesert.com/Data/Down/`, which is the page that links `BlackDesert_Installer_RU.exe`.
  Those are the pages where the other regions' installer links (and so their CDN hosts) were found.
- `https://launcher.ru.playblackdesert.com/` loads (200), but neither it nor its scripts
  (`https://s1.pearlcdn.com/RU/contents/js/...`) name a patch host.
- None of these resolve: `ru-o-dn`, `ruo-o-dn`, `rus-o-dn`, `ru-dn`, `ruo-dn`, `cis-o-dn`, `dn.ru`, `cdn.ru`,
  `patch.ru` and 20 similar names under `playblackdesert.com`. The Pearl Abyss launcher's product config lists no RU
  product.
- The Internet Archive's CDX API answered "Temporarily Offline".

Fetching the RU download page from a network that Incapsula does not block should reveal the installer URL. Its host
then serves `UploadData/service.ini` and `UploadData/ads_files`.

### TR (Turkish)

`https://dn.tr.playblackdesert.com/UploadData/ads/languagedata_tr/766/languagedata_tr.loc` is reachable (200,
38,549,779 bytes). Its Last-Modified is 2026-07-03, and it has no name for 227 catalog items, all of them newer content
(for example 800, 890, 4016, Apeiron gear 11733). Turkey has moved to the new launcher (product `982bbd3e9b96`, a
"transfer" product). Its new root, `https://dn.tr.playblackdesert.com/982bbd3e9b96`, has the same unreadable layout as
Asia. The live Turkish names are behind the same blocker as TH.

### KO (Korean), not verified

The Korean service's `ads_files` lists only `spare.dat`: Korean is the game's source language, and the KR client ships
no `languagedata_kr.loc`. Korean item names are embedded in the encrypted PAZ archives' item table, which the NA/EU
client also carries. Reading them needs PAZ decryption and an item-table parser. We did not build these, because RU
and TH already prevent a full rebuild. Whether these embedded names match the names KR players see is also still
open.

## Comparison with the shipped catalog

For the 9 locales obtained, `table 0, field 0` names were compared with `data/catalog/<locale>/items.json`.

| Locale         | Same   | Different | Missing |
| -------------- | ------ | --------- | ------- |
| EN             | 12,504 | 4         | 0       |
| DE             | 12,479 | 29        | 0       |
| FR             | 12,485 | 23        | 0       |
| ES_EU (`sp`)   | 12,431 | 77        | 0       |
| ES (`es`)      | 12,251 | 257       | 0       |
| PT             | 12,495 | 13        | 0       |
| JA             | 12,504 | 4         | 0       |
| ZH_TW          | 12,503 | 5         | 0       |
| TR (July file) | 12,248 | 33        | 227     |

Sample differences, shown as shipped name → game file name:

- 9727 EN: `Blue Whale Oil` → `Great Ocean Oil`; JA: `オオクジラの脂` → `大洋の油`.
- 12831 EN: `Crio's Fishing Chair` → `Crio's Fishing Chair (3 Days)`.
- 890 DE: `Kampf-EP +50 % (60 Min.)` → `Parfüm des Grüns`. The shipped name looks like the name of a different item.
- 800 ES: `Elixir de añil` → `Frasco de Añil`. ES_EU is the reverse (`Frasco de Añil` → `Elixir de añil`), so the
  shipped catalog has swapped some ES and ES_EU names.
- Several game names end in a trailing space (for example 54437, 9491). An importer would need to decide whether to
  trim them.

## Reproducing

1. Read `<PATCH_URL>ads_files` for the version, then download
   `<PATCH_URL>ads/languagedata_<code>/<version>/languagedata_<code>.loc`.
2. Skip 4 bytes, inflate with zlib, walk the records, and keep `table 0, field 0`.

Download untrusted files into their own directory under `.artifacts/`. Never write to a game installation.
