import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
const start = source.indexOf("const API_BASE =");
const end = source.indexOf("\nfunction App()");
assert.ok(start >= 0 && end > start, "locate the production auth/request functions");
const authSource = source.slice(start, end);
const host = "panel.example:8688";
const managementKey = "fixture-management-key";
const auth = { state: { rememberPassword: true, managementKey }, version: 0 };

function encodeSession(version) {
  const secret = new TextEncoder().encode(
    `cli-proxy-api-webui::secure-storage|${host}${version === 1 ? "|Browser/1" : ""}`,
  );
  const bytes = new TextEncoder().encode(JSON.stringify(auth));
  return `enc::v${version}::` + btoa(
    String.fromCharCode(...bytes.map((byte, i) => byte ^ secret[i % secret.length])),
  );
}

function loadAuth(raw, userAgent = "Browser/1") {
  const requests = [];
  const context = vm.createContext({
    TextEncoder,
    TextDecoder,
    atob,
    location: { host },
    navigator: { userAgent },
    localStorage: {
      getItem(key) {
        assert.equal(key, "cli-proxy-auth");
        return raw;
      },
    },
    async fetch(path, options) {
      requests.push({ path, options });
      return { status: 200, ok: true, json: async () => ({ events: [] }) };
    },
  });
  vm.runInContext(authSource, context);
  return { context, requests };
}

for (const [name, raw] of [
  ["plaintext", JSON.stringify(auth)],
  ["CPAMC v1", encodeSession(1)],
  ["CPAMC v2", encodeSession(2)],
]) {
  test(`saved ${name} login authenticates plugin requests`, async () => {
    const { context, requests } = loadAuth(raw);
    assert.equal(context.readManagementKey(), managementKey);
    await context.request("/usage");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.headers.Authorization, `Bearer ${managementKey}`);
  });
}

test("CPAMC v2 login remains readable after the browser user agent changes", () => {
  const { context } = loadAuth(encodeSession(2), "Browser/2");
  assert.equal(context.readManagementKey(), managementKey);
});

test("missing or malformed saved logins still require authentication", async () => {
  for (const raw of [null, "{broken", "enc::v2::not-base64", JSON.stringify({ state: {} })]) {
    const { context, requests } = loadAuth(raw);
    assert.equal(context.readManagementKey(), "");
    await assert.rejects(context.request("/usage"), /记住密码/);
    assert.equal(requests.length, 0);
  }
});
