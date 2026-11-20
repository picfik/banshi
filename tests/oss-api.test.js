import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

async function setup() {
  const objects = new Map();
  const deleted = [];
  let failDataWrites = false;
  const ossClient = {
    async get(key) {
      if (!objects.has(key)) throw Object.assign(new Error("not found"), { code: "NoSuchKey" });
      return { content: objects.get(key) };
    },
    async put(key, value) {
      if (failDataWrites && key === "test/data/cases.json") throw new Error("simulated write failure");
      objects.set(key, value);
    },
    async delete(key) {
      deleted.push(key);
      objects.delete(key);
    },
  };
  globalThis.__testOssClient = ossClient;
  globalThis.window = {
    location: { origin: "https://example.test" },
    dispatchEvent() {},
  };
  globalThis.localStorage = {
    getItem() { return null; },
    setItem() {},
  };
  const vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("../", import.meta.url)),
    resolve: {
      alias: [{
        find: "./oss",
        replacement: fileURLToPath(new URL("./fixtures/oss-client.js", import.meta.url)),
      }],
    },
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  try {
    const { api } = await vite.ssrLoadModule("/src/oss-api.ts");
    return {
      api,
      deleted,
      objects,
      setFailDataWrites(value) { failDataWrites = value; },
      async createCase(title) {
        return api("/api/cases", {
          method: "POST",
          body: JSON.stringify({ title, source: "测试来源" }),
        }).then((result) => result.case);
      },
      async upload(record, filename = "shared.txt") {
        const form = new FormData();
        form.set("file", new File(["same file"], filename, { type: "text/plain" }));
        return api(`/api/cases/${record.id}/steps/source-register/attachments`, {
          method: "POST",
          body: form,
        });
      },
      async close() {
        await vite.close();
        delete globalThis.__testOssClient;
      },
    };
  } catch (error) {
    await vite.close();
    delete globalThis.__testOssClient;
    throw error;
  }
}

test("reuses matching attachments and preserves shared OSS objects", async (t) => {
  const context = await setup();
  t.after(() => context.close());

  const firstCase = await context.createCase("第一事项");
  const firstUpload = await context.upload(firstCase);
  const secondCase = await context.createCase("第二事项");
  const secondUpload = await context.upload(secondCase);

  assert.equal(firstUpload.attachment.objectKey, secondUpload.attachment.objectKey);
  assert.match(secondUpload.attachment.syncMessage, /未重复上传/);
  assert.equal([...context.objects.keys()].filter((key) => key.startsWith("test/attachments/")).length, 1);

  await assert.rejects(
    context.api(`/api/cases/${firstCase.id}/steps/source-register/attachments/${firstUpload.attachment.id}`, {
      method: "DELETE",
      body: JSON.stringify({ confirm: true }),
    }),
    (error) => error.status === 409 && error.code === "ATTACHMENT_SHARED",
  );

  const removedCase = await context.api(`/api/cases/${firstCase.id}`, { method: "DELETE" });
  assert.equal(removedCase.preservedAttachmentCount, 1);
  assert.equal(context.deleted.length, 0);

  await context.api(`/api/cases/${secondCase.id}/steps/source-register/attachments/${secondUpload.attachment.id}`, {
    method: "DELETE",
    body: JSON.stringify({ confirm: true }),
  });
  assert.equal(context.deleted.length, 1);
});

test("does not delete attachments when case deletion fails to sync", async (t) => {
  const context = await setup();
  t.after(() => context.close());

  const record = await context.createCase("保留事项");
  await context.upload(record, "unique.txt");
  context.setFailDataWrites(true);

  await assert.rejects(
    context.api(`/api/cases/${record.id}`, { method: "DELETE" }),
    (error) => error.code === "OSS_SYNC_FAILED",
  );

  const result = await context.api("/api/cases");
  assert.equal(result.cases.some((item) => item.id === record.id), true);
  assert.equal(context.deleted.length, 0);
});

test("renames cases and sorts important cases first and held cases last", async (t) => {
  const context = await setup();
  t.after(() => context.close());

  const ordinary = await context.createCase("普通事项");
  const important = await context.createCase("待办事项");
  const held = await context.createCase("暂缓事项");

  await assert.rejects(
    context.api(`/api/cases/${ordinary.id}/flags`, {
      method: "PATCH",
      body: JSON.stringify({ isImportant: true, isOnHold: true }),
    }),
    (error) => error.status === 400 && error.code === "INVALID_CASE_FLAGS",
  );

  const renamed = await context.api(`/api/cases/${ordinary.id}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "  已修改名称  " }),
  });
  assert.equal(renamed.case.title, "已修改名称");

  await context.api(`/api/cases/${important.id}/flags`, {
    method: "PATCH",
    body: JSON.stringify({ isImportant: true, isOnHold: false }),
  });
  await context.api(`/api/cases/${held.id}/flags`, {
    method: "PATCH",
    body: JSON.stringify({ isImportant: false, isOnHold: true }),
  });

  const result = await context.api("/api/cases");
  assert.deepEqual(result.cases.map((record) => record.id), [important.id, ordinary.id, held.id]);
  assert.equal(result.cases[2].isOnHold, true);
});

test("saves AI provider credentials and model in shared OSS settings", async (t) => {
  const context = await setup();
  t.after(() => context.close());

  const saved = await context.api("/api/settings/ai", {
    method: "PUT",
    body: JSON.stringify({ provider: "tencent", apiKey: "test-key", model: "hunyuan-test" }),
  });
  const config = await context.api("/api/config");
  const persisted = JSON.parse(await context.objects.get("test/data/cases.json").text());

  assert.equal(saved.aiEnabled, true);
  assert.deepEqual(config.aiPreferences, {
    provider: "tencent",
    apiKey: "test-key",
    model: "hunyuan-test",
  });
  assert.deepEqual(persisted.settings.ai, config.aiPreferences);
});
