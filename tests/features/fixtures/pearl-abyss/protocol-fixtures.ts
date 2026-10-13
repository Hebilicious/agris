export interface PearlAbyssProtocolFixture {
  readonly payload: string;
  readonly provenance: string;
}

export const pearlAbyssProtocolFixtures = {
  summaries: {
    provenance: "Arsha MarketResponseFixtures.java at commit 0d04e43a75bb90983781ad4374e8dd06926c4552",
    payload: "10007-44-76500-514774|10006-0-377000-114184",
  },
  listings: {
    provenance: "Direct NA Pearl Abyss observation recorded by repository research on 2026-08-22",
    payload: "44195-0-0-1680000-43483-708081197-75000-5000000-1670000-1787364852|",
  },
  catalog: {
    provenance: "Decoded Arsha MarketResponseFixtures.java row at commit 0d04e43a75bb90983781ad4374e8dd06926c4552",
    payload: "10003-1-60715-72000",
  },
  orderBook: {
    provenance: "Decoded Arsha MarketResponseFixtures.java row at commit 0d04e43a75bb90983781ad4374e8dd06926c4552",
    payload: "74500-0-9|76000-0-5|76500-2-0|77000-1-0",
  },
  priceHistory: {
    provenance: "Arsha MarketResponseFixtures.java at commit 0d04e43a75bb90983781ad4374e8dd06926c4552",
    payload:
      "219302-219302-221553-221939-221939-217501-216932-216932-214566-214566-210731-210731-205866-205866-197068-187591-182458-181141-181141-177311-170974-170974-171945-171945-171945-165972-165729-163608-163608-167622-164180-156488-152574-152574-149897-147014-145045-144482-144482-134627-134627-126013-118036-108390-108390-100531-94128-91034-83703-78704-70763-70763-67233-67233-62788-59138-62813-62813-56942-59410-60107-68306-78259-85938-98946-98946-108972-125168-135164-135164-131831-119971-115901-110605-110605-102082-94976-94976-89238-82857-82857-81564-88989-87423-85790-86588-86588-87205-79163-76326",
  },
  hotItems: {
    provenance: "Decoded Arsha MarketResponseFixtures.java row at commit 0d04e43a75bb90983781ad4374e8dd06926c4552",
    payload: "784-0-0-166000-0-31223-2-30000-2670-190000-166000-1692679415",
  },
  registrations: {
    provenance: "Arsha MarketResponseFixtures.java at commit 0d04e43a75bb90983781ad4374e8dd06926c4552",
    payload: "705517-20-45800000000-1693064335|12257-4-15400000000-1693064590",
  },
} as const satisfies Readonly<Record<string, PearlAbyssProtocolFixture>>;

// Direct first-party observation on 2026-08-23:
// POST https://na-trade.naeu.playblackdesert.com/TradeMarket/GetBiddingInfoList
// body {"keyType":0,"mainKey":10006,"subKey":0}. The Huffman payload decodes to "371000-0-0|".
export const observedBiddingInfoCompressedBase64 =
  "TAAAAAAAAAAGAAAAAgAAAC0AAAAFAAAAMAAAAAEAAAAxAAAAAQAAADMAAAABAAAANwAAAAEAAAB8AAAAGQAAAAQAAAALAAAAvQZngA==";
