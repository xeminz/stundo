// Erzeugt ein VAPID-Schlüsselpaar für Push-Mitteilungen: node tools/gen-vapid.mjs
import { generateKeyPairSync } from "node:crypto";
const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
console.log(`VAPID_PUBLIC=${pub}\nVAPID_PRIVATE=${jwk.d}`);
