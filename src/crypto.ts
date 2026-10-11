import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** AES-256-GCM for secrets at rest (Wise API tokens). */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash("sha256").update(secret).digest();
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
  }

  open(sealed: string): string {
    const [version, iv, tag, data] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || !data) throw new Error("Unsupported sealed value");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  }

  /** HMAC signature for short-lived browser cookies. */
  sign(value: string): string {
    return `${value}.${createHmac("sha256", this.key).update(value).digest("base64url")}`;
  }

  unsign(signed: string): string | undefined {
    const i = signed.lastIndexOf(".");
    if (i < 0) return undefined;
    const value = signed.slice(0, i);
    const expected = Buffer.from(this.sign(value));
    const given = Buffer.from(signed);
    return expected.length === given.length && timingSafeEqual(expected, given) ? value : undefined;
  }
}

export const randomToken = () => randomBytes(32).toString("hex");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
