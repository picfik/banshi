import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import request from "supertest";
import vm from "node:vm";
import { createApp } from "../server/index.js";
import { createDataStore } from "../server/store.js";

const credentials = {
  AUTH_USERNAME: "test-operator",
  AUTH_PASSWORD: "test-password",
  SESSION_SECRET: "test-session-secret-with-more-than-32-characters",
  OSS_PREFIX: "test-prefix",
  AI_ENABLED: "false",
};

async function setup(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "casework-test-"));
  const dataStore = createDataStore(path.join(directory, "cases.json"));
  await dataStore.load();
  const app = await createApp({
    dataStore,
    uploadDir: path.join(directory, "uploads"),
    env: { ...credentials, ...options.env },
    ossClientPromise: options.ossClientPromise ?? null,
    aiService: options.aiService,
  });
  const agent = request.agent(app);
  const login = await agent.post("/api/auth/login").send({
    username: credentials.AUTH_USERNAME,
    password: credentials.AUTH_PASSWORD,
  });
  assert.equal(login.status, 200);
  return { agent, app, dataStore, directory };
}

async function newCase(agent) {
  const response = await agent.post("/api/cases").send({
    title: "测试事项",
    source: "工作交办",
    description: "虚构的测试记录",
  });
  assert.equal(response.status, 201);
  return response.body.case;
}

test("backend blocks a step until its predecessor is completed", async (t) => {
  const context = await setup();
  t.after(() => rm(context.directory, { recursive: true, force: true }));
  const record = await newCase(context.agent);
  const blocked = await context.agent
    .post(`/api/cases/${record.id}/steps/source-verify/complete`)
    .send({});
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, "STEP_NOT_CURRENT");
});

test("business APIs require an authenticated session", async (t) => {
  const context = await setup();
  t.after(() => rm(context.directory, { recursive: true, force: true }));
  const response = await request(context.app).get("/api/cases");
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "UNAUTHENTICATED");
});

test("renames cases and orders important cases first and held cases last", async (t) => {
  const context = await setup();
  t.after(() => rm(context.directory, { recursive: true, force: true }));

  const ordinary = await newCase(context.agent);
  const important = await newCase(context.agent);
  const held = await newCase(context.agent);

  const renamed = await context.agent.patch(`/api/cases/${ordinary.id}`).send({ title: "  已修改名称  " });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.case.title, "已修改名称");

  const invalidTitle = await context.agent.patch(`/api/cases/${ordinary.id}`).send({ title: " " });
  assert.equal(invalidTitle.status, 400);
  assert.equal(invalidTitle.body.error.code, "INVALID_TITLE");

  assert.equal((await context.agent.patch(`/api/cases/${important.id}/flags`).send({
    isImportant: true,
    isOnHold: false,
  })).status, 200);
  assert.equal((await context.agent.patch(`/api/cases/${held.id}/flags`).send({
    isImportant: true,
    isOnHold: true,
  })).status, 200);

  const listed = await context.agent.get("/api/cases");
  assert.deepEqual(listed.body.cases.map((record) => record.id), [important.id, ordinary.id, held.id]);
  assert.equal(listed.body.cases[2].isOnHold, true);
});

test("global search finds case records and step notes", async (t) => {
  const context = await setup();
  t.after(() => rm(context.directory, { recursive: true, force: true }));
  const record = await newCase(context.agent);
  const note = "回归检索标记-采购依据记录";
  await context.agent.patch(`/api/cases/${record.id}/steps/source-register`).send({ note });
  const response = await context.agent.get(`/api/search?q=${encodeURIComponent("回归检索标记")}`);
  assert.equal(response.status, 200);
  assert.ok(response.body.results.some((item) =>
    item.caseId === record.id && item.stepId === "source-register" && item.field === "办理记录",
  ));
});

test("a completed current step permits the next sequential step", async (t) => {
  const context = await setup();
  t.after(() => rm(context.directory, { recursive: true, force: true }));
  const record = await newCase(context.agent);
  const saved = await context.agent.patch(`/api/cases/${record.id}/steps/source-register`).send({ note: "已核对来源记录" });
  assert.equal(saved.status, 200);
  const completed = await context.agent.post(`/api/cases/${record.id}/steps/source-register/complete`).send({});
  assert.equal(completed.status, 200);
  const next = await context.agent.patch(`/api/cases/${record.id}/steps/source-verify`).send({ note: "已核对事项信息" });
  assert.equal(next.status, 200);
});

test("procurement mode steps are configurable, snapshotted, and server-enforced in order", async (t) => {
  const context = await setup();
  t.after(() => rm(context.directory, { recursive: true, force: true }));

  const settings = await context.agent.get("/api/settings/procurement");
  assert.equal(settings.body.modes.length, 4);
  const customized = settings.body.modes.map((mode) => ({
    ...mode,
    steps: mode.id === "direct-delegation"
      ? [
          { title: "测试采购步骤一", guidance: "记录第一步" },
          { title: "测试采购步骤二", guidance: "记录第二步" },
        ]
      : [{ title: `${mode.title}自定义步骤`, guidance: "按本单位配置记录" }],
  }));
  const savedSettings = await context.agent.put("/api/settings/procurement").send({ modes: customized });
  assert.equal(savedSettings.status, 200);

  const record = await newCase(context.agent);
  for (const [stepId, note] of [
    ["source-register", "登记来源"],
    ["source-verify", "核实事项"],
  ]) {
    assert.equal((await context.agent.patch(`/api/cases/${record.id}/steps/${stepId}`).send({ note })).status, 200);
    assert.equal((await context.agent.post(`/api/cases/${record.id}/steps/${stepId}/complete`).send({})).status, 200);
  }
  const assignment = await context.agent.patch(`/api/cases/${record.id}/steps/process-assign`).send({
    note: "已明确承办安排",
    handlingPath: "direct-delegation",
  });
  assert.equal(assignment.status, 200);
  assert.equal((await context.agent.post(`/api/cases/${record.id}/steps/process-assign/complete`).send({})).status, 200);
  const updatedModes = customized.map((mode) => mode.id === "direct-delegation"
    ? { ...mode, steps: [{ title: "更新后的新流程", guidance: "仅供新事项使用" }] }
    : mode);
  assert.equal((await context.agent.put("/api/settings/procurement").send({ modes: updatedModes })).status, 200);

  const detail = await context.agent.get(`/api/cases/${record.id}`);
  const procurementSteps = detail.body.case.steps.find((step) => step.id === "process-handle").procurementSteps;
  assert.equal(procurementSteps.length, 2);

  const skipped = await context.agent
    .post(`/api/cases/${record.id}/procurement-steps/${procurementSteps[1].id}/complete`)
    .send({});
  assert.equal(skipped.status, 409);
  assert.equal(skipped.body.error.code, "PROCUREMENT_STEP_NOT_CURRENT");

  await context.agent.patch(`/api/cases/${record.id}/steps/process-handle`).send({ note: "总办理记录" });
  const parentBlocked = await context.agent.post(`/api/cases/${record.id}/steps/process-handle/complete`).send({});
  assert.equal(parentBlocked.status, 409);
  assert.equal(parentBlocked.body.error.code, "PROCUREMENT_STEPS_INCOMPLETE");

  await context.agent.patch(`/api/cases/${record.id}/procurement-steps/${procurementSteps[0].id}`).send({ note: "完成第一项记录" });
  assert.equal((await context.agent.post(`/api/cases/${record.id}/procurement-steps/${procurementSteps[0].id}/complete`).send({})).status, 200);
  await context.agent.patch(`/api/cases/${record.id}/procurement-steps/${procurementSteps[1].id}`).send({ note: "完成第二项记录" });
  assert.equal((await context.agent.post(`/api/cases/${record.id}/procurement-steps/${procurementSteps[1].id}/complete`).send({})).status, 200);
  assert.equal((await context.agent.post(`/api/cases/${record.id}/steps/process-handle/complete`).send({})).status, 200);
});

test("failed OSS JSON sync is visible and retryable", async (t) => {
  let shouldFail = true;
  const client = {
    async put() {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("private provider error");
      }
    },
  };
  const context = await setup({ ossClientPromise: client, env: {
    OSS_REGION: "test-region",
    OSS_BUCKET: "private-test-bucket",
    OSS_ACCESS_KEY_ID: "not-a-real-key",
    OSS_ACCESS_KEY_SECRET: "not-a-real-secret",
  } });
  t.after(() => rm(context.directory, { recursive: true, force: true }));
  const created = await newCase(context.agent);
  assert.equal(created.id.length > 0, true);
  const failed = await context.agent.get("/api/cases");
  assert.equal(failed.body.sync.status, "failed");
  assert.match(failed.body.sync.message, /OSS 同步失败/);
  const retried = await context.agent.post("/api/sync/retry").send({});
  assert.equal(retried.status, 200);
  assert.equal(retried.body.sync.status, "success");
});

test("unconfigured AI returns an explicit error and creates no analysis", async (t) => {
  const context = await setup();
  t.after(() => rm(context.directory, { recursive: true, force: true }));
  const record = await newCase(context.agent);
  const upload = await context.agent
    .post(`/api/cases/${record.id}/steps/source-register/attachments`)
    .attach("file", Buffer.from("虚构的测试材料"), { filename: "sample.txt", contentType: "text/plain" });
  assert.equal(upload.status, 201);
  assert.equal(upload.body.attachment.localPath, undefined);
  assert.equal(upload.body.case.steps[0].attachments[0].extractedText, undefined);
  const attachmentId = upload.body.attachment.id;
  const response = await context.agent
    .post(`/api/cases/${record.id}/steps/source-register/attachments/${attachmentId}/analyze`)
    .send({});
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, "AI_NOT_CONFIGURED");
  const stored = context.dataStore.data.cases[0].steps[0].attachments[0];
  assert.equal(stored.analysis, null);
});

test("service worker caches same-origin app assets but leaves OSS requests to the browser", async () => {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  const listeners = new Map();
  const context = {
    self: {
      location: { origin: "https://app.example.test", href: "https://app.example.test/banshi/sw.js" },
      registration: { scope: "https://app.example.test/banshi/" },
      clients: { claim() {} },
      skipWaiting() {},
      addEventListener(name, callback) { listeners.set(name, callback); },
    },
    caches: {
      match: async () => null,
      open: async () => ({ addAll: async () => {}, put: async () => {} }),
      keys: async () => ["casework-static-v1"],
      delete: async () => true,
    },
    URL,
    fetch: async () => ({ ok: true, type: "basic", clone() { return this; } }),
    Promise,
  };
  vm.runInNewContext(source, context);

  const staticRequest = { request: { method: "GET", url: "https://app.example.test/assets/app.js" }, respondWith(value) { this.response = value; } };
  listeners.get("fetch")(staticRequest);
  assert.ok(staticRequest.response, "static GET should use the static cache strategy");

  const ossRequest = { request: { method: "GET", url: "https://bucket.oss-cn-hangzhou.aliyuncs.com/casework/data/cases.json" }, respondWith(value) { this.response = value; } };
  listeners.get("fetch")(ossRequest);
  assert.equal(ossRequest.response, undefined, "OSS data should not be cached by the app service worker");
});
