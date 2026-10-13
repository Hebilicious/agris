import { URL as NodeUrl } from "node:url";

import { registerNativeProperties } from "../support/native-property-adapter.ts";
import { registerFeature } from "../support/vitest-adapter.ts";
import { itemNameSearchFeature } from "./item-name-search.manifest.ts";
import { nativeProperty as itemNameSearchProperty } from "./item-name-search.property.ts";

await registerFeature(itemNameSearchFeature, new NodeUrl("./item-name-search.feature", import.meta.url));
registerNativeProperties([itemNameSearchProperty]);
