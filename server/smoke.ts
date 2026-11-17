export {};
// Read-only deployment smoke. Does not manufacture hardware approvals or spend demo funds.
const SERVER = process.env.SERVER || "http://localhost:8787";
const check = (label: string, condition: unknown) => {
  console.log(`${condition ? "ok" : "FAIL"}  ${label}`);
  if (!condition) process.exitCode = 1;
};
for (const path of ["/", "/phone", "/phone.js", "/pay", "/payment.js", "/demo", "/demo-evidence.json", "/idl.json"]) {
  const response = await fetch(SERVER + path);
  check(`${path} is available`, response.ok);
}
for (const [path, body] of [
  ["/v1/lookup", { invalid: true }],
  ["/v1/act", { kind: "forged" }],
  ["/v1/enrollment/verify", { id: "missing", certificates: [], signature: "fake" }],
] as const) {
  const response = await fetch(SERVER + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  check(`${path} rejects invalid input`, response.status === 400 && Boolean((await response.json() as any).error));
}
const handle = process.env.HANDLE;
if (handle) {
  const record = await (await fetch(`${SERVER}/v1/project?handle=${encodeURIComponent(handle)}`)).json() as any;
  check("project has an explicit onchain approval", record.handle === handle && Boolean(record.record));
  if (record.evidence) {
    const evidence = await (await fetch(`${SERVER}/v1/enrollment/evidence/${record.evidence}`)).json() as any;
    check("public hardware evidence matches the approval", evidence.evidence === record.evidence && evidence.policy === "thumbprint-biometric-v2");
  }
}
